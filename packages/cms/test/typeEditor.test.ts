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
  const root = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
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
const groupFile = async (name: string) => JSON.parse(await readFile(join(dirs.types, `../groups/${name}.json`), 'utf8'))
const migrationFile = (file: string) => readFile(join(dirs.migrations, file), 'utf8')

const events = {
  label: 'Events',
  name: 'events',
  structure: 'collection',
  titleField: 'title',
  listColumns: ['title'],
  fields: [{ id: 'fld_event_title', type: 'text', name: 'title', label: 'Title', required: true }],
}

test('types are read-only without the site project folders, as outside sorlo dev', async () => {
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
      body: { message: 'Content types can only be changed in development, with sorlo dev.' },
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
          'Flagged: the type posts is gone, but its entries stay until you delete them. sorlo migrate --check lists them',
        ],
      },
    },
  })
  expect(await readdir(dirs.types)).toEqual(['authors.json'])
})

// Shared groups (PLAN.md section 19)
const seo = {
  label: 'SEO',
  name: 'seo',
  fields: [
    { id: 'fld_seo_title', type: 'text', name: 'title', label: 'Title' },
    { id: 'fld_seo_description', type: 'textarea', name: 'description', label: 'Description' },
  ],
}

test('shared groups need a session, and are read-only without the site project folders', async () => {
  for (const [method, path] of [
    ['GET', '/types'],
    ['POST', '/groups'],
    ['PUT', '/groups/seo'],
    ['DELETE', '/groups/seo'],
  ]) {
    const response = await app.request(`/api${path}`, { method, headers: { origin: 'http://localhost' } })
    expect(response.status).toBe(401)
  }

  const readOnly = createApp(db, fixtures)
  expect((await send('GET', '/types', undefined, readOnly)).body.groups).toEqual([])
  for (const [method, path] of [
    ['POST', '/groups'],
    ['PUT', '/groups/seo'],
    ['DELETE', '/groups/seo'],
  ]) {
    expect(await send(method, path, seo, readOnly)).toEqual({
      status: 403,
      body: { message: 'Shared groups can only be changed in development, with sorlo dev.' },
    })
  }
})

test('creates, changes and deletes a shared group, with one migration for every type that uses it', async () => {
  const created = await send('POST', '/groups', seo)
  expect(created.status).toBe(201)
  expect(created.body.data.id).toMatch(/^grp_[0-9a-z]{8}$/)
  expect(created.body.migration).toEqual({ file: null, notes: [] })
  const id = created.body.data.id
  expect(await groupFile('seo')).toEqual({ id, ...seo })

  // A type uses it by id, and comes back from the API with the use expanded
  const use = { id: 'fld_seo', type: 'shared', name: 'seo', label: 'Search', options: { group: id } }
  for (const type of [blog, authors]) {
    const saved = await send('PUT', `/types/${type.name}`, { ...type, fields: [...type.fields, use] })
    expect(saved.body.migration).toEqual({ file: null, notes: [] })
  }
  expect((await typeFile('blog')).fields.at(-1)).toEqual(use)
  const list = (await send('GET', '/types')).body
  expect(list.groups).toEqual([{ id, ...seo }])
  expect(list.data[1].fields.at(-1)).toEqual({
    ...use,
    type: 'group',
    options: {
      group: id,
      fields: seo.fields.map((field) => ({ ...field, id: `fld_seo.${field.id}` })),
    },
  })

  // A change to the group reaches both types in one migration
  const fields = [{ ...seo.fields[0], name: 'headline' }]
  const changed = await send('PUT', '/groups/seo', { ...seo, label: 'Search', fields })
  expect(changed.status).toBe(200)
  expect(changed.body.migration.file).toMatch(/_authors_blog\.ts$/)
  expect(changed.body.migration.notes).toEqual([
    "Flagged: deletes the values of seo.description, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of seo.description, which down can't bring back. Old versions keep them",
  ])
  const source = await migrationFile(changed.body.migration.file)
  expect(source).toContain("entries.renameField('authors', 'seo.title', 'seo.headline')")
  expect(source).toContain("entries.renameField('blog', 'seo.title', 'seo.headline')")

  // Renaming the group renames its file, and uses still find it by id
  const renamed = await send('PUT', '/groups/seo', { ...seo, name: 'search', fields })
  expect(renamed.body.migration.file).toBeNull()
  expect(await readdir(join(dirs.types, '../groups'))).toEqual(['search.json'])

  expect(await send('DELETE', '/groups/search')).toEqual({
    status: 409,
    body: { message: 'Authors, Blog posts use SEO. Take it out of them first.' },
  })
  await send('PUT', '/types/authors', authors)
  await send('PUT', '/types/blog', blog)
  expect(await send('DELETE', '/groups/search')).toEqual({
    status: 200,
    body: { migration: { file: null, notes: [] } },
  })
  expect(await readdir(join(dirs.types, '../groups'))).toEqual([])
})

test('problems with a shared group or a use reply 422, and nothing is written', async () => {
  const bad = await send('POST', '/groups', { name: 'not ok', fields: [{ type: 'colour', name: 'x' }] })
  expect(bad.status).toBe(422)
  expect(Object.keys(bad.body.fields).sort()).toEqual(['label', 'name'])

  const id = (await send('POST', '/groups', seo)).body.data.id
  const taken = await send('POST', '/groups', { ...seo, fields: [{ type: 'text', name: 'title' }] })
  expect(taken.body.fields.name).toEqual({ isValid: false, messages: ['Another shared group is named seo.'] })
  expect(taken.body.fields.fields).toEqual({
    isValid: false,
    messages: ['Field "title" needs an "id", such as fld_k3x9q2mz.'],
  })

  // A group can use another, but never itself, even through others
  const og = (await send('POST', '/groups', { label: 'Sharing', name: 'og', fields: [] })).body.data.id
  const usesSeo = { id: 'fld_more', type: 'shared', name: 'more', options: { group: id } }
  expect((await send('PUT', '/groups/og', { label: 'Sharing', name: 'og', fields: [usesSeo] })).status).toBe(200)
  const loop = await send('PUT', '/groups/seo', {
    ...seo,
    fields: [...seo.fields, { id: 'fld_og', type: 'shared', name: 'og', options: { group: og } }],
  })
  expect(loop.body.fields.fields).toEqual({ isValid: false, messages: ['It uses itself, through og.'] })

  const unknown = await send('PUT', '/types/blog', {
    ...blog,
    fields: [...blog.fields, { id: 'fld_x', type: 'shared', name: 'x', options: { group: 'grp_nope' } }],
  })
  expect(unknown.body.fields.fields).toEqual({
    isValid: false,
    messages: ['Field "x" must name a shared group by its id in "options.group".'],
  })
  expect(await groupFile('seo')).toEqual({ id, ...seo })
  expect((await typeFile('blog')).fields).toEqual(blog.fields)

  // Deleting one a type links to waits until no shared group links to it either, used or not
  const linking = {
    label: 'Byline',
    name: 'byline',
    fields: [{ id: 'fld_by', type: 'relationship', name: 'by', options: { types: [authors.id] } }],
  }
  expect((await send('POST', '/groups', linking)).status).toBe(201)
  const unlinked = blog.fields.filter((field) => !['author', 'credits'].includes(field.name))
  expect((await send('PUT', '/types/blog', { ...blog, fields: unlinked })).status).toBe(200)
  expect(await send('DELETE', '/types/authors')).toEqual({
    status: 409,
    body: { message: 'Relationship fields in the shared group Byline link to Authors. Take it out of them first.' },
  })
})

test("Make shared and Use shared group swap a type's copy for a use, keeping the values whose names match", async () => {
  // Blog posts and authors each have a copy of the SEO fields, authors' with a keywords field of its own
  const copy = (id: string, fields: Array<object>) => ({ id, type: 'group', name: 'seo', options: { fields } })
  await send('PUT', '/types/blog', { ...blog, fields: [...blog.fields, copy('fld_blog_seo', seo.fields)] })
  const keywords = { id: 'fld_keywords', type: 'text', name: 'keywords' }
  const authorsCopy = copy('fld_authors_seo', [{ ...seo.fields[0], id: 'fld_a_title' }, keywords])
  await send('PUT', '/types/authors', { ...authors, fields: [...authors.fields, authorsCopy] })

  // Make shared gives the new group the copy's fields, then swaps the copy for a use with its id and name
  const id = (await send('POST', '/groups', seo)).body.data.id
  const use = (field: string) => ({ id: field, type: 'shared', name: 'seo', options: { group: id } })
  const made = await send('PUT', '/types/blog', { ...blog, fields: [...blog.fields, use('fld_blog_seo')] })
  expect(made.body.migration).toEqual({ file: null, notes: [] })

  // Use shared group keeps title and flags keywords, which the group doesn't have
  const used = await send('PUT', '/types/authors', { ...authors, fields: [...authors.fields, use('fld_authors_seo')] })
  expect(used.body.migration.notes).toEqual([
    "Flagged: deletes the values of seo.keywords, which down can't bring back. Old versions keep them",
  ])
  const source = await migrationFile(used.body.migration.file)
  expect(source).toContain("entries.removeField('authors', 'seo.keywords')")
  expect(source).not.toContain("'seo.title'")
})
