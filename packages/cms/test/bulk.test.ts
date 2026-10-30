import { createApp } from '../src/app'
import { createApiKey } from '../src/delivery'
import type { ContentType } from '../src/types'
import { db } from './database'
import { setUp, types } from './fixtures'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// Bulk editing (PLAN.md section 18): PATCH /api/types/:type/entries saves the changed fields of many entries at once

// Products, with a group inside a group and a list, for changed fields to merge into
const products: ContentType = {
  id: 'typ_products',
  name: 'products',
  label: 'Products',
  structure: 'collection',
  titleField: 'name',
  slugField: 'slug',
  fields: [
    { id: 'fld_product', type: 'text', name: 'name', label: 'Name', required: true },
    { id: 'fld_product_slug', type: 'identifier', name: 'slug', label: 'Slug' },
    { id: 'fld_price', type: 'number', name: 'price', label: 'Price', options: { min: 0 } },
    {
      id: 'fld_seo',
      type: 'group',
      name: 'seo',
      options: {
        fields: [
          { id: 'fld_seo_title', type: 'text', name: 'title' },
          { id: 'fld_seo_description', type: 'textarea', name: 'description' },
          {
            id: 'fld_social',
            type: 'group',
            name: 'social',
            options: {
              fields: [
                { id: 'fld_social_title', type: 'text', name: 'title' },
                { id: 'fld_social_image', type: 'url', name: 'image' },
              ],
            },
          },
        ],
      },
    },
    {
      id: 'fld_specs',
      type: 'repeater',
      name: 'specs',
      options: { fields: [{ id: 'fld_spec', type: 'text', name: 'label' }] },
    },
  ],
}

const app = createApp(db, new Map([...types, ['products', products]]))
// The same, with products as a type without drafts
const withoutDrafts = createApp(db, new Map([...types, ['products', { ...products, drafts: false }]]))
let cookie: string
let key: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  key = await createApiKey(db, 'Website')
})
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('events').execute()
})
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown, to = app) => {
  // Browsers send an Origin header with every POST, PUT, PATCH and DELETE, which the CSRF check needs
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await to.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

// Create an entry, publishing it when asked, and fail the test if it doesn't save
const create = async (
  type: string,
  values: object,
  { publish = false, parentId = null as string | null, to = app } = {},
) => {
  const { status, body } = await send('POST', `/types/${type}/entries`, { values, publish, parentId }, to)
  expect(status, JSON.stringify(body)).toBe(201)
  return body.data
}

const bulk = (type: string, entries: Array<{ id: string; values: object }>, publish = false, to = app) =>
  send('PATCH', `/types/${type}/entries`, { publish, entries }, to)

const versions = async (id: string) => (await send('GET', `/entries/${id}/versions`)).body.data.length

const deliver = async (path: string, to = app) => {
  const response = await to.request(`/v1${path}`, { headers: { authorization: `Bearer ${key}` } })
  return { status: response.status, body: await response.json() }
}

test("merges each entry's changed fields into its values, a group's fields one by one at any depth", async () => {
  const lamp = await create('products', {
    name: 'Lamp',
    slug: 'lamp',
    price: 40,
    seo: { title: 'A lamp', description: 'Brass', social: { title: 'Lamp', image: 'https://example.com/lamp.png' } },
    specs: [{ label: 'Brass' }, { label: 'LED' }],
  })
  // Another editor renames it after the grid loaded, which changes to its other fields keep
  await send('PUT', `/entries/${lamp.id}`, { values: { ...lamp.values, name: 'Desk lamp' } })

  const changed = { price: 45, seo: { social: { title: 'A desk lamp' } }, specs: [{ label: 'Steel' }], unknown: 1 }
  const { status, body } = await bulk('products', [{ id: lamp.id, values: changed }])
  expect(status).toBe(200)
  expect(body.data).toEqual([{ id: lamp.id, status: 200, data: expect.objectContaining({ id: lamp.id }) }])
  expect(body.data[0].data.values).toEqual({
    name: 'Desk lamp',
    slug: 'lamp',
    price: 45,
    seo: {
      title: 'A lamp',
      description: 'Brass',
      social: { title: 'A desk lamp', image: 'https://example.com/lamp.png' },
    },
    specs: [{ label: 'Steel' }],
  })
})

test('saves the rows that pass, with a result for each row in the order sent', async () => {
  const lamp = await create('products', { name: 'Lamp', price: 40 })
  const chair = await create('products', { name: 'Chair', price: 90 })
  const stool = await create('products', { name: 'Stool', price: 20 })
  await send('POST', `/entries/${stool.id}/archive`)
  const post = await create('blog', { title: 'Hello', slug: 'hello' })

  const { status, body } = await bulk('products', [
    { id: lamp.id, values: { price: 45 } },
    { id: chair.id, values: { price: -1 } },
    { id: stool.id, values: { price: 25 } },
    { id: post.id, values: { name: 'Not a product' } },
    { id: 'nope', values: {} },
  ])
  expect(status).toBe(200)
  expect(body.data.map((result: { id: string; status: number }) => [result.id, result.status])).toEqual([
    [lamp.id, 200],
    [chair.id, 422],
    [stool.id, 409],
    [post.id, 404],
    ['nope', 404],
  ])
  expect(body.data[1].report.fields.price).toEqual({
    isValid: false,
    messages: ['This field requires a minimum value of 0.'],
  })
  expect(body.data[2].message).toBe('This entry is archived. Restore it to edit it.')
  expect(body.data[3].message).toBe("There's no entry of this type with this id.")

  // Only the row that passed saved, as a new version
  expect(body.data[0].data.values.price).toBe(45)
  expect((await send('GET', `/entries/${chair.id}`)).body.data.values.price).toBe(90)
  expect([await versions(lamp.id), await versions(chair.id)]).toEqual([2, 1])
})

test('drafts save unfinished, Publish runs every check, and a type without drafts publishes every save', async () => {
  const draft = await create('blog', { title: 'Draft', slug: 'draft' })
  const live = await create('blog', { title: 'Live', slug: 'live' }, { publish: true })

  // A draft can lose a required field, and the live copy stays as it was
  const saved = await bulk('blog', [
    { id: draft.id, values: { title: '' } },
    { id: live.id, values: { title: 'Live, edited' } },
  ])
  expect(saved.body.data.map((result: any) => [result.status, result.data.status])).toEqual([
    [200, 'draft'],
    [200, 'changed'],
  ])
  expect((await deliver(`/entries/blog/${live.id}`)).body.data.values.title).toBe('Live')

  // Publish runs every check, so the unfinished draft stays as it was while the other goes live
  const published = await bulk(
    'blog',
    [
      { id: draft.id, values: { slug: 'draft-2' } },
      { id: live.id, values: { featured: true } },
    ],
    true,
  )
  expect(published.body.data.map((result: { status: number }) => result.status)).toEqual([422, 200])
  expect(published.body.data[0].report.fields.title).toEqual({ isValid: false, messages: ['This field is required.'] })
  expect(published.body.data[1].data).toMatchObject({ status: 'published', publishedVersion: 3 })
  expect((await deliver(`/entries/blog/${live.id}`)).body.data.values).toMatchObject({
    title: 'Live, edited',
    featured: true,
  })
  expect((await send('GET', `/entries/${draft.id}`)).body.data).toMatchObject({ status: 'draft', slug: 'draft' })

  // A page goes live only under a live parent, which doesn't hold up the rest, and pages keep their parents
  const guide = await create('docs', { title: 'Guide', slug: 'guide' })
  const install = await create('docs', { title: 'Install', slug: 'install' }, { parentId: guide.id })
  const pages = await bulk(
    'docs',
    [
      { id: install.id, values: { title: 'Installing' } },
      { id: guide.id, values: { title: 'The guide' } },
    ],
    true,
  )
  expect(pages.body.data).toMatchObject([
    { id: install.id, status: 409, message: "Its parent isn't published. Publish the parent first." },
    { id: guide.id, status: 200, data: { status: 'published', parentId: null } },
  ])
  expect((await send('GET', `/entries/${install.id}`)).body.data).toMatchObject({
    parentId: guide.id,
    uri: 'guide/install',
    values: { title: 'Install' },
  })

  // Without drafts, every save runs every check and publishes
  const lamp = await create('products', { name: 'Lamp' }, { to: withoutDrafts })
  const unfinished = await bulk('products', [{ id: lamp.id, values: { name: '' } }], false, withoutDrafts)
  expect(unfinished.body.data[0]).toMatchObject({ status: 422, report: { fields: { name: { isValid: false } } } })
  const priced = await bulk('products', [{ id: lamp.id, values: { price: 12 } }], false, withoutDrafts)
  expect(priced.body.data[0].data).toMatchObject({ status: 'published', values: { price: 12 } })
  expect((await deliver(`/entries/products/${lamp.id}`, withoutDrafts)).body.data.values.price).toBe(12)
})

test("a save that lands while a row is saving keeps its changes to the entry's other fields", async () => {
  const lamp = await create('products', { name: 'Lamp', price: 40 })

  // Another save holds the entry as the bulk request starts, and renames it before letting go
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const other = db.transaction().execute(async (trx) => {
    await trx.selectFrom('entries').select('id').where('id', '=', lamp.id).forUpdate().execute()
    await held
    await trx
      .updateTable('entries')
      .set({ values: { ...lamp.values, name: 'Desk lamp' } })
      .where('id', '=', lamp.id)
      .execute()
  })
  const saving = bulk('products', [{ id: lamp.id, values: { price: 45 } }])
  // Long enough for the request to reach the entry. Had it read the entry without waiting, it would have read it by now.
  await new Promise((resolve) => setTimeout(resolve, 200))
  release()
  await other

  const { body } = await saving
  expect(body.data[0].data.values).toEqual({ name: 'Desk lamp', price: 45 })
})

test('when two rows take the same slug, the first saves and the second gets a 422 on its slug', async () => {
  const first = await create('blog', { title: 'First', slug: 'first' })
  const second = await create('blog', { title: 'Second', slug: 'second' })

  const { body } = await bulk('blog', [
    { id: first.id, values: { slug: 'same' } },
    { id: second.id, values: { slug: 'same' } },
  ])
  expect(body.data.map((result: { status: number }) => result.status)).toEqual([200, 422])
  expect(body.data[1].report.fields.slug).toEqual({
    isValid: false,
    messages: ['Another entry here already uses this slug.'],
  })
  expect((await send('GET', `/entries/${second.id}`)).body.data.slug).toBe('second')
})

test('each row that saves gets a version, its links and its events', async () => {
  const ada = await create('authors', { name: 'Ada' })
  const post = await create('blog', { title: 'Hello', slug: 'hello' })
  const other = await create('blog', { title: 'Other', slug: 'other' })
  await db.deleteFrom('events').execute()

  await bulk(
    'blog',
    [
      { id: post.id, values: { author: ada.id } },
      { id: other.id, values: { title: 'Other, edited' } },
    ],
    true,
  )
  expect([await versions(post.id), await versions(other.id)]).toEqual([2, 2])
  const events = await db.selectFrom('events').select(['name', 'data']).execute()
  expect(events.map((event) => `${event.name} ${event.data.entry.values.title}`).sort()).toEqual([
    'entry.published Hello',
    'entry.published Other, edited',
    'entry.updated Hello',
    'entry.updated Other, edited',
  ])
  const usedBy = (await send('GET', `/entries/${ada.id}/used-by`)).body.data
  expect(usedBy.map((entry: { id: string }) => entry.id)).toEqual([post.id])
})

test('the whole request replies 400 to a malformed body, 404 for an unknown type, and 409 for a singleton or a pending migration', async () => {
  const post = await create('blog', { title: 'Hello', slug: 'hello' })
  const one = [{ id: post.id, values: { title: 'Hi' } }]
  expect(await bulk('nope', one)).toEqual({ status: 404, body: { message: 'Not Found' } })
  expect(await bulk('home', one)).toEqual({ status: 409, body: { message: 'A singleton has one entry, open it.' } })

  const malformed = { status: 400, body: { message: 'entries must list 1 to 100 entries, each { id, values }.' } }
  const lists = [
    undefined,
    [],
    [{ id: post.id }],
    [{ id: post.id, values: [] }],
    [{ values: {} }],
    Array(101).fill(one[0]),
  ]
  for (const entries of lists) expect(await send('PATCH', '/types/blog/entries', { entries })).toEqual(malformed)
  expect(await bulk('blog', [...one, ...one])).toEqual({
    status: 400,
    body: { message: 'Each entry can only be sent once.' },
  })

  // While a content migration hasn't run, nothing saves
  const pending = createApp(db, types, {
    migrations: async () => ({ '2099_01_01_000000_blog': { up: async () => {}, down: async () => {} } }),
  })
  expect(await bulk('blog', one, false, pending)).toEqual({
    status: 409,
    body: { message: "Run iight migrate first. The content migration 2099_01_01_000000_blog hasn't run yet." },
  })
  expect(await versions(post.id)).toBe(1)
})
