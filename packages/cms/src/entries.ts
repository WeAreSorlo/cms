import type { Preview, VersionOptions } from '.'
import { ContentMigrationFile, appliedMigrations, catchUp } from './content'
import { inputs, isEmptyValue, pickValues, validateServerValues, validationError } from './core'
import { Database, isUuid, transaction, uuidv7 } from './db'
import { page } from './embed'
import { addEvents } from './events'
import { type HookArgs, type HookSource, Refusal, type SiteHooks, Write, refusedReport } from './hooks'
import { origin } from './media'
import {
  EntryRow,
  StatusRow,
  entryIds,
  listEntries,
  parseQuery,
  toAdminEntry,
  toEntry,
  usedBy,
  withStatus,
} from './query'
import { cmsInputs, saveRelations, serverInputs } from './relations'
import { EventName, maxTicked, versionSchema } from './schemas'
import type { ContentType } from './types'
import type { FieldSchema, InputSchema, ValidationReport } from '@sorlo/forms'
import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely, sql } from 'kysely'
import { isDeepStrictEqual } from 'node:util'

export type AdminEnv = { Variables: { user: { id: string; email: string; name: string }; origin?: string } }

const slugTaken = 'Another entry here already uses this slug.'
const liveSlugTaken = 'A published entry here already uses this slug.'
const unpublishedParent = "Its parent isn't published. Publish the parent first."
const archived = 'This entry is archived. Restore it to edit it.'
const parentArchived = 'Its parent is archived. Restore the parent first.'
const notOfType = "There's no entry of this type with this id."

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Changed fields merged into an entry's values. A group's fields merge one by one, at any depth, and any other field's
// value replaces what's stored, so a list or a link is sent whole. Keys that aren't the type's fields are left out.
export function merge(fields: Array<FieldSchema>, values: Record<string, any>, changed: Record<string, any>) {
  const merged = { ...values }
  for (const field of fields) {
    if (!Object.hasOwn(changed, field.name)) continue
    const value = changed[field.name]
    const group = field.type === 'group' && isObject(value)
    const saved = isObject(values[field.name]) ? values[field.name] : {}
    merged[field.name] = group ? merge(field.options?.fields ?? [], saved, value) : value
  }
  return merged
}

// The entries and everything under them, as a "tree" for the statement that follows
const tree = (ids: Array<string>) => sql`
  with recursive tree as (
    select id from entries where id = any(${ids}::uuid[])
    union
    select entries.id from entries join tree on entries.parent_id = tree.id
  )`

// Writes an event for each changed entry, with the entry as the admin API returns it once the change is made
async function addEntryEvents(trx: Kysely<Database>, name: EventName, rows: Array<{ id: string }>) {
  const ids = rows.map((row) => row.id)
  const changed = ids.length ? await withStatus(trx).selectAll().where('id', 'in', ids).execute() : []
  await addEvents(
    trx,
    name,
    changed.map((row) => ({ entry: toAdminEntry(row) })),
  )
}

type Operation = HookArgs<unknown>['operation']
type Values = Record<string, any>

// Runs the before hook named for each entry an action takes, refusing the whole action with a 422 if one refuses. Each
// gets the draft's values, or for unpublishing, the live copy's, which live gives by ID.
async function beforeEach(
  trx: Kysely<Database>,
  write: Write | undefined,
  name: 'beforeUnpublish' | 'beforeArchive' | 'beforeRestore',
  operation: Operation,
  ids: Array<string>,
  live?: Map<string, Values>,
) {
  if (!write?.hooks?.has('content', name) || !ids.length) return
  const rows = await withStatus(trx).selectAll().where('id', 'in', ids).orderBy('id').execute()
  for (const row of rows) {
    const values = live?.get(row.id) ?? row.values
    const base = { operation, values, original: values, entry: toAdminEntry(row) }
    const result = await write.before('content', row.type, name, base, { trx })
    if (result.refused) throw new Refusal(refusedReport(result.refused))
  }
}

// Queues the after hooks named for the entries a write took, each with the entry as the write left it, read in its
// transaction. original is the values before a save, which other actions leave as they were. Unpublishing gives the
// values of the live copies it took down, by ID, in live.
async function queueAfter(
  trx: Kysely<Database>,
  write: Write | undefined,
  ids: Array<string>,
  hooks: Array<[name: 'afterSave' | 'afterPublish' | 'afterUnpublish' | 'afterArchive' | 'afterRestore', Operation]>,
  original?: Values | null,
  live?: Map<string, Values>,
) {
  if (!write || !hooks.some(([name]) => write.hooks?.has('content', name)) || !ids.length) return
  const rows = await withStatus(trx).selectAll().where('id', 'in', ids).orderBy('id').execute()
  for (const row of rows) {
    const values = live?.get(row.id) ?? row.values
    for (const [name, operation] of hooks) {
      const base = { operation, values, original: original === undefined ? values : original }
      write.after('content', row.type, name, { ...base, entry: toAdminEntry(row) })
    }
  }
}

// Gives the pages under an entry the uris its own gives them, among the drafts or the live copies, returning the pages
// whose uri changed
async function followUri(trx: Kysely<Database>, table: 'entries' | 'published_entries', id: string) {
  const { rows } = await sql<{ id: string }>`
    with recursive tree as (
      select id, uri from ${sql.table(table)} where id = ${id}
      union all
      select page.id, case when tree.uri is null or page.slug is null then null else tree.uri || '/' || page.slug end
      from ${sql.table(table)} page join tree on page.parent_id = tree.id
    )
    update ${sql.table(table)} page set uri = tree.uri from tree
    where page.id = tree.id and page.id <> ${id} and page.uri is distinct from tree.uri
    returning page.id
  `.execute(trx)
  return rows
}

// Takes entries off the live site, with the live pages under them, marking each as taken down by a person, since only
// people unpublish and archive. Marking them locks them as a save locks an entry, before their live copies go, so a
// publish under way finishes first, and one waiting behind this finds the mark.
// shortcut: a page published under one of them at that same moment goes down with it unmarked, until this takes the
// type's publish lock too
// With a write, its unpublish hooks run for each entry it takes down. Archiving takes entries down with its own hooks.
export async function unpublish(trx: Kysely<Database>, ids: Array<string>, write?: Write) {
  if (!ids.length) return
  const live = sql`
    with recursive live as (
      select id from published_entries where id = any(${ids}::uuid[])
      union
      select page.id from published_entries page join live on page.parent_id = live.id
    )`
  // The live copies' values, which the unpublish hooks get
  const copies = (rows: Array<{ id: string; values: Values }>) => new Map(rows.map((row) => [row.id, row.values]))
  if (write) {
    const { rows: taking } = await sql<{ id: string; values: Values }>`${live}
      select page.id, page.values from published_entries page join live on live.id = page.id
    `.execute(trx)
    const taken = taking.map((row) => row.id)
    await beforeEach(trx, write, 'beforeUnpublish', 'unpublish', taken, copies(taking))
  }
  await sql`${live} update entries set taken_down_at = now() from live where entries.id = live.id`.execute(trx)
  const { rows } = await sql<{ id: string; values: Values }>`${live}
    delete from published_entries using live where published_entries.id = live.id
    returning published_entries.id, published_entries.values
  `.execute(trx)
  await addEntryEvents(trx, 'entry.unpublished', rows)
  const taken = rows.map((row) => row.id)
  await queueAfter(trx, write, taken, [['afterUnpublish', 'unpublish']], undefined, copies(rows))
}

// Archives entries with their descendants that aren't archived, all stamped with the transaction's time, so restoring
// one of them brings back just what was archived along with it. It takes them off the live site, with the live pages
// under them. With a write, its archive hooks run for each entry it archives.
export async function archive(trx: Kysely<Database>, ids: Array<string>, write?: Write) {
  if (write) {
    const { rows: taking } = await sql<{ id: string }>`${tree(ids)}
      select entries.id from entries join tree on entries.id = tree.id where entries.archived_at is null
    `.execute(trx)
    const taken = taking.map((row) => row.id)
    await beforeEach(trx, write, 'beforeArchive', 'archive', taken)
  }
  const { rows } = await sql<{ id: string }>`${tree(ids)}
    update entries set archived_at = now() from tree where entries.id = tree.id and entries.archived_at is null
    returning entries.id
  `.execute(trx)
  const archived = rows.map((row) => row.id)
  await unpublish(trx, archived)
  await addEntryEvents(trx, 'entry.archived', rows)
  await queueAfter(trx, write, archived, [['afterArchive', 'archive']])
}

// Restores an entry with what was archived along with it, as drafts to publish again, or throws a 409 while its
// parent is archived. With a write, its restore hooks run for each entry it restores.
export async function restore(trx: Kysely<Database>, row: { id: string; parent_id: string | null }, write?: Write) {
  const parent = row.parent_id
    ? await trx.selectFrom('entries').select('archived_at').where('id', '=', row.parent_id).executeTakeFirst()
    : undefined
  if (parent?.archived_at) throw new HTTPException(409, { message: parentArchived })

  const along = sql`
    where entries.id = tree.id and entries.archived_at = (select archived_at from entries where id = ${row.id})`
  if (write) {
    const { rows: taking } = await sql<{ id: string }>`${tree([row.id])}
      select entries.id from entries, tree ${along}
    `.execute(trx)
    const taken = taking.map((each) => each.id)
    await beforeEach(trx, write, 'beforeRestore', 'restore', taken)
  }
  const { rows } = await sql<{ id: string }>`${tree([row.id])}
    update entries set archived_at = null from tree ${along}
    returning entries.id
  `.execute(trx)
  await addEntryEvents(trx, 'entry.restored', rows)
  await queueAfter(
    trx,
    write,
    rows.map((each) => each.id),
    [['afterRestore', 'restore']],
  )
}

// Makes what was just saved the entry's live copy, and has the live pages under it follow its live uri, which comes
// from its live parents' slugs. A page goes live only under a live parent that isn't under it on the live site.
async function goLive(
  trx: Kysely<Database>,
  type: ContentType,
  row: EntryRow,
  version: number,
  user: string | null,
  via?: Via,
) {
  let uri = row.uri
  if (type.structure === 'hierarchical') {
    // One publish of the type at a time, so two can't each put a page under the other
    await sql`select pg_advisory_xact_lock(hashtext(${`publish ${type.name}`}))`.execute(trx)
    if (row.parent_id) {
      const { rows: ancestors } = await sql<{ id: string; uri: string | null }>`
        with recursive ancestors as (
          select id, parent_id, uri, 0 as depth from published_entries where id = ${row.parent_id}
          union all
          select page.id, page.parent_id, page.uri, depth + 1
          from published_entries page join ancestors on page.id = ancestors.parent_id
        )
        select id, uri from ancestors order by depth
      `.execute(trx)
      if (!ancestors.length) throw new HTTPException(409, { message: unpublishedParent })
      if (ancestors.some((ancestor) => ancestor.id === row.id)) {
        throw new HTTPException(409, { message: 'Its parent is under it on the live site. Publish the parent first.' })
      }
      uri = row.slug && ancestors[0].uri && `${ancestors[0].uri}/${row.slug}`
    }
  }

  const live = {
    type: row.type,
    values: row.values,
    parent_id: row.parent_id,
    position: row.position,
    slug: row.slug,
    uri,
    migration: row.migration,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version,
    published_at: sql<Date>`now()`,
    published_by: user,
  }
  await trx
    .insertInto('published_entries')
    .values({ id: row.id, ...live })
    .onConflict((oc) => oc.column('id').doUpdateSet(live))
    .execute()
  // So each version records the last time it went live, and how
  await trx
    .updateTable('entry_versions')
    .set({
      published_at: sql`now()`,
      published_by: user,
      published_chat_id: via?.chat ?? null,
      published_token_id: via?.token ?? null,
    })
    .where('entry_id', '=', row.id)
    .where('number', '=', version)
    .execute()
  // A person's publish ends a person's take-down, and a token's never does
  if (!via?.token) {
    await trx
      .updateTable('entries')
      .set({ taken_down_at: null })
      .where('id', '=', row.id)
      .where('taken_down_at', 'is not', null)
      .execute()
  }

  const moved = type.structure === 'hierarchical' ? await followUri(trx, 'published_entries', row.id) : []
  await addEntryEvents(trx, 'entry.published', [row, ...moved])
}

// An entry, archived or not, with its content type, or a 404
export async function findEntry(db: Kysely<Database>, types: Map<string, ContentType>, id: string) {
  const row = isUuid(id) ? await withStatus(db).selectAll().where('id', '=', id).executeTakeFirst() : undefined
  const type = row && types.get(row.type)
  if (!row || !type) throw new HTTPException(404)
  return { row, type }
}

// The assistant's chat or the MCP token behind a save or a publish, with the chat's title or the token's name, or no
// name once the chat is deleted
const viaOf = (chat: string | null, title: string | null, token: string | null, name: string | null) =>
  chat ? { kind: 'chat' as const, id: chat, name: title } : token ? { kind: 'token' as const, id: token, name } : null

// An entry's versions, newest first, or the one with the given number: its name, who saved it and when, and when it
// last went live and who published it then. Only people's saves and publishes record a user, so a version with none
// came from sorlo import or sorlo migrate, or a user deleted before removal kept people's rows. via is the assistant's
// chat or the MCP token it was saved through, and publishedVia the one its last publish came through.
export async function listVersions(db: Kysely<Database>, id: string, number?: number) {
  const rows = await db
    .selectFrom('entry_versions')
    .leftJoin('users as saver', 'saver.id', 'entry_versions.created_by')
    .leftJoin('users as publisher', 'publisher.id', 'entry_versions.published_by')
    .leftJoin('chats', 'chats.id', 'entry_versions.chat_id')
    .leftJoin('personal_tokens as token', 'token.id', 'entry_versions.token_id')
    .leftJoin('chats as published_chat', 'published_chat.id', 'entry_versions.published_chat_id')
    .leftJoin('personal_tokens as published_token', 'published_token.id', 'entry_versions.published_token_id')
    .select([
      'number',
      'entry_versions.name',
      'entry_versions.created_at',
      'entry_versions.published_at',
      'entry_versions.chat_id',
      'entry_versions.token_id',
      'entry_versions.published_chat_id',
      'entry_versions.published_token_id',
      'chats.title as chat_title',
      'token.name as token_name',
      'published_chat.title as published_chat_title',
      'published_token.name as published_token_name',
      'saver.id as saver_id',
      'saver.name as saver_name',
      'publisher.id as publisher_id',
      'publisher.name as publisher_name',
    ])
    .where('entry_id', '=', id)
    .$if(number !== undefined, (qb) => qb.where('number', '=', number!))
    .orderBy('number', 'desc')
    .execute()
  return rows.map((version) => ({
    number: version.number,
    name: version.name,
    createdBy: version.saver_id ? { id: version.saver_id, name: version.saver_name } : null,
    createdAt: version.created_at,
    publishedAt: version.published_at,
    publishedBy: version.publisher_id ? { id: version.publisher_id, name: version.publisher_name } : null,
    via: viaOf(version.chat_id, version.chat_title, version.token_id, version.token_name),
    publishedVia: viaOf(
      version.published_chat_id,
      version.published_chat_title,
      version.published_token_id,
      version.published_token_name,
    ),
  }))
}

// One of an entry's versions with its values brought up to date, by running the ups of the content migrations that
// ran after it was saved, so they fit the type's fields, or a 404
export async function readVersion(
  db: Kysely<Database>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  entry: { id: string; type: string },
  number: number,
) {
  const version = await db
    .selectFrom('entry_versions')
    .selectAll()
    .where('entry_id', '=', entry.id)
    .where('number', '=', number)
    .executeTakeFirst()
  if (!version) throw new HTTPException(404)

  const files = await migrations()
  const applied = await appliedMigrations(db, files)
  const since = version.migration === null ? 0 : applied.indexOf(version.migration) + 1
  if (since === 0 && version.migration !== null) {
    const message = `Version ${number} was saved after the content migration ${version.migration}, which has been rolled back. Migrate again to restore it.`
    throw new HTTPException(409, { message })
  }
  const values = await catchUp(
    entry.type,
    version.values,
    applied.slice(since).map((name) => files[name].up),
  )

  return {
    number: version.number,
    values,
    parentId: version.parent_id,
    createdBy: version.created_by,
    createdAt: version.created_at,
  }
}

// Where a save came from besides who made it, which the version it writes records
export interface Via {
  chat?: string
  token?: string
}

export interface SaveOptions {
  via?: Via
  // The id a new entry is made with, which its proposal gave it in advance
  newId?: string
  // Forms proposed in the same chat, which a form field can name before they're made
  pendingForms?: Array<string>
  // Runs every check and write, then takes them all back, for checking a proposal
  dryRun?: boolean
  // Runs in the save's transaction once an existing entry is locked, before anything is written, such as to check
  // it's still as it was read
  before?: (trx: Kysely<Database>, existing: EntryRow) => Promise<void>
  // Runs in the save's transaction once it's written, with the version it wrote, or the current one when nothing
  // changed, such as to claim the proposal it applies
  during?: (trx: Kysely<Database>, version: number) => Promise<void>
  // The site's hooks for the save, who it's by and where it came from. Without one, as for a dry run, none run.
  write?: Write
}

// What a dry run would have saved, thrown so its transaction takes every write back
class DryRun extends Error {
  constructor(readonly saved: { id: string; version: number }) {
    super('Dry run')
  }
}

// A hook's refusal, thrown so the save's transaction takes back what the hooks before it wrote through sorlo
class Refused extends Error {
  constructor(readonly report: ValidationReport) {
    super('Refused')
  }
}

// Checking and saving entries, as the editor, bulk editing, the assistant's Apply and MCP tokens all do
export function entrySaver(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  { keep }: Partial<VersionOptions> = {},
) {
  // The inputs' server checks, with the type's slug field also checking that no sibling has the slug, archived ones
  // included, and for a publish, no live sibling. Built per save, since the check needs the entry and its parent, and
  // querying through the save's transaction.
  const checkInputs = (
    trx: Kysely<Database>,
    type: ContentType,
    id: string | null,
    parentId: string | null,
    publish: boolean,
    pendingForms: Array<string> = [],
  ) => {
    const inputs = serverInputs(trx, types, pendingForms)
    const slugField = type.fields.find((field) => field.name === type.slugField)
    if (!slugField) return inputs

    const identifier = inputs.identifier
    const validateServerValue = async (value: unknown, schema: InputSchema) => {
      const validation = identifier.validateValue!(value, schema)
      if (schema.id !== slugField.id || !validation.isValid || isEmptyValue(value)) return validation

      const sibling = await trx
        .selectFrom('entries')
        .select('archived_at')
        .where('type', '=', type.name)
        .where('parent_id', parentId === null ? 'is' : '=', parentId)
        .where('slug', '=', String(value))
        .$if(id !== null, (qb) => qb.where('id', '!=', id!))
        .executeTakeFirst()

      if (sibling) {
        return validationError(
          value,
          sibling.archived_at ? 'An archived entry here already uses this slug.' : slugTaken,
        )
      }

      // A live entry keeps its slug until it's published again, so a publish can clash with one that no draft has
      const live =
        publish &&
        (await trx
          .selectFrom('published_entries')
          .select('id')
          .where('type', '=', type.name)
          .where('parent_id', parentId === null ? 'is' : '=', parentId)
          .where('slug', '=', String(value))
          .$if(id !== null, (qb) => qb.where('id', '!=', id!))
          .executeTakeFirst())
      return live ? validationError(value, liveSlugTaken) : validation
    }

    return { ...inputs, identifier: { ...identifier, validateServerValue } }
  }

  // A parent must be an entry of the same type that isn't archived, and neither the entry nor one of its descendants
  const checkParent = async (trx: Kysely<Database>, type: ContentType, parentId: unknown, id?: string) => {
    const parent = isUuid(parentId)
      ? await trx
          .selectFrom('entries')
          .selectAll()
          .where('id', '=', parentId)
          .where('type', '=', type.name)
          .where('archived_at', 'is', null)
          .executeTakeFirst()
      : undefined

    // The entry would sit under itself if it's the parent or one of the parent's ancestors
    const loops =
      parent &&
      id &&
      (
        await sql<{ loops: boolean }>`
          with recursive ancestors as (
            select id, parent_id from entries where id = ${parent.id}
            union all
            select entries.id, entries.parent_id from entries join ancestors on entries.id = ancestors.parent_id
          )
          select exists (select 1 from ancestors where id = ${id}) as loops
        `.execute(trx)
      ).rows[0].loops

    if (!parent || loops) {
      throw new HTTPException(400, {
        message: "The parent must be another entry of this type that isn't archived, outside this one.",
      })
    }
    return parent
  }

  // The content migrations that have run, which values saved now have been through. While one is pending, the types
  // already have its change, so saving would mix the old fields' values with the new.
  const migrated = async () => {
    const files = await migrations()
    const applied = await appliedMigrations(db, files)
    const pending = Object.keys(files)
      .sort()
      .find((name) => !applied.includes(name))
    if (pending) {
      throw new HTTPException(409, {
        message: `Run sorlo migrate first. The content migration ${pending} hasn't run yet.`,
      })
    }
    return applied
  }

  // Check values and save them as a new entry, or as the new version of the entry with the given ID, in one
  // transaction. An entry is read and locked first, and what's saved comes from that read, so no other save of the
  // entry can land between the two: what's sent replaces its values, or for bulk editing, merges into them. With
  // publish, it runs the checks a publish needs too and makes what it saves the live copy, or does neither. A failed
  // check comes back as core's report, and whatever else stops the save throws. The checks query through the
  // transaction, so a save never waits for a second connection while it holds one. It replies the version it wrote, or
  // the current one when nothing changed. With a write, the site's hooks run around it: the before hooks on values
  // that passed, with core checking what beforeSave returns again in the save's own mode, and the after hooks once it
  // commits. A dry run runs none, since a hook's own writes would escape its taking back.
  const saveEntry = async (
    type: ContentType,
    user: string | null,
    applied: Array<string>,
    publish: boolean,
    sent: (saved?: EntryRow) => { values: unknown; parentId: string | null },
    id?: string,
    { via, newId, pendingForms, dryRun, before, during, write: hooked }: SaveOptions = {},
  ): Promise<
    | { id: string; version: number; report?: undefined }
    | { id?: undefined; version?: undefined; report: ValidationReport }
  > => {
    let report: ValidationReport | undefined
    const write = dryRun ? undefined : hooked
    // What was saved, after the hooks that run in its transaction
    const done = async (trx: Kysely<Database>, saved: { id: string; version: number }) => {
      await during?.(trx, saved.version)
      if (dryRun) throw new DryRun(saved)
      return saved
    }
    try {
      // Inside the transaction of a write whose before hook makes this one through sorlo, as a savepoint
      const saved = await transaction(db, async (trx) => {
        const existing =
          id !== undefined && isUuid(id)
            ? await trx.selectFrom('entries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
            : undefined
        if (id !== undefined && existing?.type !== type.name) throw new HTTPException(404)
        if (existing?.archived_at) throw new HTTPException(409, { message: archived })
        if (existing) await before?.(trx, existing)

        const { values: posted, parentId } = sent(existing)
        const parent = parentId === null ? undefined : await checkParent(trx, type, parentId, existing?.id)

        // A draft can be unfinished, with required fields left empty, but a publish runs every check
        let values = pickValues(type.fields, (posted as Record<string, any>) ?? {}, cmsInputs)
        const inputs = checkInputs(trx, type, existing?.id ?? null, parentId, publish, pendingForms)
        const mode = { allowIncomplete: !publish }
        report = await validateServerValues(type.fields, values, inputs, mode)
        if (!report.isValid) return { report }

        const status =
          existing && (await withStatus(trx).selectAll().where('id', '=', existing.id).executeTakeFirstOrThrow())
        const base = { original: existing?.values ?? null, entry: status ? toAdminEntry(status) : null }
        // A hook's refusal, merged into core's report
        const refuse = (messages: Record<string, Array<string>>) => {
          throw new Refused((report = refusedReport(messages, report)))
        }
        if (write) {
          const check = async (next: Values) => {
            const picked = pickValues(type.fields, next, cmsInputs)
            return { values: picked, report: await validateServerValues(type.fields, picked, inputs, mode) }
          }
          const operation = existing ? 'update' : 'create'
          const saving = await write.before(
            'content',
            type.name,
            'beforeSave',
            { ...base, operation, values },
            { check, id: existing?.id, trx },
          )
          if (saving.refused) return refuse(saving.refused)
          values = saving.values
        }

        // A save that changes nothing does nothing once the entry has a version: no version, relations or events, and
        // its updated_at stays. Values compare as stored, so their keys' order doesn't count. A publish still makes the
        // newest version live while the live copy is older or missing.
        const unchanged =
          !!status?.version &&
          existing!.parent_id === parentId &&
          isDeepStrictEqual(JSON.parse(JSON.stringify(values)), existing!.values)
        const goesLive = publish && (!unchanged || (status!.published_version ?? 0) < status!.version!)
        if (write && goesLive) {
          const publishing = await write.before(
            'content',
            type.name,
            'beforePublish',
            { ...base, operation: 'publish', values },
            { id: existing?.id, trx },
          )
          if (publishing.refused) return refuse(publishing.refused)
        }
        if (unchanged) {
          if (goesLive) {
            await goLive(trx, type, existing!, status!.version!, user, via)
            await queueAfter(trx, write, [existing!.id], [['afterPublish', 'publish']], base.original)
          }
          return done(trx, { id: existing!.id, version: status!.version! })
        }

        const slug: string | null = (type.slugField && values[type.slugField]) || null
        const hierarchical = type.structure === 'hierarchical'
        const uri = !hierarchical || !slug ? null : parent ? parent.uri && `${parent.uri}/${slug}` : slug

        // A new or moved entry goes after its siblings
        const position = !hierarchical
          ? null
          : existing && existing.parent_id === parentId
            ? existing.position
            : (
                await trx
                  .selectFrom('entries')
                  .select(sql<number>`coalesce(max(position) + 1, 0)`.as('next'))
                  .where('type', '=', type.name)
                  .where('parent_id', parentId === null ? 'is' : '=', parentId)
                  .executeTakeFirstOrThrow()
              ).next

        const migration = applied.at(-1) ?? null
        const fields = { values, parent_id: parentId, position, slug, uri, migration, updated_by: user }
        const row = existing
          ? await trx
              .updateTable('entries')
              .set({ ...fields, updated_at: sql`now()` })
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('entries')
              .values({ ...fields, id: newId ?? uuidv7(), type: type.name, created_by: user })
              .returningAll()
              .executeTakeFirstOrThrow()

        // The entry is locked, so concurrent saves number their versions in turn
        const { number } = await trx
          .insertInto('entry_versions')
          .values({
            entry_id: row.id,
            number: sql`(select coalesce(max(number), 0) + 1 from entry_versions where entry_id = ${row.id})`,
            values,
            parent_id: parentId,
            migration,
            created_by: user,
            chat_id: via?.chat ?? null,
            token_id: via?.token ?? null,
          })
          .returning('number')
          .executeTakeFirstOrThrow()
        await saveRelations(trx, type, row.id, values)
        await addEntryEvents(trx, existing ? 'entry.updated' : 'entry.created', [row])

        // A new slug or parent changes the uri of every page under the entry
        if (existing && existing.uri !== uri) {
          await addEntryEvents(trx, 'entry.updated', await followUri(trx, 'entries', row.id))
        }

        if (publish) await goLive(trx, type, row, number, user, via)
        const saving: ['afterSave', Operation] = ['afterSave', existing ? 'update' : 'create']
        await queueAfter(
          trx,
          write,
          [row.id],
          publish ? [saving, ['afterPublish', 'publish']] : [saving],
          base.original,
        )

        // The newest versions up to the cap, so the current one stays, besides the named ones and the live one. The
        // name is checked again on each row as it's deleted, so a version named meanwhile stays.
        if (keep) {
          await sql`
            delete from entry_versions where entry_id = ${row.id} and name is null and number in (
              select number from entry_versions
              where entry_id = ${row.id} and name is null
                and number is distinct from (select version from published_entries where id = ${row.id})
              order by number desc offset ${keep}
            )
          `.execute(trx)
        }
        return done(trx, { id: row.id, version: number })
      })
      if ('report' in saved) write?.drop()
      else await write?.flush()
      return saved
    } catch (error) {
      write?.drop()
      if (error instanceof DryRun) return error.saved
      if (error instanceof Refused) return { report: error.report }
      const constraint = (error as { constraint?: string }).constraint
      // Its live parent was unpublished while it was being published
      if (constraint === 'published_entries_parent_id_fkey')
        throw new HTTPException(409, { message: unpublishedParent })

      // Two saves can pass a slug check at the same moment, and then an index stops the second
      const message = { entries_slug_unique: slugTaken, published_entries_slug_unique: liveSlugTaken }[constraint!]
      if (!message) throw error
      const fields = { ...report!.fields, [type.slugField!]: { isValid: false, messages: [message] } }
      return { report: { isValid: false, fields } }
    }
  }

  return { checkInputs, checkParent, migrated, saveEntry }
}

// Whether a Preview button can follow an address: http or https only, so one built from an entry's values can never
// run script
const followable = (url: unknown): url is string =>
  typeof url === 'string' && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)

// previews in sorlo.config.ts, as the servers start: each an http or https address, a function giving one, or nothing
export function checkPreviews(previews: Record<string, Preview | null | undefined>, types: Map<string, ContentType>) {
  for (const [name, preview] of Object.entries(previews)) {
    if (preview == null) continue
    if (typeof preview !== 'function' && !followable(preview)) {
      throw new Error(
        `previews.${name} in sorlo.config.ts needs to be an http or https address, or a function giving one.`,
      )
    }
    // Advice rather than a refusal, since the type editor can add the type
    if (!types.has(name))
      console.warn(`previews.${name} in sorlo.config.ts names no content type, so nothing has a Preview button.`)
  }
}

// The admin API for entries. Every route needs a session, which createApp checks
export function entryRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  { keep }: Partial<VersionOptions> = {},
  // The editor's Preview button for each type, from sorlo.config.ts
  previews: Record<string, Preview | null | undefined> = {},
  // The site's hooks, which every write here runs
  hooks?: SiteHooks,
) {
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    throw new Error('versions.keep in sorlo.config.ts needs a whole number from 1.')
  }

  const app = new Hono<AdminEnv>()

  // The last content migration to run, which values saved now have been through
  const lastMigration = async (trx: Kysely<Database>) =>
    (await appliedMigrations(trx, await migrations())).at(-1) ?? null

  const typeNamed = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  // A type whose entries can be made and acted on many at once, which a singleton's one entry can't
  const listNamed = (name: string) => {
    const type = typeNamed(name)
    if (type.structure === 'singleton') throw new HTTPException(409, { message: 'A singleton has one entry, open it.' })
    return type
  }

  // The ids sent to act on many of a type's entries at once: 1 to max of them, each sent once. A UUID's case doesn't
  // count, as Postgres ignores it, so one sent in capitals is the same entry.
  const idsSent = async (c: Context<AdminEnv>, max = 100) => {
    const ids: Array<string> = (await c.req.json().catch(() => ({})))?.ids
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > max || !ids.every((id) => typeof id === 'string')) {
      throw new HTTPException(400, { message: `ids must list 1 to ${max.toLocaleString('en')} entry ids.` })
    }
    if (new Set(ids.map((id) => id.toLowerCase())).size < ids.length) {
      throw new HTTPException(400, { message: 'Each entry can only be sent once.' })
    }
    return ids
  }

  // Each sent id's result in the order sent: the entry as it is now, why it was refused, or a 404 for an id that isn't
  // one of the type's entries. Rows and refusals are by the database's lower-case ids.
  const results = async (
    trx: Kysely<Database>,
    type: ContentType,
    ids: Array<string>,
    refused = new Map<string, HTTPException>(),
    writes = new Map<string, Write>(),
  ) => {
    const uuids = ids.filter(isUuid)
    const rows = uuids.length
      ? await withStatus(trx).selectAll().where('type', '=', type.name).where('id', 'in', uuids).execute()
      : []
    const found = new Map(rows.map((row) => [row.id, row]))
    return ids.map((id) => {
      const error = refused.get(id.toLowerCase())
      if (error instanceof Refusal) return { id, status: 422, report: error.report }
      if (error) return { id, status: error.status, message: error.message }
      const row = found.get(id.toLowerCase())
      const warnings = writes.get(id.toLowerCase())?.reply
      return row ? { id, status: 200, data: toAdminEntry(row), ...warnings } : { id, status: 404, message: notOfType }
    })
  }

  const find = (id: string) => findEntry(db, types, id)

  // The entry as it is now, with the warnings the write's hooks added
  const reply = async (c: Context<AdminEnv>, id: string, status: 200 | 201 = 200, write?: Write) =>
    c.json({ data: toAdminEntry((await find(id)).row), ...write?.reply }, status)

  // A write by the signed-in person, for the site's hooks
  const writeOf = (c: Context<AdminEnv>, source: HookSource = 'admin') =>
    new Write(hooks, { user: c.var.user, source, origin: origin(c) })

  const { migrated, saveEntry } = entrySaver(db, types, migrations, { keep })

  // Create or update an entry from { values, parentId, publish }, where a type without drafts publishes every save
  const save = async (c: Context<AdminEnv>, type: ContentType, id?: string) => {
    const applied = await migrated()
    const body = await c.req.json().catch(() => ({}))
    const publish = type.drafts === false || body?.publish === true
    const parentId: string | null = type.structure === 'hierarchical' ? (body?.parentId ?? null) : null
    const write = writeOf(c)
    const sent = () => ({ values: body?.values, parentId })
    const saved = await saveEntry(type, c.var.user.id, applied, publish, sent, id, { write })
    return saved.report ? c.json(saved.report, 422) : reply(c, saved.id, id ? 200 : 201, write)
  }

  app.get('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const archived = c.req.query('archived') === 'true'
    const from = withStatus(db).where('archived_at', archived ? 'is not' : 'is', null)
    const { data, pagination } = await listEntries<StatusRow>(from, type, query)
    return c.json({ data: data.map(toAdminEntry), pagination })
  })

  // Select all in a list: the ids of every entry its query finds, as the list orders them, for
  // ticking them all. It takes the list's where, order and archived, and refuses past maxTicked.
  app.get('/types/:type/entries/ids', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const archived = c.req.query('archived') === 'true'
    const from = db.selectFrom('entries').where('archived_at', archived ? 'is not' : 'is', null)
    const data = await entryIds(from, type, query, maxTicked)
    if (!data) {
      const most = maxTicked.toLocaleString('en')
      throw new HTTPException(400, {
        message: `More than ${most} entries match. Narrow the search or filter to ${most} or fewer.`,
      })
    }
    return c.json({ data })
  })

  app.post('/types/:type/entries', async (c) => save(c, listNamed(c.req.param('type'))))

  // Bulk editing: save the changed fields of up to 100 of a type's entries, with one publish for
  // them all, replying with each one's result in the order sent. Each saves on its own, as PUT /entries/:id saves,
  // so the rows that pass are saved whatever happens to the others. Each merges into its entry as it's locked for the
  // save, so another save's changes to its other fields are kept, however close together they land.
  app.patch('/types/:type/entries', async (c) => {
    const type = listNamed(c.req.param('type'))
    const body = await c.req.json().catch(() => ({}))
    const entries: Array<{ id: string; values: Record<string, any> }> = body?.entries
    const sound =
      Array.isArray(entries) &&
      entries.length >= 1 &&
      entries.length <= 100 &&
      entries.every((entry) => isObject(entry) && typeof entry.id === 'string' && isObject(entry.values))
    if (!sound) throw new HTTPException(400, { message: 'entries must list 1 to 100 entries, each { id, values }.' })
    if (new Set(entries.map((entry) => entry.id.toLowerCase())).size < entries.length) {
      throw new HTTPException(400, { message: 'Each entry can only be sent once.' })
    }

    const applied = await migrated()
    const publish = type.drafts === false || body.publish === true
    const data = []
    for (const { id, values } of entries) {
      try {
        // Pages stay where they are
        const merged = (saved?: EntryRow) => ({
          values: merge(type.fields, saved!.values, values),
          parentId: saved!.parent_id,
        })
        const write = writeOf(c, 'bulk')
        const saved = await saveEntry(type, c.var.user.id, applied, publish, merged, id, { write })
        data.push(
          saved.report
            ? { id, status: 422, report: saved.report }
            : { id, status: 200, data: toAdminEntry((await find(id)).row), ...write.reply },
        )
      } catch (error) {
        if (!(error instanceof HTTPException)) throw error
        const message = error.status === 404 ? notOfType : error.message
        data.push({ id, status: error.status, message })
      }
    }
    return c.json({ data })
  })

  // Archive up to 100 of a type's entries at once, each as POST /entries/:id/archive archives it, in one transaction, so
  // all are stamped with one time, replying with each one's result in the order sent. One already archived stays as it
  // is.
  app.post('/types/:type/entries/archive', async (c) => {
    const type = listNamed(c.req.param('type'))
    const ids = await idsSent(c)
    const uuids = ids.filter(isUuid)
    const writes = new Map<string, Write>()
    const data = await db.transaction().execute(async (trx) => {
      const found = uuids.length
        ? await trx.selectFrom('entries').select('id').where('type', '=', type.name).where('id', 'in', uuids).execute()
        : []
      // One at a time, each as a savepoint, so a hook that refuses one takes back only what that one's hooks wrote, and
      // leaves the others to archive
      const refused = new Map<string, HTTPException>()
      for (const { id } of found) {
        const write = writeOf(c, 'bulk')
        try {
          await transaction(trx, (each) => archive(each, [id], write))
          writes.set(id, write)
        } catch (error) {
          if (!(error instanceof Refusal)) throw error
          refused.set(id, error)
        }
      }
      return results(trx, type, ids, refused, writes)
    })
    for (const write of writes.values()) await write.flush()
    return c.json({ data })
  })

  // Restore up to 100 of a type's entries at once, each as POST /entries/:id/restore restores it, in one transaction,
  // replying with each one's result in the order sent. Parents go first, so a page sent with its parent comes back
  // after it, and one whose parent stays archived gets a 409. One that isn't archived stays as it is.
  app.post('/types/:type/entries/restore', async (c) => {
    const type = listNamed(c.req.param('type'))
    const ids = await idsSent(c)
    const uuids = ids.filter(isUuid)
    const writes = new Map<string, Write>()
    const data = await db.transaction().execute(async (trx) => {
      // How many ancestors each has, at any depth, since a page's parent may not be among those sent
      const { rows } = await sql<{ id: string; parent_id: string | null }>`
        with recursive up as (
          select id as entry, parent_id, 0 as depth from entries where type = ${type.name} and id = any(${uuids}::uuid[])
          union all
          select up.entry, entries.parent_id, up.depth + 1 from entries join up on entries.id = up.parent_id
        )
        select entries.id, entries.parent_id from entries
        join (select entry, max(depth) as depth from up group by entry) depths on depths.entry = entries.id
        order by depths.depth, entries.id
      `.execute(trx)

      const refused = new Map<string, HTTPException>()
      for (const row of rows) {
        const write = writeOf(c, 'bulk')
        try {
          await transaction(trx, (each) => restore(each, row, write))
          writes.set(row.id, write)
        } catch (error) {
          if (!(error instanceof HTTPException)) throw error
          refused.set(row.id, error)
        }
      }
      return results(trx, type, ids, refused, writes)
    })
    for (const write of writes.values()) await write.flush()
    return c.json({ data })
  })

  // How many of up to maxTicked of a type's entries, counting the pages under them, other entries link to, for bulk
  // Archive to warn of before it takes them off the site. Links from among them, or from pages under them, which go
  // with them, and from archived entries don't count, and nor do entries already archived.
  app.post('/types/:type/entries/used-by', async (c) => {
    const type = listNamed(c.req.param('type'))
    const ids = (await idsSent(c, maxTicked)).filter(isUuid)
    const { rows } = await sql<{ count: number }>`
      with recursive tree as (
        select id as root, id from entries
        where type = ${type.name} and archived_at is null and id = any(${ids}::uuid[])
        union
        select tree.root, entries.id from entries join tree on entries.parent_id = tree.id
        where entries.archived_at is null
      )
      select count(distinct tree.root)::int as count from tree
      join entry_relations link on link.target_id = tree.id
      join entries source on source.id = link.entry_id
      where source.archived_at is null and source.id not in (select id from tree)
    `.execute(db)
    return c.json({ data: { count: rows[0].count } })
  })

  // A singleton's entry, created the first time it's opened
  app.get('/types/:type/singleton', async (c) => {
    const type = typeNamed(c.req.param('type'))
    if (type.structure !== 'singleton') throw new HTTPException(404)

    const row = await db.transaction().execute(async (trx) => {
      // Two admins opening a new singleton at once still make one entry
      await sql`select pg_advisory_xact_lock(hashtext(${type.name}))`.execute(trx)
      const found = await trx.selectFrom('entries').select('id').where('type', '=', type.name).executeTakeFirst()
      if (found) return found

      const values = pickValues(type.fields, {}, cmsInputs)
      const user = c.var.user.id
      return trx
        .insertInto('entries')
        .values({
          id: uuidv7(),
          type: type.name,
          values,
          migration: await lastMigration(trx),
          created_by: user,
          updated_by: user,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    })

    return reply(c, row.id)
  })

  app.get('/entries/:id', (c) => reply(c, c.req.param('id')))

  // The editor's Preview, a link that opens a new tab here: the address previews gives the entry's saved draft, as the
  // delivery API replies it to a preview key, worked out as the tab opens, so one that expires still works, and
  // followed. The address never sits in the admin's page. Previews leave archived entries out, as delivery does.
  app.get('/entries/:id/preview', async (c) => {
    const { row } = await find(c.req.param('id'))
    const preview = previews[row.type]
    const none = (status: 404 | 500, text: string) =>
      c.html(page('No preview', `<p>${text}</p>`), status, {
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
    const missing = "There's no preview of this entry on the site."
    if (preview == null || row.archived_at) return none(404, missing)
    try {
      // Through JSON, so its dates are strings, as the site's preview route sees them
      const entry = JSON.parse(JSON.stringify(toEntry(row)))
      const url = typeof preview === 'function' ? await preview({ entry }) : preview
      // Such as entry.slug && an address, before a draft has its slug
      if (!url) return none(404, missing)
      if (followable(url)) return c.redirect(new URL(url).href, 302)
      // Not the address itself, which can hold a secret
      console.error(`previews.${row.type} in sorlo.config.ts gave an address that isn't http or https.`)
    } catch (error) {
      console.error(`previews.${row.type} in sorlo.config.ts failed:`, error)
    }
    return none(500, "The address of this entry's preview couldn't be worked out. The server's log says why.")
  })

  app.put('/entries/:id', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    if (row.archived_at) throw new HTTPException(409, { message: archived })
    return save(c, type, row.id)
  })

  // Take an entry off the live site, with the live pages under it, keeping its draft
  app.post('/entries/:id/unpublish', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    if (type.drafts === false) {
      throw new HTTPException(409, {
        message: `${type.label} has no drafts, so its entries are live until they're archived.`,
      })
    }
    const write = writeOf(c)
    await db.transaction().execute((trx) => unpublish(trx, [row.id], write))
    await write.flush()
    return reply(c, row.id, 200, write)
  })

  // Move an entry among its siblings, numbering them from 0 in their new order. The live order changes at once.
  app.put('/entries/:id/position', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    const { position } = await c.req.json().catch(() => ({}))
    if (type.structure !== 'hierarchical' || row.archived_at) {
      throw new HTTPException(409, {
        message: "Only a hierarchical type's entries that aren't archived have a position.",
      })
    }
    if (!Number.isInteger(position) || position < 0) {
      throw new HTTPException(400, { message: 'position must be a whole number from 0.' })
    }

    const siblings = await db
      .selectFrom('entries')
      .select('id')
      .where('type', '=', type.name)
      .where('parent_id', row.parent_id === null ? 'is' : '=', row.parent_id)
      .where('archived_at', 'is', null)
      .where('id', '!=', row.id)
      .orderBy('position')
      .orderBy('id')
      .execute()
    const ids = siblings.map((sibling) => sibling.id)
    ids.splice(position, 0, row.id)

    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ id: string }>`
        update entries set position = ordered.position - 1
        from unnest(${ids}::uuid[]) with ordinality as ordered (id, position)
        where entries.id = ordered.id and entries.position is distinct from ordered.position - 1
        returning entries.id
      `.execute(trx)
      await addEntryEvents(trx, 'entry.updated', rows)

      // The live pages that are siblings on the live site too take the same order
      const live = await sql<{ id: string }>`
        update published_entries page set position = entries.position from entries
        where page.id = entries.id and entries.id = any(${ids}::uuid[])
          and page.parent_id is not distinct from entries.parent_id and page.position is distinct from entries.position
        returning page.id
      `.execute(trx)
      await addEntryEvents(trx, 'entry.published', live.rows)
    })
    return reply(c, row.id)
  })

  // Archive an entry with its descendants that aren't archived, stamped with the same time so restoring brings back
  // just those. It takes them off the live site, with the live pages under them.
  app.post('/entries/:id/archive', async (c) => {
    const { row } = await find(c.req.param('id'))
    const write = writeOf(c)
    await db.transaction().execute((trx) => archive(trx, [row.id], write))
    await write.flush()
    return reply(c, row.id, 200, write)
  })

  // Restoring gives back drafts, to publish again
  app.post('/entries/:id/restore', async (c) => {
    const { row } = await find(c.req.param('id'))
    const write = writeOf(c)
    await db.transaction().execute((trx) => restore(trx, row, write))
    await write.flush()
    return reply(c, row.id, 200, write)
  })

  // The entries that link to this one, archived ones included
  app.get('/entries/:id/used-by', async (c) => {
    const { row } = await find(c.req.param('id'))
    return c.json({ data: (await usedBy(db, row.id)).map(toAdminEntry) })
  })

  // Delete an archived entry for good, with its descendants, which are archived too, and its versions. Links from
  // entries outside it would be left broken, so they must go first.
  // shortcut: a save that links the entry while it's being deleted can slip past the check, lock it when that matters
  // shortcut: only drafts' links count, so a live copy can keep one its draft has dropped, which with() then leaves out;
  // record live copies' links in entry_relations too when that matters
  app.delete('/entries/:id', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    if (!row.archived_at) throw new HTTPException(409, { message: 'Archive the entry before deleting it.' })

    const { users } = (
      await sql<{ users: number }>`${tree([row.id])}
        select count(distinct entry_id)::int as users from entry_relations
        where target_id in (select id from tree) and entry_id not in (select id from tree)
      `.execute(db)
    ).rows[0]
    if (users) {
      const linked = `${users === 1 ? 'Another entry links' : `${users} other entries link`} to this one`
      const under = type.structure === 'hierarchical' ? ' or to pages under it' : ''
      throw new HTTPException(409, { message: `${linked}${under}. Remove the links before deleting it.` })
    }

    await db.transaction().execute(async (trx) => {
      // The whole tree, rather than leaving its descendants to the cascade, so each one gets its event
      const { rows } = await sql<EntryRow>`${tree([row.id])}
        delete from entries using tree where entries.id = tree.id returning entries.*
      `.execute(trx)
      // As they were left: archived, so not live, and with their versions gone
      const gone = rows.map((row) => ({ ...row, published_at: null, published_version: null, version: null }))
      await addEvents(
        trx,
        'entry.deleted',
        gone.map((row) => ({ entry: toAdminEntry(row) })),
      )
    })
    return c.body(null, 204)
  })

  // A version's number in the URL, short enough to be a Postgres integer, or a 404
  const numberOf = (param: string) => {
    if (!/^\d{1,9}$/.test(param)) throw new HTTPException(404)
    return Number(param)
  }

  // One of an entry's versions, as the list gives it, or a 404
  const versionOf = async (id: string, number: number) => {
    const [version] = await listVersions(db, id, number)
    if (!version) throw new HTTPException(404)
    return version
  }

  // To restore a version, save its values again under its parent, which GET /entries/:id/versions/:number replies, with
  // the values brought up to date
  app.get('/entries/:id/versions', async (c) => {
    const { row } = await find(c.req.param('id'))
    return c.json({ data: await listVersions(db, row.id) })
  })

  // Name a version, or clear its name with an empty one. An archived entry's versions stay as they are.
  app.put('/entries/:id/versions/:number', async (c) => {
    const { row } = await find(c.req.param('id'))
    const { number } = await versionOf(row.id, numberOf(c.req.param('number')))
    if (row.archived_at) throw new HTTPException(409, { message: archived })

    const values = pickValues(versionSchema, (await c.req.json().catch(() => null)) ?? {}, inputs)
    const report = await validateServerValues(versionSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    await db
      .updateTable('entry_versions')
      .set({ name: values.name?.trim() || null })
      .where('entry_id', '=', row.id)
      .where('number', '=', number)
      .execute()
    return c.json({ data: await versionOf(row.id, number) })
  })

  // Delete a version for good, except the current one, the live one and an archived entry's. Numbers never shift, and
  // since the current version stays, new ones go on numbering from it. Only the newest version is ever published, so a
  // version that passes these checks can't become current or live while it's deleted.
  app.delete('/entries/:id/versions/:number', async (c) => {
    const { row } = await find(c.req.param('id'))
    const { number } = await versionOf(row.id, numberOf(c.req.param('number')))
    if (row.archived_at) throw new HTTPException(409, { message: archived })
    if (number === row.version) {
      throw new HTTPException(409, { message: `Version ${number} is the current version, so it can't be deleted.` })
    }
    if (number === row.published_version) {
      throw new HTTPException(409, {
        message: `Version ${number} is live, so it can't be deleted. Publish another version first.`,
      })
    }

    await db.deleteFrom('entry_versions').where('entry_id', '=', row.id).where('number', '=', number).execute()
    return c.body(null, 204)
  })

  app.get('/entries/:id/versions/:number', async (c) => {
    const { row } = await find(c.req.param('id'))
    return c.json({ data: await readVersion(db, migrations, row, numberOf(c.req.param('number'))) })
  })

  return app
}
