import { createApp } from '../src/app'
import { createApiKey } from '../src/delivery'
import { db } from './database'
import { setUp, types } from './fixtures'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

const app = createApp(db, types)
let cookie: string
let userId: string

beforeAll(async () => ({ cookie, userId } = await setUp()))
beforeEach(() => db.deleteFrom('entries').execute())
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown) => {
  // Browsers send an Origin header with every POST, PUT and DELETE, which the CSRF check needs
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

// Create an entry and return it, failing the test if it doesn't save
const create = async (type: string, values: object, parentId?: string) => {
  const { status, body } = await send('POST', `/types/${type}/entries`, { values, parentId })
  expect(status).toBe(201)
  return body.data
}

const page = (title: string, parent?: { id: string }) =>
  create('docs', { title, slug: title.toLowerCase() }, parent?.id)

// Each page's uri and position among its siblings
const uris = async () =>
  (await db.selectFrom('entries').select(['uri', 'position']).orderBy('uri').execute()).map(
    ({ uri, position }) => `${uri} ${position}`,
  )

test('needs a session', async () => {
  for (const path of ['/api/types', '/api/types/blog/entries', '/api/entries/0192f0c4-0000-7000-8000-000000000000']) {
    const response = await app.request(path)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Unauthenticated.' })
  }
})

test('lists the content types', async () => {
  const { body } = await send('GET', '/types')
  expect(body.data.map((type: { name: string }) => type.name)).toEqual(['blog', 'docs', 'home'])
})

test("creates and edits entries with the type's fields, saving a version each time", async () => {
  const invalid = await send('POST', '/types/blog/entries', { values: { slug: 'Not a slug' } })
  expect(invalid.status).toBe(422)
  expect(invalid.body.fields.title).toEqual({ isValid: false, messages: ['This field is required.'] })
  expect(invalid.body.fields.slug.isValid).toBe(false)

  // featured is posted, since core will soon store an unposted boolean as false
  const entry = await create('blog', { title: 'Hello', slug: 'hello', views: 3, featured: true, unknown: 'dropped' })
  expect(entry).toEqual({
    id: expect.any(String),
    type: 'blog',
    slug: 'hello',
    uri: null,
    parentId: null,
    position: null,
    values: { title: 'Hello', slug: 'hello', views: 3, featured: true },
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    archivedAt: null,
    createdBy: userId,
    updatedBy: userId,
  })

  const edited = await send('PUT', `/entries/${entry.id}`, { values: { title: 'Hello again', slug: 'hello-again' } })
  expect(edited.status).toBe(200)
  expect(edited.body.data).toMatchObject({ slug: 'hello-again', values: { title: 'Hello again', slug: 'hello-again' } })
  expect((await send('GET', `/entries/${entry.id}`)).body.data.slug).toBe('hello-again')

  const versions = await send('GET', `/entries/${entry.id}/versions`)
  expect(versions.body.data).toEqual([
    { number: 2, createdBy: userId, createdAt: expect.any(String) },
    { number: 1, createdBy: userId, createdAt: expect.any(String) },
  ])

  // Restoring a version means saving its values again, as a new version
  const first = await send('GET', `/entries/${entry.id}/versions/1`)
  expect(first.body.data.values).toEqual({ title: 'Hello', slug: 'hello', views: 3, featured: true })
  await send('PUT', `/entries/${entry.id}`, { values: first.body.data.values })
  expect((await send('GET', `/entries/${entry.id}`)).body.data.slug).toBe('hello')
  expect((await send('GET', `/entries/${entry.id}/versions`)).body.data.map((v: any) => v.number)).toEqual([3, 2, 1])

  expect((await send('GET', `/entries/${entry.id}/versions/9`)).status).toBe(404)
  expect((await send('GET', '/entries/not-an-id')).status).toBe(404)
  expect((await send('GET', '/types/nope/entries')).status).toBe(404)
})

test('lists entries a page at a time, with the delivery query model', async () => {
  for (const title of ['One', 'Two', 'Three']) await create('blog', { title, slug: title.toLowerCase() })

  const { body } = await send(
    'GET',
    `/types/blog/entries?perPage=2&order=${encodeURIComponent('{"values.title":"asc"}')}`,
  )
  expect(body.data.map((entry: any) => entry.values.title)).toEqual(['One', 'Three'])
  expect(body.pagination).toEqual({ page: 1, perPage: 2, total: 3, lastPage: 2 })

  expect((await send('GET', '/types/blog/entries?where=nope')).status).toBe(400)
})

test('slugs are unique among siblings, archived ones included', async () => {
  const taken = { isValid: false, messages: ['Another entry here already uses this slug.'] }
  const hello = await create('blog', { title: 'Hello', slug: 'hello' })

  const clash = await send('POST', '/types/blog/entries', { values: { title: 'Hello', slug: 'hello' } })
  expect(clash.status).toBe(422)
  expect(clash.body.fields.slug).toEqual(taken)

  // An entry keeps its own slug, and another type can use it
  expect((await send('PUT', `/entries/${hello.id}`, { values: { title: 'Hi', slug: 'hello' } })).status).toBe(200)
  await create('docs', { title: 'Hello', slug: 'hello' })

  await send('POST', `/entries/${hello.id}/archive`)
  const archived = await send('POST', '/types/blog/entries', { values: { title: 'Hello', slug: 'hello' } })
  expect(archived.body.fields.slug.messages).toEqual(['An archived entry here already uses this slug.'])

  // Pages may share a slug under different parents
  const guide = await page('Guide')
  const api = await page('API')
  await page('Install', guide)
  await page('Install', api)
  const moved = await send('POST', '/types/docs/entries', {
    values: { title: 'Install', slug: 'install' },
    parentId: guide.id,
  })
  expect(moved.body.fields.slug).toEqual(taken)

  // Saves that race past the check are stopped by the index, with the same reply
  const racing = await Promise.all(
    [1, 2].map(() => send('POST', '/types/blog/entries', { values: { title: 'Race', slug: 'race' } })),
  )
  expect(racing.map(({ status }) => status).sort()).toEqual([201, 422])
  expect(racing.find(({ status }) => status === 422)?.body.fields.slug).toEqual(taken)
})

test('pages get a uri from their parents, which follows slug changes and moves', async () => {
  const guide = await page('Guide')
  const install = await page('Install', guide)
  await page('Linux', install)
  await page('FAQ')
  expect(await uris()).toEqual(['faq 1', 'guide 0', 'guide/install 0', 'guide/install/linux 0'])

  await send('PUT', `/entries/${guide.id}`, { values: { title: 'Handbook', slug: 'handbook' } })
  expect(await uris()).toEqual(['faq 1', 'handbook 0', 'handbook/install 0', 'handbook/install/linux 0'])

  // Moving goes to the end of the new siblings
  await send('PUT', `/entries/${install.id}`, { values: { title: 'Install', slug: 'install' }, parentId: null })
  expect(await uris()).toEqual(['faq 1', 'handbook 0', 'install 2', 'install/linux 0'])
})

test("a page's parent must be another live page of the type, outside it", async () => {
  const guide = await page('Guide')
  const install = await page('Install', guide)
  const post = await create('blog', { title: 'Post', slug: 'post' })
  const old = await page('Old')
  await send('POST', `/entries/${old.id}/archive`)

  for (const parentId of [guide.id, install.id, post.id, old.id, 'nope']) {
    const response = await send('PUT', `/entries/${guide.id}`, { values: { title: 'Guide', slug: 'guide' }, parentId })
    expect(response).toEqual({
      status: 400,
      body: { message: 'The parent must be another live entry of this type, outside this one.' },
    })
  }
})

test('orders pages among their siblings', async () => {
  const [a, , c] = [await page('A'), await page('B'), await page('C')]

  expect((await send('PUT', `/entries/${c.id}/position`, { position: 0 })).body.data.position).toBe(0)
  const { body } = await send('GET', `/types/docs/entries?order=${encodeURIComponent('{"position":"asc"}')}`)
  expect(body.data.map((entry: any) => entry.slug)).toEqual(['c', 'a', 'b'])

  expect((await send('PUT', `/entries/${a.id}/position`, { position: -1 })).status).toBe(400)
  const post = await create('blog', { title: 'Post', slug: 'post' })
  expect((await send('PUT', `/entries/${post.id}/position`, { position: 0 })).status).toBe(409)
})

test('archives and restores a page with what was archived along with it, and deletes from the archive', async () => {
  const guide = await page('Guide')
  const install = await page('Install', guide)
  const linux = await page('Linux', install)
  const mac = await page('Mac', install)
  const live = async () => (await send('GET', '/types/docs/entries')).body.data.map((entry: any) => entry.slug)
  const archived = async () =>
    (await send('GET', '/types/docs/entries?archived=true')).body.data.map((entry: any) => entry.slug)

  await send('POST', `/entries/${mac.id}/archive`)
  const { body } = await send('POST', `/entries/${install.id}/archive`)
  expect(body.data.archivedAt).toEqual(expect.any(String))
  expect(await live()).toEqual(['guide'])
  expect(await archived()).toEqual(['install', 'linux', 'mac'])

  expect(await send('POST', `/entries/${linux.id}/restore`)).toEqual({
    status: 409,
    body: { message: 'Its parent is archived. Restore the parent first.' },
  })
  expect((await send('PUT', `/entries/${install.id}`, { values: { title: 'Install', slug: 'install' } })).status).toBe(
    409,
  )

  // Mac was archived on its own, so it stays archived
  expect((await send('POST', `/entries/${install.id}/restore`)).body.data.archivedAt).toBeNull()
  expect(await live()).toEqual(['guide', 'install', 'linux'])

  expect((await send('DELETE', `/entries/${guide.id}`)).status).toBe(409)
  await send('POST', `/entries/${guide.id}/archive`)
  expect((await send('DELETE', `/entries/${guide.id}`)).status).toBe(204)
  expect(await db.selectFrom('entries').select('id').execute()).toEqual([])
  expect(await db.selectFrom('entry_versions').select('entry_id').execute()).toEqual([])
})

test('a singleton opens its one entry, created the first time', async () => {
  const opened = await Promise.all([1, 2].map(() => send('GET', '/types/home/singleton')))
  expect(opened[0].body.data).toMatchObject({ type: 'home', values: { intro: 'Welcome' } })
  expect(opened[1].body.data.id).toBe(opened[0].body.data.id)
  expect(await db.selectFrom('entries').select('id').execute()).toHaveLength(1)

  // It saves like any entry, and only through itself
  const saved = await send('PUT', `/entries/${opened[0].body.data.id}`, { values: { headline: 'Hi' } })
  expect(saved.body.data.values).toEqual({ headline: 'Hi', intro: 'Welcome' })
  expect((await send('POST', '/types/home/entries', { values: { headline: 'Hi' } })).status).toBe(409)
  expect((await send('GET', '/types/blog/singleton')).status).toBe(404)
})

test('the delivery API serves a singleton from its first save', async () => {
  const key = await createApiKey(db, 'Website')
  const deliver = (path = '') => app.request(`/v1/entries/home${path}`, { headers: { authorization: `Bearer ${key}` } })

  // Opening it creates its entry without the headline that the generated types say is always there
  const { id } = (await send('GET', '/types/home/singleton')).body.data
  expect((await (await deliver()).json()).data).toEqual([])
  expect((await deliver(`/${id}`)).status).toBe(404)

  await send('PUT', `/entries/${id}`, { values: { headline: 'Hi' } })
  expect((await (await deliver()).json()).data).toMatchObject([{ id, values: { headline: 'Hi' } }])
  expect((await deliver(`/${id}`)).status).toBe(200)
})
