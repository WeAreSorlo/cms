import type { VersionOptions } from '.'
import { ContentMigrationFile, appliedMigrations, catchUp } from './content'
import { inputs, isEmptyValue, pickValues, validateServerValues, validationError } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { addEvents } from './events'
import { EntryRow, StatusRow, listEntries, parseQuery, toAdminEntry, usedBy, withStatus } from './query'
import { cmsInputs, saveRelations, serverInputs } from './relations'
import { EventName, versionSchema } from './schemas'
import type { ContentType } from './types'
import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { FieldSchema, InputSchema, ValidationReport } from 'iight'
import { Kysely, sql } from 'kysely'
import { isDeepStrictEqual } from 'node:util'

export type AdminEnv = { Variables: { user: { id: string; email: string; name: string } } }

const slugTaken = 'Another entry here already uses this slug.'
const liveSlugTaken = 'A published entry here already uses this slug.'
const unpublishedParent = "Its parent isn't published. Publish the parent first."
const archived = 'This entry is archived. Restore it to edit it.'

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Changed fields merged into an entry's values. A group's fields merge one by one, at any depth, and any other field's
// value replaces what's stored, so a list or a link is sent whole. Keys that aren't the type's fields are left out.
function merge(fields: Array<FieldSchema>, values: Record<string, any>, changed: Record<string, any>) {
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

// The entry and everything under it, as a "tree" for the statement that follows
const tree = (id: string) => sql`
  with recursive tree as (
    select id from entries where id = ${id}
    union all
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

// Takes entries off the live site, with the live pages under them
async function unpublish(trx: Kysely<Database>, ids: Array<string>) {
  if (!ids.length) return
  const { rows } = await sql<{ id: string }>`
    with recursive live as (
      select id from published_entries where id = any(${ids}::uuid[])
      union
      select page.id from published_entries page join live on page.parent_id = live.id
    )
    delete from published_entries using live where published_entries.id = live.id returning published_entries.id
  `.execute(trx)
  await addEntryEvents(trx, 'entry.unpublished', rows)
}

// Makes what was just saved the entry's live copy, and has the live pages under it follow its live uri, which comes
// from its live parents' slugs. A page goes live only under a live parent that isn't under it on the live site.
async function goLive(trx: Kysely<Database>, type: ContentType, row: EntryRow, version: number, user: string) {
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
  // So each version records the last time it went live
  await trx
    .updateTable('entry_versions')
    .set({ published_at: sql`now()`, published_by: user })
    .where('entry_id', '=', row.id)
    .where('number', '=', version)
    .execute()

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

// An entry's versions, newest first, or the one with the given number: its name, who saved it and when, and when it
// last went live and who published it then. Only saves and publishes record a user, so a version with none was saved
// or published by a user deleted since.
export async function listVersions(db: Kysely<Database>, id: string, number?: number) {
  const rows = await db
    .selectFrom('entry_versions')
    .leftJoin('users as saver', 'saver.id', 'entry_versions.created_by')
    .leftJoin('users as publisher', 'publisher.id', 'entry_versions.published_by')
    .select([
      'number',
      'entry_versions.name',
      'entry_versions.created_at',
      'entry_versions.published_at',
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

// The admin API for entries. Every route needs a session, which createApp checks
export function entryRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  { keep }: Partial<VersionOptions> = {},
) {
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    throw new Error('versions.keep in iight.config.ts needs a whole number from 1.')
  }

  const app = new Hono<AdminEnv>()

  // The last content migration to run, which values saved now have been through (PLAN.md section 6)
  const lastMigration = async (trx: Kysely<Database>) =>
    (await appliedMigrations(trx, await migrations())).at(-1) ?? null

  const typeNamed = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  const find = (id: string) => findEntry(db, types, id)

  const reply = async (c: Context<AdminEnv>, id: string, status: 200 | 201 = 200) =>
    c.json({ data: toAdminEntry((await find(id)).row) }, status)

  // The inputs' server checks, with the type's slug field also checking that no sibling has the slug, archived ones
  // included, and for a publish, no live sibling. Built per save, since the check needs the entry and its parent, and
  // querying through the save's transaction.
  const checkInputs = (
    trx: Kysely<Database>,
    type: ContentType,
    id: string | null,
    parentId: string | null,
    publish: boolean,
  ) => {
    const inputs = serverInputs(trx, types)
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
        message: `Run iight migrate first. The content migration ${pending} hasn't run yet.`,
      })
    }
    return applied
  }

  // Check values and save them as a new entry, or as the new version of the entry with the given ID, in one
  // transaction. An entry is read and locked first, and what's saved comes from that read, so no other save of the
  // entry can land between the two: what's sent replaces its values, or for bulk editing, merges into them. With
  // publish, it runs the checks a publish needs too and makes what it saves the live copy, or does neither. A failed
  // check comes back as core's report, and whatever else stops the save throws. The checks query through the
  // transaction, so a save never waits for a second connection while it holds one.
  const saveEntry = async (
    type: ContentType,
    user: string,
    applied: Array<string>,
    publish: boolean,
    sent: (saved?: EntryRow) => { values: unknown; parentId: string | null },
    id?: string,
  ): Promise<{ id: string; report?: undefined } | { id?: undefined; report: ValidationReport }> => {
    let report: ValidationReport | undefined
    try {
      return await db.transaction().execute(async (trx) => {
        const existing =
          id !== undefined && isUuid(id)
            ? await trx.selectFrom('entries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
            : undefined
        if (id !== undefined && existing?.type !== type.name) throw new HTTPException(404)
        if (existing?.archived_at) throw new HTTPException(409, { message: archived })

        const { values: posted, parentId } = sent(existing)
        const parent = parentId === null ? undefined : await checkParent(trx, type, parentId, existing?.id)

        // A draft can be unfinished, with required fields left empty, but a publish runs every check
        const values = pickValues(type.fields, (posted as Record<string, any>) ?? {}, cmsInputs)
        const inputs = checkInputs(trx, type, existing?.id ?? null, parentId, publish)
        report = await validateServerValues(type.fields, values, inputs, { allowIncomplete: !publish })
        if (!report.isValid) return { report }

        // A save that changes nothing does nothing once the entry has a version: no version, relations or events, and
        // its updated_at stays. Values compare as stored, so their keys' order doesn't count. A publish still makes the
        // newest version live while the live copy is older or missing.
        const status =
          existing &&
          (await withStatus(trx)
            .select(['version', 'published_version'])
            .where('id', '=', existing.id)
            .executeTakeFirstOrThrow())
        if (
          existing &&
          status?.version &&
          existing.parent_id === parentId &&
          isDeepStrictEqual(JSON.parse(JSON.stringify(values)), existing.values)
        ) {
          if (publish && (status.published_version ?? 0) < status.version) {
            await goLive(trx, type, existing, status.version, user)
          }
          return { id: existing.id }
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
              .values({ ...fields, id: uuidv7(), type: type.name, created_by: user })
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
          })
          .returning('number')
          .executeTakeFirstOrThrow()
        await saveRelations(trx, type, row.id, values)
        await addEntryEvents(trx, existing ? 'entry.updated' : 'entry.created', [row])

        // A new slug or parent changes the uri of every page under the entry
        if (existing && existing.uri !== uri) {
          await addEntryEvents(trx, 'entry.updated', await followUri(trx, 'entries', row.id))
        }

        if (publish) await goLive(trx, type, row, number, user)

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
        return { id: row.id }
      })
    } catch (error) {
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

  // Create or update an entry from { values, parentId, publish }, where a type without drafts publishes every save
  const save = async (c: Context<AdminEnv>, type: ContentType, id?: string) => {
    const applied = await migrated()
    const body = await c.req.json().catch(() => ({}))
    const publish = type.drafts === false || body?.publish === true
    const parentId: string | null = type.structure === 'hierarchical' ? (body?.parentId ?? null) : null
    const saved = await saveEntry(type, c.var.user.id, applied, publish, () => ({ values: body?.values, parentId }), id)
    return saved.report ? c.json(saved.report, 422) : reply(c, saved.id, id ? 200 : 201)
  }

  app.get('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const archived = c.req.query('archived') === 'true'
    const from = withStatus(db).where('archived_at', archived ? 'is not' : 'is', null)
    const { data, pagination } = await listEntries<StatusRow>(from, type, query)
    return c.json({ data: data.map(toAdminEntry), pagination })
  })

  app.post('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    if (type.structure === 'singleton') throw new HTTPException(409, { message: 'A singleton has one entry, open it.' })
    return save(c, type)
  })

  // Bulk editing (PLAN.md section 18): save the changed fields of up to 100 of a type's entries, with one publish for
  // them all, replying with each one's result in the order sent. Each saves on its own, as PUT /entries/:id saves,
  // so the rows that pass are saved whatever happens to the others. Each merges into its entry as it's locked for the
  // save, so another save's changes to its other fields are kept, however close together they land.
  app.patch('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    if (type.structure === 'singleton') throw new HTTPException(409, { message: 'A singleton has one entry, open it.' })

    const body = await c.req.json().catch(() => ({}))
    const entries: Array<{ id: string; values: Record<string, any> }> = body?.entries
    const sound =
      Array.isArray(entries) &&
      entries.length >= 1 &&
      entries.length <= 100 &&
      entries.every((entry) => isObject(entry) && typeof entry.id === 'string' && isObject(entry.values))
    if (!sound) throw new HTTPException(400, { message: 'entries must list 1 to 100 entries, each { id, values }.' })
    if (new Set(entries.map((entry) => entry.id)).size < entries.length) {
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
        const saved = await saveEntry(type, c.var.user.id, applied, publish, merged, id)
        data.push(
          saved.report
            ? { id, status: 422, report: saved.report }
            : { id, status: 200, data: toAdminEntry((await find(id)).row) },
        )
      } catch (error) {
        if (!(error instanceof HTTPException)) throw error
        const message = error.status === 404 ? "There's no entry of this type with this id." : error.message
        data.push({ id, status: error.status, message })
      }
    }
    return c.json({ data })
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
    await db.transaction().execute((trx) => unpublish(trx, [row.id]))
    return reply(c, row.id)
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
    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ id: string }>`${tree(row.id)}
        update entries set archived_at = now() from tree where entries.id = tree.id and entries.archived_at is null
        returning entries.id
      `.execute(trx)
      await unpublish(
        trx,
        rows.map((row) => row.id),
      )
      await addEntryEvents(trx, 'entry.archived', rows)
    })
    return reply(c, row.id)
  })

  // Restoring gives back drafts, to publish again
  app.post('/entries/:id/restore', async (c) => {
    const { row } = await find(c.req.param('id'))
    const parent = row.parent_id
      ? await db.selectFrom('entries').select('archived_at').where('id', '=', row.parent_id).executeTakeFirst()
      : undefined
    if (parent?.archived_at)
      throw new HTTPException(409, { message: 'Its parent is archived. Restore the parent first.' })

    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ id: string }>`${tree(row.id)}
        update entries set archived_at = null from tree
        where entries.id = tree.id and entries.archived_at = (select archived_at from entries where id = ${row.id})
        returning entries.id
      `.execute(trx)
      await addEntryEvents(trx, 'entry.restored', rows)
    })
    return reply(c, row.id)
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
      await sql<{ users: number }>`${tree(row.id)}
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
      const { rows } = await sql<EntryRow>`${tree(row.id)}
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
