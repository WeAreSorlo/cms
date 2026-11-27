import { flattenValidationReport, pickValues, validateServerValues } from './core'
import type { Database } from './db'
import { type SiteHooks, Write, linesOf, refusedReport } from './hooks'
import { type MigrationFile, type Migrations, readMigrations } from './migrator'
import { type EntryRow, type PublishedRow, isSaved, toAdminEntry, withStatus } from './query'
import { cmsInputs, serverInputs } from './relations'
import type { ContentType } from './types'
import { Kysely, sql } from 'kysely'
import { isDeepStrictEqual } from 'node:util'

// Content migrations change the values inside entries when a content type changes. An up or down
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
  // Runs the site's beforeSave and afterSave hooks on the entries it changes, as export const hooks = true in its file.
  // Off unless true, so a migration is a pure transform of values.
  hooks?: boolean
}

// What content migrations that opt into hooks run them with: the site's hooks and types, and each migration's write,
// whose after hooks run once its transaction commits
export interface MigrationHooks {
  hooks: SiteHooks
  types: () => Promise<Map<string, ContentType>>
  writes: Map<string, Write>
}

// A change a migration declares to the entries of one type: a new name for the type, or new values for each entry
interface Step {
  type: string
  rename?: string
  change?: (values: Values) => Values
}

const isObject = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// A rich text field's tree, whose blocks sit in its block nodes, as a list of them
const blocksIn = (node: Values) =>
  isObject(node.root) && node.root.type === 'root' && Array.isArray(node.root.children)
    ? node.root.children.flatMap((child: unknown) => (isObject(child) && child.type === 'block' ? [child.block] : []))
    : undefined

// Call change with every object a path leads to: through groups by key, into every item of a list, and into the blocks
// of the flexible or rich text layout the path names. Blocks are known by their _layout key, which no field can have.
function each(node: unknown, path: Array<string>, change: (object: Values) => void, inBlock = false): void {
  if (Array.isArray(node)) return node.forEach((item) => each(item, path, change))
  if (!isObject(node)) return
  const blocks = inBlock ? undefined : blocksIn(node)
  if (blocks) return each(blocks, path, change)
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
          const field = object[key]
          if (Array.isArray(field)) object[key] = field.filter((block) => block?._layout !== layout)
          else if (isObject(field) && blocksIn(field)) {
            const children = field.root.children.filter((node: Values) => node?.block?._layout !== layout)
            object[key] = { ...field, root: { ...field.root, children } }
          }
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

// Both hold entries' values: the drafts, and the live copies of those that are published
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

// Runs a content migration that opts into hooks, then the site's beforeSave on each draft and live copy it changed, with
// the values it had before as original, checked again as a save of each would be, and queues afterSave for each draft.
// A refusal fails the migration. A version can't run hooks as it catches up, so the version a draft or live copy whose
// values a hook changed comes from takes its values, as of the migration at, which the entry records once it's done.
// Hooks read through sorlo in the migration's transaction, and can't write through it until it commits.
// shortcut: it holds the values of the types the migration changes in memory, and reads each changed row on its own;
// stream them when a site's content outgrows that
async function runWithHooks(
  db: Kysely<Database>,
  migration: ContentMigration,
  ran: () => Promise<void>,
  write: Write,
  types: Map<string, ContentType>,
  at: string | null,
) {
  const touched = [...new Set((await stepsOf(migration)).map((step) => step.type))]
  const before = new Map<(typeof tables)[number], Map<string, Values>>()
  for (const table of tables) {
    const rows = touched.length
      ? await db.selectFrom(table).select(['id', 'values']).where('type', 'in', touched).execute()
      : []
    before.set(table, new Map(rows.map((row) => [row.id, row.values])))
  }
  await ran()

  const inputs = serverInputs(db, types)
  for (const table of tables) {
    const draft = table === 'entries'
    for (const [id, original] of before.get(table)!) {
      const row = await db.selectFrom(table).select(['type', 'values']).where('id', '=', id).executeTakeFirst()
      const type = row && types.get(row.type)
      if (!type || isDeepStrictEqual(row.values, original)) continue
      const entry = async () => {
        const status = await withStatus(db).selectAll().where('id', '=', id).executeTakeFirst()
        return status ? toAdminEntry(status) : null
      }
      const mode = { allowIncomplete: draft }
      const check = async (next: Values) => {
        const picked = pickValues(type.fields, next, cmsInputs)
        return { values: picked, report: await validateServerValues(type.fields, picked, inputs, mode) }
      }
      const base = { operation: 'update' as const, original }
      const saving = await write.before(
        'content',
        type.name,
        'beforeSave',
        { ...base, values: row.values, entry: await entry() },
        { check, trx: db },
      )
      if (saving.refused) {
        const lines = linesOf(refusedReport(saving.refused)).join('\n  ')
        throw new Error(
          `A hook refused the ${draft ? 'draft' : 'live copy'} of the ${type.name} entry ${id}:\n  ${lines}`,
        )
      }
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(saving.values)), row.values)) {
        await db.updateTable(table).set({ values: saving.values }).where('id', '=', id).execute()
        // The draft's newest version, or the live copy's own
        const number = draft
          ? sql<number>`(select max(number) from entry_versions where entry_id = ${id})`
          : sql<number>`(select version from published_entries where id = ${id})`
        await db
          .updateTable('entry_versions')
          .set({ values: saving.values, migration: at })
          .where('entry_id', '=', id)
          .where('number', '=', number)
          .execute()
      }
      if (draft && write.wants('content', type.name, 'afterSave')) {
        const after = await entry()
        write.after('content', type.name, 'afterSave', { ...base, values: after!.values, entry: after })
      }
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
  // The site's hooks, for the migrations that opt into them
  hooked?: MigrationHooks,
): Migrations {
  // Runs a migration's up or down, and with hooks, the site's hooks on what it changed
  const step = async (trx: Kysely<Database>, name: string, file: ContentMigrationFile, migration: ContentMigration) => {
    const ran = () => run(trx, migration, migration === file.up ? rows : undefined)
    if (file.hooks !== true || !hooked) return ran()
    const write = new Write(hooked.hooks, { user: null, source: 'migration' })
    hooked.writes.set(name, write)
    // The migration the entries' values have been through once this one is done
    const applied = migration === file.up ? [] : await appliedMigrations(trx, files)
    const at = migration === file.up ? name : (applied[applied.indexOf(name) - 1] ?? null)
    await runWithHooks(trx, migration, ran, write, await hooked.types(), at)
  }
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      {
        up: async (trx) => {
          await step(trx, name, file, file.up)
          for (const table of tables) await trx.updateTable(table).set({ migration: name }).execute()
          await linksDue(trx)
        },
        down: async (trx) => {
          await step(trx, name, file, file.down)
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
  return walk(steps, type, values).values
}

// Values that a type then named type had, through the steps in turn, with the name the type has after them
function walk(steps: Array<Step>, type: string, values: Values) {
  for (const step of steps) {
    if (step.type !== type) continue
    if (step.rename !== undefined) type = step.rename
    else values = step.change!(values)
  }
  return { type, values }
}

// Brings values from before the migrations up to date with their ups, as sorlo import does with an export made before
// them, from the name the type had in the export to the name it has now
export async function catchUpFrom(migrations: Array<ContentMigration>) {
  const steps = (await Promise.all(migrations.map(stepsOf))).flat()
  return (type: string, values: Values) => walk(steps, type, values)
}

// Every saved entry and every live copy whose values no longer pass its type's checks, or whose type is gone, for
// `sorlo migrate --check`. Drafts can be unfinished, so they pass what a save checks, and live copies what a publish
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
