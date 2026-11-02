import type { ContentMigrationFile } from './content'
import { inputs, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { bearerOf, markUsed } from './delivery'
import type { AdminEnv } from './entries'
import { origin } from './media'
import { hashToken } from './passwords'
import { tokenSchema } from './schemas'
import { callTool, instructions, tools } from './tools'
import type { ContentType } from './types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

// The MCP server at /mcp, where AI clients such as Claude Code, Cursor and VS Code read the site's content through the
// CMS's tools, with the personal tokens people make on the admin's MCP tokens page (PLAN.md section 21)

const { version } = createRequire(import.meta.url)('../package.json')

// A token as the admin API returns it. Only the reply that makes it holds the token itself, since only its hash is kept.
const toToken = (row: { id: string; name: string; created_at: Date; last_used_at: Date | null }) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})

const columns = ['id', 'name', 'created_at', 'last_used_at'] as const

// The admin's MCP tokens page, where each person manages their own tokens. Someone else's token replies as one that
// doesn't exist does. Revoking a token deletes it, so it's refused from then on.
export function tokenRoutes(db: Kysely<Database>) {
  const app = new Hono<AdminEnv>()

  app.get('/tokens', async (c) => {
    const rows = await db
      .selectFrom('personal_tokens')
      .select(columns)
      .where('user_id', '=', c.var.user.id)
      .orderBy('name')
      .orderBy('id')
      .execute()
    return c.json({ data: rows.map(toToken) })
  })

  app.post('/tokens', async (c) => {
    const values = pickValues(tokenSchema, (await c.req.json().catch(() => null)) ?? {}, inputs)
    const report = await validateServerValues(tokenSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    // A prefix of its own, so neither people nor secret scanners take it for an API key's iight_
    const token = `iightpat_${randomBytes(32).toString('base64url')}`
    const row = await db
      .insertInto('personal_tokens')
      .values({ id: uuidv7(), user_id: c.var.user.id, name: values.name, token_hash: hashToken(token) })
      .returning(columns)
      .executeTakeFirstOrThrow()
    return c.json({ data: { ...toToken(row), token } }, 201)
  })

  app.delete('/tokens/:id', async (c) => {
    const id = c.req.param('id')
    const deleted =
      isUuid(id) &&
      (await db
        .deleteFrom('personal_tokens')
        .where('id', '=', id)
        .where('user_id', '=', c.var.user.id)
        .executeTakeFirst())
    if (!deleted || !deleted.numDeletedRows) throw new HTTPException(404)
    return c.body(null, 204)
  })

  return app
}

// The MCP server, over Streamable HTTP. It's stateless: each request gets a server and a transport of its own, which
// reply with JSON, so nothing is kept between requests and any process can answer. The tools never send anything
// unprompted, so there's no stream to open, and only POST is taken.
// No Origin check, which the spec asks of servers against DNS rebinding: every request needs a token, which a page on
// another site has no way to send.
export function mcpRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
) {
  const app = new Hono()

  app.all('/mcp', async (c) => {
    const sent = bearerOf(c)
    const found =
      sent &&
      (await db
        .selectFrom('personal_tokens')
        .innerJoin('users', 'users.id', 'personal_tokens.user_id')
        .select(['personal_tokens.id as token', 'users.id', 'users.email', 'users.name'])
        .where('token_hash', '=', hashToken(sent))
        .executeTakeFirst())

    // As the MCP spec's authorization section asks, naming where OAuth's protected resource metadata goes. It's served
    // with OAuth (PLAN.md section 21, phase 15), since the spec has it name an authorization server.
    if (!found) {
      const metadata = `${origin(c)}/.well-known/oauth-protected-resource/mcp`
      c.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${sent ? ', error="invalid_token"' : ''}`)
      return c.json({ message: 'Unauthenticated.' }, 401)
    }
    await markUsed(db, 'personal_tokens', found.token)

    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json({ message: 'Method Not Allowed' }, 405)
    }

    const { token, ...user } = found
    const context = { db, types, migrations, user, origin: origin(c) }
    const server = new McpServer({ name: 'iight', version }, { instructions })
    for (const tool of tools) {
      const config = {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: true, openWorldHint: false },
      }
      server.registerTool(tool.name, config, (input: unknown) => callTool(tool, context, input))
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}
