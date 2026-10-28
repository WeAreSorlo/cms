import { loadContentMigrations } from '../src/content'
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
  ])

  await migrate(db, migrations)
  expect(await tables()).toEqual([
    'api_keys',
    'automation_runs',
    'automations',
    'entries',
    'entry_relations',
    'entry_versions',
    'events',
    'form_versions',
    'forms',
    'media',
    'migrations',
    'sessions',
    'submissions',
    'users',
  ])

  await rollback(db, migrations)
  expect(await tables()).toEqual(['migrations'])
})
