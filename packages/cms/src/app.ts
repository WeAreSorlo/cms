import { inputs, pickValues, validateServerValues } from './core'
import { Database, uuidv7 } from './db'
import { deliveryRoutes } from './delivery'
import { AdminEnv, entryRoutes } from './entries'
import { hashToken, verifyPassword } from './passwords'
import { signInSchema } from './schemas'
import type { ContentType } from './types'
import { Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'
import { STATUS_CODES } from 'node:http'

const sessionCookie = 'iight_session'
const sessionLength = 30 * 24 * 60 * 60 * 1000

export function createApp(db: Kysely<Database>, types = new Map<string, ContentType>()) {
  const app = new Hono<AdminEnv>()

  // Every error except a failed validation replies { message }, as Laravel does
  app.notFound((c) => c.json({ message: 'Not Found' }, 404))
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message || STATUS_CODES[error.status] }, error.status)
    }

    console.error(error)
    return c.json({ message: 'Server Error' }, 500)
  })

  // Sessions live in a cookie, so refuse form posts from other sites
  app.use(csrf())

  app.get('/', (c) => c.redirect('/admin/'))

  // Sign in
  app.post('/api/session', async (c) => {
    const values = pickValues(signInSchema, await c.req.json().catch(() => ({})), inputs)
    const report = await validateServerValues(signInSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', values.email.toLowerCase())
      .executeTakeFirst()

    const passwordMatches = await verifyPassword(values.password, user?.password_hash)
    if (!user || !passwordMatches) {
      const fields = {
        ...report.fields,
        email: { isValid: false, messages: ['These credentials do not match our records.'] },
      }
      return c.json({ isValid: false, fields }, 422)
    }

    const token = randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + sessionLength)
    await db.deleteFrom('sessions').where('expires_at', '<=', new Date()).execute()
    await db
      .insertInto('sessions')
      .values({ id: uuidv7(), user_id: user.id, token_hash: hashToken(token), expires_at: expires })
      .execute()

    setCookie(c, sessionCookie, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      expires,
      secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    })

    return c.json({ data: { id: user.id, email: user.email, name: user.name } })
  })

  // The user whose session cookie came with the request
  const sessionUser = async (token: string | undefined) =>
    token &&
    (await db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select(['users.id', 'users.email', 'users.name'])
      .where('sessions.token_hash', '=', hashToken(token))
      .where('sessions.expires_at', '>', new Date())
      .executeTakeFirst())

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
  app.use('/api/entries/*', signedIn)
  app.route('/api', entryRoutes(db, types))

  app.route('/v1', deliveryRoutes(db, types))

  return app
}
