import type { FormOptions } from '.'
import { networkList } from './actions'
import { flattenValidationReport, inputs, isEmptyValue, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { keyOf } from './delivery'
import { embedHtml, escapeHtml, honeypot, page } from './embed'
import type { AdminEnv } from './entries'
import { addEvents } from './events'
import { origin } from './media'
import { SubmissionRow, listSubmissions, parseSubmissionQuery } from './query'
import { formSchema } from './schemas'
import { checkFormFields } from './types'
import type { HttpBindings } from '@hono/node-server'
import type { FieldSchema } from '@sorlo/core'
import { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Kysely, RawBuilder, Selectable, sql } from 'kysely'
import { BlockList, isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'

export type FormRow = Selectable<Database['forms']>

// Forms live in the database, made in the admin with core's schema builder, and take submissions from anyone through
// the public routes

// A form as the public routes return it. A closed one serves its fields and takes no submissions.
export const toForm = (row: FormRow) => ({
  id: row.id,
  name: row.name,
  label: row.label,
  version: row.version,
  fields: row.fields,
  open: row.open,
})

// A form as the admin API returns it, with HTML for pasting it into a page, which posts to it by its ID
const toAdminForm = (row: FormRow, origin: string) => ({
  ...toForm(row),
  embed: embedHtml(row.fields, `${origin}/v1/forms/${row.id}`),
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAdminSubmission = (row: SubmissionRow) => ({
  id: row.id,
  formId: row.form_id,
  version: row.form_version,
  values: row.values,
  spam: row.spam,
  ip: row.ip,
  userAgent: row.user_agent,
  referer: row.referer,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
})

const nameTaken = 'Another form has this name.'

export interface FormValues {
  name: string
  label: string
  fields: Array<FieldSchema>
}

// A form's label, name and fields from what was sent, or core's report: the settings as formSchema checks them, the
// fields as checkFormFields does, and a name no other form has
export async function checkForm(db: Kysely<Database>, body: unknown, existing?: { id: string }) {
  const sent = (body && typeof body === 'object' ? body : {}) as Record<string, any>
  const settings = pickValues(formSchema, sent, inputs)
  const report = await validateServerValues(formSchema, settings, inputs)
  const problems = checkFormFields(sent.fields)
  const taken =
    report.isValid &&
    (await db
      .selectFrom('forms')
      .select('id')
      .where('name', '=', settings.name)
      .$if(!!existing, (qb) => qb.where('id', '!=', existing!.id))
      .executeTakeFirst())
  if (!report.isValid || problems.length || taken) {
    const fields = {
      ...report.fields,
      ...(taken && { name: { isValid: false, messages: [nameTaken] } }),
      ...(problems.length && { fields: { isValid: false, messages: problems } }),
    }
    return { report: { isValid: false, fields } }
  }
  return {
    form: { name: settings.name as string, label: settings.label as string, fields: sent.fields as Array<FieldSchema> },
  }
}

// What opening a form sets: open, and when it was first opened, the first time. Over MCP, a change to a form that has
// been open could show at once on a page that shows it, so MCP changes only forms that have never been open.
export const opening = { open: true, first_opened_at: sql<Date>`coalesce(first_opened_at, now())` }
const setOpen = (open: boolean) => (open ? opening : { open: false })

export interface FormSaveOptions {
  // The id a new form is made with, which its proposal gave it in advance
  id?: string
  // Whether it takes submissions from now on: a new form does unless it's false, as forms made through AI start
  // closed, and a form saved again stays as it was unless it's given
  open?: boolean
  // Runs on the form as it is, locked, before it's changed, and can throw to stop the save
  guard?: (current: FormRow) => void
  // Runs in the save's transaction once it's written, such as to claim the proposal it applies
  during?: (trx: Kysely<Database>, row: FormRow) => Promise<void>
}

// Saves a checked form as a new form, or as the form with the given ID, as a person. New fields make a new version,
// which the submissions from then on are checked against.
export async function saveForm(
  db: Kysely<Database>,
  user: string,
  form: FormValues,
  id?: string,
  { id: newId, open, guard, during }: FormSaveOptions = {},
) {
  const saved = { name: form.name, label: form.label, fields: JSON.stringify(form.fields), updated_by: user }
  try {
    const row = await db.transaction().execute(async (trx) => {
      const current = id
        ? await trx.selectFrom('forms').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
        : undefined
      if (id && !current) throw new HTTPException(404)
      if (current) guard?.(current)

      // The lock means concurrent saves number their versions in turn
      const changed = !current || !isDeepStrictEqual(current.fields, form.fields)
      const row = current
        ? await trx
            .updateTable('forms')
            .set({
              ...saved,
              ...(changed && { version: sql<number>`version + 1` }),
              ...(open !== undefined && setOpen(open)),
              updated_at: sql`now()`,
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto('forms')
            .values({
              ...saved,
              id: newId ?? uuidv7(),
              version: 1,
              open: open ?? true,
              first_opened_at: open === false ? null : sql<Date>`now()`,
              created_by: user,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
      if (changed) {
        await trx
          .insertInto('form_versions')
          .values({ form_id: row.id, number: row.version, fields: saved.fields, created_by: user })
          .execute()
      }
      await during?.(trx, row)
      return row
    })
    return { row }
  } catch (error) {
    // Two saves can pass the name check at the same moment, and then the index stops the second
    if ((error as { constraint?: string }).constraint !== 'forms_name_key') throw error
    return { report: { isValid: false, fields: { name: { isValid: false, messages: [nameTaken] } } } }
  }
}

// The admin API for forms and their submissions. Every route needs a session, which createApp checks.
export function formRoutes(db: Kysely<Database>) {
  const app = new Hono<AdminEnv>()

  const find = async (id: string) => {
    const row = isUuid(id)
      ? await db.selectFrom('forms').selectAll().where('id', '=', id).executeTakeFirst()
      : undefined
    if (!row) throw new HTTPException(404)
    return row
  }

  // Create or change a form from its settings and fields
  const save = async (c: Context<AdminEnv>, existing?: FormRow) => {
    const checked = await checkForm(db, await c.req.json().catch(() => ({})), existing)
    if (checked.report) return c.json(checked.report, 422)
    const saved = await saveForm(db, c.var.user.id, checked.form, existing?.id)
    if (saved.report) return c.json(saved.report, 422)
    return c.json({ data: toAdminForm(saved.row, origin(c)) }, existing ? 200 : 201)
  }

  // Open a form to submissions, or close it, such as once its event is over
  const opens = (open: boolean) => async (c: Context<AdminEnv>) => {
    const id = c.req.param('id')!
    const row = isUuid(id)
      ? await db.updateTable('forms').set(setOpen(open)).where('id', '=', id).returningAll().executeTakeFirst()
      : undefined
    if (!row) throw new HTTPException(404)
    return c.json({ data: toAdminForm(row, origin(c)) })
  }

  // shortcut: every form, unpaged, page them when sites have hundreds
  app.get('/forms', async (c) => {
    const rows = await db.selectFrom('forms').selectAll().orderBy('label').execute()
    return c.json({ data: rows.map((row) => toAdminForm(row, origin(c))) })
  })

  app.post('/forms', (c) => save(c))

  app.get('/forms/:id', async (c) => c.json({ data: toAdminForm(await find(c.req.param('id')), origin(c)) }))

  app.put('/forms/:id', async (c) => save(c, await find(c.req.param('id'))))

  app.post('/forms/:id/open', opens(true))
  app.post('/forms/:id/close', opens(false))

  // The fields a version had, for showing the submissions that were checked against it
  app.get('/forms/:id/versions/:number', async (c) => {
    const form = await find(c.req.param('id'))
    const number = Number(c.req.param('number'))
    const version = Number.isInteger(number)
      ? await db
          .selectFrom('form_versions')
          .selectAll()
          .where('form_id', '=', form.id)
          .where('number', '=', number)
          .executeTakeFirst()
      : undefined
    if (!version) throw new HTTPException(404)
    return c.json({
      data: {
        number: version.number,
        fields: version.fields,
        createdBy: version.created_by,
        createdAt: version.created_at,
      },
    })
  })

  // A form's inbox, or its archive with archived=true, or its spam with spam=true
  app.get('/forms/:id/submissions', async (c) => {
    const form = await find(c.req.param('id'))
    const query = parseSubmissionQuery(c.req.query())
    const views = { archived: c.req.query('archived') === 'true', spam: c.req.query('spam') === 'true' }
    const { data, pagination } = await listSubmissions(db, form.id, query, views)
    return c.json({ data: data.map(toAdminSubmission), pagination })
  })

  // Archive or restore a submission, or mark it as spam or not, which moves it between the inbox and spam
  const change = (set: { archived_at?: RawBuilder<Date> | null; spam?: boolean }) => async (c: Context<AdminEnv>) => {
    const id = c.req.param('id')!
    const row = isUuid(id)
      ? await db.updateTable('submissions').set(set).where('id', '=', id).returningAll().executeTakeFirst()
      : undefined
    if (!row) throw new HTTPException(404)
    return c.json({ data: toAdminSubmission(row) })
  }

  app.post('/submissions/:id/archive', change({ archived_at: sql<Date>`coalesce(archived_at, now())` }))
  app.post('/submissions/:id/restore', change({ archived_at: null }))
  app.post('/submissions/:id/spam', change({ spam: true }))
  app.post('/submissions/:id/not-spam', change({ spam: false }))

  return app
}

// A form by its ID, as embeds post to it, or by its name, as the SDK does. Names start with a letter, so neither can be
// taken for the other.
const findForm = (db: Kysely<Database>, form: string) =>
  db
    .selectFrom('forms')
    .selectAll()
    .where(isUuid(form) ? 'id' : 'name', '=', form)
    .executeTakeFirst()

// A plain form post's values, read by the form's fields: a group's fields come as address.town, and a list of choices
// comes as its name again for each choice
function postedValues(fields: Array<FieldSchema>, data: FormData, prefix = '') {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    const name = `${prefix}${field.name}`
    const list = field.type === 'checkbox' || (field.type === 'select' && field.options?.multiple === true)
    if (field.type === 'group') values[field.name] = postedValues(field.options?.fields ?? [], data, `${name}.`)
    else if (data.has(name)) values[field.name] = list ? data.getAll(name) : data.get(name)
  }
  return values
}

// The label of the field a report's path names, such as Town for address.town, or the list's for an item in a list
function labelOf(fields: Array<FieldSchema>, path: string): string {
  const [name, ...rest] = path.split('.')
  const field = fields.find((field) => field.name === name)
  if (!field) return path
  if (rest.length && field.type === 'group') return labelOf(field.options?.fields ?? [], rest.join('.'))
  return field.label ?? field.name
}

// Loopback and private networks, such as a load balancer's, whose proxies' X-Forwarded-For is always believed
const privateNetworks = new BlockList()
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateNetworks.addSubnet(network, prefix, 'ipv4')
}
privateNetworks.addAddress('::1', 'ipv6')
privateNetworks.addSubnet('fc00::', 7, 'ipv6')

// The networks sorlo.config.ts's proxies lists, such as a CDN's, whose X-Forwarded-For is believed for one hop. One that
// holds every address believes whoever connects, which a site behind a host that publishes no addresses may choose, so
// it's taken with a warning.
export function proxyList(proxies: Array<string> = []) {
  const { list, wide } = networkList('proxies', proxies, '173.245.48.0/20')
  for (const { network } of wide) {
    console.warn(
      `proxies in sorlo.config.ts has ${network}, which holds every address, so whoever connects can name any address ` +
        'in X-Forwarded-For. List it only if nothing reaches the CMS except through your proxies.',
    )
  }
  return list
}

const within = (list: BlockList, address: string) =>
  isIP(address) !== 0 && list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')

// The address a request came from. Anyone can send X-Forwarded-For, so it's read from the right, past every proxy on a
// private network, then past one in proxyList at most: the hop that one names is the visitor, even if it's in a listed
// network too, since a CDN's customers can connect from its networks, as Cloudflare's Workers do.
export function clientIp(c: Context, proxies: BlockList) {
  const socket = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket
  if (!socket?.remoteAddress) return null
  let address = unmapped(socket.remoteAddress)
  const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim())
  for (const hop of forwarded.filter(Boolean).reverse()) {
    const isPrivate = within(privateNetworks, address)
    if (!isPrivate && !within(proxies, address)) break
    address = addressOf(hop)
    if (!isPrivate) break
  }
  return address
}

// A forwarded hop's address, without the port some proxies write after it, as Azure's Application Gateway writes
// 203.0.113.9:51234 or [2001:db8::9]:443
function addressOf(hop: string) {
  const bracketed = hop.match(/^\[(.+)\](?::\d+)?$/)
  return unmapped(bracketed ? bracketed[1] : hop.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'))
}

// An IPv4 address that an IPv6 socket or proxy wrote as ::ffff:1.2.3.4, as itself
const unmapped = (address: string) => address.replace(/^::ffff:(?=\d+\.)/i, '')

// An IPv6 address's eight 16-bit groups, an IPv4 address written at its end counting as two
function groupsOf(address: string) {
  const parts = (text?: string) =>
    (text ? text.split(':') : []).flatMap((group) => {
      if (!group.includes('.')) return [parseInt(group, 16)]
      const [a, b, c, d] = group.split('.').map(Number)
      return [(a << 8) | b, (c << 8) | d]
    })
  const [head, tail] = address.split('%')[0].split('::')
  const left = parts(head)
  const right = parts(tail)
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
}

// An address as the limits count it: an IPv6 address by its /64, the usual allocation for one machine or home, which
// would otherwise give 2^64 fresh budgets, and an IPv4 address written as IPv6, in any form, as the IPv4 address
export function limitKey(address: string | null) {
  if (!address || isIP(address) !== 6) return address ?? ''
  const groups = groupsOf(address)
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

// Counts what each key does in a window of time, such as an address's posts, giving the seconds it has to wait once
// it's over the limit
// shortcut: the counts live in this process, so each process behind a load balancer keeps its own; keep them in the
// database when a site runs several
export function rateLimiter(limit: number, window: number) {
  const counts = new Map<string, { count: number; resetsAt: number }>()
  let sweepAt = Date.now() + window

  // The key's count in the window it's in, if it has one
  const current = (key: string) => {
    const now = Date.now()
    if (now >= sweepAt) {
      for (const [key, { resetsAt }] of counts) if (resetsAt <= now) counts.delete(key)
      sweepAt = now + window
    }
    const count = counts.get(key)
    return count && count.resetsAt > now ? count : undefined
  }
  const secondsLeft = (count: { resetsAt: number }) => Math.ceil((count.resetsAt - Date.now()) / 1000)

  return {
    // Counts one, giving the seconds to wait once that's over the limit
    hit(key: string) {
      let count = current(key)
      if (!count) counts.set(key, (count = { count: 0, resetsAt: Date.now() + window }))
      count.count++
      return count.count > limit ? secondsLeft(count) : 0
    },
    clear: (key: string) => void counts.delete(key),
  }
}

// How many list items a post's values hold in all, at any depth, such as a repeater's items and the boxes ticked in
// each, counting only until there are more than most. It doesn't recurse, so a post nested deep can't overflow the stack.
function itemsIn(values: unknown, most: number) {
  let items = 0
  const pending = [values]
  while (pending.length && items <= most) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null) continue
    if (Array.isArray(value)) items += value.length
    if (items <= most) for (const child of Object.values(value)) pending.push(child)
  }
  return items
}

// JSON for JSON requests, and otherwise a page, since a plain HTML form's post puts its reply in the browser
function reply(c: Context, status: ContentfulStatusCode, json: object, title: string, body: string) {
  if (/json/.test(`${c.req.header('content-type')} ${c.req.header('accept')}`)) return c.json(json, status)

  const referer = c.req.header('referer')
  const back = referer && /^https?:\/\//i.test(referer) ? `<p><a href="${escapeHtml(referer)}">Go back</a></p>` : ''
  const headers = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }
  return c.html(page(title, `${body}\n    ${back}`), status, headers)
}

const tooLarge = (c: Context) =>
  reply(c, 413, { message: 'The submission is too large.' }, 'Too large', '<p>The submission is too large.</p>')

// The public routes, under /v1, that serve a form's fields and take its submissions, with no key needed
export function publicFormRoutes(
  db: Kysely<Database>,
  { origins, rateLimit = {}, maxItems = 1000 }: FormOptions = {},
  proxies: BlockList,
) {
  const { posts = 10, minutes = 10 } = rateLimit
  if (!Number.isInteger(posts) || posts < 1 || !(minutes > 0)) {
    throw new Error('forms.rateLimit in sorlo.config.ts needs a whole number of posts from 1, and minutes above 0.')
  }
  if (maxItems !== Infinity && !(Number.isInteger(maxItems) && maxItems >= 1)) {
    throw new Error('forms.maxItems in sorlo.config.ts needs a whole number from 1, or Infinity for no limit.')
  }
  const limit = rateLimiter(posts, minutes * 60 * 1000)
  const app = new Hono()

  // Any site's JavaScript can call them, unless sorlo.config.ts names the sites that can
  app.use('/forms/*', cors({ origin: origins ?? '*', exposeHeaders: ['Retry-After'] }))

  app.get('/forms/:form', async (c) => {
    const form = await findForm(db, c.req.param('form'))
    return form ? c.json({ data: toForm(form) }) : c.json({ message: 'Not Found' }, 404)
  })

  app.post(
    '/forms/:form',
    // Far more than a form's text needs, so a post can't fill the memory
    bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }),
    async (c) => {
      // A site's own server sends a key with the submit scope, and posts for all its visitors
      const ip = clientIp(c, proxies)
      const seconds = (await keyOf(db, c))?.scopes.includes('submit') ? 0 : limit.hit(limitKey(ip))
      if (seconds) {
        c.header('retry-after', String(seconds))
        const message = 'Too many submissions. Wait a few minutes, then send it again.'
        return reply(c, 429, { message }, 'Too many submissions', `<p>${message}</p>`)
      }

      const form = await findForm(db, c.req.param('form'))
      if (!form) return reply(c, 404, { message: 'Not Found' }, 'Form not found', "<p>This form doesn't exist.</p>")
      if (!form.open) {
        const message = "This form isn't taking submissions."
        return reply(c, 403, { message }, 'Not taking submissions', `<p>${message}</p>`)
      }

      // The values themselves, from JSON or from a plain HTML form
      let posted: Record<string, any> = {}
      if (c.req.header('content-type')?.includes('json')) {
        const body = await c.req.json().catch(() => null)
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) posted = body
      } else {
        const data = await c.req.formData().catch(() => new FormData())
        posted = { ...postedValues(form.fields, data), [honeypot]: data.get(honeypot) }
      }
      // Its list items count as sent, before pickValues builds any, since core checks every one
      if (itemsIn(posted, maxItems) > maxItems) return tooLarge(c)

      const values = pickValues(form.fields, posted, inputs)
      const report = await validateServerValues(form.fields, values, inputs)
      if (!report.isValid) {
        const problems = Object.entries(flattenValidationReport(report).messages).map(
          ([path, messages]) => `<li>${escapeHtml(labelOf(form.fields, path))}: ${escapeHtml(messages.join(' '))}</li>`,
        )
        return reply(c, 422, report, 'Your submission has problems', `<ul>${problems.join('')}</ul>`)
      }

      const row = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('submissions')
          .values({
            id: uuidv7(),
            form_id: form.id,
            form_version: form.version,
            values,
            ip,
            user_agent: c.req.header('user-agent') ?? null,
            referer: c.req.header('referer') ?? null,
            // A bot that fills in the honeypot gets the reply anyone gets, so it can't tell
            spam: !isEmptyValue(posted[honeypot]),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        // Spam triggers automations too, with spam in its data for their conditions to skip
        const event = { form: { id: form.id, name: form.name, label: form.label }, submission: toAdminSubmission(row) }
        await addEvents(trx, 'submission.created', [event])
        return row
      })

      const data = { id: row.id, version: row.form_version, values: row.values, createdAt: row.created_at }
      return reply(c, 201, { data }, 'Thank you', '<p>Your submission has been received.</p>')
    },
  )

  return app
}
