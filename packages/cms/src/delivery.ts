import type { DeliveryOptions } from '.'
import { inputs, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import type { AdminEnv } from './entries'
import { findMedia, origin, toMedia } from './media'
import { hashToken } from './passwords'
import { Delivered, deliveredEntries, listEntries, listMedia, parseMediaQuery, parseQuery, toEntry } from './query'
import { parseWith, resolveLinks } from './relations'
import { apiKeySchema, apiKeyScopes } from './schemas'
import type { ContentType } from './types'
import { maker } from './users'
import { Context, Hono, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { Kysely, sql } from 'kysely'
import { randomBytes } from 'node:crypto'

// A new key for the delivery API, which reads what's live, and more with its scopes, such as drafts with preview. Only
// its hash is stored, so this is the one time it can be shown. Keys from the CLI have no user.
async function makeKey(db: Kysely<Database>, name: string, scopes: Array<string>, createdBy: string | null) {
  const token = `sorlo_${randomBytes(32).toString('base64url')}`
  const id = uuidv7()
  await db
    .insertInto('api_keys')
    .values({ id, name, token_hash: hashToken(token), scopes, created_by: createdBy })
    .execute()
  return { id, token }
}

export const createApiKey = async (db: Kysely<Database>, name: string, scopes: Array<string> = []) =>
  (await makeKey(db, name, scopes, null)).token

// When this process last wrote each key's and personal token's last_used_at, so reads don't each write it
const writtenAt = new Map<string, number>()

// What a request sends as Authorization: Bearer <token>
export const bearerOf = (c: Context) => c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]

// Marks a key or a personal token as used, once a minute. Other processes mark it too, so the database only takes a
// time a minute after the last.
export async function markUsed(db: Kysely<Database>, table: 'api_keys' | 'personal_tokens', id: string) {
  if (Date.now() - (writtenAt.get(id) ?? 0) < 60_000) return
  writtenAt.set(id, Date.now())
  await db
    .updateTable(table)
    .set({ last_used_at: sql`now()` })
    .where('id', '=', id)
    .where((eb) =>
      eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<=', sql<Date>`now() - interval '1 minute'`)]),
    )
    .execute()
}

// The key a request sends for the delivery API, marked as used
export async function keyOf(db: Kysely<Database>, c: Context) {
  const key = bearerOf(c)
  const found = key
    ? await db
        .selectFrom('api_keys')
        .select(['id', 'scopes'])
        .where('token_hash', '=', hashToken(key))
        .executeTakeFirst()
    : undefined
  if (found) await markUsed(db, 'api_keys', found.id)
  return found
}

// Lets a request through when it sends a key for the delivery API with a scope, replying 403 with the message without
export const apiKey =
  (db: Kysely<Database>, scope: string, message: string): MiddlewareHandler =>
  async (c, next) => {
    const found = await keyOf(db, c)
    if (!found) return c.json({ message: 'Unauthenticated.' }, 401)
    if (!found.scopes.includes(scope)) return c.json({ message }, 403)
    await next()
  }

// The admin's API keys page, where anyone signed in manages keys. A key's token is in the reply that makes it, and no
// other, since only its hash is stored. Revoking a key deletes it, so it's refused from then on.
export function keyRoutes(db: Kysely<Database>) {
  const app = new Hono<AdminEnv>()

  // Every key, or the one with an ID, as the routes reply them, with the user who made each, or null for the CLI
  const keys = async (id?: string) => {
    const rows = await db
      .selectFrom('api_keys')
      .leftJoin('users', 'users.id', 'api_keys.created_by')
      .select([
        'api_keys.id',
        'api_keys.name',
        'scopes',
        'api_keys.created_at',
        'last_used_at',
        'users.id as user_id',
        'users.name as user_name',
      ])
      .$if(id !== undefined, (qb) => qb.where('api_keys.id', '=', id!))
      .orderBy('api_keys.name')
      .orderBy('api_keys.id')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      createdAt: row.created_at,
      createdBy: row.user_id ? { id: row.user_id, name: row.user_name } : null,
      lastUsedAt: row.last_used_at,
    }))
  }

  const find = async (id: string) => {
    const [key] = isUuid(id) ? await keys(id) : []
    if (!key) throw new HTTPException(404)
    return key
  }

  // A key's name and scopes from the request, the scopes in the checkbox's order, or core's report
  const read = async (c: Context) => {
    const values = pickValues(apiKeySchema, (await c.req.json().catch(() => null)) ?? {}, inputs)
    const report = await validateServerValues(apiKeySchema, values, inputs)
    if (!report.isValid) return { report }
    const scopes = apiKeyScopes.map(({ value }) => value).filter((scope) => values.scopes?.includes(scope))
    return { report, key: { name: values.name as string, scopes } }
  }

  // shortcut: every key, unpaged, page them when sites have hundreds
  app.get('/keys', async (c) => c.json({ data: await keys() }))

  app.post('/keys', async (c) => {
    const { report, key } = await read(c)
    if (!key) return c.json(report, 422)
    // Keys outlive their maker's removal, but someone being removed can't make another meanwhile
    const made = await db
      .transaction()
      .execute(async (trx) => (await maker(trx, c.var.user.id)) && makeKey(trx, key.name, key.scopes, c.var.user.id))
    if (!made) return c.json({ message: 'Unauthenticated.' }, 401)
    return c.json({ data: { ...(await find(made.id)), token: made.token } }, 201)
  })

  app.put('/keys/:id', async (c) => {
    const { id } = await find(c.req.param('id'))
    const { report, key } = await read(c)
    if (!key) return c.json(report, 422)
    await db.updateTable('api_keys').set(key).where('id', '=', id).execute()
    return c.json({ data: await find(id) })
  })

  app.delete('/keys/:id', async (c) => {
    const { id } = await find(c.req.param('id'))
    await db.deleteFrom('api_keys').where('id', '=', id).execute()
    return c.body(null, 204)
  })

  return app
}

// Whether a request reads drafts in place of what's live
type DeliveryEnv = { Variables: { draft: boolean } }

// The read-only delivery API, for clients with an API key. It serves live entries and media, and drafts to a preview
// key that asks for them with status=draft (PLAN.md section 17).
export function deliveryRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  delivery: DeliveryOptions & { depth: number; maxDepth: number; maxLinks: number },
) {
  const { depth, maxDepth, maxLinks, origins } = delivery
  if (![depth, maxDepth].every(Number.isInteger) || depth < 1 || depth > maxDepth) {
    throw new Error('delivery in sorlo.config.ts needs a whole number depth from 1 to its maxDepth.')
  }
  if (maxLinks !== Infinity && !(Number.isInteger(maxLinks) && maxLinks >= 1)) {
    throw new Error('delivery.maxLinks in sorlo.config.ts needs a whole number from 1, or Infinity for no limit.')
  }

  const app = new Hono<DeliveryEnv>()

  // Each route needs a key, and status=draft one with the preview scope. Plain keys sit in frontends, so they only ever
  // read what's live.
  const key: MiddlewareHandler<DeliveryEnv> = async (c, next) => {
    const found = await keyOf(db, c)
    if (!found) return c.json({ message: 'Unauthenticated.' }, 401)

    const status = c.req.query('status') ?? 'published'
    if (status !== 'published' && status !== 'draft') {
      throw new HTTPException(400, { message: 'status must be published or draft.' })
    }
    if (status === 'draft' && !found.scopes.includes('preview')) {
      return c.json(
        { message: "This key can't read drafts. Make one that can with sorlo make:api-key --preview." },
        403,
      )
    }
    c.set('draft', status === 'draft')
    await next()
  }

  // Any site's JavaScript can read them, unless sorlo.config.ts names the sites that can. Ahead of the key, as a browser
  // asks first without one. Keys go in a header, never a cookie, so a site gets nothing a visitor's session could give.
  const crossSite = cors({ origin: origins ?? '*', allowMethods: ['GET'] })
  // The public form routes share /v1, so these name their paths
  app.use('/entries/*', crossSite)
  app.use('/media/*', crossSite)
  app.use('/entries/*', key)
  app.use('/media/*', key)

  const typeNamed = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  // Entries as the delivery API returns them, with the links resolved that the request's with names
  const withLinks = (c: Context<DeliveryEnv>, resolving: ReturnType<typeof parseWith>, rows: Array<Delivered>) => {
    const found = rows.map(toEntry)
    return resolving
      ? resolveLinks(db, types, origin(c), found, resolving.names, resolving.depth, maxLinks, c.var.draft)
      : found
  }

  // One entry, replied as { data }, or a 404. Only top-level entries have unique slugs.
  const one = async (c: Context<DeliveryEnv>, column: 'id' | 'slug' | 'uri', value: string) => {
    const type = typeNamed(c.req.param('type')!)
    const resolving = parseWith(type, c.req.query(), delivery)
    const row = await deliveredEntries(db, c.var.draft)
      .selectAll()
      .$castTo<Delivered>()
      .where('type', '=', type.name)
      .where(column, '=', value)
      .$if(column === 'slug', (qb) => qb.where('parent_id', 'is', null))
      .executeTakeFirst()
    if (!row) throw new HTTPException(404)
    const [data] = await withLinks(c, resolving, [row])
    return c.json({ data })
  }

  app.get('/entries/:type', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const query = parseQuery(type, c.req.query())
    const resolving = parseWith(type, c.req.query(), delivery)
    const { data, pagination } = await listEntries<Delivered>(deliveredEntries(db, c.var.draft), type, query)
    return c.json({ data: await withLinks(c, resolving, data), pagination })
  })

  app.get('/entries/:type/slug/:slug', (c) => one(c, 'slug', c.req.param('slug')))

  app.get('/entries/:type/uri/:uri{.+}', (c) => one(c, 'uri', c.req.param('uri')))

  app.get('/entries/:type/:id', (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) throw new HTTPException(404)
    return one(c, 'id', id)
  })

  app.get('/media', async (c) => {
    const { data, pagination } = await listMedia(db, parseMediaQuery(c.req.query()))
    const base = origin(c)
    return c.json({ data: data.map((row) => toMedia(row, base)), pagination })
  })

  app.get('/media/:id', async (c) => c.json({ data: toMedia(await findMedia(db, c.req.param('id')), origin(c)) }))

  return app
}
