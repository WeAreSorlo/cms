import { Kysely, sql } from 'kysely'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface Migration {
  up: (db: Kysely<any>) => Promise<void>
  down: (db: Kysely<any>) => Promise<void>
}

export type Migrations = Record<string, Migration>

// A migration's file, as it is now: its name, its text and a hash of that, and its module
export interface MigrationFile<T = Migration> {
  name: string
  text: string
  hash: string
  load: () => Promise<T>
}

// The CMS's own migrations, which create its fixed tables
export const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

// Every migration file in a folder, in name order, named after its file, with its text. Other files, such as a site
// project's migrations/.snapshot.json, are skipped, and a folder that doesn't exist yet has none. Each is imported by
// a hash of its text, since Node keeps a module by its address, so a file edited since the server first imported it,
// such as a migration whose TODO was written after the admin listed it, loads as it is now. A file that changes
// between being read and being loaded isn't loaded, so what's checked of its text, such as its TODOs, is what runs.
// shortcut: each edited version stays in memory until the process ends, and files a migration imports stay as they
// were first imported; fine while migration files change only in development
export async function readMigrations<T = Migration>(dir: string): Promise<Array<MigrationFile<T>>> {
  const files = existsSync(dir) ? (await readdir(dir)).filter((file) => /^[^.].*\.[jt]s$/.test(file)).sort() : []
  return Promise.all(
    files.map(async (file) => {
      const path = join(dir, file)
      const text = await readFile(path, 'utf8')
      const hash = hashOf(text)
      const load = async (): Promise<T> => {
        const module = await import(`${pathToFileURL(path).href}?text=${hash}`)
        if (hashOf(await readFile(path, 'utf8')) !== hash) throw new Error('It changed while it loaded. Load it again.')
        return module
      }
      return { name: basename(file, extname(file)), text, hash, load }
    }),
  )
}

// Load every migration in a folder, named after its file, as it is now
export async function loadMigrations<T = Migration>(dir: string): Promise<Record<string, T>> {
  const migrations: Record<string, T> = {}
  for (const file of await readMigrations<T>(dir)) migrations[file.name] = await file.load()
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
export const migrate = (db: Kysely<any>, ...sets: Array<Migrations>) => migrateWith(db, sets)

// What a run is told of each migration: as it starts, in its transaction, and once that transaction has committed
export interface MigrationHooks {
  starting?: (name: string) => void
  ran?: (name: string) => void
}

// migrate, telling hooks of each migration as it starts and once it has run
export async function migrateWith(
  db: Kysely<any>,
  sets: Array<Migrations>,
  { starting, ran: committed }: MigrationHooks = {},
) {
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
      starting?.(name)
      await migration.up(trx)
      await trx.insertInto('migrations').values({ name, batch }).execute()
    })
    committed?.(name)
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

// Every migration that has run, in the order it ran, with its batch and when
export async function ranMigrations(db: Kysely<any>) {
  await ensureTable(db)
  return db.selectFrom('migrations').select(['name', 'batch', 'migrated_at']).orderBy('id').execute()
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
