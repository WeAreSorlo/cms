import { Database, isUuid, uuidv7 } from './db'
import { hashToken } from './passwords'
import { isSaved, listEntries, parseQuery, toEntry } from './query'
import type { ContentType } from './types'
import { Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'

// A new key for the delivery API. Only its hash is stored, so this is the one time it can be shown.
// shortcut: every key reads all content, add scopes when keys need to do more than read
export async function createApiKey(db: Kysely<Database>, name: string) {
  const key = `iight_${randomBytes(32).toString('base64url')}`
  await db
    .insertInto('api_keys')
    .values({ id: uuidv7(), name, token_hash: hashToken(key) })
    .execute()
  return key
}

// Lets a request through when it sends a key for the delivery API as Authorization: Bearer <key>
export const apiKey =
  (db: Kysely<Database>): MiddlewareHandler =>
  async (c, next) => {
    const key = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1]
    const found =
      key && (await db.selectFrom('api_keys').select('id').where('token_hash', '=', hashToken(key)).executeTakeFirst())
    if (!found) return c.json({ message: 'Unauthenticated.' }, 401)
    await next()
  }

// The read-only delivery API, for clients with an API key. It serves live entries that have been saved.
export function deliveryRoutes(db: Kysely<Database>, types: Map<string, ContentType>) {
  const app = new Hono()

  app.use(apiKey(db))

  const typeNamed = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  // One live entry, replied as { data }, or a 404. Only top-level entries have unique slugs.
  const one = async (typeName: string, column: 'id' | 'slug' | 'uri', value: string) => {
    const row = await db
      .selectFrom('entries')
      .selectAll()
      .where('type', '=', typeNamed(typeName).name)
      .where('archived_at', 'is', null)
      .where(isSaved)
      .where(column, '=', value)
      .$if(column === 'slug', (qb) => qb.where('parent_id', 'is', null))
      .executeTakeFirst()
    if (!row) throw new HTTPException(404)
    return { data: toEntry(row) }
  }

  app.get('/entries/:type', async (c) => {
    const type = typeNamed(c.req.param('type'))
    const { data, pagination } = await listEntries(db, type, parseQuery(type, c.req.query()), { saved: true })
    return c.json({ data: data.map(toEntry), pagination })
  })

  app.get('/entries/:type/slug/:slug', async (c) => c.json(await one(c.req.param('type'), 'slug', c.req.param('slug'))))

  app.get('/entries/:type/uri/:uri{.+}', async (c) => c.json(await one(c.req.param('type'), 'uri', c.req.param('uri'))))

  app.get('/entries/:type/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) throw new HTTPException(404)
    return c.json(await one(c.req.param('type'), 'id', id))
  })

  return app
}
