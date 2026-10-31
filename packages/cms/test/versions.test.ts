import { createApp } from '../src/app'
import { ContentMigrationFile, contentMigrations } from '../src/content'
import { uuidv7 } from '../src/db'
import { migrate, rollback } from '../src/migrator'
import { hashToken } from '../src/passwords'
import type { ContentType } from '../src/types'
import { db } from './database'
import { blog, setUp, types } from './fixtures'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'

let cookie: string
let userId: string
// A second user, so a test can tell whose save or publish counted
const bob = { id: uuidv7(), cookie: 'iight_session=bob-token' }
beforeAll(async () => {
  ;({ cookie, userId } = await setUp())
  await db
    .insertInto('users')
    .values({ id: bob.id, name: 'Bob', email: 'bob@example.com', password_hash: '' })
    .execute()
  await db
    .insertInto('sessions')
    .values({
      id: uuidv7(),
      user_id: bob.id,
      token_hash: hashToken('bob-token'),
      expires_at: new Date(Date.now() + 60_000),
    })
    .execute()
})
afterAll(() => db.destroy())

// The blog type once its title is renamed, and the content migration that renames it
const renamed: ContentType = {
  ...blog,
  titleField: 'headline',
  listColumns: ['headline'],
  fields: blog.fields.map((field) => (field.name === 'title' ? { ...field, name: 'headline' } : field)),
}
const files: Record<string, ContentMigrationFile> = {
  '2026_10_28_120000_blog': {
    up: ({ entries }) => entries.renameField('blog', 'title', 'headline'),
    down: ({ entries }) => entries.renameField('blog', 'headline', 'title'),
  },
}
// The site before the migration was written, once it's been written but not run or been rolled back, and once it's run
const fresh = createApp(db, types)
const before = createApp(db, types, { migrations: async () => files })
const after = createApp(db, new Map([...types, ['blog', renamed]]), { migrations: async () => files })

const send = async (app: typeof before, method: string, path: string, body?: unknown, as = cookie) => {
  const headers: Record<string, string> = { cookie: as, origin: 'http://localhost', 'content-type': 'application/json' }
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

const markers = async () =>
  (await db.selectFrom('entry_versions').select('migration').orderBy('number').execute()).map((row) => row.migration)

test('restoring a version first runs the content migrations that ran after it was saved', async () => {
  const created = await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'Hello', slug: 'hello' } })
  const id = created.body.data.id
  expect(await markers()).toEqual([null])

  await migrate(db, contentMigrations(files))
  const entry = (await send(after, 'GET', `/entries/${id}`)).body.data
  expect(entry.values).toMatchObject({ headline: 'Hello', slug: 'hello' })
  expect(entry.values).not.toHaveProperty('title')

  // Version 1 was saved before the rename, so it comes back renamed
  const first = await send(after, 'GET', `/entries/${id}/versions/1`)
  expect(first.body.data.values).toMatchObject({ headline: 'Hello', slug: 'hello' })
  expect(first.body.data.values).not.toHaveProperty('title')

  // A save records the migration its values have been through, so its version is already up to date
  const saved = await send(after, 'PUT', `/entries/${id}`, { values: { headline: 'Hello again', slug: 'hello' } })
  expect(saved.status).toBe(200)
  expect(await markers()).toEqual([null, '2026_10_28_120000_blog'])
  expect((await send(after, 'GET', `/entries/${id}/versions/2`)).body.data.values).toMatchObject({
    headline: 'Hello again',
  })

  // Rolled back, version 1 is as it was saved, and version 2 waits for the migration to run again, as saves do
  await rollback(db, contentMigrations(files))
  expect(await send(before, 'PUT', `/entries/${id}`, { values: { title: 'Hello', slug: 'hello' } })).toEqual({
    status: 409,
    body: { message: "Run iight migrate first. The content migration 2026_10_28_120000_blog hasn't run yet." },
  })
  expect((await send(before, 'GET', `/entries/${id}/versions/1`)).body.data.values).toMatchObject({ title: 'Hello' })
  expect(await send(before, 'GET', `/entries/${id}/versions/2`)).toEqual({
    status: 409,
    body: {
      message:
        'Version 2 was saved after the content migration 2026_10_28_120000_blog, which has been rolled back. Migrate again to restore it.',
    },
  })
})

// The numbers of an entry's versions, newest first
const numbers = async (id: string) =>
  (await send(fresh, 'GET', `/entries/${id}/versions`)).body.data.map((version: { number: number }) => version.number)

// The names of the events written since the last call
const written = async () => {
  const names = (await db.selectFrom('events').select('name').execute()).map((event) => event.name).sort()
  await db.deleteFrom('events').execute()
  return names
}

// When each of an entry's links was written, which changes whenever they're rebuilt
const linksWritten = async (id: string) =>
  (await sql<{ xmin: string }>`select xmin::text from entry_relations where entry_id = ${id}`.execute(db)).rows

test('a save that changes nothing writes no version, links or events, and leaves the entry as it was', async () => {
  const author = (await send(fresh, 'POST', '/types/authors/entries', { values: { name: 'Grace' } })).body.data
  const values = {
    title: 'Quiet',
    slug: 'quiet',
    views: 2,
    author: author.id,
    credits: [{ person: author.id, role: 'Editor' }],
  }
  const created = (await send(fresh, 'POST', '/types/blog/entries', { values })).body.data
  const links = await linksWritten(created.id)
  expect(links).toHaveLength(2)
  await written()

  // The same values with their keys in another order, saved by someone else
  const reordered = {
    credits: [{ role: 'Editor', person: author.id }],
    author: author.id,
    views: 2,
    slug: 'quiet',
    title: 'Quiet',
  }
  expect(await send(fresh, 'PUT', `/entries/${created.id}`, { values: reordered }, bob.cookie)).toEqual({
    status: 200,
    body: { data: created },
  })
  expect(await numbers(created.id)).toEqual([1])
  expect(await linksWritten(created.id)).toEqual(links)
  expect(await written()).toEqual([])

  // A publish of what's saved makes the newest version live without saving another, and once it's live, does nothing
  const published = (await send(fresh, 'PUT', `/entries/${created.id}`, { values, publish: true }, bob.cookie)).body
    .data
  expect(published).toEqual({ ...created, status: 'published', publishedVersion: 1, publishedAt: expect.any(String) })
  expect(await written()).toEqual(['entry.published'])
  expect((await send(fresh, 'PUT', `/entries/${created.id}`, { values, publish: true })).body.data).toEqual(published)
  expect(await written()).toEqual([])
  expect(await numbers(created.id)).toEqual([1])

  // A change saves as before, and publishing it later saves nothing more
  await send(fresh, 'PUT', `/entries/${created.id}`, { values: { ...values, views: 3 } })
  expect(await numbers(created.id)).toEqual([2, 1])
  expect(await written()).toEqual(['entry.updated'])
  const republished = await send(fresh, 'PUT', `/entries/${created.id}`, {
    values: { ...values, views: 3 },
    publish: true,
  })
  expect(republished.body.data).toMatchObject({ status: 'published', publishedVersion: 2 })
  expect(await numbers(created.id)).toEqual([2, 1])
  expect(await written()).toEqual(['entry.published'])

  // Bulk rows follow the same rule, row by row, publishing included
  const loud = (await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'Loud', slug: 'loud' } })).body.data
  await written()
  const rows = [
    { id: created.id, values: { views: 3 } },
    { id: loud.id, values: { views: 9 } },
  ]
  const bulk = await send(fresh, 'PATCH', '/types/blog/entries', { entries: rows })
  expect(bulk.body.data.map((row: { status: number }) => row.status)).toEqual([200, 200])
  expect(bulk.body.data[0].data).toEqual(republished.body.data)
  expect(await numbers(created.id)).toEqual([2, 1])
  expect(await numbers(loud.id)).toEqual([2, 1])
  expect(await written()).toEqual(['entry.updated'])
  const bulkPublish = await send(fresh, 'PATCH', '/types/blog/entries', { publish: true, entries: rows })
  expect(bulkPublish.body.data[1].data).toMatchObject({ status: 'published', publishedVersion: 2 })
  expect(await numbers(loud.id)).toEqual([2, 1])
  expect(await written()).toEqual(['entry.published'])

  // A page's parent counts as a change
  const page = (title: string, parentId: string | null = null) =>
    send(fresh, 'POST', '/types/docs/entries', { values: { title, slug: title.toLowerCase() }, parentId })
  const guide = (await page('Guide')).body.data
  const faq = (await page('FAQ')).body.data
  const install = (await page('Install', guide.id)).body.data
  await send(fresh, 'PUT', `/entries/${install.id}`, { values: install.values, parentId: guide.id })
  expect(await numbers(install.id)).toEqual([1])
  await send(fresh, 'PUT', `/entries/${install.id}`, { values: install.values, parentId: faq.id })
  expect(await numbers(install.id)).toEqual([2, 1])

  // A singleton that's been opened but never saved has no version yet, so its first save writes one, changed or not
  const home = (await send(fresh, 'GET', '/types/home/singleton')).body.data
  expect(await numbers(home.id)).toEqual([])
  await send(fresh, 'PUT', `/entries/${home.id}`, { values: home.values })
  expect(await numbers(home.id)).toEqual([1])
})

test('a version can be named, renamed and have its name cleared', async () => {
  const entry = (await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'Named', slug: 'named' } })).body
    .data
  await send(fresh, 'PUT', `/entries/${entry.id}`, { values: { title: 'Named again', slug: 'named' } })
  const path = `/entries/${entry.id}/versions/1`

  const named = await send(fresh, 'PUT', path, { name: 'Launch copy' })
  expect(named).toEqual({
    status: 200,
    body: {
      data: {
        number: 1,
        name: 'Launch copy',
        createdBy: { id: userId, name: 'Ada' },
        createdAt: expect.any(String),
        publishedAt: null,
        publishedBy: null,
      },
    },
  })
  const listed = (await send(fresh, 'GET', `/entries/${entry.id}/versions`)).body.data
  expect(listed.map((version: { name: string | null }) => version.name)).toEqual([null, 'Launch copy'])
  expect(listed[1]).toEqual(named.body.data)

  expect((await send(fresh, 'PUT', path, { name: ' Approved by legal ' })).body.data.name).toBe('Approved by legal')
  expect((await send(fresh, 'PUT', path, { name: '' })).body.data.name).toBeNull()
  await send(fresh, 'PUT', path, { name: 'Again' })
  expect((await send(fresh, 'PUT', path, { name: '   ' })).body.data.name).toBeNull()

  // Names are up to 100 characters, checked with core's report
  const long = await send(fresh, 'PUT', path, { name: 'x'.repeat(101) })
  expect(long.status).toBe(422)
  expect(long.body.fields.name.isValid).toBe(false)
  expect((await send(fresh, 'PUT', path, { name: 'x'.repeat(100) })).body.data.name).toHaveLength(100)

  expect((await send(fresh, 'PUT', `/entries/${entry.id}/versions/9`, { name: 'Nope' })).status).toBe(404)
  expect((await send(fresh, 'PUT', `/entries/${entry.id}/versions/first`, { name: 'Nope' })).status).toBe(404)

  // An archived entry's versions stay as they are
  await send(fresh, 'POST', `/entries/${entry.id}/archive`)
  expect(await send(fresh, 'PUT', path, { name: 'Late' })).toEqual({
    status: 409,
    body: { message: 'This entry is archived. Restore it to edit it.' },
  })
})

test("deleting a version keeps every number, and the current version, the live one and an archived entry's stay", async () => {
  const { id } = (await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'One', slug: 'deleting' } })).body
    .data
  const save = (title: string, publish = false) =>
    send(fresh, 'PUT', `/entries/${id}`, { values: { title, slug: 'deleting' }, publish })
  const remove = (number: number | string) => send(fresh, 'DELETE', `/entries/${id}/versions/${number}`)
  await save('Two', true)
  await save('Three')
  await save('Four')

  expect(await remove(3)).toEqual({ status: 204, body: null })
  expect(await numbers(id)).toEqual([4, 2, 1])
  expect(await remove(4)).toEqual({
    status: 409,
    body: { message: "Version 4 is the current version, so it can't be deleted." },
  })
  expect(await remove(2)).toEqual({
    status: 409,
    body: { message: "Version 2 is live, so it can't be deleted. Publish another version first." },
  })
  expect((await remove(3)).status).toBe(404)
  expect((await remove(9)).status).toBe(404)
  expect((await remove('first')).status).toBe(404)

  // New versions number on from the newest
  await save('Five')
  expect(await numbers(id)).toEqual([5, 4, 2, 1])
  expect((await send(fresh, 'GET', `/entries/${id}/versions/4`)).body.data.values.title).toBe('Four')

  await send(fresh, 'POST', `/entries/${id}/archive`)
  expect(await remove(1)).toEqual({ status: 409, body: { message: 'This entry is archived. Restore it to edit it.' } })
  expect(await numbers(id)).toEqual([5, 4, 2, 1])
})

test('the cap keeps the newest versions, besides the named ones and the live one', async () => {
  const capped = createApp(db, types, { versions: { keep: 2 } })
  const { id } = (
    await send(capped, 'POST', '/types/blog/entries', { values: { title: 'v1', slug: 'capped' }, publish: true })
  ).body.data
  const save = (title: string, publish = false) =>
    send(capped, 'PUT', `/entries/${id}`, { values: { title, slug: 'capped' }, publish })

  // Version 1 is live, so it stays on top of the newest two
  for (const title of ['v2', 'v3', 'v4']) await save(title)
  expect(await numbers(id)).toEqual([4, 3, 1])

  // So does a named version
  await send(capped, 'PUT', `/entries/${id}/versions/3`, { name: 'Keep me' })
  await save('v5')
  expect(await numbers(id)).toEqual([5, 4, 3, 1])
  await save('v6')
  expect(await numbers(id)).toEqual([6, 5, 3, 1])

  // Once version 7 is live, version 1 is an old version like the others
  await save('v7', true)
  expect(await numbers(id)).toEqual([7, 6, 5, 3])

  // A save that writes no version deletes none
  await send(capped, 'PUT', `/entries/${id}/versions/3`, { name: '' })
  await save('v7')
  expect(await numbers(id)).toEqual([7, 6, 5, 3])

  // An entry saved before the cap shrinks at its next save, and with a cap of 1 its current version still stays
  const { id: old } = (await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'a', slug: 'uncapped' } }))
    .body.data
  for (const title of ['b', 'c', 'd'])
    await send(fresh, 'PUT', `/entries/${old}`, { values: { title, slug: 'uncapped' } })
  expect(await numbers(old)).toEqual([4, 3, 2, 1])
  await send(capped, 'PUT', `/entries/${old}`, { values: { title: 'e', slug: 'uncapped' } })
  expect(await numbers(old)).toEqual([5, 4])
  const single = createApp(db, types, { versions: { keep: 1 } })
  await send(single, 'PUT', `/entries/${old}`, { values: { title: 'f', slug: 'uncapped' } })
  expect(await numbers(old)).toEqual([6])
})

test('versions.keep in iight.config.ts must be a whole number from 1', () => {
  for (const keep of [0, -1, 1.5, '3', null]) {
    expect(() => createApp(db, types, { versions: { keep } as any })).toThrow(
      'versions.keep in iight.config.ts needs a whole number from 1.',
    )
  }
  expect(() => createApp(db, types, { versions: { keep: 1 } })).not.toThrow()
})

test('each version records the last time it went live, and who published it then', async () => {
  const { id } = (
    await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'Live', slug: 'history' }, publish: true })
  ).body.data
  const history = async () =>
    (await send(fresh, 'GET', `/entries/${id}/versions`)).body.data.map(
      ({ number, publishedAt, publishedBy }: any) => ({
        number,
        publishedAt,
        publishedBy,
      }),
    )
  const ada = { id: userId, name: 'Ada' }

  const [first] = await history()
  expect(first).toEqual({ number: 1, publishedAt: expect.any(String), publishedBy: ada })
  expect(first.publishedAt).toBe((await send(fresh, 'GET', `/entries/${id}`)).body.data.publishedAt)

  // Version 1 keeps its last publish once Bob publishes version 2
  await send(
    fresh,
    'PUT',
    `/entries/${id}`,
    { values: { title: 'Live again', slug: 'history' }, publish: true },
    bob.cookie,
  )
  const [second, firstAgain] = await history()
  expect(second).toEqual({ number: 2, publishedAt: expect.any(String), publishedBy: { id: bob.id, name: 'Bob' } })
  expect(firstAgain).toEqual(first)

  // Published again after being taken down, the version records the new publish
  await send(fresh, 'POST', `/entries/${id}/unpublish`)
  await send(fresh, 'PUT', `/entries/${id}`, { values: { title: 'Live again', slug: 'history' }, publish: true })
  const [again] = await history()
  expect(again).toMatchObject({ number: 2, publishedBy: ada })
  expect(again.publishedAt > second.publishedAt).toBe(true)

  // Bulk publishes and types without drafts record theirs too
  await send(fresh, 'PATCH', '/types/blog/entries', { publish: true, entries: [{ id, values: { title: 'Bulk' } }] })
  expect((await history())[0]).toEqual({ number: 3, publishedAt: expect.any(String), publishedBy: ada })
  const withoutDrafts = createApp(db, new Map([...types, ['blog', { ...blog, drafts: false }]]))
  await send(withoutDrafts, 'PUT', `/entries/${id}`, { values: { title: 'Saved', slug: 'history' } }, bob.cookie)
  expect((await history())[0]).toEqual({
    number: 4,
    publishedAt: expect.any(String),
    publishedBy: { id: bob.id, name: 'Bob' },
  })

  // Once its publisher is deleted, the publish stays without them
  await db.deleteFrom('users').where('id', '=', bob.id).execute()
  const [saved] = await history()
  expect(saved).toEqual({ number: 4, publishedAt: expect.any(String), publishedBy: null })
})

test('each version records the parent it was saved under, bulk saves included', async () => {
  const page = async (title: string, parentId: string | null = null) =>
    (await send(fresh, 'POST', '/types/docs/entries', { values: { title, slug: title.toLowerCase() }, parentId })).body
      .data
  const setup = await page('Setup')
  const help = await page('Help')
  const linux = await page('Linux', setup.id)
  await send(fresh, 'PUT', `/entries/${linux.id}`, { values: linux.values, parentId: help.id })
  await send(fresh, 'PATCH', '/types/docs/entries', { entries: [{ id: linux.id, values: { title: 'Linux guide' } }] })
  await send(fresh, 'PUT', `/entries/${linux.id}`, {
    values: { ...linux.values, title: 'Linux guide' },
    parentId: null,
  })

  const parents = []
  for (const number of [1, 2, 3, 4]) {
    parents.push((await send(fresh, 'GET', `/entries/${linux.id}/versions/${number}`)).body.data.parentId)
  }
  expect(parents).toEqual([setup.id, help.id, help.id, null])
})
