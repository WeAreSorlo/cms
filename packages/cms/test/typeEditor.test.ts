import { createApp } from '../src/app'
import { makeMigration } from '../src/makeMigration'
import { loadTypes } from '../src/types'
import { db } from './database'
import { authors, blog, setUp, types as fixtures } from './fixtures'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

let cookie: string
let dirs: { types: string; migrations: string }
let app: ReturnType<typeof createApp>

beforeAll(async () => ({ cookie } = await setUp()))
afterAll(() => db.destroy())

// A site project with the blog and authors types and a snapshot of them, served with the type editor
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'iight-site-'))
  dirs = { types: join(root, 'schema/types'), migrations: join(root, 'migrations') }
  await mkdir(dirs.types, { recursive: true })
  await writeFile(join(dirs.types, 'blog.json'), JSON.stringify(blog))
  await writeFile(join(dirs.types, 'authors.json'), JSON.stringify(authors))
  const types = await loadTypes(dirs.types)
  await makeMigration(dirs.migrations, types)
  app = createApp(db, types, { editor: dirs })
})

const send = async (method: string, path: string, body?: unknown, to = app) => {
  const headers: Record<string, string> = { cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const response = await to.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

const typeFile = async (name: string) => JSON.parse(await readFile(join(dirs.types, `${name}.json`), 'utf8'))

const events = {
  label: 'Events',
  name: 'events',
  structure: 'collection',
  titleField: 'title',
  listColumns: ['title'],
  fields: [{ id: 'fld_event_title', type: 'text', name: 'title', label: 'Title', required: true }],
}

test('types are read-only without the site project folders, as outside iight dev', async () => {
  const readOnly = createApp(db, fixtures)
  const list = await send('GET', '/types', undefined, readOnly)
  expect(list.body.editable).toBe(false)
  expect(list.body.data.map((type: { name: string }) => type.name)).toEqual(['blog', 'docs', 'home', 'authors'])

  for (const [method, path] of [
    ['POST', '/types'],
    ['PUT', '/types/blog'],
    ['DELETE', '/types/blog'],
  ]) {
    expect(await send(method, path, events, readOnly)).toEqual({
      status: 403,
      body: { message: 'Content types can only be changed in development, with iight dev.' },
    })
  }
  expect((await send('GET', '/types')).body.editable).toBe(true)
})

test('creates a type, writing its file with a new id', async () => {
  const { status, body } = await send('POST', '/types', events)
  expect(status).toBe(201)
  expect(body.data.id).toMatch(/^typ_[0-9a-z]{8}$/)
  expect(body.migration).toEqual({ file: null, notes: [] })

  // Settings keep the order of the files people write, and empty ones are left out
  const file = await typeFile('events')
  expect(Object.keys(file)).toEqual(['id', 'name', 'label', 'structure', 'titleField', 'listColumns', 'fields'])
  expect(file).toEqual(body.data)
  expect((await send('GET', '/types')).body.data.map((type: { name: string }) => type.name)).toEqual([
    'authors',
    'blog',
    'events',
  ])
})

test('problems reply 422 with a report on the settings, and on the fields for the rest', async () => {
  const bad = await send('POST', '/types', { name: 'not ok', structure: 'list', icon: 7, fields: [] })
  expect(bad.status).toBe(422)
  expect(bad.body.isValid).toBe(false)
  for (const key of ['label', 'name', 'structure', 'icon']) expect(bad.body.fields[key].isValid).toBe(false)

  const fields = [{ type: 'text', name: 'title' }]
  const taken = await send('POST', '/types', { ...events, name: 'blog', titleField: undefined, fields })
  expect(taken.body.fields.name).toEqual({ isValid: false, messages: ['Another content type is named blog.'] })
  expect(taken.body.fields.fields).toEqual({
    isValid: false,
    messages: ['Field "title" needs an "id", such as fld_k3x9q2mz.'],
  })
  expect(await readdir(dirs.types)).toEqual(['authors.json', 'blog.json'])
})

test('changes a type, writing its file and a migration for the change', async () => {
  const fields = blog.fields.map((field) => (field.name === 'title' ? { ...field, name: 'headline' } : field))
  const { status, body } = await send('PUT', '/types/blog', {
    ...blog,
    titleField: 'headline',
    listColumns: ['headline'],
    fields,
  })

  expect(status).toBe(200)
  expect(body.migration.notes).toEqual([])
  expect(body.migration.file).toMatch(/^\d{4}_\d\d_\d\d_\d{6}_blog\.ts$/)
  expect(await readFile(join(dirs.migrations, body.migration.file), 'utf8')).toContain(
    "entries.renameField('blog', 'title', 'headline')",
  )
  expect(await typeFile('blog')).toEqual({ ...blog, titleField: 'headline', listColumns: ['headline'], fields })
  expect((await send('GET', '/types')).body.data[1].titleField).toBe('headline')

  // Drafts are on unless the file says otherwise, which needs no migration
  const settings = { ...blog, titleField: 'headline', listColumns: ['headline'], fields }
  const off = await send('PUT', '/types/blog', { ...settings, drafts: false })
  expect(off.body.migration.file).toBeNull()
  expect(Object.keys(await typeFile('blog'))).toEqual([
    'id',
    'name',
    'label',
    'structure',
    'drafts',
    'titleField',
    'slugField',
    'listColumns',
    'fields',
  ])
  expect((await typeFile('blog')).drafts).toBe(false)
  await send('PUT', '/types/blog', { ...settings, drafts: true })
  expect(await typeFile('blog')).not.toHaveProperty('drafts')
})

test('renaming a type renames its file, and deleting one removes it and flags its entries', async () => {
  const renamed = await send('PUT', '/types/blog', { ...blog, name: 'posts' })
  expect(renamed.status).toBe(200)
  expect(await readdir(dirs.types)).toEqual(['authors.json', 'posts.json'])
  expect(await readFile(join(dirs.migrations, renamed.body.migration.file), 'utf8')).toContain(
    "entries.renameType('blog', 'posts')",
  )

  expect((await send('PUT', '/types/blog', blog)).status).toBe(404)

  // Relationship fields name types by id, so the rename kept the link, which stops authors from being deleted
  expect(await send('DELETE', '/types/authors')).toEqual({
    status: 409,
    body: { message: 'Relationship fields in Blog posts link to Authors. Take it out of them first.' },
  })

  const deleted = await send('DELETE', '/types/posts')
  expect(deleted).toEqual({
    status: 200,
    body: {
      migration: {
        file: expect.stringMatching(/_posts\.ts$/),
        notes: [
          'Flagged: the type posts is gone, but its entries stay until you delete them. iight migrate --check lists them',
        ],
      },
    },
  })
  expect(await readdir(dirs.types)).toEqual(['authors.json'])
})
