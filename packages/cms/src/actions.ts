import type { MailOptions } from '.'
import { Database } from './db'
import { escapeHtml } from './embed'
import { isEmpty, showValue } from './fields'
import { events } from './schemas'
import type { ContentType } from './types'
import type { FieldSchema } from 'iight'
import { Kysely, Selectable } from 'kysely'
import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

// What automations' actions do, each with its settings from its layout in schemas.ts (PLAN.md section 11)

export type EventRow = Selectable<Database['events']>

// What a run gets besides its settings and the event
export interface ActionContext {
  db: Kysely<Database>
  types: Map<string, ContentType>
  automation: { name: string }
  mail?: MailOptions
  // Whether a webhook may connect to an address
  reaches: (address: string) => boolean
}

// A failed try, with what came back, such as a webhook's reply
export class ActionFailed extends Error {
  constructor(
    message: string,
    readonly response: string | null = null,
  ) {
    super(message)
  }
}

interface Action {
  // Fills in settings before they're checked and saved
  prepare?: (settings: Record<string, any>) => Record<string, any>
  // Problems with settings that core's checks don't see
  check?: (settings: Record<string, any>) => Array<string>
  // Resolves what came back, for the runs log, or throws why it failed, to be tried again
  run: (settings: Record<string, any>, event: EventRow, context: ActionContext) => Promise<string | null>
}

// What came back, as text short enough for the log
const logged = (value: unknown) => {
  if (value === undefined) return null
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 2000)
  } catch {
    return String(value).slice(0, 2000)
  }
}

type Row = [label: string, value: string]

// Each top-level field with a value, as its label and its value as text
const fieldRows = (fields: Array<FieldSchema>, values: Record<string, any>): Array<Row> =>
  fields
    .filter((field) => field.type !== 'content' && !isEmpty(values[field.name]))
    .map((field) => [field.label ?? field.name, showValue(field, values[field.name])])

// What an event is about, as a title and rows of labels and values, with the fields of the submission's form version
// or of the entry's type
async function summary(event: EventRow, { db, types }: ActionContext) {
  const { entry, media, form, submission } = event.data
  if (submission) {
    const version = await db
      .selectFrom('form_versions')
      .select('fields')
      .where('form_id', '=', form.id)
      .where('number', '=', submission.version)
      .executeTakeFirst()
    const title = `New submission: ${form.label}${submission.spam ? ' (spam)' : ''}`
    return { title, rows: fieldRows(version?.fields ?? [], submission.values) }
  }
  if (entry) {
    const type = types.get(entry.type)
    const [name] = fieldRows(type?.fields.filter((field) => field.name === type.titleField) ?? [], entry.values)
    const title = `${type?.singular ?? type?.label ?? entry.type} ${event.name.split('.')[1]}${name ? `: ${name[1]}` : ''}`
    return { title, rows: fieldRows(type?.fields ?? [], entry.values) }
  }
  const title = `${events.find((known) => known.value === event.name)?.label}: ${media.name}`
  const rows: Array<Row> = [
    ['Type', media.mime],
    ['Alt text', media.alt],
    ['Caption', media.caption],
    ['URL', media.url],
  ]
  return { title, rows: rows.filter(([, value]) => value) }
}

// A Standard Webhooks secret is whsec_ and then 24 to 64 bytes in base64
const isSecret = (secret: unknown) => typeof secret === 'string' && /^whsec_[A-Za-z0-9+/]{32,86}={0,2}$/.test(secret)

// A header's name is an HTTP token, and its value has no control characters, which would end the header
const isHeaderName = (name: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
const isHeaderValue = (value: string) => !/[\0-\x08\x0a-\x1f\x7f]/.test(value)

export const actions: Record<string, Action> = {
  email: {
    run: async (settings, event, context) => {
      const { mail, automation } = context
      if (!mail) throw new ActionFailed('Set mail in iight.config.ts to send email.')

      const { title, rows } = await summary(event, context)
      const footer = `Sent by the automation ${automation.name}.`
      const text = [title, '', ...rows.map(([label, value]) => `${label}: ${value}`), '', footer].join('\n')
      const html = [
        `<h1>${escapeHtml(title)}</h1>`,
        '<table>',
        ...rows.map(
          ([label, value]) =>
            `<tr><th align="left" valign="top">${escapeHtml(label)}</th><td style="white-space: pre-wrap">${escapeHtml(value)}</td></tr>`,
        ),
        '</table>',
        `<p>${escapeHtml(footer)}</p>`,
      ].join('\n')

      const to = String(settings.to).split(/[ ,]+/).filter(Boolean)
      // On one line, since a title can come from an entry's values and a line break would start another header
      const subject = String(settings.subject || title).replace(/\s+/g, ' ')
      return logged(await mail.send({ from: mail.from, to, subject, text, html }))
    },
  },

  webhook: {
    // A new webhook gets a secret of its own, for its receiver to check its requests with
    prepare: (settings) =>
      settings.secret ? settings : { ...settings, secret: `whsec_${randomBytes(24).toString('base64')}` },

    check: (settings) => [
      ...(isSecret(settings.secret) ? [] : ['The signing secret must be whsec_ and then 24 to 64 bytes in base64.']),
      ...(settings.headers ?? []).flatMap(({ name, value }: { name: string; value: string }) => [
        ...(isHeaderName(name) ? [] : [`"${name}" can't be a header's name.`]),
        ...(isHeaderValue(value) ? [] : [`The ${name} header's value has a character a header can't hold.`]),
      ]),
    ],

    // Posts the event, signed the Standard Webhooks way: the event's ID, which retries keep, so a receiver can drop the
    // ones it already has, a timestamp, and an HMAC of both with the body
    run: async (settings, event, { reaches }) => {
      const body = JSON.stringify({ id: event.id, event: event.name, createdAt: event.created_at, data: event.data })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = createHmac('sha256', Buffer.from(settings.secret.slice('whsec_'.length), 'base64'))
        .update(`${event.id}.${timestamp}.${body}`)
        .digest('base64')
      const custom = (settings.headers ?? []).map(({ name, value }: { name: string; value: string }) => [
        name.toLowerCase(),
        value,
      ])
      const headers = {
        'user-agent': 'iight',
        ...Object.fromEntries(custom),
        'content-type': 'application/json',
        'webhook-id': event.id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      }

      const { status, text } = await post(new URL(settings.url), headers, body, settings.timeout, reaches)
      const response = text ? `${status}\n${text}` : String(status)
      if (status < 200 || status >= 300) throw new ActionFailed(`The webhook replied ${status}.`, response)
      return response
    },
  },
}

// Loopback, private, link-local (cloud metadata services among them), shared, reserved and multicast addresses
const internal = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  internal.addSubnet(network, prefix, 'ipv4')
}
// The unspecified address and loopback, IPv4 inside IPv6, unique local, link-local and multicast
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  internal.addSubnet(network, prefix, 'ipv6')
}

const family = (address: string) => (isIP(address) === 4 ? 'ipv4' : 'ipv6')

// Whether a webhook may connect to an address: any public one, and the internal ones in webhooks.allowNetworks, such
// as 10.0.0.0/8 or 127.0.0.1
export function webhookNetworks(allowNetworks: Array<string> = []) {
  const allowed = new BlockList()
  for (const network of allowNetworks) {
    const [address, prefix, ...rest] = network.split('/')
    const version = isIP(address)
    const valid = version && !rest.length && (prefix === undefined || /^\d{1,3}$/.test(prefix))
    if (!valid || Number(prefix ?? 0) > (version === 4 ? 32 : 128)) {
      throw new Error(
        `webhooks.allowNetworks in iight.config.ts has ${network}, which isn't an address or a network such as 10.0.0.0/8.`,
      )
    }
    if (prefix === undefined) allowed.addAddress(address, family(address))
    else allowed.addSubnet(address, Number(prefix), family(address))
  }
  return (address: string) => allowed.check(address, family(address)) || !internal.check(address, family(address))
}

// Posts to a URL whose address the webhook may reach, reading up to 2000 characters of the reply. It connects to the
// address it checked, so the name can't resolve somewhere else in between, and follows no redirects.
async function post(
  url: URL,
  headers: Record<string, string>,
  body: string,
  seconds: number,
  reaches: (address: string) => boolean,
) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionFailed('A webhook URL starts with http:// or https://.')
  }

  const signal = AbortSignal.timeout(seconds * 1000)
  const timedOut = () => new ActionFailed(`No reply within ${seconds} second${seconds === 1 ? '' : 's'}.`)
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const address = isIP(host)
    ? host
    : await Promise.race([
        lookup(host).then((found) => found.address),
        once(signal, 'abort').then(() => Promise.reject(timedOut())),
      ])
  if (!reaches(address)) {
    const where = address === host ? address : `${host}, at ${address},`
    throw new ActionFailed(
      `${where} is on a network webhooks can't reach, unless webhooks.allowNetworks in iight.config.ts allows it.`,
    )
  }

  const secure = url.protocol === 'https:'
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = (secure ? https : http).request(
      {
        host: address,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // The certificate is checked against the URL's name
        servername: secure && !isIP(host) ? host : undefined,
        headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)) },
        signal,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text = (text + chunk).slice(0, 2000)))
        response.on('end', () => resolve({ status: response.statusCode!, text }))
        response.on('error', (error) => reject(signal.aborted ? timedOut() : error))
      },
    )
    request.on('error', (error) => reject(signal.aborted ? timedOut() : error))
    request.end(body)
  })
}
