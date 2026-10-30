import type { MailMessage } from '../src'
import { webhookNetworks } from '../src/actions'
import { createApp } from '../src/app'
import { createWorker } from '../src/automations'
import { baseInputSchemaFields, flattenValidationReport } from '../src/core'
import { automationSchema } from '../src/schemas'
import { db } from './database'
import { contactFields, setUp, types } from './fixtures'
import { FSDriver } from 'flydrive/drivers/fs'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingHttpHeaders, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

const root = await mkdtemp(join(tmpdir(), 'iight-automations-'))
const disk = (location: string) => ({
  default: 'local',
  services: { local: () => new FSDriver({ location, visibility: 'public' }) },
})
const app = createApp(db, types, { storage: disk(join(root, 'storage')) })
// A disk whose folder is a file, so every upload to it fails after its row is written
const broken = createApp(db, types, { storage: disk(join(root, 'file')) })

// Emails go to this list, through the test's own send
const sent: Array<MailMessage> = []
const mail = {
  from: 'iight <cms@example.com>',
  send: async (message: MailMessage) => ({ messageId: `<${sent.push(message)}@example.com>` }),
}
const options = { mail, webhooks: { allowNetworks: ['127.0.0.1'] } }
const worker = createWorker(db, types, options)
// Another process's worker, on the same database
const other = createWorker(db, types, options)

// A webhook receiver on this machine. It replies with the statuses queued for it, then 200s, once held is done.
const received: Array<{ headers: IncomingHttpHeaders; body: string }> = []
let statuses: Array<number> = []
let held: Promise<void> | undefined
let reply = 'Thanks'
const receiver = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  received.push({ headers: request.headers, body })
  await held
  response.writeHead(statuses.shift() ?? 200, { 'content-type': 'text/plain' }).end(reply)
})
let hookUrl: string

let cookie: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  await writeFile(join(root, 'file'), '')
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`
})
beforeEach(async () => {
  for (const table of ['automations', 'events', 'forms', 'entries', 'media'] as const) {
    await db.deleteFrom(table).execute()
  }
  sent.length = 0
  received.length = 0
  statuses = []
  held = undefined
  reply = 'Thanks'
  await admin('POST', '/forms', { label: 'Contact us', name: 'contact_us', fields: contactFields })
})
afterAll(async () => {
  receiver.close()
  await db.destroy()
  await rm(root, { recursive: true, force: true })
})

// The admin API, with the session cookie and the Origin header browsers send
const admin = async (method: string, path: string, body?: unknown, to = app) => {
  const response = await to.request(`/api${path}`, {
    method,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

const valid = { name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' } }

// A visitor's submission to the contact form, each from an address of its own so none is rate limited
let visitors = 0
const submit = (values: object) =>
  app.request(
    '/v1/forms/contact_us',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) },
    { incoming: { socket: { remoteAddress: `203.0.113.${++visitors}` } } },
  )

const email = { _layout: 'email', to: 'ada@example.com, sales@example.com' }
const webhook = (settings: object = {}) => ({ _layout: 'webhook', url: hookUrl, timeout: 5, ...settings })

const createAutomation = async (body: object) => {
  const { status, body: reply } = await admin('POST', '/automations', {
    name: 'Notify',
    triggers: ['submission.created'],
    ...body,
  })
  expect(status).toBe(201)
  return reply.data
}

const events = () => db.selectFrom('events').selectAll().orderBy('created_at').execute()
const runs = () => db.selectFrom('automation_runs').selectAll().orderBy('created_at').orderBy('attempt').execute()

// Dispatch the events, then run every action that's due
const drain = async (from = worker) => {
  await from.dispatch()
  while (await from.deliver());
}

// Bring every pending try forward, as if its wait were over
const skipWaits = () =>
  db
    .updateTable('automation_runs')
    .set({ run_at: new Date(Date.now() - 1000) })
    .where('status', '=', 'pending')
    .execute()

const until = async (done: () => boolean) => {
  for (let tries = 0; !done(); tries++) {
    if (tries > 200) throw new Error('Gave up waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('each change to an entry writes its event, with the entry as it became', async () => {
  const { id } = (await admin('POST', '/types/blog/entries', { values: { title: 'Hello', slug: 'hello' } })).body.data
  await admin('PUT', `/entries/${id}`, { values: { title: 'Hello again', slug: 'hello' } })
  await admin('POST', `/entries/${id}/archive`)
  await admin('POST', `/entries/${id}/restore`)
  await admin('POST', `/entries/${id}/archive`)
  expect((await admin('DELETE', `/entries/${id}`)).status).toBe(204)

  const written = await events()
  expect(written.map((event) => event.name)).toEqual([
    'entry.created',
    'entry.updated',
    'entry.archived',
    'entry.restored',
    'entry.archived',
    'entry.deleted',
  ])
  expect(written.every((event) => event.data.entry.id === id && event.dispatched_at === null)).toBe(true)
  expect(written[1].data.entry).toMatchObject({ type: 'blog', slug: 'hello', values: { title: 'Hello again' } })
  expect(written[2].data.entry.archivedAt).toEqual(expect.any(String))
  expect(written[3].data.entry.archivedAt).toBeNull()

  // A page's changes reach the pages under it: a new slug changes their uris, and archiving takes them along
  const page = (await admin('POST', '/types/docs/entries', { values: { title: 'Install', slug: 'install' } })).body.data
  const child = (
    await admin('POST', '/types/docs/entries', { values: { title: 'Linux', slug: 'linux' }, parentId: page.id })
  ).body.data
  await db.deleteFrom('events').execute()
  await admin('PUT', `/entries/${page.id}`, { values: { title: 'Setup', slug: 'setup' } })
  await admin('POST', `/entries/${page.id}/archive`)
  expect((await events()).map((event) => [event.name, event.data.entry.uri])).toEqual(
    expect.arrayContaining([
      ['entry.updated', 'setup'],
      ['entry.updated', 'setup/linux'],
      ['entry.archived', 'setup'],
      ['entry.archived', 'setup/linux'],
    ]),
  )
  expect(await events()).toHaveLength(4)
  expect((await events()).filter((event) => event.data.entry.id === child.id)).toHaveLength(2)
})

test('publishing writes entry.published, and taking entries off the live site writes entry.unpublished for each', async () => {
  // The names of the events written since the last call, in any order, since a change's events share a time
  const written = async () => {
    const names = (await events()).map((event) => event.name).sort()
    await db.deleteFrom('events').execute()
    return names
  }

  const created = await admin('POST', '/types/blog/entries', { values: { title: 'Hi', slug: 'hi' }, publish: true })
  const { id } = created.body.data
  expect(await written()).toEqual(['entry.created', 'entry.published'])
  await admin('PUT', `/entries/${id}`, { values: { title: 'Hello', slug: 'hi' } })
  expect(await written()).toEqual(['entry.updated'])
  await admin('POST', `/entries/${id}/unpublish`)
  const [unpublished] = await events()
  expect(unpublished.data.entry).toMatchObject({ id, status: 'draft', publishedAt: null })
  expect(await written()).toEqual(['entry.unpublished'])
  await admin('PUT', `/entries/${id}`, { values: { title: 'Hello', slug: 'hi' }, publish: true })
  const published = (await events()).find((event) => event.name === 'entry.published')
  expect(published?.data.entry).toMatchObject({ id, status: 'published', publishedAt: expect.any(String) })
  expect(await written()).toEqual(['entry.published', 'entry.updated'])
  await admin('POST', `/entries/${id}/archive`)
  expect(await written()).toEqual(['entry.archived', 'entry.unpublished'])

  // A live page's changes reach the live pages under it
  const body = { values: { title: 'Install', slug: 'install' }, publish: true }
  const page = (await admin('POST', '/types/docs/entries', body)).body.data
  const child = { values: { title: 'Linux', slug: 'linux' }, parentId: page.id, publish: true }
  await admin('POST', '/types/docs/entries', child)
  await written()
  await admin('PUT', `/entries/${page.id}`, { values: { title: 'Setup', slug: 'setup' }, publish: true })
  const uris = (await events()).filter((event) => event.name === 'entry.published').map((event) => event.data.entry.uri)
  expect(uris.sort()).toEqual(['setup', 'setup/linux'])
  expect(await written()).toEqual(['entry.published', 'entry.published', 'entry.updated', 'entry.updated'])
  await admin('POST', `/entries/${page.id}/unpublish`)
  expect(await written()).toEqual(['entry.unpublished', 'entry.unpublished'])

  // Both can trigger automations, whose runs from one dispatch can go in any order
  await createAutomation({ triggers: ['entry.published', 'entry.unpublished'], actions: [email] })
  await admin('PUT', `/entries/${page.id}`, { values: { title: 'Setup', slug: 'setup' }, publish: true })
  await admin('POST', `/entries/${page.id}/unpublish`)
  await drain()
  expect(sent.map((message) => message.subject).sort()).toEqual(['Docs published: Setup', 'Docs unpublished: Setup'])
})

test('uploads, changes to files and submissions write events too, spam included', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
  const body = new FormData()
  body.append('file', new File([bytes as BlobPart], 'dot.png'))
  const uploaded = await app.request('/api/media', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost' },
    body,
  })
  const { id } = (await uploaded.json()).data
  await admin('PUT', `/media/${id}`, { name: 'Dot', alt: 'A white dot' })
  await admin('DELETE', `/media/${id}`)

  expect((await submit(valid)).status).toBe(201)
  expect((await submit({ ...valid, _website: 'https://spam.example' })).status).toBe(201)

  const written = await events()
  expect(written.map((event) => event.name)).toEqual([
    'media.created',
    'media.updated',
    'media.deleted',
    'submission.created',
    'submission.created',
  ])
  expect(written[1].data.media).toMatchObject({ id, name: 'Dot.png', alt: 'A white dot', mime: 'image/png' })
  expect(written[1].data.media.url).toMatch(/^http:\/\/localhost\/media\//)
  expect(written[3].data).toMatchObject({
    form: { name: 'contact_us', label: 'Contact us' },
    submission: { version: 1, values: { name: 'Ada', email: 'ada@example.com' }, spam: false },
  })
  expect(written[4].data.submission.spam).toBe(true)
})

test('an event is written only when its change commits', async () => {
  // The upload's row is written, then storing the file fails, which rolls back the row and its event
  const body = new FormData()
  body.append(
    'file',
    new File(
      [
        await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
          .png()
          .toBuffer(),
      ],
      'a.png',
    ),
  )
  const response = await broken.request('/api/media', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost' },
    body,
  })
  expect(response.status).toBe(500)
  expect(await db.selectFrom('media').selectAll().execute()).toEqual([])

  // A submission that doesn't pass changes nothing
  expect((await submit({ name: 'Ada' })).status).toBe(422)
  expect(await events()).toEqual([])
})

test('the worker hands each event to the automations it triggers, and runs their actions in order', async () => {
  const automation = await createAutomation({ actions: [email, webhook()] })
  await createAutomation({ name: 'On new entries', triggers: ['entry.created'], actions: [email] })
  await submit(valid)

  expect(await worker.dispatch()).toBe(1)
  expect(await worker.dispatch()).toBe(0)
  expect((await events())[0].dispatched_at).toEqual(expect.any(Date))
  expect(await runs()).toMatchObject([{ automation_id: automation.id, action: 0, attempt: 1, status: 'pending' }])

  // The email goes first, and only then is the webhook queued
  expect(await worker.deliver()).toBe(true)
  expect(sent).toHaveLength(1)
  expect(received).toHaveLength(0)
  expect(await worker.deliver()).toBe(true)
  expect(received).toHaveLength(1)
  expect(await worker.deliver()).toBe(false)
  expect(await runs()).toMatchObject([
    { action: 0, attempt: 1, status: 'succeeded' },
    { action: 1, attempt: 1, status: 'succeeded', response: '200\nThanks', error: null },
  ])
})

test("a second worker can't take an event or a run that another has", async () => {
  await createAutomation({ actions: [webhook()] })
  await submit(valid)

  // A worker partway through dispatching holds its events' locks
  let locked!: () => void
  let release!: () => void
  const isLocked = new Promise<void>((resolve) => (locked = resolve))
  const dispatching = db.transaction().execute(async (trx) => {
    await trx.selectFrom('events').select('id').forUpdate().execute()
    locked()
    await new Promise<void>((resolve) => (release = resolve))
  })
  await isLocked
  expect(await other.dispatch()).toBe(0)
  release()
  await dispatching
  expect(await worker.dispatch()).toBe(1)
  expect(await other.dispatch()).toBe(0)

  // While one worker waits for the webhook's reply, the other finds nothing to do
  let reply!: () => void
  held = new Promise((resolve) => (reply = resolve))
  const delivering = worker.deliver()
  await until(() => received.length === 1)
  expect(await other.deliver()).toBe(false)
  reply()
  expect(await delivering).toBe(true)
  expect(received).toHaveLength(1)
  expect(await runs()).toMatchObject([{ status: 'succeeded', attempt: 1 }])
})

test('conditions on the event data decide which automations run', async () => {
  const contact = await createAutomation({
    name: 'Contact us',
    conditions: [
      {
        rules: [
          { field: 'form.name', operator: 'equals', value: 'contact_us' },
          { field: 'submission.spam', operator: 'equals', value: 'false' },
        ],
      },
    ],
    actions: [email],
  })
  const elsewhere = await createAutomation({
    name: 'Another form',
    conditions: [{ rules: [{ field: 'form.name', operator: 'equals', value: 'newsletter' }] }],
    actions: [email],
  })
  const every = await createAutomation({ name: 'Every submission', actions: [email] })
  await submit(valid)
  await submit({ ...valid, _website: 'https://spam.example' })
  await worker.dispatch()

  const queued = await runs()
  const count = (automation: { id: string }) => queued.filter((run) => run.automation_id === automation.id).length
  expect([count(contact), count(elsewhere), count(every)]).toEqual([1, 0, 2])

  // The form's page lists the automations its submissions can run, leaving out the ones for other forms
  const form = (await admin('GET', '/forms')).body.data[0]
  const listed = (await admin('GET', `/automations?form=${form.id}`)).body.data
  expect(listed.map((automation: { name: string }) => automation.name)).toEqual(['Contact us', 'Every submission'])
  expect((await admin('GET', '/automations?form=nope')).status).toBe(404)
})

test("rules test the fields of the site's types and forms, as the editor lists them", async () => {
  const form = (await admin('GET', '/forms')).body.data[0]
  // The rules Email new submissions starts with, and one on each kind of value
  const rules = [
    { field: 'form.id', operator: 'equals', value: form.id },
    { field: 'submission.spam', operator: 'equals', value: 'false' },
    { field: 'submission.values.topics', operator: 'contains', value: 'sales' },
    { field: 'entry.type', operator: 'equals', value: 'blog' },
    { field: 'entry.values.views', operator: 'greaterThan', value: '100' },
    { field: 'entry.values.published_at', operator: 'lessThan', value: '2026-10-30' },
    { field: 'media.mime', operator: 'startsWith', value: 'image/' },
  ]
  await createAutomation({ name: 'Every kind of rule', conditions: [{ rules }], actions: [email] })

  const refused = await admin('POST', '/automations', {
    name: 'Wrong rules',
    triggers: ['entry.created'],
    actions: [email],
    conditions: [
      {
        rules: [
          { field: 'entry.values.nope', operator: 'equals', value: 'x' },
          { field: 'entry.values.featured', operator: 'contains', value: 'yes' },
          { field: 'entry.type', operator: 'equals', value: 'gone' },
        ],
      },
    ],
  })
  expect(refused.status).toBe(422)
  expect(flattenValidationReport(refused.body).messages).toEqual({
    'conditions.0.rules.0.field': ['A valid choice required.'],
    'conditions.0.rules.1.operator': ['A valid choice required.'],
    'conditions.0.rules.1.value': ['A valid choice required.'],
    'conditions.0.rules.2.value': ['A valid choice required.'],
  })
})

test('lists a path once when several types share it, with each type it belongs to', () => {
  const conditions = automationSchema(baseInputSchemaFields(), types.values(), []).find(
    (field) => field.name === 'conditions',
  )!
  const titles = conditions.options!.fieldChoices.filter((choice: any) => choice.value === 'entry.values.title')
  expect(titles).toEqual([{ value: 'entry.values.title', label: 'Blog posts, Docs › Title', type: 'text' }])
})

test("emails go out through the site's own send, with the submission's fields", async () => {
  await createAutomation({ name: 'Contact us notifications', actions: [email] })
  await submit({ ...valid, topics: ['support', 'sales'], subscribe: true })
  await drain()

  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    from: 'iight <cms@example.com>',
    to: ['ada@example.com', 'sales@example.com'],
    subject: 'New submission: Contact us',
  })
  expect(sent[0].text).toContain('Name: Ada\nEmail: ada@example.com\nTopics: Support, Sales\nSubscribe: Yes\n')
  expect(sent[0].text).toContain('Sent by the automation Contact us notifications.')
  expect(sent[0].html).toContain('<th align="left" valign="top">Address</th>')
  expect(await runs()).toMatchObject([{ status: 'succeeded', response: '{"messageId":"<1@example.com>"}' }])

  // The subject can be set, and without mail settings the email fails, to be tried again
  await db.deleteFrom('automations').execute()
  await createAutomation({ actions: [{ ...email, subject: 'A new lead <3' }] })
  await submit(valid)
  await drain()
  expect(sent[1].subject).toBe('A new lead <3')
  expect(sent[1].html).toContain('Ada')

  await submit(valid)
  await drain(createWorker(db, types))
  expect((await runs()).slice(-2)).toMatchObject([
    { status: 'failed', attempt: 1, error: 'Set mail in iight.config.ts to send email.' },
    { status: 'pending', attempt: 2 },
  ])
})

test('webhooks are signed the Standard Webhooks way, with their own headers', async () => {
  const automation = await createAutomation({
    actions: [webhook({ headers: [{ name: 'Authorization', value: 'Bearer abc' }] })],
  })
  const { secret } = automation.actions[0]
  expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/)
  await submit(valid)
  await drain()

  const [{ headers, body }] = received
  const [event] = await events()
  expect(headers).toMatchObject({
    'content-type': 'application/json',
    'user-agent': 'iight',
    authorization: 'Bearer abc',
    'webhook-id': event.id,
  })
  expect(Math.abs(Number(headers['webhook-timestamp']) - Date.now() / 1000)).toBeLessThan(10)
  const signature = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
    .digest('base64')
  expect(headers['webhook-signature']).toBe(`v1,${signature}`)
  expect(JSON.parse(body)).toEqual({
    id: event.id,
    event: 'submission.created',
    createdAt: event.created_at.toISOString(),
    data: event.data,
  })

  // Saving again keeps the secret, and a secret of the wrong shape is turned away
  const saved = await admin('PUT', `/automations/${automation.id}`, { ...automation, name: 'Renamed' })
  expect(saved.body.data.actions[0].secret).toBe(secret)
  const wrong = await admin('PUT', `/automations/${automation.id}`, {
    ...automation,
    actions: [webhook({ secret: 'hunter2', headers: [{ name: 'Bad name', value: 'x' }] })],
  })
  expect(wrong.status).toBe(422)
  expect(wrong.body.fields.actions.messages).toEqual([
    'Action 1: The signing secret must be whsec_ and then 24 to 64 bytes in base64.',
    `Action 1: "Bad name" can't be a header's name.`,
  ])
})

test('a failing webhook is tried again later, and every try is logged', async () => {
  const automation = await createAutomation({ actions: [webhook()] })
  statuses = [500, 503]
  await submit(valid)
  await drain()

  // The first try failed, and the next waits a minute
  const [first, second] = await runs()
  expect(first).toMatchObject({
    attempt: 1,
    status: 'failed',
    response: '500\nThanks',
    error: 'The webhook replied 500.',
  })
  expect(second).toMatchObject({ attempt: 2, status: 'pending' })
  const wait = second.run_at.getTime() - first.finished_at!.getTime()
  expect(wait).toBeGreaterThan(59_000)
  expect(wait).toBeLessThan(61_000)
  expect(await worker.deliver()).toBe(false)

  await skipWaits()
  await drain()
  await skipWaits()
  await drain()
  expect(received).toHaveLength(3)
  expect(new Set(received.map(({ headers }) => headers['webhook-id'])).size).toBe(1)
  expect((await runs()).map((run) => [run.attempt, run.status])).toEqual([
    [1, 'failed'],
    [2, 'failed'],
    [3, 'succeeded'],
  ])

  // The runs page shows every try, newest first, with its event
  const page = await admin('GET', `/automations/${automation.id}/runs?order=${encodeURIComponent('{"id":"desc"}')}`)
  expect(page.body.pagination).toMatchObject({ total: 3 })
  expect(page.body.data[0]).toMatchObject({ attempt: 3, status: 'succeeded', event: { name: 'submission.created' } })
  expect(page.body.data[2]).toMatchObject({ attempt: 1, status: 'failed', response: '500\nThanks' })

  // Once its tries run out, an action is given up
  const twice = createWorker(db, types, { ...options, automations: { attempts: 2 } })
  statuses = [500, 500]
  await submit(valid)
  await drain(twice)
  await skipWaits()
  await drain(twice)
  expect((await runs()).slice(3).map((run) => [run.attempt, run.status])).toEqual([
    [1, 'failed'],
    [2, 'failed'],
  ])
})

test("webhooks can't reach private networks unless iight.config.ts allows them, nor wait forever", async () => {
  await createAutomation({ actions: [webhook()] })
  await submit(valid)
  await drain(createWorker(db, types, { mail }))
  expect(received).toEqual([])
  expect((await runs())[0].error).toBe(
    "127.0.0.1 is on a network webhooks can't reach, unless webhooks.allowNetworks in iight.config.ts allows it.",
  )

  // Names are checked by the address they resolve to
  await db.deleteFrom('automations').execute()
  await createAutomation({ actions: [webhook({ url: hookUrl.replace('127.0.0.1', 'localhost') })] })
  await submit(valid)
  await drain(createWorker(db, types, { mail }))
  expect((await runs()).at(-2)?.error).toMatch(
    /^localhost, at (127\.0\.0\.1|::1), is on a network webhooks can't reach/,
  )

  // A receiver that never replies
  await db.deleteFrom('automations').execute()
  await createAutomation({ actions: [webhook({ timeout: 1 })] })
  held = new Promise(() => {})
  await submit(valid)
  await drain()
  expect((await runs()).at(-2)?.error).toBe('No reply within 1 second.')

  expect(() => createWorker(db, types, { webhooks: { allowNetworks: ['10.0.0.0/33'] } })).toThrow(
    "webhooks.allowNetworks in iight.config.ts has 10.0.0.0/33, which isn't an address or a network such as 10.0.0.0/8.",
  )
  expect(() => createWorker(db, types, { automations: { attempts: 0 } })).toThrow(
    'automations.attempts in iight.config.ts needs a whole number from 1.',
  )
})

test('webhooks reach public addresses, and no way of writing an internal one', () => {
  const reaches = webhookNetworks()
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(reaches(address), address).toBe(true)
  for (const address of [
    ...['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.100.100.200', '::1', 'fd00:ec2::254', 'fe80::1'],
    // IPv4 inside IPv6, and NAT64's prefixes, which a site's own NAT64 translates to its internal IPv4 addresses
    ...['::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::a00:1'],
  ]) {
    expect(reaches(address), address).toBe(false)
  }

  // IPv4 addresses are checked as IPv6 ones too, so an IPv6 network as wide as ::ffff:0:0/96 would let them all in
  expect(webhookNetworks(['::ffff:10.0.0.0/104'])('10.0.0.1')).toBe(true)
  expect(() => webhookNetworks(['::ffff:10.0.0.0/8'])).toThrow(
    'webhooks.allowNetworks in iight.config.ts has ::ffff:10.0.0.0/8, which holds every IPv4 address. Write IPv4 networks as such, as in 10.0.0.0/8.',
  )
})

test('a reply with a NUL in it is logged, rather than failing the log and holding up every other run', async () => {
  await createAutomation({ actions: [webhook()] })
  reply = 'Tha\0nks'
  await submit(valid)
  await drain()
  expect(await runs()).toMatchObject([{ attempt: 1, status: 'succeeded', response: '200\nThanks' }])
})

test('automations are checked, saved, listed and deleted through the admin API', async () => {
  const invalid = await admin('POST', '/automations', {
    name: '',
    triggers: ['entry.exploded'],
    actions: [{ _layout: 'email', to: 'not an address' }],
  })
  expect(invalid.status).toBe(422)
  expect(invalid.body.fields.name.isValid).toBe(false)
  expect(invalid.body.fields.triggers.isValid).toBe(false)
  expect(invalid.body.fields.actions.isValid).toBe(false)
  expect((await admin('POST', '/automations', { name: 'No actions', triggers: ['entry.created'] })).status).toBe(422)

  const created = await createAutomation({
    name: 'Rebuild the site',
    triggers: ['entry.created', 'entry.updated'],
    actions: [webhook()],
  })
  expect(created).toMatchObject({ triggers: ['entry.created', 'entry.updated'], conditions: [] })
  expect((await admin('GET', `/automations/${created.id}`)).body.data.name).toBe('Rebuild the site')
  expect((await admin('GET', '/automations')).body.data).toHaveLength(1)

  expect((await admin('DELETE', `/automations/${created.id}`)).status).toBe(204)
  expect((await admin('GET', `/automations/${created.id}`)).status).toBe(404)

  const signedOut = await app.request('/api/automations')
  expect(signedOut.status).toBe(401)
})
