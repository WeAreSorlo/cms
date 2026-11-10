import type { DraftEntry } from '../src'
import { createApp } from '../src/app'
import { createApiKey } from '../src/delivery'
import { db } from './database'
import { setUp, types } from './fixtures'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'

// The editor's Preview button: previews in sorlo.config.ts, which the admin opens through the CMS

const seen: Array<DraftEntry> = []
const previews = {
  // An address for each entry from its saved draft, or nothing before it has a slug
  blog: async ({ entry }: { entry: DraftEntry }) => {
    seen.push(entry)
    return entry.slug && `https://example.com/api/preview?secret=s3cret&path=/blog/${entry.slug}`
  },
  docs: 'https://example.com/docs',
  authors: () => 'javascript:alert(document.cookie)',
  home: () => {
    throw new Error('The site is down')
  },
}
const app = createApp(db, types, { previews })
let cookie: string
let previewKey: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  previewKey = await createApiKey(db, 'Previews', ['preview'])
})
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  seen.length = 0
})
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown, to = app) => {
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await to.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return response
}
const save = async (type: string, values: object, publish = false) =>
  (await (await send('POST', `/types/${type}/entries`, { values, publish })).json()).data

// What a Preview button's tab gets: a redirect's status and address, or a page's status and paragraph
const preview = async (id: string, to = app) => {
  const response = await send('GET', `/entries/${id}/preview`, undefined, to)
  const text = response.headers.get('content-type')?.startsWith('text/html')
    ? (await response.text()).match(/<p>(.*)<\/p>/)?.[1]
    : null
  return { status: response.status, location: response.headers.get('location'), text }
}
const none = "There's no preview of this entry on the site."
const failed = "The address of this entry's preview couldn't be worked out. The server's log says why."

test('the types reply names the types with a Preview button', async () => {
  const { previews: named } = await (await send('GET', '/types')).json()
  expect(named).toEqual(['blog', 'docs', 'authors', 'home'])
})

test('a function gets the saved draft as the delivery API replies it to a preview key, and its address is followed', async () => {
  const post = await save('blog', { title: 'Hello', slug: 'hello', views: 3 })
  expect(await preview(post.id)).toEqual({
    status: 302,
    location: 'https://example.com/api/preview?secret=s3cret&path=/blog/hello',
    text: null,
  })

  const delivered = await app.request('/v1/entries/blog?status=draft', {
    headers: { authorization: `Bearer ${previewKey}` },
  })
  expect(seen).toEqual((await delivered.json()).data)
  expect(seen[0]).toMatchObject({ values: { title: 'Hello', views: 3 }, publishedAt: null })
  expect(typeof seen[0].createdAt).toBe('string')

  // Nothing, as before a draft has its slug, gives no preview
  const unfinished = await save('blog', { title: 'No slug yet' })
  expect(await preview(unfinished.id)).toEqual({ status: 404, location: null, text: none })
})

test('an address is followed as it is, and an archived entry has no preview, as delivery leaves it out', async () => {
  const page = await save('docs', { title: 'Install', slug: 'install' })
  expect(await preview(page.id)).toMatchObject({ status: 302, location: 'https://example.com/docs' })

  const post = await save('blog', { title: 'Gone', slug: 'gone' })
  await send('POST', `/entries/${post.id}/archive`)
  expect(await preview(post.id)).toEqual({ status: 404, location: null, text: none })
  expect(seen).toEqual([])
})

test("only http and https addresses are followed, and a function's failure is logged, never shown", async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const author = await save('authors', { name: 'Ada' })
    expect(await preview(author.id)).toEqual({ status: 500, location: null, text: failed })
    expect(error).toHaveBeenLastCalledWith(
      "previews.authors in sorlo.config.ts gave an address that isn't http or https.",
    )

    const home = (await (await send('GET', '/types/home/singleton')).json()).data
    expect(await preview(home.id)).toEqual({ status: 500, location: null, text: failed })
    expect(error).toHaveBeenLastCalledWith('previews.home in sorlo.config.ts failed:', new Error('The site is down'))
  } finally {
    error.mockRestore()
  }
})

test("a type left out of previews has no preview, and the route needs a session, as the admin's do", async () => {
  const post = await save('blog', { title: 'Hello', slug: 'hello' })
  expect(await preview(post.id, createApp(db, types))).toEqual({ status: 404, location: null, text: none })
  expect((await app.request(`/api/entries/${post.id}/preview`)).status).toBe(401)
})

test('previews are checked as the servers start: addresses must be http or https, and unknown types get a warning', () => {
  expect(() => createApp(db, types, { previews: { blog: 'example.com/blog' } })).toThrow(
    'previews.blog in sorlo.config.ts needs to be an http or https address, or a function giving one.',
  )
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    createApp(db, types, { previews: { posts: 'https://example.com', blog: undefined } })
    expect(warn.mock.calls).toEqual([
      ['previews.posts in sorlo.config.ts names no content type, so nothing has a Preview button.'],
    ])
  } finally {
    warn.mockRestore()
  }
})
