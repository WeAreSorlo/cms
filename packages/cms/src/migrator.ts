import { Kysely, sql } from 'kysely'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface Migration {
  up: (db: Kysely<any>) => Promise<void>
  down: (db: Kysely<any>) => Promise<void>
}

export type Migrations = Record<string, Migration>

// The CMS's own migrations, which create its fixed tables
export const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

// Load every migration in a folder, named after its file. Other files, such as a site project's
// migrations/.snapshot.json, are skipped, and a folder that doesn't exist yet has none.
export async function loadMigrations<T = Migration>(dir: string): Promise<Record<string, T>> {
  const migrations: Record<string, T> = {}
  const files = existsSync(dir) ? await readdir(dir) : []
  for (const file of files.filter((file) => /^[^.].*\.[jt]s$/.test(file))) {
    migrations[basename(file, extname(file))] = await import(pathToFileURL(join(dir, file)).href)
  }
  return migrations
}

// shortcut: no migration lock, a concurrent run fails on the unique name and rolls back; add one for MySQL,
// whose DDL can't roll back
async function ensureTable(db: Kysely<any>) {
  await db.schema
    .createTable('migrations')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('batch', 'integer', (col) => col.notNull())
    .addColumn('migrated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

// Run every pending migration, each in its own transaction, as one new batch. Sets run in the order given, such as
// the CMS's before the site project's, and the migrations in each set in name order.
export async function migrate(db: Kysely<any>, ...sets: Array<Migrations>) {
  await ensureTable(db)
  const ran = await db.selectFrom('migrations').select(['name', 'batch']).execute()
  const done = new Set(ran.map((row) => row.name))
  const pending = sets.flatMap((set) =>
    Object.keys(set)
      .sort()
      .filter((name) => !done.has(name))
      .map((name) => ({ name, migration: set[name] })),
  )
  const batch = Math.max(0, ...ran.map((row) => row.batch)) + 1

  for (const { name, migration } of pending) {
    await db.transaction().execute(async (trx) => {
      await migration.up(trx)
      await trx.insertInto('migrations').values({ name, batch }).execute()
    })
  }

  return pending.map(({ name }) => name)
}

// Roll back every migration in the latest batch, newest first
export async function rollback(db: Kysely<any>, migrations: Migrations) {
  await ensureTable(db)
  const ran = await db.selectFrom('migrations').select(['name', 'batch']).orderBy('id', 'desc').execute()
  const names = ran.filter((row) => row.batch === ran[0].batch).map((row) => row.name)

  for (const name of names) {
    const migration = migrations[name]
    if (!migration) throw new Error(`Can't roll back ${name}, its file is missing`)

    await db.transaction().execute(async (trx) => {
      await migration.down(trx)
      await trx.deleteFrom('migrations').where('name', '=', name).execute()
    })
  }

  return names
}

// List every migration with the batch it ran in, or null while it's pending
export async function status(db: Kysely<any>, migrations: Migrations) {
  await ensureTable(db)
  const ran = await db.selectFrom('migrations').select(['name', 'batch']).execute()
  const batches = new Map(ran.map((row) => [row.name, row.batch]))
  return Object.keys(migrations)
    .sort()
    .map((name) => ({ name, batch: batches.get(name) ?? null }))
}
