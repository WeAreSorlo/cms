import { loadContentMigrations } from '../src/content'
import { uuidv7 } from '../src/db'
import { Migration, loadMigrations, migrate, migrationsDir, rollback, status } from '../src/migrator'
import { db, resetDb } from './database'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'

beforeEach(resetDb)
afterAll(() => db.destroy())

// Creates a table on the way up and drops it on the way down
const table = (name: string): Migration => ({
  up: (db) => db.schema.createTable(name).addColumn('id', 'integer').execute(),
  down: (db) => db.schema.dropTable(name).execute(),
})

const tables = async () => (await db.introspection.getTables()).map((table) => table.name).sort()

test('runs pending migrations as a batch and rolls back one batch at a time', async () => {
  const first = { '2026_01_01_a': table('a'), '2026_01_02_b': table('b') }
  expect(await migrate(db, first)).toEqual(['2026_01_01_a', '2026_01_02_b'])
  expect(await migrate(db, first)).toEqual([])

  const later = { ...first, '2026_01_03_c': table('c') }
  expect(await migrate(db, later)).toEqual(['2026_01_03_c'])
  expect(await status(db, later)).toEqual([
    { name: '2026_01_01_a', batch: 1 },
    { name: '2026_01_02_b', batch: 1 },
    { name: '2026_01_03_c', batch: 2 },
  ])

  expect(await rollback(db, later)).toEqual(['2026_01_03_c'])
  expect(await tables()).toEqual(['a', 'b', 'migrations'])

  expect(await rollback(db, later)).toEqual(['2026_01_02_b', '2026_01_01_a'])
  expect(await tables()).toEqual(['migrations'])
  expect(await status(db, later)).toEqual([
    { name: '2026_01_01_a', batch: null },
    { name: '2026_01_02_b', batch: null },
    { name: '2026_01_03_c', batch: null },
  ])

  expect(await rollback(db, later)).toEqual([])
})

test('a failing migration leaves nothing behind and stops the batch', async () => {
  const failing: Migration = {
    up: async (db) => {
      await db.schema.createTable('half_done').addColumn('id', 'integer').execute()
      throw new Error('Something broke')
    },
    down: async () => {},
  }
  const migrations = { '2026_01_01_a': table('a'), '2026_01_02_fails': failing, '2026_01_03_c': table('c') }

  await expect(migrate(db, migrations)).rejects.toThrow('Something broke')
  expect(await tables()).toEqual(['a', 'migrations'])
  expect(await status(db, migrations)).toEqual([
    { name: '2026_01_01_a', batch: 1 },
    { name: '2026_01_02_fails', batch: null },
    { name: '2026_01_03_c', batch: null },
  ])
})

test('sets of migrations run in the order given, as one batch, and roll back in reverse', async () => {
  // The CMS's migrations run before the site project's, even ones with earlier names
  const cms = { '2026_02_01_cms': table('cms') }
  const content = { '2026_01_01_content': table('content') }
  expect(await migrate(db, cms, content)).toEqual(['2026_02_01_cms', '2026_01_01_content'])
  expect(await status(db, content)).toEqual([{ name: '2026_01_01_content', batch: 1 }])
  expect(await rollback(db, { ...cms, ...content })).toEqual(['2026_01_01_content', '2026_02_01_cms'])
})

test("loads a folder's migrations, skipping other files, and needs an up and a down in content migrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iight-migrations-'))
  await writeFile(join(dir, '2026_01_01_000000_blog.ts'), 'export const up = () => {}\nexport const down = () => {}\n')
  await writeFile(join(dir, '.snapshot.json'), '{}')
  await writeFile(join(dir, 'notes.md'), 'Not a migration')
  expect(Object.keys(await loadContentMigrations(dir))).toEqual(['2026_01_01_000000_blog'])
  expect(await loadMigrations(join(dir, 'missing'))).toEqual({})

  await writeFile(join(dir, '2026_01_02_000000_docs.ts'), 'export const up = () => {}\n')
  await expect(loadContentMigrations(dir)).rejects.toThrow(
    'The content migration 2026_01_02_000000_docs must export an up and a down function.',
  )
})

test('refuses to roll back a migration whose file is gone', async () => {
  await migrate(db, { '2026_01_01_a': table('a') })
  await expect(rollback(db, {})).rejects.toThrow("Can't roll back 2026_01_01_a, its file is missing")
})

test("the CMS's own migrations run forward and back", async () => {
  const migrations = await loadMigrations(migrationsDir)
  expect(Object.keys(migrations)).toEqual([
    '2026_10_28_000000_create_users_table',
    '2026_10_28_000001_create_sessions_table',
    '2026_10_28_000002_create_entries_table',
    '2026_10_28_000003_create_entry_versions_table',
    '2026_10_28_000004_create_api_keys_table',
    '2026_10_28_000005_create_media_table',
    '2026_10_28_000006_create_entry_relations_table',
    '2026_10_28_000007_create_forms_table',
    '2026_10_28_000008_create_form_versions_table',
    '2026_10_28_000009_create_submissions_table',
    '2026_10_28_000010_create_events_table',
    '2026_10_28_000011_create_automations_table',
    '2026_10_28_000012_create_automation_runs_table',
    '2026_10_28_000013_create_published_entries_table',
    '2026_10_30_000014_add_api_key_permissions',
    '2026_10_30_000015_add_version_names_and_publishes',
    '2026_10_31_000016_add_version_parents',
    '2026_11_02_000017_create_personal_tokens_table',
    '2026_11_02_000018_create_chats_tables',
  ])

  await migrate(db, migrations)
  expect(await tables()).toEqual([
    'api_keys',
    'automation_runs',
    'automations',
    'chat_messages',
    'chats',
    'entries',
    'entry_relations',
    'entry_versions',
    'events',
    'form_versions',
    'forms',
    'media',
    'migrations',
    'personal_tokens',
    'published_entries',
    'sessions',
    'submissions',
    'users',
  ])

  await rollback(db, migrations)
  expect(await tables()).toEqual(['migrations'])
})

test('the migration that adds live copies publishes every saved entry that is not archived, as it stands', async () => {
  const migrations = await loadMigrations(migrationsDir)
  const published = '2026_10_28_000013_create_published_entries_table'
  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name < published)))

  const user = uuidv7()
  await db.insertInto('users').values({ id: user, name: 'Ada', email: 'ada@example.com', password_hash: 'x' }).execute()
  await db.insertInto('api_keys').values({ id: uuidv7(), name: 'Website', token_hash: 'x' }).execute()

  const entry = (type: string, values: object, columns: object = {}) => ({ id: uuidv7(), type, values, ...columns })
  // A content migration has changed its values since its newest version
  const post = entry('blog', { headline: 'Hello' }, { slug: 'hello' })
  const guide = entry('docs', { title: 'Guide' }, { slug: 'guide', uri: 'guide', position: 0 })
  const install = entry('docs', { title: 'Install' }, { slug: 'install', uri: 'guide/install', parent_id: guide.id })
  const archived = entry('blog', { title: 'Old' }, { slug: 'old', archived_at: new Date() })
  // A singleton that's been opened but never saved
  const home = entry('home', {})
  await db.insertInto('entries').values([post, guide, install, archived, home]).execute()
  const version = (entry: { id: string }, number: number, created_at = new Date()) => ({
    entry_id: entry.id,
    number,
    values: {},
    created_by: user,
    created_at,
  })
  await db
    .insertInto('entry_versions')
    .values([
      version(post, 1, new Date('2026-10-01')),
      version(post, 2, new Date('2026-10-02')),
      version(guide, 1),
      version(install, 1),
      version(archived, 1),
    ])
    .execute()

  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= published)))
  const live = await db.selectFrom('published_entries').selectAll().execute()
  expect(live.map((row) => row.id).sort()).toEqual([post.id, guide.id, install.id].sort())
  expect(live.find((row) => row.id === post.id)).toMatchObject({
    type: 'blog',
    values: { headline: 'Hello' },
    slug: 'hello',
    version: 2,
    published_at: new Date('2026-10-02'),
    published_by: user,
  })
  expect(live.find((row) => row.id === install.id)).toMatchObject({ parent_id: guide.id, uri: 'guide/install' })
  // Keys read what's live as before, and none can preview
  expect(await db.selectFrom('api_keys').select('scopes').execute()).toEqual([{ scopes: [] }])

  expect(await rollback(db, migrations)).toEqual([published])
  expect(await tables()).not.toContain('published_entries')
  expect(await db.selectFrom('entries').select('id').execute()).toHaveLength(5)
})

test('the migration that adds key permissions gives every key types and submit, which every key could do before', async () => {
  const migrations = await loadMigrations(migrationsDir)
  const permissions = '2026_10_30_000014_add_api_key_permissions'
  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name < permissions)))
  await db
    .insertInto('api_keys')
    .values([
      { id: uuidv7(), name: 'Website', token_hash: 'a' },
      { id: uuidv7(), name: 'Previews', token_hash: 'b', scopes: ['preview'] },
    ])
    .execute()

  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= permissions)))
  const keys = () => db.selectFrom('api_keys').selectAll().orderBy('name').execute()
  expect(await keys()).toMatchObject([
    { name: 'Previews', scopes: ['preview', 'types', 'submit'], created_by: null, last_used_at: null },
    { name: 'Website', scopes: ['types', 'submit'], created_by: null, last_used_at: null },
  ])

  expect(await rollback(db, migrations)).toEqual([permissions])
  expect((await keys()).map(({ scopes, ...rest }) => [scopes, Object.keys(rest)])).toEqual([
    [['preview'], ['id', 'name', 'token_hash', 'created_at']],
    [[], ['id', 'name', 'token_hash', 'created_at']],
  ])
})

test('the migration that names versions gives each live version the publish its live copy records', async () => {
  const migrations = await loadMigrations(migrationsDir)
  const names = '2026_10_30_000015_add_version_names_and_publishes'
  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name < names)))

  const user = uuidv7()
  await db.insertInto('users').values({ id: user, name: 'Ada', email: 'ada@example.com', password_hash: 'x' }).execute()
  const post = { id: uuidv7(), type: 'blog', values: {}, slug: 'hello' }
  const draft = { id: uuidv7(), type: 'blog', values: {}, slug: 'draft' }
  await db.insertInto('entries').values([post, draft]).execute()
  const version = (entry: { id: string }, number: number) => ({
    entry_id: entry.id,
    number,
    values: {},
    created_by: user,
  })
  await db
    .insertInto('entry_versions')
    .values([version(post, 1), version(post, 2), version(post, 3), version(draft, 1)])
    .execute()
  const at = new Date('2026-10-05T09:00:00Z')
  await db
    .insertInto('published_entries')
    .values({ ...post, created_at: at, updated_at: at, version: 2, published_at: at, published_by: user })
    .execute()

  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= names)))
  const versionsOf = (entry: { id: string }) =>
    db
      .selectFrom('entry_versions')
      .select(['number', 'name', 'published_at', 'published_by'])
      .where('entry_id', '=', entry.id)
      .orderBy('number')
      .execute()
  const unpublished = { name: null, published_at: null, published_by: null }
  expect(await versionsOf(post)).toEqual([
    { number: 1, ...unpublished },
    { number: 2, name: null, published_at: at, published_by: user },
    { number: 3, ...unpublished },
  ])
  expect(await versionsOf(draft)).toEqual([{ number: 1, ...unpublished }])

  expect(await rollback(db, migrations)).toEqual([names])
  const columns = await db.introspection.getTables()
  expect(columns.find((table) => table.name === 'entry_versions')?.columns.map((column) => column.name)).toEqual([
    'entry_id',
    'number',
    'values',
    'migration',
    'created_by',
    'created_at',
  ])
})

test("the migration that records versions' parents gives each version the parent its entry has now", async () => {
  const migrations = await loadMigrations(migrationsDir)
  const parents = '2026_10_31_000016_add_version_parents'
  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name < parents)))

  const guide = { id: uuidv7(), type: 'docs', values: {}, slug: 'guide', uri: 'guide', position: 0 }
  const install = { id: uuidv7(), type: 'docs', values: {}, slug: 'install', parent_id: guide.id, position: 0 }
  await db.insertInto('entries').values([guide, install]).execute()
  const version = (entry: { id: string }, number: number) => ({ entry_id: entry.id, number, values: {} })
  await db
    .insertInto('entry_versions')
    .values([version(guide, 1), version(install, 1), version(install, 2)])
    .execute()

  await migrate(db, Object.fromEntries(Object.entries(migrations).filter(([name]) => name <= parents)))
  const parentsOf = async (entry: { id: string }) =>
    (
      await db
        .selectFrom('entry_versions')
        .select('parent_id')
        .where('entry_id', '=', entry.id)
        .orderBy('number')
        .execute()
    ).map((row) => row.parent_id)
  expect(await parentsOf(guide)).toEqual([null])
  expect(await parentsOf(install)).toEqual([guide.id, guide.id])

  expect(await rollback(db, migrations)).toEqual([parents])
  const columns = (await db.introspection.getTables()).find((table) => table.name === 'entry_versions')?.columns
  expect(columns?.map((column) => column.name)).not.toContain('parent_id')
})
