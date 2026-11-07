import { createApp } from '../src/app'
import { flattenValidationReport } from '../src/core'
import { createApiKey } from '../src/delivery'
import { db, url } from './database'
import { setUp, types } from './fixtures'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// Drafts and publishing (PLAN.md section 17): the live copies the delivery API serves, and previews of drafts

const app = createApp(db, types)
let cookie: string
let key: string
let previewKey: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  key = await createApiKey(db, 'Website')
  previewKey = await createApiKey(db, 'Previews', ['preview'])
})
beforeEach(() => db.deleteFrom('entries').execute())
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown) => {
  // Browsers send an Origin header with every POST, PUT and DELETE, which the CSRF check needs
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

interface Saving {
  id?: string
  parentId?: string | null
  publish?: boolean
}

// Save an entry, a new one or over an existing one, publishing it when asked, and fail the test if it doesn't save
const save = async (type: string, values: object, { id, parentId, publish = false }: Saving = {}) => {
  const body = { values, parentId, publish }
  const { status, body: reply } = id
    ? await send('PUT', `/entries/${id}`, body)
    : await send('POST', `/types/${type}/entries`, body)
  expect(status, JSON.stringify(reply)).toBe(id ? 200 : 201)
  return reply.data
}

const post = (title: string, publish = false) =>
  save('blog', { title, slug: title.toLowerCase().replace(/\W+/g, '-') }, { publish })

const page = (title: string, parent?: { id: string }, publish = false) =>
  save('docs', { title, slug: title.toLowerCase() }, { parentId: parent?.id ?? null, publish })

// Publish an entry as its draft stands
const publish = (entry: { id: string; type: string; values: object; parentId: string | null }) =>
  save(entry.type, entry.values, { id: entry.id, parentId: entry.parentId, publish: true })

const deliver = async (path: string, token = key) => {
  const response = await app.request(`/v1${path}`, { headers: { authorization: `Bearer ${token}` } })
  return { status: response.status, body: await response.json() }
}

// The uris of the live pages, in order
const liveUris = async () =>
  (await deliver(`/entries/docs?order=${encodeURIComponent('{"uri":"asc"}')}`)).body.data.map(
    (entry: { uri: string }) => entry.uri,
  )

test('publishing copies the draft to the live site, which keeps it as the draft changes, until it is unpublished', async () => {
  const draft = await post('Hello')
  expect(draft).toMatchObject({ status: 'draft', publishedAt: null, publishedVersion: null })
  expect((await deliver(`/entries/blog/${draft.id}`)).status).toBe(404)
  expect((await deliver('/entries/blog')).body.data).toEqual([])

  // Publish saves what it's sent first, as a new version, and makes that the live copy
  const published = await save('blog', { title: 'Hello world', slug: 'hello' }, { id: draft.id, publish: true })
  expect(published).toMatchObject({
    status: 'published',
    publishedAt: expect.any(String),
    publishedVersion: 2,
    values: { title: 'Hello world' },
  })
  const { archivedAt, createdBy, updatedBy, status, version, publishedVersion, ...delivered } = published
  expect((await deliver(`/entries/blog/${draft.id}`)).body.data).toEqual(delivered)

  // A draft save leaves the live copy as it was, its updatedAt included
  const changed = await save('blog', { title: 'Hello again', slug: 'hello' }, { id: draft.id })
  expect(changed).toMatchObject({ status: 'changed', publishedVersion: 2, publishedAt: published.publishedAt })
  expect(changed.updatedAt).not.toBe(published.updatedAt)
  expect((await deliver(`/entries/blog/${draft.id}`)).body.data).toEqual(delivered)
  expect((await deliver('/entries/blog/slug/hello')).body.data.values.title).toBe('Hello world')

  // Unpublishing takes the live copy down and keeps the draft, and doing it again changes nothing
  const unpublished = await send('POST', `/entries/${draft.id}/unpublish`)
  expect(unpublished.body.data).toMatchObject({
    status: 'draft',
    publishedAt: null,
    publishedVersion: null,
    values: { title: 'Hello again' },
  })
  expect((await deliver(`/entries/blog/${draft.id}`)).status).toBe(404)
  expect((await send('POST', `/entries/${draft.id}/unpublish`)).status).toBe(200)

  // A new entry can go live as it's created
  const created = await post('Second', true)
  expect(created).toMatchObject({ status: 'published', publishedVersion: 1 })
  expect((await deliver('/entries/blog/slug/second')).body.data.id).toBe(created.id)
})

test('a draft can be saved unfinished, but a publish runs every check, and saves nothing when one fails', async () => {
  const entry = await post('Hello')
  const invalid = await send('PUT', `/entries/${entry.id}`, { values: { slug: 'hello' }, publish: true })
  expect(invalid.status).toBe(422)
  expect(invalid.body.fields.title).toEqual({ isValid: false, messages: ['This field is required.'] })
  expect((await send('GET', `/entries/${entry.id}/versions`)).body.data).toHaveLength(1)

  // Required fields, minimum lengths and minimum counts can wait for the publish, but other checks can't
  const unfinished = await save('blog', { blocks: [{ _layout: 'gallery', images: [] }] })
  expect(unfinished).toMatchObject({ status: 'draft', slug: null, values: { blocks: [{ images: [] }] } })
  const wrong = await send('POST', '/types/blog/entries', { values: { slug: 'Not a slug', related: 'nope' } })
  expect(Object.keys(flattenValidationReport(wrong.body).messages)).toEqual(['slug', 'related'])

  expect(await send('PUT', `/entries/${unfinished.id}`, { values: unfinished.values, publish: true })).toMatchObject({
    status: 422,
    body: { isValid: false },
  })
  expect((await send('GET', `/entries/${entry.id}/versions`)).body.data).toHaveLength(1)
  expect((await send('GET', `/entries/${entry.id}`)).body.data).toMatchObject({
    status: 'draft',
    values: { title: 'Hello' },
  })
  expect((await deliver(`/entries/blog/${entry.id}`)).status).toBe(404)
})

test('a publish replies 422 on the slug when a live entry keeps it, though its draft has moved on', async () => {
  const taken = { isValid: false, messages: ['A published entry here already uses this slug.'] }
  const first = await save('blog', { title: 'Hello', slug: 'hello' }, { publish: true })

  // Its draft takes another slug, which frees hello for drafts, but the live copy keeps it until it's published again
  await save('blog', { title: 'Hello', slug: 'hello-2' }, { id: first.id })
  const second = await save('blog', { title: 'Hi', slug: 'hello' })
  const clash = await send('PUT', `/entries/${second.id}`, { values: { title: 'Hi', slug: 'hello' }, publish: true })
  expect(clash.status).toBe(422)
  expect(clash.body.fields.slug).toEqual(taken)

  await publish(await save('blog', { title: 'Hello', slug: 'hello-2' }, { id: first.id }))
  await publish(second)
  expect((await deliver('/entries/blog/slug/hello')).body.data.id).toBe(second.id)
  expect((await deliver('/entries/blog/slug/hello-2')).body.data.id).toBe(first.id)

  // The database stops two live entries sharing one, should a publish get past the check
  await expect(
    db.updateTable('published_entries').set({ slug: 'hello' }).where('id', '=', first.id).execute(),
  ).rejects.toThrow('published_entries_slug_unique')
})

test('a page goes live only under a live parent, and unpublishing takes the live pages under it down too', async () => {
  const guide = await page('Guide')
  const install = await page('Install', guide)
  const body = { values: install.values, parentId: guide.id, publish: true }
  expect(await send('PUT', `/entries/${install.id}`, body)).toEqual({
    status: 409,
    body: { message: "Its parent isn't published. Publish the parent first." },
  })
  expect((await send('GET', `/entries/${install.id}/versions`)).body.data).toHaveLength(1)

  await publish(guide)
  await publish(install)
  const linux = await page('Linux', install, true)
  expect(await liveUris()).toEqual(['guide', 'guide/install', 'guide/install/linux'])

  // The drafts stay as they were
  expect((await send('POST', `/entries/${install.id}/unpublish`)).body.data.status).toBe('draft')
  expect(await liveUris()).toEqual(['guide'])
  expect((await send('GET', `/entries/${linux.id}`)).body.data).toMatchObject({ status: 'draft', archivedAt: null })
  expect((await deliver('/entries/docs/uri/guide/install/linux')).status).toBe(404)
})

test('archiving takes an entry and the pages under it off the live site, and restoring gives back drafts', async () => {
  const guide = await page('Guide', undefined, true)
  const install = await page('Install', guide, true)
  // A page whose draft has moved out from under it is still under it on the live site
  const faq = await page('FAQ', guide, true)
  await save('docs', faq.values, { id: faq.id, parentId: null })

  await send('POST', `/entries/${guide.id}/archive`)
  expect(await liveUris()).toEqual([])
  expect((await send('GET', `/entries/${faq.id}`)).body.data).toMatchObject({ archivedAt: null, status: 'draft' })

  const restored = await send('POST', `/entries/${guide.id}/restore`)
  expect(restored.body.data).toMatchObject({ archivedAt: null, status: 'draft', publishedVersion: null })
  expect((await send('GET', `/entries/${install.id}`)).body.data).toMatchObject({ archivedAt: null, status: 'draft' })
  expect(await liveUris()).toEqual([])

  await publish(guide)
  await publish(install)
  expect(await liveUris()).toEqual(['guide', 'guide/install'])
})

test("a page's live uri comes from its live parents, so a new slug or parent reaches the live site with Publish", async () => {
  const guide = await page('Guide', undefined, true)
  const install = await page('Install', guide, true)

  const handbook = await save('docs', { title: 'Guide', slug: 'handbook' }, { id: guide.id })
  expect(await liveUris()).toEqual(['guide', 'guide/install'])
  expect((await send('GET', `/entries/${install.id}`)).body.data.uri).toBe('handbook/install')

  await publish(handbook)
  expect(await liveUris()).toEqual(['handbook', 'handbook/install'])
  expect((await deliver('/entries/docs/uri/handbook/install')).body.data.id).toBe(install.id)

  // A page can't be under itself on the live site, so swapping two pages publishes the new parent first
  const top = await save('docs', install.values, { id: install.id, parentId: null })
  const under = await save('docs', handbook.values, { id: guide.id, parentId: install.id })
  expect(
    await send('PUT', `/entries/${guide.id}`, { values: under.values, parentId: install.id, publish: true }),
  ).toEqual({ status: 409, body: { message: 'Its parent is under it on the live site. Publish the parent first.' } })
  await publish(top)
  await publish(under)
  expect(await liveUris()).toEqual(['install', 'install/handbook'])
})

test('a type without drafts publishes every save, after every check, and its entries are live until archived', async () => {
  const settings = createApp(db, new Map([...types, ['home', { ...types.get('home')!, drafts: false }]]))
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await settings.request(`/api${path}`, {
      method,
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  const { id } = (await request('GET', '/types/home/singleton')).body.data
  const unfinished = await request('PUT', `/entries/${id}`, { values: { intro: 'Hi' } })
  expect(unfinished.status).toBe(422)
  expect(unfinished.body.fields.headline).toEqual({ isValid: false, messages: ['This field is required.'] })

  const saved = await request('PUT', `/entries/${id}`, { values: { headline: 'Hello' } })
  expect(saved.body.data).toMatchObject({ status: 'published', publishedVersion: 1 })
  expect((await deliver('/entries/home')).body.data).toMatchObject([{ id, values: { headline: 'Hello' } }])

  expect(await request('POST', `/entries/${id}/unpublish`)).toEqual({
    status: 409,
    body: { message: "Homepage has no drafts, so its entries are live until they're archived." },
  })
  expect((await request('POST', `/entries/${id}/archive`)).body.data.status).toBe('draft')
  expect((await deliver('/entries/home')).body.data).toEqual([])
})

test('moving a page among its siblings changes the live order at once', async () => {
  const [, , c] = [await page('A', undefined, true), await page('B', undefined, true), await page('C', undefined, true)]
  await send('PUT', `/entries/${c.id}/position`, { position: 0 })

  const order = encodeURIComponent('{"position":"asc"}')
  const live = (await deliver(`/entries/docs?order=${order}`)).body.data
  expect(live.map((entry: { slug: string }) => entry.slug)).toEqual(['c', 'a', 'b'])
  // It isn't a draft change, so nothing waits to be published
  expect((await send('GET', `/entries/${c.id}`)).body.data.status).toBe('published')
})

test('a preview key reads drafts with status=draft, with links to drafts, and other keys get a 403', async () => {
  const ada = await save('authors', { name: 'Ada' })
  const live = await save('blog', { title: 'Live', slug: 'live', author: ada.id }, { publish: true })
  await save('blog', { title: 'Live, edited', slug: 'live', author: ada.id }, { id: live.id })
  const draft = await post('Draft')
  const old = await post('Old', true)
  await send('POST', `/entries/${old.id}/archive`)

  expect(await deliver('/entries/blog?status=draft')).toEqual({
    status: 403,
    body: { message: "This key can't read drafts. Make one that can with sorlo make:api-key --preview." },
  })
  expect((await deliver(`/entries/blog/${live.id}?status=draft`)).status).toBe(403)
  expect((await deliver('/media?status=draft')).status).toBe(403)
  expect(await deliver('/entries/blog?status=live', previewKey)).toEqual({
    status: 400,
    body: { message: 'status must be published or draft.' },
  })

  // Without status=draft, a preview key reads what's live like any key. Archived entries are left out either way.
  const titles = async (query = '') =>
    (await deliver(`/entries/blog${query}`, previewKey)).body.data.map((entry: any) => entry.values.title)
  expect(await titles()).toEqual(['Live'])
  expect(await titles('?status=draft')).toEqual(['Live, edited', 'Draft'])

  const found = (await deliver(`/entries/blog/${draft.id}?status=draft`, previewKey)).body.data
  expect(found).toMatchObject({ id: draft.id, publishedAt: null, values: { title: 'Draft' } })
  expect((await deliver('/entries/blog/slug/draft?status=draft', previewKey)).body.data.id).toBe(draft.id)
  expect((await deliver(`/entries/blog/${old.id}?status=draft`, previewKey)).status).toBe(404)

  // Links go to live entries only, or in a preview, to drafts
  const author = async (query = '') =>
    (await deliver(`/entries/blog/${live.id}?with=${encodeURIComponent('["author"]')}${query}`, previewKey)).body.data
      .values.author
  expect(await author()).toBeNull()
  expect(await author('&status=draft')).toMatchObject({ id: ada.id, publishedAt: null, values: { name: 'Ada' } })
})

test('sorlo make:api-key --preview makes a key that can read drafts', async () => {
  // A site project with just enough config for the command
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  const bin = fileURLToPath(new URL('../bin/sorlo.js', import.meta.url))

  try {
    const made = async (args: Array<string>) => {
      const running = promisify(execFile)(process.execPath, [bin, 'make:api-key', ...args], { cwd: dir })
      running.child.stdin!.end('Previews\n')
      const { stdout } = await running
      return { stdout, key: stdout.trim().split('\n').at(-1)! }
    }

    const preview = await made(['--preview'])
    expect(preview.stdout).toContain('Created the preview key Previews. It can read drafts, so keep it on a server.')
    expect((await deliver('/entries/blog?status=draft', preview.key)).status).toBe(200)
    expect((await deliver('/entries/blog?status=draft', (await made([])).key)).status).toBe(403)
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)
