import type { Storage, VersionOptions } from '.'
import type { ContentMigrationFile } from './content'
import { inputs, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { bearerOf, markUsed } from './delivery'
import type { AdminEnv } from './entries'
import { origin } from './media'
import { hashToken } from './passwords'
import { tokenSchema, tokenScopes } from './schemas'
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
// CMS's tools, and with Save drafts change it, with the personal tokens people make on the admin's MCP tokens page
// (PLAN.md section 21)

const { version } = createRequire(import.meta.url)('../package.json')

// A token as the admin API returns it. Only the reply that makes it holds the token itself, since only its hash is kept.
const toToken = (row: {
  id: string
  name: string
  scopes: Array<string>
  created_at: Date
  last_used_at: Date | null
}) => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})

const columns = ['id', 'name', 'scopes', 'created_at', 'last_used_at'] as const

// The admin's MCP tokens page, where each person manages their own tokens. Someone else's token replies as one that
// doesn't exist does. Revoking a token marks it revoked, so it's refused from then on, and the versions saved through
// it keep its name.
export function tokenRoutes(db: Kysely<Database>) {
  const app = new Hono<AdminEnv>()

  app.get('/tokens', async (c) => {
    const rows = await db
      .selectFrom('personal_tokens')
      .select(columns)
      .where('user_id', '=', c.var.user.id)
      .where('revoked_at', 'is', null)
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
    const scopes = tokenScopes.map(({ value }) => value).filter((scope) => values.scopes?.includes(scope))
    const row = await db
      .insertInto('personal_tokens')
      .values({ id: uuidv7(), user_id: c.var.user.id, name: values.name, token_hash: hashToken(token), scopes })
      .returning(columns)
      .executeTakeFirstOrThrow()
    return c.json({ data: { ...toToken(row), token } }, 201)
  })

  app.delete('/tokens/:id', async (c) => {
    const id = c.req.param('id')
    const revoked =
      isUuid(id) &&
      (await db
        .updateTable('personal_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .where('user_id', '=', c.var.user.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst())
    if (!revoked || !revoked.numUpdatedRows) throw new HTTPException(404)
    return c.body(null, 204)
  })

  return app
}

// The MCP server, over Streamable HTTP. It's stateless: each request gets a server and a transport of its own, which
// reply with JSON, so nothing is kept between requests and any process can answer. The tools never send anything
// unprompted, so there's no stream to open, and only POST is taken. A token with Save drafts also gets the write
// tools, which save as soon as they're called, since the client's own approval prompt is the check.
// No Origin check, which the spec asks of servers against DNS rebinding: every request needs a token, which a page on
// another site has no way to send.
export function mcpRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  versions?: VersionOptions,
  storage?: Storage,
) {
  const app = new Hono()

  app.all('/mcp', async (c) => {
    const sent = bearerOf(c)
    const found =
      sent &&
      (await db
        .selectFrom('personal_tokens')
        .innerJoin('users', 'users.id', 'personal_tokens.user_id')
        .select(['personal_tokens.id as token', 'personal_tokens.scopes', 'users.id', 'users.email', 'users.name'])
        .where('token_hash', '=', hashToken(sent))
        .where('revoked_at', 'is', null)
        .executeTakeFirst())

    // A plain bearer challenge, naming no OAuth metadata, since the CMS has no OAuth for MCP (PLAN.md section 21) and
    // a client that does OAuth would go looking for it
    if (!found) {
      c.header('WWW-Authenticate', sent ? 'Bearer error="invalid_token"' : 'Bearer')
      return c.json({ message: 'Unauthenticated.' }, 401)
    }
    await markUsed(db, 'personal_tokens', found.token)

    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json({ message: 'Method Not Allowed' }, 405)
    }

    const { token, scopes, ...user } = found
    const writes = scopes.includes('drafts')
    const context = {
      db,
      types,
      migrations,
      user,
      origin: origin(c),
      versions,
      storage,
      ...(writes && { writes: { token } }),
    }
    const server = new McpServer({ name: 'iight', version }, { instructions: instructions(writes) })
    // A file's details change on the site once applied, which over MCP has no one to apply them
    for (const tool of tools.filter((tool) => !tool.assistantOnly && (writes || !tool.changes))) {
      const config = {
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.changes
          ? {
              readOnlyHint: false,
              destructiveHint: tool.changes.destructive,
              idempotentHint: tool.changes.idempotent,
              openWorldHint: false,
            }
          : { readOnlyHint: true, openWorldHint: false },
      }
      server.registerTool(tool.name, config, (input: unknown) => callTool(tool, context, input))
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}
