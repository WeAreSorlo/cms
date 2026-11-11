import { createApp } from '../src/app'
import { checkEntries } from '../src/content'
import { flattenValidationReport } from '../src/core'
import { Database, uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { rebuildRelations } from '../src/relations'
import { db, url } from './database'
import { setUp, types } from './fixtures'
import { FSDriver } from 'flydrive/drivers/fs'
import { Kysely, PostgresDialect } from 'kysely'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// Relationship and media fields: their server checks, entry_relations, "used by", and the delivery API's with

// The SQL of every query sent through a second connection to the test database
const queries: Array<string> = []
const counted = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
  log: (event) => void queries.push(event.query.sql),
})

// The media routes need storage, though no test here writes to it
const location = join(tmpdir(), 'sorlo-relations')
const storage = { default: 'local', services: { local: () => new FSDriver({ location, visibility: 'public' }) } }
const app = createApp(db, types, { storage })
let cookie: string
let key: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  key = await createApiKey(db, 'Website')
})
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('media').execute()
})
afterAll(async () => {
  await counted.destroy()
  await db.destroy()
})

const send = async (method: string, path: string, body?: unknown) => {
  // Browsers send an Origin header with every POST, PUT and DELETE, which the CSRF check needs
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

// Save and publish an entry through the admin API, a new one or over an existing one, failing the test if it doesn't
// save
const save = async (type: string, values: object, id?: string) => {
  const { status, body } = id
    ? await send('PUT', `/entries/${id}`, { values, publish: true })
    : await send('POST', `/types/${type}/entries`, { values, publish: true })
  expect(status, JSON.stringify(body)).toBe(id ? 200 : 201)
  return body.data
}

const post = (title: string, values: object = {}, id?: string) =>
  save('blog', { title, slug: title.toLowerCase().replace(/\W+/g, '-'), ...values }, id)
const author = (name: string, values: object = {}) => save('authors', { name, ...values })

// A file in the media library, without one on a disk, which links don't need
const file = async (name: string, mime = 'image/png') => {
  const id = uuidv7()
  await db
    .insertInto('media')
    .values({ id, disk: 'local', path: `${id}.png`, name, mime, size: 100, width: 10, height: 10 })
    .execute()
  return id
}

// The messages a new blog post gets for these values, by field path, when it's published and every check runs
const problems = async (values: object) => {
  const { status, body } = await send('POST', '/types/blog/entries', {
    values: { title: 'Post', slug: `post-${uuidv7()}`, ...values },
    publish: true,
  })
  expect(status).toBe(422)
  return flattenValidationReport(body).messages
}

const relations = (id: string) =>
  db
    .selectFrom('entry_relations')
    .select(['field_id', 'target_id'])
    .where('entry_id', '=', id)
    .orderBy('field_id')
    .orderBy('target_id')
    .execute()

const deliver = async (path: string, to = app) => {
  const response = await to.request(`/v1${path}`, { headers: { authorization: `Bearer ${key}` } })
  return { status: response.status, body: await response.json() }
}

// with and depth, as the SDK sends them
const params = (names: Array<string>, depth?: number) =>
  `with=${encodeURIComponent(JSON.stringify(names))}${depth ? `&depth=${depth}` : ''}`

const gone = "It's been deleted, or isn't of a type this field takes."

test('a save checks that each link is to an entry or file of a type the field takes', async () => {
  const ada = await author('Ada')
  const photo = await file('photo.png')
  const pdf = await file('guide.pdf', 'application/pdf')
  const other = await post('Other')

  expect(await problems({ author: other.id, cover: pdf })).toEqual({ author: [gone], cover: [gone] })
  expect(await problems({ author: uuidv7(), cover: 'photo.png' })).toEqual({ author: [gone], cover: [gone] })
  expect(await problems({ related: [other.id, ada.id] })).toEqual({
    related: ["Some of them have been deleted, or aren't of a type this field takes."],
  })
  expect(
    await problems({ blocks: [{ _layout: 'gallery', images: [] }], credits: [{ person: photo, role: 'Writer' }] }),
  ).toEqual({ 'blocks.0.images': ['At least one selection is required.'], 'credits.0.person': [gone] })

  // A field that takes one item holds its ID, and others a list of different IDs within their limits
  expect(await problems({ author: [ada.id], related: other.id })).toEqual({
    author: ['Invalid value.'],
    related: ['Invalid value.'],
  })
  expect(await problems({ related: [other.id, other.id] })).toEqual({ related: ['Each item can only be chosen once.'] })
  expect(await problems({ related: [uuidv7(), uuidv7(), uuidv7(), uuidv7()] })).toEqual({
    related: ['This field requires a maximum of 3 item(s).'],
  })

  // Archived entries still count, so archiving one doesn't stop the entries that link to it from saving
  await send('POST', `/entries/${ada.id}/archive`)
  const links = { author: ada.id, cover: photo, related: [other.id], blocks: [{ _layout: 'gallery', images: [pdf] }] }
  expect((await post('Links', links)).values).toMatchObject(links)
})

test('every save rebuilds entry_relations from both kinds of field, nested ones included', async () => {
  const [ada, grace] = [await author('Ada'), await author('Grace')]
  const [photo, chart] = [await file('photo.png'), await file('chart.png')]
  const other = await post('Other')
  const saved = await post('Links', {
    author: ada.id,
    cover: photo,
    related: [other.id],
    blocks: [
      { _layout: 'text', body: 'Hi' },
      { _layout: 'gallery', images: [chart, photo] },
    ],
    credits: [{ person: grace.id }, { person: ada.id }],
  })

  // In any order, since two IDs made in the same millisecond can sort either way
  const rows = await relations(saved.id)
  expect(rows).toHaveLength(7)
  expect(rows).toEqual(
    expect.arrayContaining([
      { field_id: 'fld_author', target_id: ada.id },
      { field_id: 'fld_cover', target_id: photo },
      { field_id: 'fld_images', target_id: photo },
      { field_id: 'fld_images', target_id: chart },
      { field_id: 'fld_person', target_id: ada.id },
      { field_id: 'fld_person', target_id: grace.id },
      { field_id: 'fld_related', target_id: other.id },
    ]),
  )

  await post('Links', { author: grace.id }, saved.id)
  expect(await relations(saved.id)).toEqual([{ field_id: 'fld_author', target_id: grace.id }])

  await send('POST', `/entries/${saved.id}/archive`)
  expect((await send('DELETE', `/entries/${saved.id}`)).status).toBe(204)
  expect(await relations(saved.id)).toEqual([])
})

test('"used by" lists what links to an entry or file, which can be archived but not deleted until the links go', async () => {
  const ada = await author('Ada')
  const photo = await file('photo.png')
  const first = await post('First', { author: ada.id })
  const second = await post('Second', { cover: photo, credits: [{ person: ada.id }] })

  const usedBy = async (path: string) => (await send('GET', path)).body.data.map((entry: { id: string }) => entry.id)
  expect(await usedBy(`/entries/${ada.id}/used-by`)).toEqual([second.id, first.id])
  expect(await usedBy(`/media/${photo}/used-by`)).toEqual([second.id])
  expect(await usedBy(`/entries/${first.id}/used-by`)).toEqual([])

  // The admin warns before archiving
  expect((await send('POST', `/entries/${ada.id}/archive`)).status).toBe(200)
  expect(await send('DELETE', `/entries/${ada.id}`)).toEqual({
    status: 409,
    body: { message: '2 other entries link to this one. Remove the links before deleting it.' },
  })
  expect(await send('DELETE', `/media/${photo}`)).toEqual({
    status: 409,
    body: { message: 'An entry links to this file. Remove the links before deleting it.' },
  })

  await post('First', {}, first.id)
  expect((await send('DELETE', `/entries/${ada.id}`)).body.message).toBe(
    'Another entry links to this one. Remove the links before deleting it.',
  )
  await post('Second', { cover: photo }, second.id)
  expect((await send('DELETE', `/entries/${ada.id}`)).status).toBe(204)
})

test('with() swaps the IDs in the fields it names for what they link to, inside repeaters and flexible blocks too', async () => {
  const ada = await author('Ada', { avatar: await file('ada.png') })
  const grace = await author('Grace')
  const [photo, chart] = [await file('photo.png'), await file('chart.png')]
  const other = await post('Other')
  const saved = await post('Links', {
    author: ada.id,
    cover: photo,
    related: [other.id],
    blocks: [
      { _layout: 'text', body: 'Hi' },
      { _layout: 'gallery', images: [chart, photo] },
    ],
    credits: [{ person: grace.id, role: 'Editor' }],
  })
  const entry = async (type: string, id: string) => (await deliver(`/entries/${type}/${id}`)).body.data
  const media = async (id: string) => (await deliver(`/media/${id}`)).body.data

  // Without it, links are IDs
  expect((await entry('blog', saved.id)).values).toEqual(saved.values)

  const { body } = await deliver(`/entries/blog/${saved.id}?${params(['author', 'cover', 'blocks', 'credits'], 1)}`)
  expect(body.data.values).toEqual({
    ...saved.values,
    author: await entry('authors', ada.id),
    cover: await media(photo),
    blocks: [
      { _layout: 'text', body: 'Hi' },
      { _layout: 'gallery', images: [await media(chart), await media(photo)] },
    ],
    credits: [{ person: await entry('authors', grace.id), role: 'Editor' }],
  })
  expect(body.data.values.cover.url).toBe(`http://localhost/media/${photo}/photo.png`)

  // Lists and lookups by slug take it too
  const listed = await deliver(`/entries/blog?${params(['author', 'cover', 'blocks', 'credits'], 1)}`)
  expect(listed.body.data.find((found: { id: string }) => found.id === saved.id)).toEqual(body.data)
  expect((await deliver(`/entries/blog/slug/links?${params(['author'])}`)).body.data.values.author.id).toBe(ada.id)
})

test('with() resolves the links of what it finds a level at a time, down to the depth, leaving out what the API does not serve', async () => {
  const avatar = await file('ada.png')
  const ada = await author('Ada', { avatar })
  const first = await post('First', { author: ada.id })
  const second = await post('Second', { related: [first.id] })
  await post('First', { author: ada.id, related: [second.id] }, first.id)

  // The posts second links to, at a depth
  const related = async (depth?: number) =>
    (await deliver(`/entries/blog/${second.id}?${params(['related'], depth)}`)).body.data.values.related

  expect((await related(1))[0].values).toMatchObject({ title: 'First', author: ada.id, related: [second.id] })

  const two = (await related(2))[0].values
  expect(two.author).toMatchObject({ id: ada.id, values: { name: 'Ada', avatar } })
  expect(two.related).toMatchObject([{ id: second.id, values: { related: [first.id] } }])
  expect(await related()).toEqual(await related(2))

  // Links that loop repeat until the depth runs out
  const three = (await related(3))[0].values
  expect(three.author.values.avatar).toMatchObject({ id: avatar, name: 'ada.png' })
  expect(three.related[0].values.related).toMatchObject([{ id: first.id, values: { related: [second.id] } }])

  // So are entries of a type that's been removed
  const withoutAuthors = createApp(db, new Map([...types].filter(([name]) => name !== 'authors')))
  const { body } = await deliver(`/entries/blog/${first.id}?${params(['author'])}`, withoutAuthors)
  expect(body.data.values.author).toBeNull()

  // Archived entries are left out, which is null in a field that holds one
  await send('POST', `/entries/${ada.id}/archive`)
  expect((await related(2))[0].values.author).toBeNull()
  await send('POST', `/entries/${first.id}/archive`)
  expect(await related(1)).toEqual([])
})

test('each level of with() loads its entries in one query and its media in another, however many links it finds', async () => {
  for (let i = 0; i < 20; i++) {
    const person = await author(`Author ${i}`, { avatar: await file(`avatar-${i}.png`) })
    await post(`Post ${i}`, {
      author: person.id,
      cover: await file(`cover-${i}.png`),
      credits: [{ person: person.id }],
    })
  }

  queries.length = 0
  const { body } = await deliver(
    `/entries/blog?perPage=20&${params(['author', 'cover', 'credits'])}`,
    createApp(counted, types),
  )
  expect(body.data).toHaveLength(20)
  for (const found of body.data) {
    expect(found.values.credits[0].person).toEqual(found.values.author)
    expect(found.values.author.values.avatar.url).toMatch(/avatar-\d+\.png$/)
  }

  // The first level's authors and covers, then the second's avatars, since authors link to nothing else
  expect(queries.filter((sql) => sql.includes('= any('))).toHaveLength(3)
})

test('one reply holds at most 2,000 linked entries and files, counting every place it shows one, refused before the level that passes it loads', async () => {
  // Four posts, each with a cover and related to the other three, so each level shows each post three times as often
  const posts = [await post('A'), await post('B'), await post('C'), await post('D')]
  for (const { id, values } of posts) {
    const related = posts.filter((other) => other.id !== id).map((other) => other.id)
    await post(values.title, { related, cover: await file(`${values.title}.png`) }, id)
  }
  // And a gallery, whose images count at the first level only
  const images = []
  for (let i = 0; i < 65; i++) images.push(await file(`image-${i}.png`))
  const gallery = await post('Gallery', { blocks: [{ _layout: 'gallery', images: images.slice(0, 64) }] })

  // The entries and files a reply shows besides its five posts, every place it shows them
  const shown = (body: object) => {
    const text = JSON.stringify(body)
    return text.split('"publishedAt":').length - 1 - 5 + text.split('"mime":').length - 1
  }
  const path = `/entries/blog?${params(['related', 'cover', 'blocks'], 5)}`

  // 16 + 64 at the first level, then 48, 144, 432 and 1,296: 2,000 in all
  const { status, body } = await deliver(path)
  expect(status).toBe(200)
  expect(shown(body)).toBe(2000)

  // One more image is one too many, refused before the fifth level's entries and files load
  await post('Gallery', { blocks: [{ _layout: 'gallery', images }] }, gallery.id)
  queries.length = 0
  expect(await deliver(path, createApp(counted, types))).toEqual({
    status: 400,
    body: {
      message:
        'This reply would hold more than 2,000 linked entries and files. Ask for fewer with perPage, depth or with.',
    },
  })
  expect(queries.filter((sql) => sql.includes('= any('))).toHaveLength(8)
  expect((await deliver(`/entries/blog?${params(['related', 'cover', 'blocks'], 4)}`)).status).toBe(200)

  // delivery.maxLinks raises the limit, and Infinity lifts it
  for (const maxLinks of [2001, Infinity]) {
    expect((await deliver(path, createApp(db, types, { delivery: { maxLinks } }))).status).toBe(200)
  }
  expect(() => createApp(db, types, { delivery: { maxLinks: 0 } })).toThrow(
    'delivery.maxLinks in sorlo.config.ts needs a whole number from 1, or Infinity for no limit.',
  )
})

test('a link stored with its ID in capitals leaves the limit on', async () => {
  const [r, s, f] = [await post('R'), await post('S'), await post('F')]
  const q = await post('Q', { related: [r.id, s.id] })
  const e = await post('E', { related: [f.id] })
  const p = await post('P', { related: [q.id] })
  // A content migration or a write to the database can store one, which Postgres matches in any case
  const related = [e.id.toUpperCase(), q.id]
  await db
    .updateTable('published_entries')
    .set({ values: { ...p.values, related } })
    .where('id', '=', p.id)
    .execute()

  // The first level shows two links, then Q's two make four, past three, while E, never swapped in, shows nothing
  const { status, body } = await deliver(
    `/entries/blog/${p.id}?${params(['related'], 2)}`,
    createApp(db, types, { delivery: { maxLinks: 3 } }),
  )
  expect({ status, body }).toEqual({
    status: 400,
    body: {
      message: 'This reply would hold more than 3 linked entries and files. Ask for fewer with perPage, depth or with.',
    },
  })
})

test('a with or depth the delivery API cannot use replies 400', async () => {
  const message = async (path: string) => {
    const { status, body } = await deliver(path)
    expect(status).toBe(400)
    return body.message
  }

  expect(await message('/entries/blog?with=author')).toBe(
    'with must be a JSON list of fields, such as ["blocks","author"].',
  )
  expect(await message(`/entries/blog?${params(['title'])}`)).toBe(
    `with can't name "title". Use blocks, author, cover, related, credits, which hold blog's links.`,
  )
  expect(await message(`/entries/docs?${params(['title'])}`)).toBe(
    'docs has no relationship or media fields for with to name.',
  )
  for (const depth of ['0', '6', '1.5', 'deep']) {
    expect(await message(`/entries/blog?${params(['author'])}&depth=${depth}`)).toBe(
      'depth must be a whole number from 1 to 5.',
    )
  }

  // A site sets its own default and maximum in sorlo.config.ts
  const deeper = createApp(db, types, { delivery: { depth: 3, maxDepth: 8 } })
  expect((await deliver(`/entries/blog?${params(['author'])}&depth=8`, deeper)).status).toBe(200)
  expect(() => createApp(db, types, { delivery: { depth: 3, maxDepth: 2 } })).toThrow(
    'delivery in sorlo.config.ts needs a whole number depth from 1 to its maxDepth.',
  )
})

test('content migrations rebuild entry_relations, and migrate --check lists links to entries that are gone', async () => {
  const ada = await author('Ada')
  const saved = await post('Links', { author: ada.id })

  // As a migration that removes the field leaves it
  const write = (values: object) =>
    db
      .updateTable('entries')
      .set({ values: { title: 'Links', slug: 'links', ...values } })
      .where('id', '=', saved.id)
      .execute()
  await write({})
  await rebuildRelations(db, types)
  expect(await relations(saved.id)).toEqual([])

  // A link no save checked
  const missing = uuidv7()
  await write({ author: missing })
  await rebuildRelations(db, types)
  expect(await relations(saved.id)).toEqual([{ field_id: 'fld_author', target_id: missing }])
  expect((await checkEntries(db, types)).map(({ entry, messages }) => [entry.id, messages])).toEqual([
    [saved.id, { author: [gone] }],
  ])
})
