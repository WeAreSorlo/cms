import { flattenValidationReport, validateServerValues } from './core'
import type { Database } from './db'
import { type MigrationFile, type Migrations, readMigrations } from './migrator'
import { type EntryRow, type PublishedRow, isSaved } from './query'
import { serverInputs } from './relations'
import type { ContentType } from './types'
import { Kysely, sql } from 'kysely'

// Content migrations change the values inside entries when a content type changes (PLAN.md section 6). An up or down
// only declares changes to one entry at a time, so they can run on every entry in the database, or on an old version's
// values when it's restored.

type Values = Record<string, any>

// Paths name fields as the schema nests them: address.town in a group, pets.name in every item of a repeater or matrix,
// and blocks.quote.credit in the blocks of a flexible field's quote layout
export interface EntryChanges {
  renameField(type: string, from: string, to: string): void
  removeField(type: string, path: string): void
  // Gives entries without a value for the field this one
  addField(type: string, path: string, value: unknown): void
  mapField(type: string, path: string, change: (value: any) => unknown): void
  renameLayout(type: string, from: string, to: string): void
  removeLayout(type: string, path: string): void
  renameType(from: string, to: string): void
  // Any other change, returning an entry's new values
  update(type: string, change: (values: Values) => Values): void
}

export type ContentMigration = (context: { entries: EntryChanges }) => void | Promise<void>

export interface ContentMigrationFile {
  up: ContentMigration
  down: ContentMigration
}

// A change a migration declares to the entries of one type: a new name for the type, or new values for each entry
interface Step {
  type: string
  rename?: string
  change?: (values: Values) => Values
}

const isObject = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Call change with every object a path leads to: through groups by key, into every item of a list, and into the blocks
// of the flexible layout the path names. Blocks are known by their _layout key, which no field can have.
function each(node: unknown, path: Array<string>, change: (object: Values) => void, inBlock = false): void {
  if (Array.isArray(node)) return node.forEach((item) => each(item, path, change))
  if (!isObject(node)) return
  if (!inBlock && typeof node._layout === 'string') {
    if (node._layout === path[0]) each(node, path.slice(1), change, true)
    return
  }
  if (path.length === 0) return change(node)
  each(node[path[0]], path.slice(1), change)
}

// The object a path's last key sits in, along keys only, creating the objects on the way when asked
function container(object: Values, path: Array<string>, create: boolean) {
  let node = object
  for (const key of path.slice(0, -1)) {
    if (create && (node[key] === undefined || node[key] === null)) node[key] = {}
    if (Array.isArray(node[key])) throw new Error(`Can't move a value into or out of the list ${key}.`)
    if (!isObject(node[key])) return undefined
    node = node[key]
  }
  return node
}

// Move a value between two places in one object. Moving one into or out of a list would split or merge values, so
// make:migration writes a TODO for those instead.
function move(object: Values, from: Array<string>, to: Array<string>) {
  const source = container(object, from, false)
  const key = from.at(-1)!
  if (!source || !Object.hasOwn(source, key)) return

  const value = source[key]
  delete source[key]
  const target = container(object, to, true)
  if (!target) throw new Error(`Can't move ${from.join('.')} to ${to.join('.')}, which isn't inside an object.`)
  target[to.at(-1)!] = value
}

// How many containers two paths share. renameField steps through those, then moves the value along keys.
export function sharedDepth(from: Array<string>, to: Array<string>) {
  let shared = 0
  while (shared < from.length - 1 && shared < to.length - 1 && from[shared] === to[shared]) shared++
  return shared
}

// The steps a migration's up or down declares, in order
async function stepsOf(migration: ContentMigration) {
  const steps: Array<Step> = []
  const update = (type: string, change: (values: Values) => Values) => void steps.push({ type, change })

  // Change the object that holds a path's last key, wherever the path leads
  const inside = (type: string, path: string, change: (object: Values, key: string) => void) => {
    const keys = path.split('.')
    update(type, (values) => {
      each(values, keys.slice(0, -1), (object) => change(object, keys.at(-1)!))
      return values
    })
  }

  await migration({
    entries: {
      renameField(type, from, to) {
        const [source, target] = [from.split('.'), to.split('.')]
        const shared = sharedDepth(source, target)
        update(type, (values) => {
          each(values, source.slice(0, shared), (object) => move(object, source.slice(shared), target.slice(shared)))
          return values
        })
      },
      removeField: (type, path) => inside(type, path, (object, key) => delete object[key]),
      addField: (type, path, value) =>
        inside(type, path, (object, key) => {
          if (object[key] === undefined) object[key] = structuredClone(value)
        }),
      mapField: (type, path, change) =>
        inside(type, path, (object, key) => {
          if (Object.hasOwn(object, key)) object[key] = change(object[key])
        }),
      renameLayout(type, from, to) {
        const field = (path: string) => path.split('.').slice(0, -1).join('.')
        if (field(from) !== field(to)) throw new Error(`Can't rename ${from} to ${to}, outside its flexible field.`)
        update(type, (values) => {
          each(values, from.split('.'), (block) => (block._layout = to.split('.').at(-1)))
          return values
        })
      },
      removeLayout(type, path) {
        const layout = path.split('.').at(-1)
        inside(type, path.split('.').slice(0, -1).join('.'), (object, key) => {
          if (Array.isArray(object[key])) object[key] = object[key].filter((block) => block?._layout !== layout)
        })
      },
      renameType: (from, to) => void steps.push({ type: from, rename: to }),
      update,
    },
  })

  return steps
}

// The helper calls a migration makes, each by the helper's name with its arguments by name and functions left out, for
// saying what a waiting migration does on the admin's Migrations page. Like stepsOf, it only runs what the migration
// declares, never a change to an entry.
export async function callsOf(migration: ContentMigration) {
  const calls: Array<Record<string, unknown>> = []
  const named =
    (helper: string, ...keys: Array<string>) =>
    (...args: Array<unknown>) =>
      void calls.push({ helper, ...Object.fromEntries(keys.map((key, index) => [key, args[index]])) })
  await migration({
    entries: {
      renameField: named('renameField', 'type', 'from', 'to'),
      removeField: named('removeField', 'type', 'path'),
      addField: named('addField', 'type', 'path', 'value'),
      mapField: named('mapField', 'type', 'path'),
      renameLayout: named('renameLayout', 'type', 'from', 'to'),
      removeLayout: named('removeLayout', 'type', 'path'),
      renameType: named('renameType', 'from', 'to'),
      update: named('update', 'type'),
    },
  })
  return calls
}

const batchSize = 500

// Both hold entries' values: the drafts, and the live copies of those that are published (PLAN.md section 17)
const tables = ['entries', 'published_entries'] as const

// Call each with every row a query finds, a batch at a time in ID order, the query taking the last ID of the batch
// before
async function eachBatch<Row extends { id: string }>(
  find: (after?: string) => Promise<Array<Row>>,
  each: (rows: Array<Row>) => Promise<unknown>,
) {
  for (let after: string | undefined; ;) {
    const rows = await find(after)
    if (rows.length) await each(rows)
    if (rows.length < batchSize) return
    after = rows.at(-1)!.id
  }
}

// How many rows a migration's steps go through: each changing step goes through its type's drafts and live copies,
// counted by the name the type's entries have before the migration's renames run
async function rowsOf(db: Kysely<Database>, steps: Array<Step>) {
  const before = new Map<string, string>()
  const counted = new Map<string, number>()
  let total = 0
  for (const step of steps) {
    const type = before.get(step.type) ?? step.type
    if (step.rename !== undefined) {
      before.set(step.rename, type)
      continue
    }
    if (!counted.has(type)) {
      let count = 0
      for (const table of tables) {
        const { rows } = await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('rows'))
          .where('type', '=', type)
          .executeTakeFirstOrThrow()
        count += Number(rows)
      }
      counted.set(type, count)
    }
    total += counted.get(type)!
  }
  return total
}

// Run a content migration's up or down on every entry, drafts and live copies alike, a batch at a time, inside the
// migrator's transaction, saying how many rows it has been through of how many with each batch when asked.
// shortcut: the slug and uri columns aren't recomputed, so a hand-written change to slug values leaves them stale;
// recompute them when a migration needs that.
async function run(db: Kysely<Database>, migration: ContentMigration, rows?: (done: number, total: number) => void) {
  const steps = await stepsOf(migration)
  const total = rows ? await rowsOf(db, steps) : 0
  let done = 0
  rows?.(done, total)
  for (const step of steps) {
    if (step.rename !== undefined) {
      const taken = await db.selectFrom('entries').select('id').where('type', '=', step.rename).executeTakeFirst()
      if (taken) throw new Error(`Can't rename the type ${step.type} to ${step.rename}, which already has entries.`)
      for (const table of tables) {
        await db.updateTable(table).set({ type: step.rename }).where('type', '=', step.type).execute()
      }
      continue
    }

    for (const table of tables) {
      await eachBatch(
        (after) =>
          db
            .selectFrom(table)
            .select(['id', 'values'])
            .where('type', '=', step.type)
            .$if(after !== undefined, (qb) => qb.where('id', '>', after!))
            .orderBy('id')
            .limit(batchSize)
            .execute(),
        async (batch) => {
          const changed = batch.map((row) => ({ id: row.id, values: step.change!(row.values) }))
          await sql`
            update ${sql.table(table)} target set "values" = data."values"
            from jsonb_to_recordset(${JSON.stringify(changed)}::jsonb) as data (id uuid, "values" jsonb)
            where target.id = data.id and target."values" <> data."values"
          `.execute(db)
          rows?.((done += batch.length), total)
        },
      )
    }
  }
}

// The content migrations that have run, in the order they ran
export async function appliedMigrations(db: Kysely<Database>, files: Record<string, ContentMigrationFile>) {
  const names = Object.keys(files)
  if (names.length === 0) return []
  const rows = await db.selectFrom('migrations').select('name').where('name', 'in', names).orderBy('id').execute()
  return rows.map((row) => row.name)
}

// The site project's content migrations, from its folder or from files read from it, each of which must export an up
// and a down
export async function loadContentMigrations(from: string | Array<MigrationFile<ContentMigrationFile>>) {
  const files: Record<string, ContentMigrationFile> = {}
  for (const file of typeof from === 'string' ? await readMigrations<ContentMigrationFile>(from) : from) {
    files[file.name] = await file.load()
  }
  for (const [name, file] of Object.entries(files)) {
    if (typeof file.up !== 'function' || typeof file.down !== 'function') {
      throw new Error(`The content migration ${name} must export an up and a down function.`)
    }
  }
  return files
}

// Records, in a migration's transaction, that the links in entry_relations are due a rebuild from the entries' changed
// values, until one finishes
const linksDue = (trx: Kysely<Database>) =>
  trx
    .insertInto('rebuilds')
    .values({ name: 'entry_relations', due: 1 })
    .onConflict((oc) => oc.column('name').doUpdateSet({ due: sql`rebuilds.due + 1` }))
    .execute()

// Content migrations as the migrator runs them. Each also records on every entry the last migration its values have
// been through, and that the links are due a rebuild. Given rows, each up says how far it has got, as run does.
export function contentMigrations(
  files: Record<string, ContentMigrationFile>,
  rows?: (done: number, total: number) => void,
): Migrations {
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      {
        up: async (trx) => {
          await run(trx, file.up, rows)
          for (const table of tables) await trx.updateTable(table).set({ migration: name }).execute()
          await linksDue(trx)
        },
        down: async (trx) => {
          await run(trx, file.down)
          const applied = await appliedMigrations(trx, files)
          const before = applied[applied.indexOf(name) - 1] ?? null
          for (const table of tables) await trx.updateTable(table).set({ migration: before }).execute()
          await linksDue(trx)
        },
      },
    ]),
  )
}

// An old version's values brought up to date by the ups of the migrations that ran after it was saved, starting from
// the type its entry had then
export async function catchUp(type: string, values: Values, migrations: Array<ContentMigration>) {
  const steps = (await Promise.all(migrations.map(stepsOf))).flat()
  for (const step of [...steps].reverse()) if (step.rename === type) type = step.type

  for (const step of steps) {
    if (step.type !== type) continue
    if (step.rename !== undefined) type = step.rename
    else values = step.change!(values)
  }
  return values
}

// Every saved entry and every live copy whose values no longer pass its type's checks, or whose type is gone, for
// `iight migrate --check`. Drafts can be unfinished, so they pass what a save checks, and live copies what a publish
// does. A failure is of an entry's draft, or of its live copy when published is true.
export async function checkEntries(db: Kysely<Database>, types: Map<string, ContentType>) {
  type Failure = { entry: EntryRow | PublishedRow; published: boolean; messages: Record<string, Array<string>> }
  const failures: Array<Failure> = []
  const inputs = serverInputs(db, types)

  const check = (published: boolean) => async (rows: Array<EntryRow | PublishedRow>) => {
    for (const entry of rows) {
      const type = types.get(entry.type)
      if (!type) {
        failures.push({
          entry,
          published,
          messages: { type: [`There's no content type named ${entry.type} any more.`] },
        })
        continue
      }
      const report = await validateServerValues(type.fields, entry.values, inputs, { allowIncomplete: !published })
      if (!report.isValid) failures.push({ entry, published, messages: flattenValidationReport(report).messages })
    }
  }

  await eachBatch(
    (after) =>
      db
        .selectFrom('entries')
        .selectAll()
        .where(isSaved)
        .$if(after !== undefined, (qb) => qb.where('id', '>', after!))
        .orderBy('id')
        .limit(batchSize)
        .execute(),
    check(false),
  )
  await eachBatch(
    (after) =>
      db
        .selectFrom('published_entries')
        .selectAll()
        .$if(after !== undefined, (qb) => qb.where('id', '>', after!))
        .orderBy('id')
        .limit(batchSize)
        .execute(),
    check(true),
  )
  return failures
}
