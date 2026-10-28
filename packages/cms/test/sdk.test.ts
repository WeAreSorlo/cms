import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { typesFile } from '../src/typescript'
import { db } from './database'
import { blog, setUp, types } from './fixtures'
import { serve } from '@hono/node-server'
import { IightError, createClient } from '@iight/sdk'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

// The SDK against the delivery API, served on a real port as a frontend would reach it
let url: string
let key: string
let server: ReturnType<typeof serve>

beforeAll(async () => {
  await setUp()
  key = await createApiKey(db, 'Website')

  const post = (title: string, slug: string, values: object, createdAt: string) => ({
    id: uuidv7(),
    type: 'blog',
    slug,
    values: { title, slug, ...values },
    created_at: new Date(createdAt),
  })
  const posts = [
    post('Release 1.0', 'release-1', { views: 10, featured: true }, '2026-01-10'),
    post('Hello world', 'hello-world', { views: 5 }, '2026-02-01'),
    post('Release 2.0', 'release-2', { views: 50, featured: false }, '2026-03-01'),
    // Enough for all() to need a second page
    ...Array.from({ length: 100 }, (_, i) => post(`Post ${i}`, `post-${i}`, { views: 0 }, '2026-04-01')),
  ]
  await db.insertInto('entries').values(posts).execute()
  // Each with the version a save writes, since the delivery API serves saved entries only
  await db
    .insertInto('entry_versions')
    .values(posts.map(({ id, values }) => ({ entry_id: id, number: 1, values })))
    .execute()

  const app = createApp(db, types)
  const { port } = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, resolve)
  })
  url = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  server.close()
  await db.destroy()
})

const slugs = (entries: Array<{ slug: string | null }>) => entries.map((entry) => entry.slug)

test("the query builder sends the delivery API's query format", async () => {
  const requests: Array<URL> = []
  const cms = createClient({
    url: `${url}/`,
    token: key,
    fetch: (input, init) => {
      requests.push(new URL(String(input)))
      return fetch(input, init)
    },
  })

  const { data, pagination } = await cms
    .entries('blog')
    .where('values.featured', '=', true)
    .orWhere('values.title', 'like', 'hello')
    .where('values.views', '>', 1)
    .orderBy('values.views', 'desc')
    .paginate(10)

  expect(requests[0].pathname).toBe('/v1/entries/blog')
  expect(Object.fromEntries(requests[0].searchParams)).toEqual({
    page: '1',
    perPage: '10',
    where: JSON.stringify([
      [{ field: 'values.featured', op: '=', value: true }],
      [
        { field: 'values.title', op: 'like', value: 'hello' },
        { field: 'values.views', op: '>', value: 1 },
      ],
    ]),
    order: '{"values.views":"desc"}',
  })
  expect(slugs(data)).toEqual(['release-1', 'hello-world'])
  expect(pagination).toEqual({ page: 1, perPage: 10, total: 2, lastPage: 1 })
})

test('the delivery API takes every shape of value the builder sends', async () => {
  const blog = () => createClient({ url, token: key }).entries('blog')
  const find = async (query: ReturnType<typeof blog>) => slugs((await query.orderBy('createdAt').paginate(5)).data)

  expect(await find(blog().where('values.views', 'in', [5, 50]))).toEqual(['hello-world', 'release-2'])
  expect(await find(blog().where('values.views', 'not between', [0, 9]))).toEqual(['release-1', 'release-2'])
  expect(await find(blog().where('values.featured', 'exists'))).toEqual(['release-1', 'release-2'])
  expect(await find(blog().where('slug', 'not like', 'post').where('createdAt', '<', new Date('2026-02-15')))).toEqual([
    'release-1',
    'hello-world',
  ])

  const { data, pagination } = await blog().where('slug', 'like', 'post').orderBy('createdAt', 'asc').paginate(40, 3)
  expect(data).toHaveLength(20)
  expect(pagination).toEqual({ page: 3, perPage: 40, total: 100, lastPage: 3 })
})

test('first() finds the first match or null, and all() fetches every page', async () => {
  const cms = createClient({ url, token: key })

  expect((await cms.entries('blog').orderBy('values.views', 'desc').first())?.slug).toBe('release-2')
  expect(await cms.entries('blog').where('values.title', '=', 'Nope').first()).toBeNull()

  const all = await cms.entries('blog').all()
  expect(all).toHaveLength(103)
  expect(new Set(all.map((entry) => entry.id)).size).toBe(103)
  expect(slugs(await cms.entries('blog').where('values.featured', '=', true).all())).toEqual(['release-1'])
})

test("a failed request throws an IightError with the status and the API's message", async () => {
  const failure = (promise: Promise<unknown>) => promise.catch((error) => error)
  const cms = createClient({ url, token: key })

  const unauthenticated = await failure(createClient({ url, token: 'nope' }).entries('blog').first())
  expect(unauthenticated).toBeInstanceOf(IightError)
  expect(unauthenticated).toMatchObject({
    status: 401,
    message: 'Unauthenticated.',
    body: { message: 'Unauthenticated.' },
  })

  expect(await failure(cms.entries('nope' as 'blog').first())).toMatchObject({ status: 404, message: 'Not Found' })
  expect(
    await failure(
      cms
        .entries('blog')
        .where('values.views', 'in', 5 as never)
        .first(),
    ),
  ).toMatchObject({
    status: 400,
    message: 'values.views in needs a list of values.',
  })
})

test('generates a type for each content type, registered with the SDK', async () => {
  // sdk.test-d.ts typechecks queries against this file, so it also shows the generated types compile
  await expect(typesFile(types)).toMatchFileSnapshot('./iight-types.d.ts')

  const optional = blog.fields.map((field) => (field.name === 'slug' ? { ...field, required: false } : field))
  expect(typesFile(new Map([['news', { ...blog, name: 'news', fields: optional }]]))).toContain(
    '  slug: string | null\n',
  )
})

test('GET /types serves the generated types to API keys', async () => {
  expect((await fetch(`${url}/types`)).status).toBe(401)

  const response = await fetch(`${url}/types`, { headers: { authorization: `Bearer ${key}` } })
  expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
  expect(await response.text()).toBe(typesFile(types))
})

test('types pull writes the types into a frontend, and --check fails when they are out of date', async () => {
  const bin = fileURLToPath(new URL('../../sdk/bin/iight.js', import.meta.url))
  const dir = await mkdtemp(join(tmpdir(), 'iight-frontend-'))
  const file = join(dir, 'src/iight-types.d.ts')
  const pull = (args: Array<string>, token = key) =>
    promisify(execFile)(process.execPath, [bin, 'types', 'pull', ...args], {
      cwd: dir,
      env: { ...process.env, IIGHT_URL: url, IIGHT_TOKEN: token },
    })

  try {
    await expect(pull(['--check'])).rejects.toMatchObject({
      code: 1,
      stderr: 'src/iight-types.d.ts is missing. Run npx iight types pull.\n',
    })

    expect((await pull([])).stdout).toBe('Wrote src/iight-types.d.ts.\n')
    expect(await readFile(file, 'utf8')).toBe(typesFile(types))
    expect((await pull(['--check'])).stdout).toBe('src/iight-types.d.ts is up to date.\n')

    await writeFile(file, 'export {}\n')
    await expect(pull(['--check'])).rejects.toMatchObject({
      code: 1,
      stderr: 'src/iight-types.d.ts is out of date. Run npx iight types pull.\n',
    })

    await expect(pull([], 'nope')).rejects.toMatchObject({
      code: 1,
      stderr: `The CMS at ${url} replied 401: Unauthenticated.\n`,
    })
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)
