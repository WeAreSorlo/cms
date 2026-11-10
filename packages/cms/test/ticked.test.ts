import { hundredOf } from '../admin/lists'
import { createApp } from '../src/app'
import type { ContentType } from '../src/types'
import { db } from './database'
import { setUp, types } from './fixtures'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// Ticked entries: Select all's ids, and archiving and restoring ticked entries a hundred at a time

// Pages that link to each other, for counting the links bulk Archive warns of
const pages: ContentType = {
  id: 'typ_pages',
  name: 'pages',
  label: 'Pages',
  structure: 'hierarchical',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    { id: 'fld_page_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_page_slug', type: 'identifier', name: 'slug', label: 'Slug', required: true },
    { id: 'fld_page_links', type: 'relationship', name: 'links', options: { types: ['typ_pages'] } },
  ],
}

const app = createApp(db, new Map([...types, ['pages', pages]]))
let cookie: string

beforeAll(async () => ({ cookie } = await setUp()))
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('events').execute()
})
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown) => {
  // Browsers send an Origin header with every POST, PUT and DELETE, which the CSRF check needs
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

// Create an entry, publishing it when asked, and fail the test if it doesn't save
const create = async (type: string, values: object, parentId: string | null = null, publish = false) => {
  const { status, body } = await send('POST', `/types/${type}/entries`, { values, parentId, publish })
  expect(status, JSON.stringify(body)).toBe(201)
  return body.data
}

const post = (title: string, views: number) => create('blog', { title, slug: title.toLowerCase(), views })

const page = (title: string, parent?: { id: string }, publish = false) =>
  create('docs', { title, slug: title.toLowerCase() }, parent?.id ?? null, publish)

const ids = (type: string, query: Record<string, unknown> = {}) => {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  )
  return send('GET', `/types/${type}/entries/ids?${params}`)
}

const act = (action: 'archive' | 'restore', type: string, ids: Array<unknown>) =>
  send('POST', `/types/${type}/entries/${action}`, { ids })

// Each entry's archived_at by slug, null for those that aren't archived
const stamps = async () =>
  Object.fromEntries(
    (await db.selectFrom('entries').select(['slug', 'archived_at']).execute()).map((row) => [
      row.slug,
      row.archived_at?.toISOString() ?? null,
    ]),
  )

// The events written since the test started, as name and slug, sorted
const events = async () =>
  (await db.selectFrom('events').select(['name', 'data']).execute())
    .map((event) => `${event.name} ${event.data.entry.slug}`)
    .sort()

const missing = '0192f0c4-0000-7000-8000-000000000000'

test("Select all finds every entry the list's query finds, in the order the list pages them", async () => {
  const lamp = await post('Lamp', 3)
  const chair = await post('Chair', 10)
  const stool = await post('Stool', 7)
  const desk = await post('Desk', 10)
  const old = await post('Old', 5)
  await send('POST', `/entries/${old.id}/archive`)
  await create('authors', { name: 'Ada' })

  // Ties keep the order they were made in, by id, as the list's pages do
  const order = { 'values.views': 'desc' }
  const all = await ids('blog', { order })
  expect(all).toEqual({ status: 200, body: { data: [chair.id, desk.id, stool.id, lamp.id] } })
  const pages = []
  for (const at of [1, 2]) {
    const { body } = await send('GET', `/types/blog/entries?order=${JSON.stringify(order)}&perPage=2&page=${at}`)
    pages.push(...body.data.map((entry: { id: string }) => entry.id))
  }
  expect(pages).toEqual(all.body.data)

  const where = [[{ field: 'values.views', op: '>', value: 5 }]]
  expect((await ids('blog', { where, order: { 'values.views': 'asc' } })).body.data).toEqual([
    stool.id,
    chair.id,
    desk.id,
  ])
  expect((await ids('blog', { archived: 'true' })).body.data).toEqual([old.id])

  // The list's own checks, so a where or order it can't take gets the same reply
  for (const bad of [{ where: [[{ field: 'values.nope', op: '=', value: 1 }]] }, { order: { title: 'up' } }]) {
    const params = new URLSearchParams(Object.entries(bad).map(([key, value]) => [key, JSON.stringify(value)]))
    expect(await ids('blog', bad)).toEqual(await send('GET', `/types/blog/entries?${params}`))
    expect((await ids('blog', bad)).status).toBe(400)
  }
  expect((await ids('nope')).status).toBe(404)
})

test('Select all refuses past 10,000 entries', async () => {
  await sql`
    insert into entries (id, type, values)
    select gen_random_uuid(), 'blog', jsonb_build_object('title', 'Post ' || n) from generate_series(1, 10001) n
  `.execute(db)
  expect(await ids('blog')).toEqual({
    status: 400,
    body: { message: 'More than 10,000 entries match. Narrow the search or filter to 10,000 or fewer.' },
  })

  await sql`delete from entries where id = (select id from entries limit 1)`.execute(db)
  expect((await ids('blog')).body.data).toHaveLength(10_000)
})

test('archives ticked entries with the pages under them, stamped with one time, with a result for each', async () => {
  const guide = await page('Guide', undefined, true)
  const install = await page('Install', guide, true)
  await page('Linux', install)
  const faq = await page('FAQ', undefined, true)
  const old = await page('Old')
  await send('POST', `/entries/${old.id}/archive`)
  const post = await create('blog', { title: 'Hello', slug: 'hello' })
  await db.deleteFrom('events').execute()
  const before = await stamps()

  const { status, body } = await act('archive', 'docs', [
    install.id,
    faq.id,
    guide.id,
    old.id,
    post.id,
    'nope',
    missing,
  ])
  expect(status).toBe(200)
  const gone = { status: 404, message: "There's no entry of this type with this id." }
  expect(body.data).toEqual([
    { id: install.id, status: 200, data: expect.objectContaining({ id: install.id, archivedAt: expect.any(String) }) },
    { id: faq.id, status: 200, data: expect.objectContaining({ id: faq.id, archivedAt: expect.any(String) }) },
    { id: guide.id, status: 200, data: expect.objectContaining({ id: guide.id, status: 'draft' }) },
    // One already archived stays as it was
    { id: old.id, status: 200, data: expect.objectContaining({ id: old.id, archivedAt: before.old }) },
    { id: post.id, ...gone },
    { id: 'nope', ...gone },
    { id: missing, ...gone },
  ])

  const after = await stamps()
  expect(after.guide).not.toBeNull()
  expect([after.install, after.linux, after.faq]).toEqual([after.guide, after.guide, after.guide])
  expect(after.old).toBe(before.old)
  expect(after.hello).toBeNull()
  // Off the live site, the pages under them included
  expect(await events()).toEqual([
    'entry.archived faq',
    'entry.archived guide',
    'entry.archived install',
    'entry.archived linux',
    'entry.unpublished faq',
    'entry.unpublished guide',
    'entry.unpublished install',
  ])

  // Restoring one brings back what was archived along with it, not the others archived at the same time
  await send('POST', `/entries/${guide.id}/restore`)
  expect(await stamps()).toMatchObject({ guide: null, install: null, linux: null, faq: after.faq })
})

test('restores ticked entries parents first, and refuses a page whose parent stays archived', async () => {
  const guide = await page('Guide')
  const install = await page('Install', guide)
  const linux = await page('Linux', install)
  const faq = await page('FAQ')
  const old = await page('Old')
  const windows = await page('Windows', old)
  const kept = await page('Kept')
  const post = await create('blog', { title: 'Hello', slug: 'hello' })
  // Linux has a time of its own, so restoring Guide leaves it archived, until it comes back after Install
  for (const entry of [linux, guide, faq, old, post]) await send('POST', `/entries/${entry.id}/archive`)
  await db.deleteFrom('events').execute()

  const sent = [linux.id, windows.id, install.id, guide.id, faq.id, kept.id, post.id, missing]
  const { status, body } = await act('restore', 'docs', sent)
  expect(status).toBe(200)
  expect(body.data.map((result: { id: string; status: number }) => [result.id, result.status])).toEqual([
    [linux.id, 200],
    [windows.id, 409],
    [install.id, 200],
    [guide.id, 200],
    [faq.id, 200],
    [kept.id, 200],
    [post.id, 404],
    [missing, 404],
  ])
  expect(body.data[1]).toEqual({
    id: windows.id,
    status: 409,
    message: 'Its parent is archived. Restore the parent first.',
  })
  expect(body.data[0].data).toMatchObject({ id: linux.id, archivedAt: null, status: 'draft' })

  expect(await stamps()).toMatchObject({ guide: null, install: null, linux: null, faq: null, kept: null })
  expect((await stamps()).windows).not.toBeNull()
  expect((await stamps()).hello).not.toBeNull()
  expect(await events()).toEqual([
    'entry.restored faq',
    'entry.restored guide',
    'entry.restored install',
    'entry.restored linux',
  ])
})

test('archive and restore take 1 to 100 ids, each sent once, of a type with more than one entry', async () => {
  const hello = await create('blog', { title: 'Hello', slug: 'hello' })
  const many = Array.from({ length: 101 }, (_, at) => `id${at}`)
  for (const action of ['archive', 'restore'] as const) {
    for (const ids of [undefined, [], many, [1], [hello.id, hello.id]]) {
      const { status, body } = await act(action, 'blog', ids as Array<unknown>)
      expect(status, JSON.stringify(ids)).toBe(400)
      expect(body.message).toMatch(/^(ids must list 1 to 100 entry ids|Each entry can only be sent once)\.$/)
    }
    expect(await act(action, 'home', [hello.id])).toEqual({
      status: 409,
      body: { message: 'A singleton has one entry, open it.' },
    })
    expect((await act(action, 'nope', [hello.id])).status).toBe(404)
  }
  expect((await stamps()).hello).toBeNull()
})

test("the grid finds its hundred among the list's ticks, as a page of them", () => {
  const ticked = Array.from({ length: 250 }, (_, at) => `id${at}`)
  const pages = { perPage: 100, total: 250, lastPage: 3 }
  expect(hundredOf(ticked, ticked.slice(0, 100))).toEqual({ page: 1, ...pages })
  expect(hundredOf(ticked, ticked.slice(100, 200))).toEqual({ page: 2, ...pages })
  expect(hundredOf(ticked, ticked.slice(200))).toEqual({ page: 3, ...pages })

  // Not one of the hundreds: one that starts elsewhere, falls short, or is out of order, or no ticks, as after a reload
  expect(hundredOf(ticked, ticked.slice(50, 150))).toBeUndefined()
  expect(hundredOf(ticked, ticked.slice(0, 99))).toBeUndefined()
  expect(hundredOf(ticked, ticked.slice(0, 100).reverse())).toBeUndefined()
  expect(hundredOf([], ticked.slice(0, 100))).toBeUndefined()
  // A hundred or fewer need no pages
  expect(hundredOf(ticked.slice(0, 100), ticked.slice(0, 100))).toBeUndefined()
})

test('ids in capitals are the same entries, so each is sent once, and its result keeps the id as it was sent', async () => {
  const hello = await create('blog', { title: 'Hello', slug: 'hello' })
  const loud = hello.id.toUpperCase()
  const once = { status: 400, body: { message: 'Each entry can only be sent once.' } }
  expect(await act('archive', 'blog', [hello.id, loud])).toEqual(once)
  expect(await act('restore', 'blog', [loud, hello.id])).toEqual(once)
  expect(await send('POST', '/types/blog/entries/used-by', { ids: [hello.id, loud] })).toEqual(once)
  // As bulk saves take them
  expect(
    await send('PATCH', '/types/blog/entries', { entries: [hello.id, loud].map((id) => ({ id, values: {} })) }),
  ).toEqual(once)

  expect((await act('archive', 'blog', [loud])).body.data).toEqual([
    { id: loud, status: 200, data: expect.objectContaining({ id: hello.id, archivedAt: expect.any(String) }) },
  ])
  expect((await act('restore', 'blog', [loud])).body.data).toEqual([
    { id: loud, status: 200, data: expect.objectContaining({ id: hello.id, archivedAt: null }) },
  ])

  // A refusal keeps to the id as sent too
  const guide = await page('Guide')
  const install = await page('Install', guide)
  await send('POST', `/entries/${guide.id}/archive`)
  expect((await act('restore', 'docs', [install.id.toUpperCase()])).body.data).toEqual([
    { id: install.id.toUpperCase(), status: 409, message: 'Its parent is archived. Restore the parent first.' },
  ])
})

test('bulk Archive counts the ticked entries, with the pages under them, that other entries link to', async () => {
  const link = (title: string, links: Array<{ id: string }> = [], parent?: { id: string }) =>
    create('pages', { title, slug: title.toLowerCase(), links: links.map((page) => page.id) }, parent?.id ?? null)
  const guide = await link('Guide')
  const install = await link('Install', [], guide)
  const manual = await link('Manual')
  const setup = await link('Setup', [], manual)
  const contact = await link('Contact')
  const faq = await link('FAQ', [contact])
  const gone = await link('Gone')
  // Home links to the page under Manual, Start to Guide and the page under it, FAQ to Contact, Old, once archived, to
  // FAQ, and Tour to Gone, once archived
  await link('Home', [setup])
  await link('Start', [guide, install])
  const old = await link('Old', [faq])
  const tour = await link('Tour', [gone])
  for (const archived of [old, gone]) await send('POST', `/entries/${archived.id}/archive`)
  const other = await create('blog', { title: 'Other', slug: 'other' })
  await create('blog', { title: 'Linker', slug: 'linker', related: [other.id] })
  const usedBy = async (ids: Array<string>) => (await send('POST', '/types/pages/entries/used-by', { ids })).body

  // Guide through the page under it, counted once, but not FAQ, whose one link is from an archived page, nor Contact,
  // whose link is from FAQ, which goes with it, nor entries of another type, nor ids that aren't entries
  expect(await usedBy([guide.id, faq.id, contact.id, other.id, 'nope', missing])).toEqual({ data: { count: 1 } })
  expect(await usedBy([guide.id, install.id])).toEqual({ data: { count: 2 } })
  expect(await usedBy([manual.id])).toEqual({ data: { count: 1 } })
  // On its own, Contact's link from FAQ counts
  expect(await usedBy([contact.id])).toEqual({ data: { count: 1 } })
  // One already archived has nothing left to lose, though Tour still links to it
  expect(await usedBy([gone.id])).toEqual({ data: { count: 0 } })
  expect(await usedBy([tour.id])).toEqual({ data: { count: 0 } })

  const many = Array.from({ length: 10_001 }, (_, at) => `id${at}`)
  expect(await send('POST', '/types/pages/entries/used-by', { ids: many })).toEqual({
    status: 400,
    body: { message: 'ids must list 1 to 10,000 entry ids.' },
  })
  expect(await send('POST', '/types/home/entries/used-by', { ids: [guide.id] })).toEqual({
    status: 409,
    body: { message: 'A singleton has one entry, open it.' },
  })
  expect((await send('POST', '/types/nope/entries/used-by', { ids: [guide.id] })).status).toBe(404)
})
