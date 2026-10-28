import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { hashToken } from '../src/passwords'
import { db } from './database'
import { setUp, types } from './fixtures'
import { afterAll, beforeAll, expect, test } from 'vitest'

const app = createApp(db, types)
let key: string
const ids: Record<string, string> = {}

const insert = async (name: string, type: string, values: Record<string, any>, columns: object = {}) => {
  ids[name] = uuidv7()
  await db
    .insertInto('entries')
    .values({ id: ids[name], type, values, slug: values.slug, ...columns })
    .execute()
  // The version a save writes, since the delivery API serves saved entries only
  await db.insertInto('entry_versions').values({ entry_id: ids[name], number: 1, values }).execute()
}

beforeAll(async () => {
  await setUp()
  key = await createApiKey(db, 'Website')

  const day = (date: string) => ({ created_at: new Date(date) })
  await insert(
    'release',
    'blog',
    { title: 'Release 1.0', slug: 'release-1', views: 10, featured: true },
    day('2026-01-10'),
  )
  await insert('hello', 'blog', { title: 'Hello world', slug: 'hello-world', views: 5 }, day('2026-02-01'))
  await insert(
    'second',
    'blog',
    { title: 'Release 2.0', slug: 'release-2', views: 50, featured: false },
    day('2026-03-01'),
  )
  await insert('old', 'blog', { title: 'Old release', slug: 'old', views: 1 }, { archived_at: new Date() })
  await insert('done', 'blog', { title: '100% done', slug: 'done', views: 7, blocks: [] }, day('2026-04-01'))

  await insert('guide', 'docs', { title: 'Guide', slug: 'guide' }, { uri: 'guide', position: 0 })
  await insert('install', 'docs', { title: 'Install', slug: 'install' }, { parent_id: ids.guide, uri: 'guide/install' })
  await insert('home', 'home', { headline: 'Hi' })
})

afterAll(() => db.destroy())

const get = async (path: string, token = key) => {
  const response = await app.request(`/v1${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: response.status, body: await response.json() }
}

// The slugs of the blog posts a query finds
const find = async (query: Record<string, unknown>) => {
  const params = new URLSearchParams(Object.entries(query).map(([name, value]) => [name, JSON.stringify(value)]))
  const { status, body } = await get(`/entries/blog?${params}`)
  expect(status).toBe(200)
  return body.data.map((entry: { slug: string }) => entry.slug)
}

const rejects = async (query: string) => (await get(`/entries/blog?${query}`)).body

test('needs an API key, and stores only its hash', async () => {
  expect(await get('/entries/blog', '')).toEqual({ status: 401, body: { message: 'Unauthenticated.' } })
  expect((await get('/entries/blog', `${key}x`)).status).toBe(401)

  expect(key).toMatch(/^iight_[\w-]{43}$/)
  const { token_hash } = await db.selectFrom('api_keys').select('token_hash').executeTakeFirstOrThrow()
  expect(token_hash).toBe(hashToken(key))
})

test('lists live entries in the order they were made, a page at a time', async () => {
  const { body } = await get('/entries/blog?perPage=3&page=2')
  expect(body).toEqual({
    data: [
      {
        id: ids.done,
        type: 'blog',
        slug: 'done',
        uri: null,
        parentId: null,
        position: null,
        values: { title: '100% done', slug: 'done', views: 7, blocks: [] },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: expect.any(String),
      },
    ],
    pagination: { page: 2, perPage: 3, total: 4, lastPage: 2 },
  })

  // A singleton is a list of one
  expect((await get('/entries/home')).body.data.map((entry: { id: string }) => entry.id)).toEqual([ids.home])
})

test('filters with groups of conditions, any group matching when all its conditions do', async () => {
  const condition = (field: string, op: string, value?: unknown) => ({ field, op, value })

  expect(
    await find({ where: [[condition('values.featured', '=', true)], [condition('values.title', 'like', 'HELLO')]] }),
  ).toEqual(['release-1', 'hello-world'])
  expect(
    await find({ where: [[condition('values.views', '>', 5), condition('values.title', 'not like', '2.0')]] }),
  ).toEqual(['release-1', 'done'])

  // Values compare as their JSON types, so 10 sorts after 7 and true only matches true
  expect(await find({ where: [[condition('values.views', '>=', 10)]] })).toEqual(['release-1', 'release-2'])
  expect(await find({ where: [[condition('values.views', 'between', [6, 10])]] })).toEqual(['release-1', 'done'])
  expect(await find({ where: [[condition('values.views', 'not between', [6, 10])]] })).toEqual([
    'hello-world',
    'release-2',
  ])
  expect(await find({ where: [[condition('values.views', 'in', [5, 50])]] })).toEqual(['hello-world', 'release-2'])
  expect(await find({ where: [[condition('values.views', 'not in', [5, 50])]] })).toEqual(['release-1', 'done'])
  expect(await find({ where: [[condition('values.featured', '!=', true)]] })).toEqual(['release-2'])
  expect(await find({ where: [[condition('values.title', 'like', '100%')]] })).toEqual(['done'])

  // An empty list counts as no value, as core's isEmptyValue sees it
  expect(await find({ where: [[condition('values.featured', 'exists')]] })).toEqual(['release-1', 'release-2'])
  expect(await find({ where: [[condition('values.blocks', 'exists')]] })).toEqual([])
  expect(await find({ where: [[condition('values.featured', 'not exists')]] })).toEqual(['hello-world', 'done'])

  expect(await find({ where: [[condition('slug', 'like', 'release')]] })).toEqual(['release-1', 'release-2'])
  expect(await find({ where: [[condition('createdAt', '<', '2026-02-15')]] })).toEqual(['release-1', 'hello-world'])
  expect(await find({ where: [[condition('id', '=', ids.hello)]] })).toEqual(['hello-world'])
})

test('sorts by fields and entry properties', async () => {
  expect(await find({ order: { 'values.views': 'desc' } })).toEqual(['release-2', 'release-1', 'done', 'hello-world'])
  expect(await find({ order: { 'values.featured': 'asc', createdAt: 'desc' } })).toEqual([
    'release-2',
    'release-1',
    'done',
    'hello-world',
  ])
})

test("rejects a query it can't check against the type", async () => {
  const where = (condition: object) => `where=${encodeURIComponent(JSON.stringify([[condition]]))}`

  expect(await rejects(where({ field: 'title', op: '=', value: 'Hi' }))).toEqual({
    message:
      'Unknown field "title". Use values.<name> for one of blog\'s fields, ' +
      'or one of id, slug, uri, parentId, position, createdAt, updatedAt.',
  })
  expect(await rejects(where({ field: 'values.editor', op: '=', value: 'Ada' }))).toEqual({
    message: expect.stringContaining('Unknown field "values.editor".'),
  })
  expect(await rejects(where({ field: 'values.title', op: '~', value: 'Hi' }))).toEqual({
    message: expect.stringContaining('Unknown operator "~".'),
  })
  expect(await rejects(where({ field: 'values.views', op: 'in', value: 5 }))).toEqual({
    message: 'values.views in needs a list of values.',
  })
  expect(await rejects(where({ field: 'position', op: 'like', value: '1' }))).toEqual({
    message: "position can't use like.",
  })
  expect(await rejects(where({ field: 'createdAt', op: '>', value: 'yesterday' }))).toEqual({
    message: 'createdAt > needs a timestamp.',
  })
  expect(await rejects(where({ field: 'id', op: '=', value: 'nope' }))).toEqual({ message: 'id = needs a uuid.' })
  expect(await rejects('where=nope')).toEqual({
    message: 'where must be JSON, such as [[{"field":"values.title","op":"=","value":"Hello"}]].',
  })
  expect(await rejects('where=[]&order=[]')).toEqual({
    message: 'order must map fields to directions, such as {"createdAt":"desc"}.',
  })
  expect(await rejects(`order=${encodeURIComponent('{"slug":"up"}')}`)).toEqual({ message: 'Sort slug asc or desc.' })
  expect(await rejects('perPage=500')).toEqual({ message: 'perPage must be a whole number from 1 to 100.' })
  expect((await get('/entries/blog?page=0')).status).toBe(400)
})

test('finds one live entry by ID, slug or uri', async () => {
  expect((await get(`/entries/blog/${ids.hello}`)).body.data.slug).toBe('hello-world')
  expect((await get('/entries/blog/slug/hello-world')).body.data.id).toBe(ids.hello)
  expect((await get('/entries/docs/uri/guide/install')).body.data.id).toBe(ids.install)

  const notFound = { status: 404, body: { message: 'Not Found' } }
  expect(await get(`/entries/blog/${ids.old}`)).toEqual(notFound)
  expect(await get('/entries/blog/slug/old')).toEqual(notFound)
  expect(await get(`/entries/docs/${ids.hello}`)).toEqual(notFound)
  expect(await get('/entries/docs/slug/install')).toEqual(notFound)
  expect(await get('/entries/blog/nope')).toEqual(notFound)
  expect(await get('/entries/nope')).toEqual(notFound)
})
