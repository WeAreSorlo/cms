import { createApp } from '../src/app'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { toAdminEntry, withStatus } from '../src/query'
import { exportContent, importContent } from '../src/transfer'
import { db, resetDb } from './database'
import { blog, contactFields, setUp, types } from './fixtures'
import { FSDriver } from 'flydrive/drivers/fs'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeEach, expect, test } from 'vitest'

// sorlo export and sorlo import: a site's content to a folder and back

const root = await mkdtemp(join(tmpdir(), 'sorlo-transfer-'))
// Each site's own storage, so what an import stores can't be what was exported
const storageIn = (folder: string) => ({
  default: 'local',
  services: { local: () => new FSDriver({ location: join(root, folder), visibility: 'public' }) },
})
const from = storageIn('from')
const to = storageIn('to')
const content = join(root, 'content')
// The folder as messages name it, from where the tests run
const shown = (dir: string) => `${relative(process.cwd(), dir)}/`
const app = createApp(db, types, { storage: from })
let cookie: string

beforeEach(async () => {
  ;({ cookie } = await setUp())
  for (const folder of ['from', 'to', 'content', 'again'])
    await rm(join(root, folder), { recursive: true, force: true })
})
afterAll(async () => {
  await db.destroy()
  await rm(root, { recursive: true, force: true })
})

const send = async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  const reply = response.status === 204 ? null : await response.json()
  expect(response.ok, JSON.stringify(reply)).toBe(true)
  return reply?.data
}
const save = (type: string, values: object, { id, parentId, publish = false }: Record<string, any> = {}) =>
  id
    ? send('PUT', `/entries/${id}`, { values, parentId, publish })
    : send('POST', `/types/${type}/entries`, { values, parentId, publish })

const upload = async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#c00' } })
    .png()
    .toBuffer()
  const body = new FormData()
  body.append('file', new File([png as BlobPart], 'Team photo.png'))
  const response = await app.request('/api/media', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost' },
    body,
  })
  return (await response.json()).data
}

// A database with nothing in it but the CMS's tables, as a new site's is once it's migrated
const freshSite = async () => {
  await resetDb()
  await migrate(db, await loadMigrations(migrationsDir))
}

const importInto = (dir = content, sources = {}) =>
  importContent(db, dir, { types, migrations: {}, storage: to, ...sources })

// Every file in a folder, by its path in it
async function files(dir: string, at = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  for (const entry of await readdir(join(dir, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(found, await files(dir, path))
    else found[path] = (await readFile(join(dir, path))).toString('base64')
  }
  return found
}

// The content as the tables hold it, without who made it or the versions' numbers, which import doesn't keep
async function snapshot() {
  const columns = ['id', 'type', 'values', 'parent_id', 'position', 'slug', 'uri', 'created_at', 'updated_at'] as const
  return {
    entries: await db
      .selectFrom('entries')
      .select([...columns, 'archived_at', 'taken_down_at'])
      .orderBy('id')
      .execute(),
    live: await db
      .selectFrom('published_entries')
      .select([...columns, 'published_at'])
      .orderBy('id')
      .execute(),
    statuses: (await withStatus(db).selectAll().orderBy('id').execute()).map((row) => toAdminEntry(row).status),
    links: await db.selectFrom('entry_relations').selectAll().orderBy(['entry_id', 'field_id', 'target_id']).execute(),
    media: await db
      .selectFrom('media')
      .select(['id', 'path', 'name', 'mime', 'size', 'width', 'height', 'alt', 'caption', 'created_at', 'updated_at'])
      .execute(),
    forms: await db
      .selectFrom('forms')
      .select(['id', 'name', 'label', 'fields', 'open', 'first_opened_at', 'created_at', 'updated_at'])
      .execute(),
    automations: await db
      .selectFrom('automations')
      .select(['id', 'name', 'triggers', 'conditions', 'actions', 'created_at', 'updated_at'])
      .execute(),
  }
}

// Something of every kind: a published author with a photo, a published post that has changed since, linking to
// them, a draft, an archived post a person took down, a published page under a published page, a form, and an
// automation for the form whose webhook has a signing secret and headers
async function makeContent() {
  const photo = await upload()
  await send('PUT', `/media/${photo.id}`, { name: 'Team photo.png', alt: 'The team' })
  const ada = await save('authors', { name: 'Ada', avatar: photo.id }, { publish: true })
  const post = await save('blog', { title: 'Hello', slug: 'hello', author: ada.id }, { publish: true })
  await save('blog', { title: 'Hello, world', slug: 'hello', author: ada.id, cover: photo.id }, { id: post.id })
  await save('blog', { title: 'Draft', slug: 'draft', views: 3 })
  const gone = await save('blog', { title: 'Gone', slug: 'gone' }, { publish: true })
  await send('POST', `/entries/${gone.id}/archive`)
  const guide = await save('docs', { title: 'Guide', slug: 'guide' }, { publish: true })
  await save('docs', { title: 'Install', slug: 'install' }, { parentId: guide.id, publish: true })

  const form = await send('POST', '/forms', { label: 'Contact us', name: 'contact', fields: contactFields })
  const automation = await send('POST', '/automations', {
    name: 'Tell the site',
    triggers: ['submission.created'],
    conditions: [{ rules: [{ field: 'form.id', operator: 'equals', value: form.id }] }],
    actions: [
      {
        _layout: 'webhook',
        url: 'https://example.com/hooks/cms',
        timeout: 5,
        headers: [{ name: 'Authorization', value: 'Bearer hook' }],
      },
    ],
  })
  return { photo, post, automation }
}

test('an import puts an export back as it was, with no person and no events, and exports the same again', async () => {
  const { photo, post, automation } = await makeContent()
  const before = await snapshot()
  expect([...before.statuses].sort()).toEqual(['changed', 'draft', 'draft', 'published', 'published', 'published'])

  const exported = await exportContent(db, from, content, {})
  expect(exported).toEqual({
    moved: { entries: 6, media: 1, forms: 1, automations: 1 },
    secrets: [`${shown(content)}automations/${automation.id}.json`],
  })
  expect(JSON.parse(await readFile(join(content, 'export.json'), 'utf8'))).toEqual({ format: 1, migration: null })
  // A changed entry's live copy is written in full, and a live copy that's the draft as it stands only says when
  const changed = JSON.parse(await readFile(join(content, `entries/blog/${post.id}.json`), 'utf8'))
  expect(changed.values.title).toBe('Hello, world')
  expect(changed.live).toEqual({
    parentId: null,
    position: null,
    slug: 'hello',
    uri: null,
    values: expect.objectContaining({ title: 'Hello' }),
    updatedAt: expect.any(String),
    publishedAt: expect.any(String),
  })
  const media = Object.keys(await files(content)).filter((path) => path.startsWith('media/'))
  expect(media.sort()).toEqual([`media/${photo.id}.json`, `media/${photo.id}.png`])

  await freshSite()
  expect(await importInto()).toEqual({ entries: 6, media: 1, forms: 1, automations: 1 })
  expect(await snapshot()).toEqual(before)
  expect(await readFile(join(root, 'to', `${photo.id}.png`))).toEqual(
    await readFile(join(root, 'from', `${photo.id}.png`)),
  )

  // No events, so the automation it brings doesn't run for every entry
  expect(await db.selectFrom('events').selectAll().execute()).toEqual([])
  // A version for each live copy and one more for the changed post's draft, with no person, as from the CLI
  const versions = await db
    .selectFrom('entry_versions')
    .select(['entry_id', 'number', 'created_by', 'published_at', 'published_by'])
    .execute()
  expect(versions).toHaveLength(7)
  expect(
    versions
      .filter((version) => version.entry_id === post.id)
      .map((version) => version.number)
      .sort(),
  ).toEqual([1, 2])
  expect(versions.every((version) => version.created_by === null && version.published_by === null)).toBe(true)

  await exportContent(db, to, join(root, 'again'), {})
  expect(await files(join(root, 'again'))).toEqual(await files(content))
})

test('values from before a content migration catch up as they import, and an export from after one waits for it', async () => {
  await save('blog', { title: 'Hello', slug: 'hello' }, { publish: true })
  await exportContent(db, from, content, {})

  // This site ran a migration after the export was made, renaming title
  await freshSite()
  const name = '2099_01_01_000000_headline'
  await db.insertInto('migrations').values({ name, batch: 2 }).execute()
  const migrations = {
    [name]: {
      up: ({ entries }: any) => entries.renameField('blog', 'title', 'headline'),
      down: ({ entries }: any) => entries.renameField('blog', 'headline', 'title'),
    },
  }
  const headlined = new Map(types).set('blog', {
    ...blog,
    titleField: 'headline',
    fields: blog.fields.map((field) => (field.name === 'title' ? { ...field, name: 'headline' } : field)),
  })
  await importInto(content, { types: headlined, migrations })
  const [entry] = await db.selectFrom('entries').selectAll().execute()
  expect(entry.values).toMatchObject({ headline: 'Hello', slug: 'hello' })
  expect(entry.values).not.toHaveProperty('title')
  expect(entry.migration).toBe(name)
  const [live] = await db.selectFrom('published_entries').selectAll().execute()
  expect(live.values).toEqual(entry.values)

  await freshSite()
  await writeFile(join(content, 'export.json'), JSON.stringify({ format: 1, migration: '2099_02_02_000000_later' }))
  await expect(importInto()).rejects.toThrow(
    `${shown(content)} was exported after the content migration 2099_02_02_000000_later, which hasn't run here. Migrate, then import again.`,
  )
})

test('an import goes only into a site without content, from an export it can read', async () => {
  await save('blog', { title: 'Hello', slug: 'hello' })
  await exportContent(db, from, content, {})
  await expect(importInto()).rejects.toThrow(
    'This site has entries already. Import only goes into a site without any entries, media, forms or automations.',
  )

  await freshSite()
  await expect(importInto(join(root, 'nothing'))).rejects.toThrow(
    `${shown(join(root, 'nothing'))} isn't an export, since it has no export.json.`,
  )
  await writeFile(join(content, 'export.json'), JSON.stringify({ format: 2, migration: null }))
  await expect(importInto()).rejects.toThrow(
    `${shown(content)} was exported by a newer Sorlo, in format 2. Update Sorlo to import it.`,
  )
})

test('an import lists every problem it finds and changes nothing, even with them found as it writes', async () => {
  const { photo } = await makeContent()
  await exportContent(db, from, content, {})
  const entries = join(content, 'entries')
  const docs = (await readdir(join(entries, 'docs'))).sort()

  // Problems found before anything is written
  await rm(join(content, `media/${photo.id}.png`))
  await writeFile(join(entries, 'blog', 'not-json.json'), '{')
  const install = JSON.parse(await readFile(join(entries, 'docs', docs[1]), 'utf8'))
  await rm(join(entries, 'docs', docs[0]))
  await freshSite()
  const found = await importInto().catch((error) => error)
  expect(found.message.split('\n')).toEqual([
    expect.stringMatching(/^entries\/blog\/not-json\.json isn't JSON: /),
    `entries/docs/${docs[1]}: its parent, ${install.parentId}, isn't an entry in the export.`,
    `entries/docs/${docs[1]}: its live parent, ${install.parentId}, isn't live in the export.`,
    `media/${photo.id}.json: its file, media/${photo.id} with its extension, isn't beside it.`,
  ])

  // Values that don't pass, found once the rows are written, which then go
  await rm(content, { recursive: true })
  await setUp()
  await save('blog', { title: 'Hello', slug: 'hello' }, { publish: true })
  await exportContent(db, from, content, {})
  const [only] = await readdir(join(entries, 'blog'))
  const file = JSON.parse(await readFile(join(entries, 'blog', only), 'utf8'))
  await writeFile(join(entries, 'blog', only), JSON.stringify({ ...file, values: { ...file.values, views: 'lots' } }))
  await freshSite()
  await expect(importInto()).rejects.toThrow(`entries/blog/${only}: views: `)
  expect(await db.selectFrom('entries').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('entry_versions').selectAll().execute()).toEqual([])
  expect(existsSync(join(root, 'to'))).toBe(false)

  // Two entries the database can't keep apart, refused with what they share
  await writeFile(join(entries, 'blog', only), JSON.stringify(file))
  const twin = '019a0000-0000-7000-8000-000000000001'
  await writeFile(join(entries, 'blog', `${twin}.json`), JSON.stringify({ ...file, id: twin, live: null }))
  await expect(importInto()).rejects.toThrow(
    `Two records in ${shown(content)} share what must be unique: Key (type, parent_id, slug)=(blog, null, hello) already exists.`,
  )
  expect(await db.selectFrom('entries').selectAll().execute()).toEqual([])
})

test('a webhook without a signing secret gets a new one as it imports', async () => {
  const { automation } = await makeContent()
  const secret = automation.actions[0].secret
  expect(secret).toMatch(/^whsec_/)
  await exportContent(db, from, content, {})
  const path = join(content, `automations/${automation.id}.json`)
  const file = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...file, actions: [{ ...file.actions[0], secret: '' }] }))

  await freshSite()
  await importInto()
  const row = await db.selectFrom('automations').selectAll().executeTakeFirstOrThrow()
  expect(row.actions[0].secret).toMatch(/^whsec_/)
  expect(row.actions[0].secret).not.toBe(secret)
})

test('an export goes only into an empty folder or an earlier export, replacing just what it writes', async () => {
  // Anything else, such as a project's folder named by mistake, is refused
  await mkdir(content)
  await writeFile(join(content, 'notes.txt'), 'mine')
  await expect(exportContent(db, from, content, {})).rejects.toThrow(
    `${shown(content)} holds files that aren't an export. Choose an empty folder or an earlier export.`,
  )
  await rm(join(content, 'notes.txt'))
  // Files such as .DS_Store don't count
  await writeFile(join(content, '.gitkeep'), '')

  const post = await save('blog', { title: 'Hello', slug: 'hello' })
  await exportContent(db, from, content, {})
  await writeFile(join(content, 'README.md'), 'Sample content')
  await send('POST', `/entries/${post.id}/archive`)
  await send('DELETE', `/entries/${post.id}`)
  await save('blog', { title: 'Another', slug: 'another' })
  await exportContent(db, from, content, {})
  const left = Object.keys(await files(content)).sort()
  expect(left).toEqual(['.gitkeep', 'README.md', expect.stringMatching(/^entries\/blog\/.+\.json$/), 'export.json'])
  expect(left[2]).not.toContain(post.id)
})

test('a file missing from storage stops an export, leaving the folder as it was', async () => {
  const photo = await upload()
  await exportContent(db, from, content, {})
  const before = await files(content)
  await rm(join(root, 'from', `${photo.id}.png`))
  await save('blog', { title: 'Hello', slug: 'hello' })

  await expect(exportContent(db, from, content, {})).rejects.toThrow(
    `Couldn't read Team photo.png, the file ${photo.id}, from storage:`,
  )
  expect(await files(content)).toEqual(before)
  expect((await readdir(root)).filter((name) => name.startsWith('.content-'))).toEqual([])
})
