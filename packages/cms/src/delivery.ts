import type { DeliveryOptions } from '.'
import { Database, isUuid, uuidv7 } from './db'
import { findMedia, origin, toMedia } from './media'
import { hashToken } from './passwords'
import { Delivered, deliveredEntries, listEntries, listMedia, parseMediaQuery, parseQuery, toEntry } from './query'
import { parseWith, resolveLinks } from './relations'
import type { ContentType } from './types'
import { Context, Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'

// A new key for the delivery API, which reads what's live, and with the preview scope, drafts too. Only its hash is
// stored, so this is the one time it can be shown.
export async function createApiKey(db: Kysely<Database>, name: string, scopes: Array<string> = []) {
  const key = `iight_${randomBytes(32).toString('base64url')}`
  await db
    .insertInto('api_keys')
    .values({ id: uuidv7(), name, token_hash: hashToken(key), scopes })
    .execute()
  return key
}

// The key a request sends for the delivery API, as Authorization: Bearer <key>
async function keyOf(db: Kysely<Database>, c: Context) {
  const key = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]
  return key
    ? await db.selectFrom('api_keys').select('scopes').where('token_hash', '=', hashToken(key)).executeTakeFirst()
    : undefined
}

// Whether a request sends a key for the delivery API
export const sendsApiKey = async (db: Kysely<Database>, c: Context) => !!(await keyOf(db, c))

// Lets a request through when it sends a key for the delivery API
export const apiKey =
  (db: Kysely<Database>): MiddlewareHandler =>
  async (c, next) => {
    if (!(await sendsApiKey(db, c))) return c.json({ message: 'Unauthenticated.' }, 401)
    await next()
  }

// Whether a request reads drafts in place of what's live
type DeliveryEnv = { Variables: { draft: boolean } }

// The read-only delivery API, for clients with an API key. It serves live entries and media, and drafts to a preview
// key that asks for them with status=draft (PLAN.md section 17).
export function deliveryRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  delivery: Required<DeliveryOptions>,
) {
  const { depth, maxDepth } = delivery
  if (![depth, maxDepth].every(Number.isInteger) || depth < 1 || depth > maxDepth) {
    throw new Error('delivery in iight.config.ts needs a whole number depth from 1 to its maxDepth.')
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
        { message: "This key can't read drafts. Make one that can with iight make:api-key --preview." },
        403,
      )
    }
    c.set('draft', status === 'draft')
    await next()
  }

  // The public form routes share /v1, so the check names these routes' paths
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
    return resolving ? resolveLinks(db, types, origin(c), found, resolving.names, resolving.depth, c.var.draft) : found
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
