import type { FormOptions } from '.'
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
import { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { FieldSchema } from 'iight'
import { Kysely, RawBuilder, Selectable, sql } from 'kysely'
import { BlockList, isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'

type FormRow = Selectable<Database['forms']>

// Forms live in the database, made in the admin with core's schema builder, and take submissions from anyone through
// the public routes (PLAN.md section 10)

// A form as the public routes return it
const toForm = (row: FormRow) => ({
  id: row.id,
  name: row.name,
  label: row.label,
  version: row.version,
  fields: row.fields,
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

  // Create or change a form from its settings and fields. New fields make a new version, which the submissions from
  // then on are checked against.
  const save = async (c: Context<AdminEnv>, existing?: FormRow) => {
    const body = await c.req.json().catch(() => ({}))
    const settings = pickValues(formSchema, body ?? {}, inputs)
    const report = await validateServerValues(formSchema, settings, inputs)
    const problems = checkFormFields(body?.fields)
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
      return c.json({ isValid: false, fields }, 422)
    }

    const fields: Array<FieldSchema> = body.fields
    const changed = !existing || !isDeepStrictEqual(existing.fields, fields)
    const user = c.var.user.id
    const saved = { name: settings.name, label: settings.label, fields: JSON.stringify(fields), updated_by: user }

    try {
      const row = await db.transaction().execute(async (trx) => {
        // The update locks the form, so concurrent saves number their versions in turn
        const row = existing
          ? await trx
              .updateTable('forms')
              .set({ ...saved, ...(changed && { version: sql<number>`version + 1` }), updated_at: sql`now()` })
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('forms')
              .values({ ...saved, id: uuidv7(), version: 1, created_by: user })
              .returningAll()
              .executeTakeFirstOrThrow()
        if (changed) {
          await trx
            .insertInto('form_versions')
            .values({ form_id: row.id, number: row.version, fields: saved.fields, created_by: user })
            .execute()
        }
        return row
      })
      return c.json({ data: toAdminForm(row, origin(c)) }, existing ? 200 : 201)
    } catch (error) {
      // Two saves can pass the name check at the same moment, and then the index stops the second
      if ((error as { constraint?: string }).constraint !== 'forms_name_key') throw error
      return c.json(
        { isValid: false, fields: { ...report.fields, name: { isValid: false, messages: [nameTaken] } } },
        422,
      )
    }
  }

  // shortcut: every form, unpaged, page them when sites have hundreds
  app.get('/forms', async (c) => {
    const rows = await db.selectFrom('forms').selectAll().orderBy('label').execute()
    return c.json({ data: rows.map((row) => toAdminForm(row, origin(c))) })
  })

  app.post('/forms', (c) => save(c))

  app.get('/forms/:id', async (c) => c.json({ data: toAdminForm(await find(c.req.param('id')), origin(c)) }))

  app.put('/forms/:id', async (c) => save(c, await find(c.req.param('id'))))

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

// The networks a proxy in front of the CMS connects from, such as a load balancer's private network
const proxies = new BlockList()
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  proxies.addSubnet(network, prefix, 'ipv4')
}
proxies.addAddress('::1', 'ipv6')
proxies.addSubnet('fc00::', 7, 'ipv6')

const isProxy = (address: string) =>
  isIP(address) !== 0 && proxies.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')

// The address a request came from. Anyone can send X-Forwarded-For, so it's only believed from a proxy on one of those
// networks, taking the last address it doesn't run itself.
// shortcut: a proxy on a public address, such as a CDN's, counts as the sender; add a setting for proxies when a site
// needs one
function clientIp(c: Context) {
  const socket = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket
  let address = socket?.remoteAddress?.replace(/^::ffff:(?=\d+\.)/, '')
  if (!address) return null
  const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim())
  for (const hop of forwarded.filter(Boolean).reverse()) {
    if (!isProxy(address)) break
    address = hop
  }
  return address
}

// Counts each address's posts in a window of time, returning the seconds it has to wait once it's over the limit
// shortcut: the counts live in this process, so each process behind a load balancer keeps its own; keep them in the
// database when a site runs several
function rateLimiter(posts: number, window: number) {
  const counts = new Map<string, { count: number; resetsAt: number }>()
  let sweepAt = Date.now() + window

  return (address: string) => {
    const now = Date.now()
    if (now >= sweepAt) {
      for (const [key, { resetsAt }] of counts) if (resetsAt <= now) counts.delete(key)
      sweepAt = now + window
    }

    let count = counts.get(address)
    if (!count || count.resetsAt <= now) counts.set(address, (count = { count: 0, resetsAt: now + window }))
    count.count++
    return count.count > posts ? Math.ceil((count.resetsAt - now) / 1000) : 0
  }
}

// JSON for JSON requests, and otherwise a page, since a plain HTML form's post puts its reply in the browser
function reply(c: Context, status: ContentfulStatusCode, json: object, title: string, body: string) {
  if (/json/.test(`${c.req.header('content-type')} ${c.req.header('accept')}`)) return c.json(json, status)

  const referer = c.req.header('referer')
  const back = referer && /^https?:\/\//i.test(referer) ? `<p><a href="${escapeHtml(referer)}">Go back</a></p>` : ''
  const headers = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }
  return c.html(page(title, `${body}\n    ${back}`), status, headers)
}

// The public routes, under /v1, that serve a form's fields and take its submissions, with no key needed
export function publicFormRoutes(db: Kysely<Database>, { origins, rateLimit = {} }: FormOptions = {}) {
  const { posts = 10, minutes = 10 } = rateLimit
  if (!Number.isInteger(posts) || posts < 1 || !(minutes > 0)) {
    throw new Error('forms.rateLimit in iight.config.ts needs a whole number of posts from 1, and minutes above 0.')
  }
  const wait = rateLimiter(posts, minutes * 60 * 1000)
  const app = new Hono()

  // Any site's JavaScript can call them, unless iight.config.ts names the sites that can
  app.use('/forms/*', cors({ origin: origins ?? '*', exposeHeaders: ['Retry-After'] }))

  app.get('/forms/:form', async (c) => {
    const form = await findForm(db, c.req.param('form'))
    return form ? c.json({ data: toForm(form) }) : c.json({ message: 'Not Found' }, 404)
  })

  app.post(
    '/forms/:form',
    // Far more than a form's text needs, so a post can't fill the memory
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        reply(c, 413, { message: 'The submission is too large.' }, 'Too large', '<p>The submission is too large.</p>'),
    }),
    async (c) => {
      // A site's own server sends a key with the submit scope, and posts for all its visitors
      const ip = clientIp(c)
      const seconds = (await keyOf(db, c))?.scopes.includes('submit') ? 0 : wait(ip ?? '')
      if (seconds) {
        c.header('retry-after', String(seconds))
        const message = 'Too many submissions. Wait a few minutes, then send it again.'
        return reply(c, 429, { message }, 'Too many submissions', `<p>${message}</p>`)
      }

      const form = await findForm(db, c.req.param('form'))
      if (!form) return reply(c, 404, { message: 'Not Found' }, 'Form not found', "<p>This form doesn't exist.</p>")

      // The values themselves, from JSON or from a plain HTML form
      let posted: Record<string, any> = {}
      if (c.req.header('content-type')?.includes('json')) {
        const body = await c.req.json().catch(() => null)
        if (typeof body === 'object' && body !== null && !Array.isArray(body)) posted = body
      } else {
        const data = await c.req.formData().catch(() => new FormData())
        posted = { ...postedValues(form.fields, data), [honeypot]: data.get(honeypot) }
      }

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
