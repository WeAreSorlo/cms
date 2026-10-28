import { createApp } from '../src/app'
import { createApiKey } from '../src/delivery'
import { db } from './database'
import { contactFields, setUp, types } from './fixtures'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const app = createApp(db, types)
let cookie: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
})
beforeEach(async () => {
  await db.deleteFrom('forms').execute()
})
afterEach(() => {
  vi.useRealTimers()
})
afterAll(() => db.destroy())

// The admin API, with the session cookie and the Origin header browsers send
const admin = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

const createForm = async (fields = contactFields) =>
  (await admin('POST', '/forms', { label: 'Contact us', name: 'contact', fields })).body.data

// A request from a visitor, each from an address of its own unless it says, as the Node server gives them
let visitors = 0
const visit = (path: string, init: RequestInit = {}, ip = `203.0.113.${++visitors}`, to = app) =>
  to.request(path, init, { incoming: { socket: { remoteAddress: ip } } })

const valid = { name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' } }

// A submission sent as JSON, as the SDK sends it
const submit = async (form: string, values: unknown, headers: Record<string, string> = {}, ip?: string, to = app) => {
  const response = await visit(
    `/v1/forms/${form}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(values) },
    ip,
    to,
  )
  return { status: response.status, headers: response.headers, body: await response.json() }
}

// A submission from a plain HTML form on another site, with JavaScript off
const post = async (form: string, fields: Array<[string, string]>, ip?: string, to = app) => {
  const response = await visit(
    `/v1/forms/${form}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        origin: 'https://example.org',
        referer: 'https://example.org/contact',
        'user-agent': 'Mozilla/5.0',
      },
      body: new URLSearchParams(fields).toString(),
    },
    ip,
    to,
  )
  return { status: response.status, headers: response.headers, html: await response.text() }
}

const submissions = () => db.selectFrom('submissions').selectAll().orderBy('id').execute()

test('a form starts at version 1, and gets a new version only when its fields change', async () => {
  const created = await admin('POST', '/forms', { label: 'Contact us', name: 'contact', fields: contactFields })
  expect(created.status).toBe(201)
  expect(created.body.data).toMatchObject({ name: 'contact', label: 'Contact us', version: 1, fields: contactFields })
  const { id } = created.body.data

  const renamed = await admin('PUT', `/forms/${id}`, { label: 'Get in touch', name: 'contact', fields: contactFields })
  expect(renamed.body.data).toMatchObject({ label: 'Get in touch', version: 1 })

  const fewer = contactFields.slice(0, 3)
  const changed = await admin('PUT', `/forms/${id}`, { label: 'Get in touch', name: 'contact', fields: fewer })
  expect(changed.body.data).toMatchObject({ version: 2, fields: fewer })

  expect((await admin('GET', `/forms/${id}/versions/1`)).body.data).toMatchObject({ number: 1, fields: contactFields })
  expect((await admin('GET', `/forms/${id}/versions/2`)).body.data).toMatchObject({ number: 2, fields: fewer })
  expect((await admin('GET', `/forms/${id}/versions/3`)).status).toBe(404)
  expect((await admin('GET', '/forms')).body.data).toMatchObject([{ id, version: 2 }])
  expect((await admin('GET', `/forms/${id}`)).body.data).toMatchObject({ id, name: 'contact' })
})

test("checks a form's settings and fields, which take core's inputs", async () => {
  await createForm()
  const save = (body: object) => admin('POST', '/forms', { label: 'Survey', name: 'survey', fields: [], ...body })

  const invalid = await save({ label: '', name: 'contact' })
  expect(invalid.status).toBe(422)
  expect(invalid.body.fields.label).toEqual({ isValid: false, messages: ['This field is required.'] })

  const taken = await save({ name: 'contact' })
  expect(taken.body.fields.name).toEqual({ isValid: false, messages: ['Another form has this name.'] })

  const fields = [
    { id: 'fld_a', type: 'relationship', name: 'author' },
    { type: 'text', name: 'nameless' },
    { id: 'fld_c', type: 'text', name: 'bad name' },
  ]
  expect((await save({ fields })).body.fields.fields.messages).toEqual([
    'Field "author" has an unknown type, relationship.',
    'Field "nameless" needs an "id", such as fld_k3x9q2mz.',
    'Field "bad name" needs a name made of a letter, then letters, digits or underscores.',
  ])
  expect((await save({ fields: 'nope' })).body.fields.fields.messages).toEqual(['"fields" must be a list.'])
})

test('the admin routes need a session', async () => {
  const { id } = await createForm()
  for (const [method, path] of [
    ['GET', '/api/forms'],
    ['GET', `/api/forms/${id}/submissions`],
    ['POST', `/api/submissions/${id}/archive`],
  ]) {
    const response = await app.request(path, { method, headers: { origin: 'http://localhost' } })
    expect(response.status).toBe(401)
  }
})

test("anyone can get a form's fields, by its ID or its name, from any site", async () => {
  const { id } = await createForm()
  const form = { id, name: 'contact', label: 'Contact us', version: 1, fields: contactFields }

  const byId = await visit(`/v1/forms/${id}`, { headers: { origin: 'https://example.org' } })
  expect(await byId.json()).toEqual({ data: form })
  expect(byId.headers.get('access-control-allow-origin')).toBe('*')
  expect(await (await visit('/v1/forms/contact')).json()).toEqual({ data: form })

  const missing = await visit('/v1/forms/nope')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ message: 'Not Found' })

  // A browser asks before it sends JSON from another site
  const preflight = await visit('/v1/forms/contact', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://example.org',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type')
})

test('iight.config.ts can name the sites whose JavaScript can use forms', async () => {
  await createForm()
  const listed = createApp(db, types, { forms: { origins: ['https://example.com'] } })
  const from = async (origin: string) =>
    (await visit('/v1/forms/contact', { headers: { origin } }, undefined, listed)).headers.get(
      'access-control-allow-origin',
    )

  expect(await from('https://example.com')).toBe('https://example.com')
  expect(await from('https://example.org')).toBeNull()
})

test('takes JSON, storing the values with the version they were checked against and who sent them', async () => {
  const { id } = await createForm()
  const response = await submit(
    'contact',
    { ...valid, topics: ['sales'], size: 3, source: 'elsewhere', intro: 'dropped', extra: 'dropped' },
    { 'user-agent': 'Mozilla/5.0', referer: 'https://example.org/contact' },
    '198.51.100.7',
  )

  // A hidden field's value is the form's, whatever is sent, and a box that isn't ticked is false
  const values = { ...valid, topics: ['sales'], size: 3, subscribe: false, source: 'website' }
  expect(response.status).toBe(201)
  expect(response.body).toEqual({ data: { id: expect.any(String), version: 1, values, createdAt: expect.any(String) } })
  expect(await submissions()).toMatchObject([
    {
      id: response.body.data.id,
      form_id: id,
      form_version: 1,
      values,
      ip: '198.51.100.7',
      user_agent: 'Mozilla/5.0',
      referer: 'https://example.org/contact',
      spam: false,
      archived_at: null,
    },
  ])
})

test("replies core's report to JSON that doesn't pass, and stores nothing", async () => {
  await createForm()
  const response = await submit('contact', { name: 'Ada', email: 'nope', size: 0 })

  expect(response.status).toBe(422)
  expect(response.body.isValid).toBe(false)
  expect(response.body.fields.email).toEqual({ isValid: false, messages: ['A valid email address required.'] })
  expect(response.body.fields.size.messages).toEqual(['This field requires a minimum value of 1.'])
  expect(response.body.fields.address.isValid).toBe(false)
  expect(await submissions()).toEqual([])

  expect((await submit('nope', valid)).status).toBe(404)
})

test('takes a plain HTML form post from another site, replying with a page', async () => {
  await createForm()
  const { status, headers, html } = await post('contact', [
    ['name', 'Ada'],
    ['email', 'ada@example.com'],
    ['topics', 'support'],
    ['size', '3'],
    ['subscribe', 'on'],
    ['address.town', 'Leeds'],
    ['_website', ''],
  ])

  expect(status).toBe(201)
  expect(headers.get('content-type')).toMatch(/^text\/html/)
  expect(html).toContain('<h1>Thank you</h1>')
  expect(html).toContain('<a href="https://example.org/contact">Go back</a>')

  // One ticked box is still a list, and the text a browser posts takes each field's type
  const [row] = await submissions()
  expect(row.values).toEqual({
    name: 'Ada',
    email: 'ada@example.com',
    topics: ['support'],
    size: 3,
    subscribe: true,
    address: { town: 'Leeds' },
    source: 'website',
  })
  expect(row).toMatchObject({ user_agent: 'Mozilla/5.0', referer: 'https://example.org/contact', spam: false })
})

test("replies a page listing the problems to a plain post that doesn't pass", async () => {
  await createForm()
  const { status, html } = await post('contact', [
    ['name', '<b>Ada</b>'],
    ['email', 'nope'],
  ])

  expect(status).toBe(422)
  expect(html).toContain('<h1>Your submission has problems</h1>')
  expect(html).toContain('<li>Email: A valid email address required.</li>')
  expect(html).toContain('<li>Town: This field is required.</li>')
  expect(html).not.toContain('<b>')
  expect(await submissions()).toEqual([])

  const missing = await post('nope', [])
  expect(missing.status).toBe(404)
  expect(missing.html).toContain("This form doesn't exist.")
})

test('each submission records the version of the fields it was checked against', async () => {
  const { id } = await createForm()
  await submit('contact', valid)

  // Without the group, version 2 takes a submission that version 1 didn't
  const fields = contactFields.filter((field) => field.name !== 'address')
  await admin('PUT', `/forms/${id}`, { label: 'Contact us', name: 'contact', fields })
  expect((await submit('contact', { name: 'Grace', email: 'grace@example.com' })).body.data.version).toBe(2)

  const inbox = await admin('GET', `/forms/${id}/submissions?order=${encodeURIComponent('{"createdAt":"desc"}')}`)
  expect(inbox.body.data.map((submission: { version: number }) => submission.version)).toEqual([2, 1])
  expect(inbox.body.pagination).toEqual({ page: 1, perPage: 15, total: 2, lastPage: 1 })
})

test('keeps a submission that fills in the honeypot as spam, with the reply anyone gets', async () => {
  const { id } = await createForm()
  const caught = await submit('contact', { ...valid, _website: 'https://spam.example' })
  expect(caught.status).toBe(201)
  expect(Object.keys(caught.body.data)).toEqual(['id', 'version', 'values', 'createdAt'])
  expect(caught.body.data.values).not.toHaveProperty('_website')

  const posted = await post('contact', [
    ['name', 'Bot'],
    ['email', 'bot@example.com'],
    ['address.town', 'Nowhere'],
    ['_website', 'https://spam.example'],
  ])
  expect(posted.html).toContain('<h1>Thank you</h1>')
  await submit('contact', valid)

  const view = async (query = '') =>
    (await admin('GET', `/forms/${id}/submissions${query}`)).body.data.map((row: { spam: boolean }) => row.spam)
  expect(await view()).toEqual([false])
  expect(await view('?spam=true')).toEqual([true, true])

  const back = await admin('POST', `/submissions/${caught.body.data.id}/not-spam`)
  expect(back.body.data).toMatchObject({ id: caught.body.data.id, spam: false })
  expect(await view()).toEqual([false, false])
  expect(await view('?spam=true')).toEqual([true])
})

test('archives and restores submissions', async () => {
  const { id } = await createForm()
  const sent = await submit('contact', valid)
  const ids = async (query = '') =>
    (await admin('GET', `/forms/${id}/submissions${query}`)).body.data.map((row: { id: string }) => row.id)

  const archived = await admin('POST', `/submissions/${sent.body.data.id}/archive`)
  expect(archived.body.data.archivedAt).toEqual(expect.any(String))
  expect(await ids()).toEqual([])
  expect(await ids('?archived=true')).toEqual([sent.body.data.id])

  const restored = await admin('POST', `/submissions/${sent.body.data.id}/restore`)
  expect(restored.body.data).toMatchObject({
    id: sent.body.data.id,
    formId: id,
    version: 1,
    values: { ...valid, source: 'website' },
    spam: false,
    archivedAt: null,
  })
  expect(await ids()).toEqual([sent.body.data.id])
  expect((await admin('POST', '/submissions/nope/archive')).status).toBe(404)
})

test("limits each address's posts, valid or not, except requests that send an API key", async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await createForm()
  const limited = createApp(db, types, { forms: { rateLimit: { posts: 2, minutes: 5 } } })
  const from = (ip: string, headers?: Record<string, string>) => submit('contact', valid, headers, ip, limited)

  expect((await from('198.51.100.1')).status).toBe(201)
  expect((await submit('contact', {}, {}, '198.51.100.1', limited)).status).toBe(422)
  const refused = await from('198.51.100.1')
  expect(refused.status).toBe(429)
  expect(refused.headers.get('retry-after')).toBe('300')
  expect(refused.body).toEqual({ message: 'Too many submissions. Wait a few minutes, then send it again.' })
  expect((await post('contact', [], '198.51.100.1', limited)).html).toContain('<h1>Too many submissions</h1>')

  // Other addresses have their own count, and a site's own server sends its key
  expect((await from('198.51.100.2')).status).toBe(201)
  const key = await createApiKey(db, 'Website')
  expect((await from('198.51.100.1', { authorization: `Bearer ${key}` })).status).toBe(201)
  expect((await from('198.51.100.1', { authorization: 'Bearer nope' })).status).toBe(429)

  vi.advanceTimersByTime(5 * 60 * 1000)
  expect((await from('198.51.100.1')).status).toBe(201)
  expect(() => createApp(db, types, { forms: { rateLimit: { posts: 0 } } })).toThrow('forms.rateLimit')
})

test('takes the address a proxy on a private network forwarded for, and no one else', async () => {
  await createForm()
  const forwarded = { 'x-forwarded-for': '192.0.2.9, 198.51.100.9, 10.0.0.2' }
  await submit('contact', valid, forwarded, '::ffff:10.0.0.1')
  await submit('contact', valid, forwarded, '203.0.113.200')
  expect((await submissions()).map((row) => row.ip)).toEqual(['198.51.100.9', '203.0.113.200'])
})

test('the embed HTML posts every field it shows to the form, by its ID', async () => {
  const { id, embed } = await createForm()
  expect(embed).toContain(`<form method="post" action="http://localhost/v1/forms/${id}">`)
  expect(embed).toContain('<p>We reply within a day.</p>')
  expect(embed).toContain('<input type="email" id="iight-fld_email" name="email" required>')
  expect(embed).toContain('<label><input type="checkbox" name="topics" value="sales"> Sales</label>')
  expect(embed).toContain('<input type="text" id="iight-fld_town" name="address.town" required>')
  expect(embed).toContain('<!-- Guests is left out, as its items need JavaScript -->')
  expect(embed).toContain('<input name="_website" tabindex="-1" autocomplete="off">')

  // What a browser posts when someone fills in every field it shows, ticking one box
  const names = [...embed.matchAll(/ name="([^"]+)"/g)].map(([, name]) => name)
  expect(names).toEqual([
    'name',
    'email',
    'topics',
    'topics',
    'size',
    'subscribe',
    'address.town',
    'source',
    '_website',
  ])
  const filled: Record<string, string> = { email: 'ada@example.com', size: '2', subscribe: 'on', topics: 'sales' }
  const shown = [...new Set(names)].filter((name) => name !== '_website')
  const { status } = await post(
    id,
    shown.map((name) => [name, filled[name] ?? 'Ada']),
  )
  expect(status).toBe(201)
  expect((await submissions())[0].values).toEqual({
    name: 'Ada',
    email: 'ada@example.com',
    topics: ['sales'],
    size: 2,
    subscribe: true,
    address: { town: 'Ada' },
    source: 'website',
  })
})

test('turns away a post too large for a form', async () => {
  await createForm()
  const { status, body } = await submit('contact', { ...valid, name: 'x'.repeat(1024 * 1024) })
  expect(status).toBe(413)
  expect(body).toEqual({ message: 'The submission is too large.' })
})
