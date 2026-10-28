import { inputs, isEmptyValue, pickValues, validateServerValues, validationError } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { EntryRow, listEntries, parseQuery, toEntry } from './query'
import type { ContentType } from './types'
import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { InputSchema } from 'iight'
import { Kysely, sql } from 'kysely'

export type AdminEnv = { Variables: { user: { id: string; email: string; name: string } } }

// An entry as the admin API returns it
const toAdminEntry = (row: EntryRow) => ({
  ...toEntry(row),
  archivedAt: row.archived_at,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
})

const slugTaken = 'Another entry here already uses this slug.'

// The entry and everything under it, as a "tree" for the statement that follows
const tree = (id: string) => sql`
  with recursive tree as (
    select id from entries where id = ${id}
    union all
    select entries.id from entries join tree on entries.parent_id = tree.id
  )`

// The admin API for entries. Every route needs a session, which createApp checks
export function entryRoutes(db: Kysely<Database>, types: Map<string, ContentType>) {
  const app = new Hono<AdminEnv>()

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

  // Core's inputs, with the type's slug field also checking that no sibling has the slug, archived ones included.
  // Built per request, since the check needs the entry and its parent.
  const slugInputs = (type: ContentType, id: string | null, parentId: string | null) => {
    const slugField = type.fields.find((field) => field.name === type.slugField)
    if (!slugField) return inputs

    const identifier = inputs.identifier
    const validateServerValue = async (value: unknown, schema: InputSchema) => {
      const validation = identifier.validateValue(value, schema)
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
    const body = await c.req.json().catch(() => ({}))
    const parentId: string | null = type.structure === 'hierarchical' ? (body?.parentId ?? null) : null
    const parent = parentId === null ? undefined : await checkParent(type, parentId, existing?.id)

    const values = pickValues(type.fields, body?.values ?? {}, inputs)
    const report = await validateServerValues(type.fields, values, slugInputs(type, existing?.id ?? null, parentId))
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

        const fields = { values, parent_id: parentId, position, slug, uri, updated_by: user }
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
            created_by: user,
          })
          .execute()

        // A new slug or parent changes the uri of every page under the entry
        if (existing && existing.uri !== uri) {
          await sql`
            with recursive tree as (
              select id, uri from entries where id = ${row.id}
              union all
              select entries.id, case when tree.uri is null or entries.slug is null then null
                else tree.uri || '/' || entries.slug end
              from entries join tree on entries.parent_id = tree.id
            )
            update entries set uri = tree.uri from tree where entries.id = tree.id and entries.id <> ${row.id}
          `.execute(trx)
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

  app.get('/types', (c) => c.json({ data: [...types.values()] }))

  app.get('/types/:type/entries', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const { data, pagination } = await listEntries(db, type, query, c.req.query('archived') === 'true')
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
      const values = pickValues(type.fields, {}, inputs)
      const user = c.var.user.id
      return (
        found ??
        trx
          .insertInto('entries')
          .values({ id: uuidv7(), type: type.name, values, created_by: user, updated_by: user })
          .returningAll()
          .executeTakeFirstOrThrow()
      )
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

    await sql`
      update entries set position = ordered.position - 1
      from unnest(${ids}::uuid[]) with ordinality as ordered (id, position)
      where entries.id = ordered.id
    `.execute(db)
    return reply(c, row.id)
  })

  // Archive an entry with its live descendants, stamped with the same time so restoring brings back just those
  app.post('/entries/:id/archive', async (c) => {
    const { row } = await find(c.req.param('id'))
    await sql`${tree(row.id)}
      update entries set archived_at = now() from tree where entries.id = tree.id and entries.archived_at is null
    `.execute(db)
    return reply(c, row.id)
  })

  app.post('/entries/:id/restore', async (c) => {
    const { row } = await find(c.req.param('id'))
    const parent = row.parent_id
      ? await db.selectFrom('entries').select('archived_at').where('id', '=', row.parent_id).executeTakeFirst()
      : undefined
    if (parent?.archived_at)
      throw new HTTPException(409, { message: 'Its parent is archived. Restore the parent first.' })

    await sql`${tree(row.id)}
      update entries set archived_at = null from tree
      where entries.id = tree.id and entries.archived_at = (select archived_at from entries where id = ${row.id})
    `.execute(db)
    return reply(c, row.id)
  })

  // Delete an archived entry for good, with its descendants, which are archived too, and its versions
  app.delete('/entries/:id', async (c) => {
    const { row } = await find(c.req.param('id'))
    if (!row.archived_at) throw new HTTPException(409, { message: 'Archive the entry before deleting it.' })
    await db.deleteFrom('entries').where('id', '=', row.id).execute()
    return c.body(null, 204)
  })

  // Every saved version, newest first. To restore one, save its values again.
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

    return c.json({
      data: {
        number: version.number,
        values: version.values,
        createdBy: version.created_by,
        createdAt: version.created_at,
      },
    })
  })

  return app
}
