import { ContentMigrationFile, appliedMigrations, catchUp } from './content'
import { isEmptyValue, pickValues, validateServerValues, validationError } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { addEvents } from './events'
import { EntryRow, listEntries, parseQuery, toAdminEntry, usedBy } from './query'
import { cmsInputs, saveRelations, serverInputs } from './relations'
import type { ContentType } from './types'
import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { InputSchema } from 'iight'
import { Kysely, sql } from 'kysely'

export type AdminEnv = { Variables: { user: { id: string; email: string; name: string } } }

const slugTaken = 'Another entry here already uses this slug.'

// The entry and everything under it, as a "tree" for the statement that follows
const tree = (id: string) => sql`
  with recursive tree as (
    select id from entries where id = ${id}
    union all
    select entries.id from entries join tree on entries.parent_id = tree.id
  )`

// Each changed entry's event data
const entryEvents = (rows: Array<EntryRow>) => rows.map((row) => ({ entry: toAdminEntry(row) }))

// The admin API for entries. Every route needs a session, which createApp checks
export function entryRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
) {
  const app = new Hono<AdminEnv>()

  // The last content migration to run, which values saved now have been through (PLAN.md section 6)
  const lastMigration = async (trx: Kysely<Database>) =>
    (await appliedMigrations(trx, await migrations())).at(-1) ?? null

  const typeNamed = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  // An entry, archived or not, with its content type
  const find = async (id: string) => {
    const row = isUuid(id)
      ? await db.selectFrom('entries').selectAll().where('id', '=', id).executeTakeFirst()
      : undefined
    const type = row && types.get(row.type)
    if (!row || !type) throw new HTTPException(404)
    return { row, type }
  }

  const reply = async (c: Context<AdminEnv>, id: string) => c.json({ data: toAdminEntry((await find(id)).row) })

  // The inputs' server checks, with the type's slug field also checking that no sibling has the slug, archived ones
  // included. Built per request, since the check needs the entry and its parent.
  const checkInputs = (type: ContentType, id: string | null, parentId: string | null) => {
    const inputs = serverInputs(db, types)
    const slugField = type.fields.find((field) => field.name === type.slugField)
    if (!slugField) return inputs

    const identifier = inputs.identifier
    const validateServerValue = async (value: unknown, schema: InputSchema) => {
      const validation = identifier.validateValue!(value, schema)
      if (schema.id !== slugField.id || !validation.isValid || isEmptyValue(value)) return validation

      const sibling = await db
        .selectFrom('entries')
        .select('archived_at')
        .where('type', '=', type.name)
        .where('parent_id', parentId === null ? 'is' : '=', parentId)
        .where('slug', '=', String(value))
        .$if(id !== null, (qb) => qb.where('id', '!=', id!))
        .executeTakeFirst()

      if (!sibling) return validation
      return validationError(value, sibling.archived_at ? 'An archived entry here already uses this slug.' : slugTaken)
    }

    return { ...inputs, identifier: { ...identifier, validateServerValue } }
  }

  // A parent must be a live entry of the same type, and neither the entry nor one of its descendants
  const checkParent = async (type: ContentType, parentId: unknown, id?: string) => {
    const parent = isUuid(parentId)
      ? await db
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
        `.execute(db)
      ).rows[0].loops

    if (!parent || loops) {
      throw new HTTPException(400, { message: 'The parent must be another live entry of this type, outside this one.' })
    }
    return parent
  }

  // Create or update an entry from { values, parentId }, saving a version of its values
  const save = async (c: Context<AdminEnv>, type: ContentType, existing?: EntryRow) => {
    // The types already have a pending migration's change, so saving now would mix the old fields' values with the new
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

    const body = await c.req.json().catch(() => ({}))
    const parentId: string | null = type.structure === 'hierarchical' ? (body?.parentId ?? null) : null
    const parent = parentId === null ? undefined : await checkParent(type, parentId, existing?.id)

    const values = pickValues(type.fields, body?.values ?? {}, cmsInputs)
    const report = await validateServerValues(type.fields, values, checkInputs(type, existing?.id ?? null, parentId))
    if (!report.isValid) return c.json(report, 422)

    const slug: string | null = (type.slugField && values[type.slugField]) || null
    const hierarchical = type.structure === 'hierarchical'
    const uri = !hierarchical || !slug ? null : parent ? parent.uri && `${parent.uri}/${slug}` : slug
    const user = c.var.user.id

    try {
      const row = await db.transaction().execute(async (trx) => {
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

        // The update above locks the entry, so concurrent saves number their versions in turn
        await trx
          .insertInto('entry_versions')
          .values({
            entry_id: row.id,
            number: sql`(select coalesce(max(number), 0) + 1 from entry_versions where entry_id = ${row.id})`,
            values,
            migration,
            created_by: user,
          })
          .execute()
        await saveRelations(trx, type, row.id, values)
        await addEvents(trx, existing ? 'entry.updated' : 'entry.created', entryEvents([row]))

        // A new slug or parent changes the uri of every page under the entry
        if (existing && existing.uri !== uri) {
          const { rows } = await sql<EntryRow>`
            with recursive tree as (
              select id, uri from entries where id = ${row.id}
              union all
              select entries.id, case when tree.uri is null or entries.slug is null then null
                else tree.uri || '/' || entries.slug end
              from entries join tree on entries.parent_id = tree.id
            )
            update entries set uri = tree.uri from tree
            where entries.id = tree.id and entries.id <> ${row.id} and entries.uri is distinct from tree.uri
            returning entries.*
          `.execute(trx)
          await addEvents(trx, 'entry.updated', entryEvents(rows))
        }

        return row
      })

      return c.json({ data: toAdminEntry(row) }, existing ? 200 : 201)
    } catch (error) {
      // Two saves can pass the slug check at the same moment, and then the index stops the second
      if ((error as { constraint?: string }).constraint !== 'entries_slug_unique') throw error
      const fields = { ...report.fields, [type.slugField!]: { isValid: false, messages: [slugTaken] } }
      return c.json({ isValid: false, fields }, 422)
    }
  }

  app.get('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const { data, pagination } = await listEntries(db, type, query, { archived: c.req.query('archived') === 'true' })
    return c.json({ data: data.map(toAdminEntry), pagination })
  })

  app.post('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    if (type.structure === 'singleton') throw new HTTPException(409, { message: 'A singleton has one entry, open it.' })
    return save(c, type)
  })

  // A singleton's entry, created the first time it's opened
  app.get('/types/:type/singleton', async (c) => {
    const type = typeNamed(c.req.param('type'))
    if (type.structure !== 'singleton') throw new HTTPException(404)

    const row = await db.transaction().execute(async (trx) => {
      // Two admins opening a new singleton at once still make one entry
      await sql`select pg_advisory_xact_lock(hashtext(${type.name}))`.execute(trx)
      const found = await trx.selectFrom('entries').selectAll().where('type', '=', type.name).executeTakeFirst()
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
        .returningAll()
        .executeTakeFirstOrThrow()
    })

    return c.json({ data: toAdminEntry(row) })
  })

  app.get('/entries/:id', (c) => reply(c, c.req.param('id')))

  app.put('/entries/:id', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    if (row.archived_at) throw new HTTPException(409, { message: 'This entry is archived. Restore it to edit it.' })
    return save(c, type, row)
  })

  // Move an entry among its siblings, numbering them from 0 in their new order
  app.put('/entries/:id/position', async (c) => {
    const { row, type } = await find(c.req.param('id'))
    const { position } = await c.req.json().catch(() => ({}))
    if (type.structure !== 'hierarchical' || row.archived_at) {
      throw new HTTPException(409, { message: 'Only live entries of a hierarchical type have a position.' })
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
      const { rows } = await sql<EntryRow>`
        update entries set position = ordered.position - 1
        from unnest(${ids}::uuid[]) with ordinality as ordered (id, position)
        where entries.id = ordered.id and entries.position is distinct from ordered.position - 1
        returning entries.*
      `.execute(trx)
      await addEvents(trx, 'entry.updated', entryEvents(rows))
    })
    return reply(c, row.id)
  })

  // Archive an entry with its live descendants, stamped with the same time so restoring brings back just those
  app.post('/entries/:id/archive', async (c) => {
    const { row } = await find(c.req.param('id'))
    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<EntryRow>`${tree(row.id)}
        update entries set archived_at = now() from tree where entries.id = tree.id and entries.archived_at is null
        returning entries.*
      `.execute(trx)
      await addEvents(trx, 'entry.archived', entryEvents(rows))
    })
    return reply(c, row.id)
  })

  app.post('/entries/:id/restore', async (c) => {
    const { row } = await find(c.req.param('id'))
    const parent = row.parent_id
      ? await db.selectFrom('entries').select('archived_at').where('id', '=', row.parent_id).executeTakeFirst()
      : undefined
    if (parent?.archived_at)
      throw new HTTPException(409, { message: 'Its parent is archived. Restore the parent first.' })

    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<EntryRow>`${tree(row.id)}
        update entries set archived_at = null from tree
        where entries.id = tree.id and entries.archived_at = (select archived_at from entries where id = ${row.id})
        returning entries.*
      `.execute(trx)
      await addEvents(trx, 'entry.restored', entryEvents(rows))
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
      await addEvents(trx, 'entry.deleted', entryEvents(rows))
    })
    return c.body(null, 204)
  })

  // Every saved version, newest first. To restore one, save its values again, which the next route brings up to date.
  app.get('/entries/:id/versions', async (c) => {
    const { row } = await find(c.req.param('id'))
    const versions = await db
      .selectFrom('entry_versions')
      .select(['number', 'created_by', 'created_at'])
      .where('entry_id', '=', row.id)
      .orderBy('number', 'desc')
      .execute()
    return c.json({
      data: versions.map((version) => ({
        number: version.number,
        createdBy: version.created_by,
        createdAt: version.created_at,
      })),
    })
  })

  app.get('/entries/:id/versions/:number', async (c) => {
    const { row } = await find(c.req.param('id'))
    const number = Number(c.req.param('number'))
    const version = Number.isInteger(number)
      ? await db
          .selectFrom('entry_versions')
          .selectAll()
          .where('entry_id', '=', row.id)
          .where('number', '=', number)
          .executeTakeFirst()
      : undefined
    if (!version) throw new HTTPException(404)

    // Run the ups of the content migrations that ran after the version was saved, so its values fit the type's fields
    const files = await migrations()
    const applied = await appliedMigrations(db, files)
    const since = version.migration === null ? 0 : applied.indexOf(version.migration) + 1
    if (since === 0 && version.migration !== null) {
      const message = `Version ${number} was saved after the content migration ${version.migration}, which has been rolled back. Migrate again to restore it.`
      throw new HTTPException(409, { message })
    }
    const values = await catchUp(
      row.type,
      version.values,
      applied.slice(since).map((name) => files[name].up),
    )

    return c.json({
      data: {
        number: version.number,
        values,
        createdBy: version.created_by,
        createdAt: version.created_at,
      },
    })
  })

  return app
}
