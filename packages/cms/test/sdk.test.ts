import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { type ContentType, type SharedGroup, expandFields } from '../src/types'
import { typesFile } from '../src/typescript'
import { db } from './database'
import { blog, contactFields, setUp, types } from './fixtures'
import { serve } from '@hono/node-server'
import { SorloError, createClient } from '@sorlo/sdk'
import { sql } from 'kysely'
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

// A form, which the generated types include
const contact = { name: 'contact', fields: contactFields }

// Shared groups, which the generated types name: one holding a link, one using it, and one without links
const og: SharedGroup = {
  id: 'grp_og',
  name: 'og',
  label: 'Sharing',
  fields: [
    { id: 'fld_image', type: 'media', name: 'image', options: { types: ['image/*'], maximum: 1 } },
    { id: 'fld_alt', type: 'text', name: 'alt' },
  ],
}
const seo: SharedGroup = {
  id: 'grp_seo',
  name: 'seo',
  label: 'SEO',
  fields: [
    { id: 'fld_title', type: 'text', name: 'title', required: true },
    { id: 'fld_share', type: 'shared', name: 'share', options: { group: 'grp_og' } },
  ],
}
const meta: SharedGroup = {
  id: 'grp_meta',
  name: 'meta',
  label: 'Meta',
  fields: [{ id: 'fld_noindex', type: 'boolean', name: 'noindex' }],
}
const groups = new Map([og, seo, meta].map((group) => [group.name, group]))

// A type using them, as types load with their uses expanded
const pages: ContentType = {
  id: 'typ_pages',
  name: 'pages',
  label: 'Pages',
  structure: 'collection',
  fields: expandFields(
    [
      { id: 'fld_heading', type: 'text', name: 'heading', required: true },
      { id: 'fld_seo', type: 'shared', name: 'seo', options: { group: 'grp_seo' } },
      { id: 'fld_meta', type: 'shared', name: 'meta', options: { group: 'grp_meta' } },
      {
        id: 'fld_items',
        type: 'repeater',
        name: 'items',
        options: { fields: [{ id: 'fld_item_share', type: 'shared', name: 'share', options: { group: 'grp_og' } }] },
      },
    ],
    new Map([...groups.values()].map((group) => [group.id, group])),
  ),
}

const served = new Map([...types, ['pages', pages]])
const generated = () => typesFile(served, 2, [contact], groups)

beforeAll(async () => {
  await setUp()
  key = await createApiKey(db, 'Website')
  const fields = JSON.stringify(contactFields)
  const form = { id: uuidv7(), label: 'Contact us', name: 'contact', fields, version: 1 }
  await db.insertInto('forms').values(form).execute()
  await db.insertInto('form_versions').values({ form_id: form.id, number: 1, fields }).execute()

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
  // Each with the version a save writes and the live copy a publish makes, which the delivery API serves
  await db
    .insertInto('entry_versions')
    .values(posts.map(({ id, values }) => ({ entry_id: id, number: 1, values })))
    .execute()
  await publishAll()

  const app = createApp(db, served, { groups })
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

// Publish every entry as it stands, as the migration that added live copies did
async function publishAll() {
  await db.deleteFrom('published_entries').execute()
  await sql`
    insert into published_entries (id, type, "values", parent_id, position, slug, uri, migration, created_at, updated_at, version)
    select id, type, "values", parent_id, position, slug, uri, migration, created_at, updated_at, 1 from entries
  `.execute(db)
}

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

test('with() and depth() send the fields and levels to resolve, and the reply holds what they link to', async () => {
  const requests: Array<URL> = []
  const cms = createClient({
    url,
    token: key,
    fetch: (input, init) => {
      requests.push(new URL(String(input)))
      return fetch(input, init)
    },
  })

  // An author linked from one post, both written without a save, as the posts above are
  const author = { id: uuidv7(), type: 'authors', values: { name: 'Ada' } }
  await db.insertInto('entries').values(author).execute()
  await db.insertInto('entry_versions').values({ entry_id: author.id, number: 1, values: author.values }).execute()
  await db
    .updateTable('entries')
    .set({ values: sql`"values" || ${JSON.stringify({ author: author.id })}::jsonb` })
    .where('slug', '=', 'release-1')
    .execute()
  await publishAll()

  const post = await cms.entries('blog').where('slug', '=', 'release-1').with('author').depth(1).first()
  expect(Object.fromEntries(requests[0].searchParams)).toMatchObject({ with: '["author"]', depth: '1' })
  expect(post?.values.author).toMatchObject({ id: author.id, type: 'authors', values: { name: 'Ada' } })
  expect((await cms.entries('blog').where('slug', '=', 'release-1').first())?.values.author).toBe(author.id)
})

test('a preview client reads drafts, sending status=draft with every query, which needs a preview key', async () => {
  const requests: Array<URL> = []
  const previewKey = await createApiKey(db, 'Previews', ['preview'])
  const preview = createClient({
    url,
    token: previewKey,
    preview: true,
    fetch: (input, init) => {
      requests.push(new URL(String(input)))
      return fetch(input, init)
    },
  })

  // A draft that's never been published, without the title that publishing needs
  const draft = { id: uuidv7(), type: 'blog', slug: 'unfinished', values: { slug: 'unfinished' } }
  await db.insertInto('entries').values(draft).execute()

  const found = await preview.entries('blog').where('slug', '=', 'unfinished').first()
  expect(requests[0].searchParams.get('status')).toBe('draft')
  expect(found).toMatchObject({ id: draft.id, publishedAt: null, values: { slug: 'unfinished' } })
  expect(await createClient({ url, token: key }).entries('blog').where('slug', '=', 'unfinished').first()).toBeNull()

  await expect(createClient({ url, token: key, preview: true }).entries('blog').first()).rejects.toMatchObject({
    status: 403,
    message: "This key can't read drafts. Make one that can with sorlo make:api-key --preview.",
  })
})

test("a failed request throws a SorloError with the status and the API's message", async () => {
  const failure = (promise: Promise<unknown>) => promise.catch((error) => error)
  const cms = createClient({ url, token: key })

  const unauthenticated = await failure(createClient({ url, token: 'nope' }).entries('blog').first())
  expect(unauthenticated).toBeInstanceOf(SorloError)
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

test('submit() sends a form its values as JSON, with no key needed', async () => {
  const values = { name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' } }
  const sent = await createClient({ url }).form('contact').submit(values)
  expect(sent).toEqual({
    id: expect.any(String),
    version: 1,
    values: { ...values, subscribe: false, source: 'website' },
    createdAt: expect.any(String),
  })

  const invalid = await createClient({ url, token: key })
    .form('contact')
    .submit({ ...values, email: 'nope' })
    .catch((error) => error)
  expect(invalid).toBeInstanceOf(SorloError)
  expect(invalid).toMatchObject({ status: 422, message: "The values don't pass the form's checks." })
  expect(invalid.body.fields.email).toEqual({ isValid: false, messages: ['A valid email address required.'] })

  await expect(createClient({ url }).entries('blog').first()).rejects.toMatchObject({ status: 401 })
})

test('generates a type for each content type, shared group and form, registered with the SDK', async () => {
  // sdk.test-d.ts typechecks queries against this file, so it also shows the generated types compile
  await expect(generated()).toMatchFileSnapshot('./sorlo-types.d.ts')

  // Each shared group is named, with its resolved shape when it holds links, and types that use it refer to it
  expect(generated()).toContain(
    [
      'export type GroupOg = {\n  image?: string\n  alt?: string\n}',
      'export type GroupOgResolved<Depth extends number> = {\n  image?: Media | null\n  alt?: string\n}',
      'export type GroupSeo = {\n  title: string\n  share?: GroupOg\n}',
      'export type GroupSeoResolved<Depth extends number> = {\n  title: string\n  share?: GroupOgResolved<Depth>\n}',
      'export type GroupMeta = {\n  noindex?: boolean\n}',
    ].join('\n\n'),
  )
  expect(generated()).toContain(
    [
      'export type PagesValues = {',
      '  heading: string',
      '  seo?: GroupSeo',
      '  meta?: GroupMeta',
      '  items?: Array<{\n    share?: GroupOg\n  }>',
      '}',
      '',
      'export type PagesResolvedValues<Depth extends number> = {',
      '  seo?: GroupSeoResolved<Depth>',
      '  items?: Array<{\n    share?: GroupOgResolved<Depth>\n  }>',
      '}',
    ].join('\n'),
  )

  const optional = blog.fields.map((field) => (field.name === 'slug' ? { ...field, required: false } : field))
  expect(typesFile(new Map([['news', { ...blog, name: 'news', fields: optional }]]))).toContain(
    '  slug: string | null\n',
  )
})

test('GET /types serves the generated types to keys with the types scope', async () => {
  expect((await fetch(`${url}/types`)).status).toBe(401)
  const refused = await fetch(`${url}/types`, { headers: { authorization: `Bearer ${key}` } })
  expect({ status: refused.status, body: await refused.json() }).toEqual({
    status: 403,
    body: { message: "This key can't pull types. Make one that can with sorlo make:api-key --types." },
  })

  const typesKey = await createApiKey(db, 'Types', ['types'])
  const response = await fetch(`${url}/types`, { headers: { authorization: `Bearer ${typesKey}` } })
  expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
  expect(await response.text()).toBe(generated())
})

test('types pull writes the types into a frontend, and --check fails when they are out of date', async () => {
  const bin = fileURLToPath(new URL('../../sdk/bin/sorlo.js', import.meta.url))
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-frontend-'))
  const file = join(dir, 'src/sorlo-types.d.ts')
  const typesKey = await createApiKey(db, 'Types', ['types'])
  const pull = (args: Array<string>, token = typesKey) =>
    promisify(execFile)(process.execPath, [bin, 'types', 'pull', ...args], {
      cwd: dir,
      env: { ...process.env, SORLO_URL: url, SORLO_TOKEN: token },
    })

  try {
    await expect(pull(['--check'])).rejects.toMatchObject({
      code: 1,
      stderr: 'src/sorlo-types.d.ts is missing. Run npx sorlo types pull.\n',
    })

    expect((await pull([])).stdout).toBe('Wrote src/sorlo-types.d.ts.\n')
    expect(await readFile(file, 'utf8')).toBe(generated())
    expect((await pull(['--check'])).stdout).toBe('src/sorlo-types.d.ts is up to date.\n')

    await writeFile(file, 'export {}\n')
    await expect(pull(['--check'])).rejects.toMatchObject({
      code: 1,
      stderr: 'src/sorlo-types.d.ts is out of date. Run npx sorlo types pull.\n',
    })

    await expect(pull([], 'nope')).rejects.toMatchObject({
      code: 1,
      stderr: `The CMS at ${url} replied 401: Unauthenticated.\n`,
    })
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)
