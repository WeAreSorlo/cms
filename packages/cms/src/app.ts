import type { DeliveryOptions, FormOptions, MailOptions, McpOptions, MediaOptions, Storage, VersionOptions } from '.'
import type { AiProvider } from './ai'
import { automationRoutes } from './automations'
import { chatRoutes } from './chats'
import { type ContentMigrationFile, loadContentMigrations } from './content'
import { Database } from './db'
import { apiKey, deliveryRoutes, keyRoutes } from './delivery'
import { AdminEnv, entryRoutes } from './entries'
import { formRoutes, proxyList, publicFormRoutes } from './forms'
import { mcpRoutes, tokenRoutes } from './mcp'
import { mediaRoutes } from './media'
import { hashToken } from './passwords'
import { migrationRoutes } from './runMigrations'
import { EditorDirs, typeRoutes, typeSaver } from './typeEditor'
import type { ContentType, SharedGroup } from './types'
import { typesFile } from './typescript'
import { markActive, peopleLimits, sessionCookie, sessionRoutes, userRoutes } from './users'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { STATUS_CODES } from 'node:http'

// What every reply under /admin/ carries, in both servers, so no other site can frame the admin and lay its own page
// over the admin's buttons. X-Frame-Options is for browsers that don't know frame-ancestors.
export const adminHeaders = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }

// What the server uses from the site project, besides its types
export interface AppOptions {
  // Its migrations folder, which the admin's Migrations page lists, and runs where the editor is
  siteMigrations?: string
  // Whether to finish, as it starts, a rebuild of the links between entries that a run left due, as the servers do
  finishLinks?: boolean
  // Its content migrations, loaded by each request that needs them, so a new one counts as soon as it's written. From
  // siteMigrations unless given.
  migrations?: () => Promise<Record<string, ContentMigrationFile>>
  // Its shared groups, which its types come with expanded
  groups?: Map<string, SharedGroup>
  // Its folders, where the type editor writes types, shared groups and migrations, as in iight dev
  editor?: EditorDirs
  // Its storage for media, from iight.config.ts. The media library and its files need it.
  storage?: Storage
  // What the media library takes, and how it serves files
  media?: MediaOptions
  // How deep the delivery API's with resolves links
  delivery?: DeliveryOptions
  // Who can use the public form routes, and how often
  forms?: FormOptions
  // How many versions each entry keeps
  versions?: VersionOptions
  // The built admin's folder, which iight start serves at /admin/. iight dev serves the admin with Vite instead.
  admin?: string
  // Whether /mcp and the admin's MCP tokens page are on, and with publish, whether tokens can be given Publish changes
  mcp?: boolean | McpOptions
  // The model provider for the admin's assistant and Chat page, which are off without one
  ai?: AiProvider
  // The site's public address, which emailed links start from, and how it sends email, from iight.config.ts. Invites
  // and reset links are emailed only with both.
  url?: string
  mail?: MailOptions
  // The networks of the proxies in front of the CMS, beyond loopback and private ones, from iight.config.ts
  proxies?: Array<string>
}

export function createApp(
  db: Kysely<Database>,
  types = new Map<string, ContentType>(),
  {
    siteMigrations,
    finishLinks = false,
    migrations = siteMigrations ? () => loadContentMigrations(siteMigrations) : async () => ({}),
    groups = new Map(),
    editor,
    storage,
    media,
    delivery,
    forms,
    versions,
    admin,
    mcp = false,
    ai,
    url,
    mail,
    proxies,
  }: AppOptions = {},
) {
  const { depth = 2, maxDepth = 5, maxLinks = 2000 } = delivery ?? {}
  const publish = typeof mcp === 'object' && mcp.publish === true
  const app = new Hono<AdminEnv>()
  // The type editor's saves, which its routes and the assistant's Apply share, so they take turns
  const saver = editor && typeSaver(db, types, groups, editor)

  // Emailed links start from the site's address, never a request's Host header, which can say anything
  const site = url === undefined ? undefined : URL.canParse(url) ? new URL(url) : undefined
  if (url !== undefined && !/^https?:$/.test(site?.protocol ?? '')) {
    throw new Error("url in iight.config.ts needs to be the admin's address, such as https://cms.example.com.")
  }
  // Whose X-Forwarded-For the form limit, the address a submission records and the people limits believe
  const trusted = proxyList(proxies)
  // The limits sign-in and your account's current password share
  const people = { url: site?.origin, mail, limits: peopleLimits(), proxies: trusted }

  // Every error except a failed validation replies { message }, as Laravel does
  app.notFound((c) => c.json({ message: 'Not Found' }, 404))
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message || STATUS_CODES[error.status] }, error.status)
    }

    console.error(error)
    return c.json({ message: 'Server Error' }, 500)
  })

  // Sessions live in a cookie, so refuse form posts from other sites to the admin API. Other sites' forms post to the
  // public form routes, which take no cookie.
  app.use('/api/*', csrf())

  app.get('/', (c) => c.redirect('/admin/'))

  // The built admin. It routes by the URL's hash, so its page at /admin/ is the only page the browser asks for.
  if (admin) {
    // Each build names new files in the page, so browsers check for a new page every time
    app.use('/admin/*', async (c, next) => {
      await next()
      for (const [name, value] of Object.entries(adminHeaders)) c.header(name, value)
      if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache')
    })
    app.use('/admin/*', serveStatic({ root: admin, rewriteRequestPath: (path) => path.slice('/admin'.length) }))
  }

  // Sign in, join with an invite, and ask for and use a reset link, which need no session (PLAN.md section 5)
  app.route('/api', sessionRoutes(db, people))

  // The user whose session cookie came with the request, marked as using the admin. Someone removed has no sessions
  // left, since a removal deletes them and no session starts while one runs. It reads nothing the migration adding
  // removal makes, so people can sign in to run it from the Migrations page.
  const sessionUser = async (token: string | undefined) => {
    const user =
      token &&
      (await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select(['users.id', 'users.email', 'users.name'])
        .where('sessions.token_hash', '=', hashToken(token))
        .where('sessions.expires_at', '>', new Date())
        .executeTakeFirst())
    // Only a record of when they were last here, which never fails a request, as it would while its migration waits
    if (user) await markActive(db, user.id).catch(() => {})
    return user
  }

  // The signed-in user
  app.get('/api/session', async (c) => {
    const user = await sessionUser(getCookie(c, sessionCookie))
    return user ? c.json({ data: user }) : c.json({ message: 'Unauthenticated.' }, 401)
  })

  // Sign out
  app.delete('/api/session', async (c) => {
    const token = getCookie(c, sessionCookie)
    if (token) await db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute()

    deleteCookie(c, sessionCookie, { path: '/' })
    return c.body(null, 204)
  })

  // The rest of the admin API needs a session
  const signedIn: MiddlewareHandler<AdminEnv> = async (c, next) => {
    const user = await sessionUser(getCookie(c, sessionCookie))
    if (!user) return c.json({ message: 'Unauthenticated.' }, 401)
    c.set('user', user)
    await next()
  }
  app.use('/api/types/*', signedIn)
  app.use('/api/groups/*', signedIn)
  app.use('/api/entries/*', signedIn)
  app.use('/api/media/*', signedIn)
  app.use('/api/forms/*', signedIn)
  app.use('/api/submissions/*', signedIn)
  app.use('/api/automations/*', signedIn)
  app.use('/api/keys/*', signedIn)
  app.use('/api/migrations/*', signedIn)
  app.use('/api/users/*', signedIn)
  app.use('/api/invites/*', signedIn)
  app.use('/api/account/*', signedIn)
  if (mcp) app.use('/api/tokens/*', signedIn)
  if (ai) app.use('/api/chats/*', signedIn)
  app.route(
    '/api',
    typeRoutes(types, groups, saver, { mcp: !!mcp && { publish }, ai: !!ai, mail: !!(people.url && mail) }),
  )
  app.route('/api', entryRoutes(db, types, migrations, versions))
  // Migrations run from the admin only where the type editor is, in iight dev (PLAN.md section 6)
  app.route(
    '/api',
    migrationRoutes(db, types, { dir: siteMigrations, runnable: !!editor, queued: saver?.queued, finish: finishLinks }),
  )
  app.route('/api', formRoutes(db))
  app.route('/api', automationRoutes(db, types))
  app.route('/api', keyRoutes(db))
  app.route('/api', userRoutes(db, people))
  if (storage) app.route('/', mediaRoutes(db, storage, media))

  // AI clients read the site's content as a person, with a token that person made (PLAN.md section 21)
  if (mcp) {
    app.route('/api', tokenRoutes(db, publish))
    app.route('/', mcpRoutes(db, types, migrations, versions, storage, publish))
  }

  // The admin's assistant reads the same way, with the site's own model (PLAN.md section 21)
  if (ai) app.route('/api', chatRoutes(db, types, migrations, ai, versions, storage, saver))

  app.route('/v1', deliveryRoutes(db, types, { depth, maxDepth, maxLinks, origins: delivery?.origins }))
  app.route('/v1', publicFormRoutes(db, forms, trusted))

  // What the delivery API returns and the forms take, as TypeScript, for `npx iight types pull`, to keys with the types
  // scope. Made for each request, since the type editor can change the types, and the admin the forms.
  const typesKey = apiKey(db, 'types', "This key can't pull types. Make one that can with iight make:api-key --types.")
  app.get('/types', typesKey, async (c) => {
    const found = await db.selectFrom('forms').select(['name', 'fields']).orderBy('name').execute()
    return c.text(typesFile(types, depth, found, groups))
  })

  return app
}
