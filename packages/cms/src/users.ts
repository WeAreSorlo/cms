import type { MailMessage, MailOptions } from '.'
import { inputs, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import { escapeHtml } from './embed'
import type { AdminEnv } from './entries'
import { clientIp, limitKey, rateLimiter } from './forms'
import { origin } from './media'
import { hashPassword, hashToken, verifyPassword } from './passwords'
import { accountSchema, inviteSchema, joinSchema, resetSchema, signInSchema } from './schemas'
import { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { Kysely, sql } from 'kysely'
import { randomBytes } from 'node:crypto'
import type { BlockList } from 'node:net'

// People, and how they get a session: sign-in, invites, reset links and each person's account. The
// routes under /api/session need no session, since they're how someone gets one, and the rest need one.

export const sessionCookie = 'sorlo_session'
const sessionLength = 30 * 24 * 60 * 60 * 1000

// How long a link works: an invite's for 7 days, and a reset link for an hour
const inviteLength = 7 * 24 * 60 * 60 * 1000
const resetLength = 60 * 60 * 1000

const inviteGone = 'This invite has expired or been used. Ask for a new one.'
const resetGone = 'This link has expired or been used. Ask for a new one.'
const emailTaken = 'This email already has an account.'
const forgotSent =
  "If that email has an account here, we've sent it a link to choose a new password. It works for an hour."

// What sign-in and Forgot your password? allow, counted for each email from each address together: 10 sign-ins in 10
// minutes without a success, which clears them, and 10 asks for a link, within Forgot's 20 asks
// a minute from each address, whatever the emails
export const peopleLimits = () => ({
  signIns: rateLimiter(10, 10 * 60_000),
  forgot: rateLimiter(10, 10 * 60_000),
  forgotAddresses: rateLimiter(20, 60_000),
})

// The most links Forgot your password? has waiting to be looked up and emailed after its replies, past which it
// replies 429 for a minute, so no one can fill the memory or the database's queue with them
const maxEmailing = 50

export interface PeopleOptions {
  // The site's address, from sorlo.config.ts's url, which emailed links start from
  url?: string
  // How the site sends email, which invites and reset links go by only with url set too
  mail?: MailOptions
  limits: ReturnType<typeof peopleLimits>
  // The networks whose X-Forwarded-For the limits believe, from proxyList
  proxies: BlockList
}

// A link to one of the admin's pages for links. The token goes in the URL's fragment, which browsers never send to a
// server or in a Referer header, so it stays out of access logs.
const linkTo = (base: string, page: 'invite' | 'reset', token: string) => `${base}/admin/#/${page}/${token}`

// 256 random bits, as sessions' and keys' are, of which only the hash is kept
const newToken = () => randomBytes(32).toString('base64url')

// The hash of the token a link's page sends, or '' for none
const tokenHashOf = (body: any) => (typeof body?.token === 'string' && body.token ? hashToken(body.token) : '')

// 429, with how many seconds to wait
function tooMany(c: Context, seconds: number, message: string) {
  c.header('retry-after', String(seconds))
  return c.json({ message }, 429)
}

// Whoever is making an invite, a key, a token or a reset link, their row held as a removal holds it, or undefined once
// they're removed, so nothing they make while being removed outlives the removal
export const maker = (trx: Kysely<Database>, id: string) =>
  trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', id)
    .where('removed_at', 'is', null)
    .forShare()
    .executeTakeFirst()

// A new session for someone, made in the transaction that locked their row and checked them, as a removal locks it,
// so no session starts for someone while they're being removed
async function newSession(trx: Kysely<Database>, userId: string) {
  const token = newToken()
  const expires = new Date(Date.now() + sessionLength)
  await trx.deleteFrom('sessions').where('expires_at', '<=', new Date()).execute()
  await trx
    .insertInto('sessions')
    .values({ id: uuidv7(), user_id: userId, token_hash: hashToken(token), expires_at: expires })
    .execute()
  return { token, expires }
}

// Gives this browser the session's cookie, replying as sign-in does
function signedIn(
  c: Context,
  { token, expires }: { token: string; expires: Date },
  user: { id: string; email: string; name: string },
) {
  setCookie(c, sessionCookie, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    expires,
    secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
  })
  return c.json({ data: { id: user.id, email: user.email, name: user.name } })
}

// When this process last wrote each person's last_active_at, so requests don't each write it
const activeAt = new Map<string, number>()

// Marks someone as using the admin, once a minute, as markUsed marks keys and tokens. Other processes mark them too, so
// the database only takes a time a minute after the last.
export async function markActive(db: Kysely<Database>, id: string) {
  if (Date.now() - (activeAt.get(id) ?? 0) < 60_000) return
  activeAt.set(id, Date.now())
  await db
    .updateTable('users')
    .set({ last_active_at: sql`now()` })
    .where('id', '=', id)
    .where((eb) =>
      eb.or([eb('last_active_at', 'is', null), eb('last_active_at', '<=', sql<Date>`now() - interval '1 minute'`)]),
    )
    .execute()
}

// Makes someone's reset link, replacing any they had, recording who made it for them, or with everyMinute, as for an
// emailed one, which nobody makes, none while theirs is under a minute old, so Forgot your password? sends one email a
// minute whoever asks
async function makeReset(db: Kysely<Database>, userId: string, madeBy: string | null, everyMinute = false) {
  const token = newToken()
  const link = { token_hash: hashToken(token), made_by: madeBy, expires_at: new Date(Date.now() + resetLength) }
  const row = await db
    .insertInto('password_resets')
    .values({ user_id: userId, ...link })
    .onConflict((oc) => {
      const replace = oc.column('user_id').doUpdateSet({ ...link, created_at: sql`now()` })
      return everyMinute
        ? replace.where('password_resets.created_at', '<=', sql<Date>`now() - interval '1 minute'`)
        : replace
    })
    .returning('expires_at')
    .executeTakeFirst()
  return row && { token, expiresAt: row.expires_at }
}

// Sends an email, waiting at most 10 seconds, so a slow mail service can't hold up a reply, and gives whether it went.
// A failure logs why, never the email, since it holds a link.
async function sends(mail: MailOptions, what: string, message: Omit<MailMessage, 'from'>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), 10_000)))
  try {
    return await Promise.race([mail.send({ from: mail.from, ...message }).then(() => true), timeout])
  } catch (error) {
    console.error(`Couldn't send ${what}:`, error instanceof Error ? error.message : error)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// An email's paragraphs as text and as HTML, with its link as a link
const email = (to: string, subject: string, paragraphs: Array<string>, link: string) => ({
  to: [to],
  subject,
  text: `${paragraphs.join('\n\n')}\n`,
  html: paragraphs
    .map(
      (text) => `<p>${text === link ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : escapeHtml(text)}</p>`,
    )
    .join('\n'),
})

// Emails name the site by its address, since sites have no name. A name goes on one line, since it heads the subject.
function inviteEmail(to: string, inviter: string, url: string, link: string) {
  const host = new URL(url).host
  const name = inviter.replace(/\s+/g, ' ').trim()
  const paragraphs = [
    `${name} invited you to edit content at ${host}. Choose your name and password within 7 days:`,
    link,
    "If you weren't expecting this, you can ignore it.",
  ]
  return email(to, `${name} invited you to ${host}`, paragraphs, link)
}

function resetEmail(to: string, url: string, link: string) {
  const host = new URL(url).host
  const paragraphs = [
    `Someone asked to reset the password for this email at ${host}. Choose a new one within an hour:`,
    link,
    "If it wasn't you, ignore this email, and your password stays as it is.",
  ]
  return email(to, `Reset your password for ${host}`, paragraphs, link)
}

// The routes under /api/session that need no session: signing in, joining with an invite, and asking for and using a
// reset link. Anyone can post to them, so each body is limited before it's read, and each link is looked up before any
// password is hashed, so a made-up one costs no scrypt.
export function sessionRoutes(db: Kysely<Database>, { url, mail, limits, proxies }: PeopleOptions) {
  const app = new Hono()
  const limit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ message: 'The request is too large.' }, 413),
  })
  // How many of Forgot your password?'s links wait to be looked up and emailed after their replies
  let emailing = 0

  // Sign in. Attempts count by email and address together, so one person's typos don't lock out an office behind one
  // address, and nobody can lock someone out from elsewhere.
  app.post('/session', limit, async (c) => {
    const values = pickValues(signInSchema, await c.req.json().catch(() => ({})), inputs)
    const report = await validateServerValues(signInSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    // Every attempt counts as it arrives, before the lookup and the hash, so guesses sent at once can't all get through,
    // and a success clears the count
    const address = values.email.toLowerCase()
    const key = `${limitKey(clientIp(c, proxies))} ${address}`
    const seconds = limits.signIns.hit(key)
    if (seconds) return tooMany(c, seconds, 'Too many failed sign-ins. Wait a few minutes, then try again.')

    // Someone removed has a blank password, which fails as an unknown email does, hashing a dummy. Sign-in reads no
    // column that the migration adding removal makes, so people can sign in to run it from the Migrations page.
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'password_hash'])
      .where('email', '=', address)
      .executeTakeFirst()

    const passwordMatches = await verifyPassword(values.password, user?.password_hash)
    // The session starts only while the password checked is still theirs, with their row locked, so a sign-in racing
    // their removal, or a new password, gets nothing
    const session =
      user &&
      passwordMatches &&
      (await db.transaction().execute(async (trx) => {
        const still = await trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', user.id)
          .where('password_hash', '=', user.password_hash)
          .forUpdate()
          .executeTakeFirst()
        return still && newSession(trx, user.id)
      }))
    if (!user || !session) {
      const fields = {
        ...report.fields,
        email: { isValid: false, messages: ['These credentials do not match our records.'] },
      }
      return c.json({ isValid: false, fields }, 422)
    }

    limits.signIns.clear(key)
    return signedIn(c, session, user)
  })

  // Join with an invite: the account for its address, with the name and password chosen, or for someone removed, their
  // account back, then signed in. A form that fails its checks leaves the link to use.
  app.post('/session/invite', limit, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const values = pickValues(joinSchema, body, inputs)
    const report = await validateServerValues(joinSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const hash = tokenHashOf(body)
    const found =
      hash &&
      (await db
        .selectFrom('invites')
        .select('id')
        .where('token_hash', '=', hash)
        .where('expires_at', '>', new Date())
        .executeTakeFirst())
    if (!found) return c.json({ message: inviteGone }, 404)

    const passwordHash = await hashPassword(values.password)
    const joined = await db.transaction().execute(async (trx) => {
      // Used once: only the request that deletes it goes on
      const invite = await trx
        .deleteFrom('invites')
        .where('id', '=', found.id)
        .where('token_hash', '=', hash)
        .where('expires_at', '>', new Date())
        .returning(['email', 'invited_by'])
        .executeTakeFirst()
      if (!invite) return 'gone'

      const existing = await trx
        .selectFrom('users')
        .select(['id', 'removed_at'])
        .where('email', '=', invite.email)
        .forUpdate()
        .executeTakeFirst()
      if (existing && !existing.removed_at) return 'taken'

      const person = {
        name: values.name,
        password_hash: passwordHash,
        invited_by: invite.invited_by,
        removed_at: null,
        removed_by: null,
      }
      const columns = ['id', 'email', 'name'] as const
      const user = existing
        ? await trx
            .updateTable('users')
            .set({ ...person, updated_at: new Date() })
            .where('id', '=', existing.id)
            .returning(columns)
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto('users')
            .values({ id: uuidv7(), email: invite.email, ...person })
            .returning(columns)
            .executeTakeFirstOrThrow()
      return { user, session: await newSession(trx, user.id) }
    })

    if (joined === 'gone') return c.json({ message: inviteGone }, 404)
    if (joined === 'taken') return c.json({ message: 'This email has an account already, so sign in with it.' }, 409)
    return signedIn(c, joined.session, joined.user)
  })

  // Ask for a reset link by email. It replies the same, and at once, whatever the address, then does the work, so
  // neither the reply nor its timing tells an account from none.
  app.post('/session/forgot', limit, async (c) => {
    if (!url || !mail) return c.json({ message: "This site doesn't send email." }, 404)
    const values = pickValues(inviteSchema, await c.req.json().catch(() => ({})), inputs)
    const report = await validateServerValues(inviteSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    // An address's asks first, whatever the emails, so one client can't fill the per-email counts, then the email's, then
    // the work waiting, which counts no one's and so says nothing about accounts
    const from = limitKey(clientIp(c, proxies))
    const address = values.email.toLowerCase()
    const seconds = limits.forgotAddresses.hit(from) || limits.forgot.hit(`${from} ${address}`)
    if (seconds) return tooMany(c, seconds, 'Too many requests. Wait a few minutes, then try again.')
    if (emailing >= maxEmailing) return tooMany(c, 60, 'Too many requests right now. Wait a minute, then try again.')

    const emailLink = async () => {
      const user = await db
        .selectFrom('users')
        .select('id')
        .where('email', '=', address)
        .where('removed_at', 'is', null)
        .executeTakeFirst()
      const reset = user && (await makeReset(db, user.id, null, true))
      if (reset) await sends(mail, 'a reset link', resetEmail(address, url, linkTo(url, 'reset', reset.token)))
    }
    emailing++
    void emailLink()
      .catch((error) => console.error("Couldn't make a reset link:", error))
      .finally(() => emailing--)
    return c.json({ message: forgotSent }, 202)
  })

  // Choose a new password with a reset link, which ends every session of theirs, then signs them in here
  app.post('/session/reset', limit, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const values = pickValues(resetSchema, body, inputs)
    const report = await validateServerValues(resetSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const hash = tokenHashOf(body)
    const found =
      hash &&
      (await db
        .selectFrom('password_resets')
        .select('user_id')
        .where('token_hash', '=', hash)
        .where('expires_at', '>', new Date())
        .executeTakeFirst())
    if (!found) return c.json({ message: resetGone }, 404)

    const passwordHash = await hashPassword(values.password)
    const reset = await db.transaction().execute(async (trx) => {
      // The person first, as a removal locks them first, then the link, which only one request can use
      const person = await trx
        .selectFrom('users')
        .select(['id', 'email', 'name'])
        .where('id', '=', found.user_id)
        .where('removed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
      const used =
        person &&
        (await trx
          .deleteFrom('password_resets')
          .where('user_id', '=', person.id)
          .where('token_hash', '=', hash)
          .where('expires_at', '>', new Date())
          .executeTakeFirst())
      if (!person || !used?.numDeletedRows) return

      await trx
        .updateTable('users')
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where('id', '=', person.id)
        .execute()
      await trx.deleteFrom('sessions').where('user_id', '=', person.id).execute()
      return { person, session: await newSession(trx, person.id) }
    })

    if (!reset) return c.json({ message: resetGone }, 404)
    return signedIn(c, reset.session, reset.person)
  })

  return app
}

// The people routes behind the session: the Users page, invites, and your own account. Anyone signed in can invite,
// remove and make reset links, until roles exist.
export function userRoutes(db: Kysely<Database>, { url, mail, limits, proxies }: PeopleOptions) {
  const app = new Hono<AdminEnv>()

  // Links in replies start from the site's address, or without one, from the address of the request, which is that of
  // someone signed in
  const base = (c: Context) => url ?? origin(c)

  // People as the routes reply them, with who invited and who removed each
  const findPeople = async ({ id, removed }: { id?: string; removed?: boolean }) => {
    const rows = await db
      .selectFrom('users')
      .leftJoin('users as inviter', 'inviter.id', 'users.invited_by')
      .leftJoin('users as remover', 'remover.id', 'users.removed_by')
      .select([
        'users.id',
        'users.name',
        'users.email',
        'users.created_at',
        'users.last_active_at',
        'users.removed_at',
        'inviter.id as inviter_id',
        'inviter.name as inviter_name',
        'remover.id as remover_id',
        'remover.name as remover_name',
      ])
      .$if(id !== undefined, (qb) => qb.where('users.id', '=', id!))
      .$if(removed !== undefined, (qb) => qb.where('users.removed_at', removed ? 'is not' : 'is', null))
      .$if(!!removed, (qb) => qb.orderBy('users.removed_at', 'desc'))
      .orderBy('users.name')
      .orderBy('users.id')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      invitedBy: row.inviter_id ? { id: row.inviter_id, name: row.inviter_name } : null,
      removedAt: row.removed_at,
      removedBy: row.remover_id ? { id: row.remover_id, name: row.remover_name } : null,
    }))
  }

  const find = async (id: string) => {
    const [person] = isUuid(id) ? await findPeople({ id }) : []
    if (!person) throw new HTTPException(404)
    return person
  }

  // Invites as the routes reply them, with who sent each, and the person removed whose address it is, whom accepting
  // brings back
  const findInvites = async (id?: string) => {
    const rows = await db
      .selectFrom('invites')
      .leftJoin('users as inviter', 'inviter.id', 'invites.invited_by')
      .leftJoin('users as removed', (join) =>
        join.onRef('removed.email', '=', 'invites.email').on('removed.removed_at', 'is not', null),
      )
      .select([
        'invites.id',
        'invites.email',
        'invites.created_at',
        'invites.expires_at',
        'inviter.id as inviter_id',
        'inviter.name as inviter_name',
        'removed.id as removed_id',
        'removed.name as removed_name',
        'removed.removed_at',
      ])
      .$if(id !== undefined, (qb) => qb.where('invites.id', '=', id!))
      .orderBy('invites.created_at', 'desc')
      .orderBy('invites.id')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      invitedBy: row.inviter_id ? { id: row.inviter_id, name: row.inviter_name } : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      restores: row.removed_id ? { id: row.removed_id, name: row.removed_name, removedAt: row.removed_at } : null,
    }))
  }

  // Everyone who can sign in, by name, or with removed=true, those removed, latest first
  // shortcut: every person, unpaged, as keys are; page them when sites have hundreds
  app.get('/users', async (c) => c.json({ data: await findPeople({ removed: c.req.query('removed') === 'true' }) }))

  app.get('/users/:id', async (c) => c.json({ data: await find(c.req.param('id')) }))

  // Remove someone, keeping their row, so everything that points at them keeps their name. Nobody removes themselves,
  // so whoever removes stays and someone can always sign in.
  app.post('/users/:id/remove', async (c) => {
    const id = c.req.param('id')
    const me = c.var.user.id
    if (id === me) return c.json({ message: "You can't remove yourself. Ask someone else to." }, 409)
    if (!isUuid(id)) throw new HTTPException(404)

    const outcome = await db.transaction().execute(async (trx) => {
      // Both people, locked in id order, so two removing each other at once take turns, and the second finds they've
      // been removed
      const rows = await trx
        .selectFrom('users')
        .select(['id', 'removed_at'])
        .where('id', 'in', [id, me])
        .orderBy('id')
        .forUpdate()
        .execute()
      if (!rows.some((row) => row.id === me && !row.removed_at)) return 401
      const person = rows.find((row) => row.id === id)
      if (!person) return 404
      if (person.removed_at) return 409

      const now = new Date()
      // A blank password fails sign-in as an unknown email does, so only an invite brings them back
      await trx
        .updateTable('users')
        .set({ removed_at: now, removed_by: me, password_hash: '', updated_at: now })
        .where('id', '=', id)
        .execute()
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute()
      // Their own reset link, and those they made for colleagues
      await trx
        .deleteFrom('password_resets')
        .where((eb) => eb.or([eb('user_id', '=', id), eb('made_by', '=', id)]))
        .execute()
      // Revoked as Revoke does, keeping the rows, so the versions saved and published through them keep their names
      await trx
        .updateTable('personal_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute()
      // So nobody they invited, such as themselves at another address, gets in after them
      await trx.deleteFrom('invites').where('invited_by', '=', id).execute()
      return 200
    })

    if (outcome === 401) return c.json({ message: 'Unauthenticated.' }, 401)
    if (outcome === 404) throw new HTTPException(404)
    if (outcome === 409) return c.json({ message: 'They were removed already.' }, 409)
    return c.json({ data: await find(id) })
  })

  // A reset link for someone else, which works for an hour, to pass on, replacing any they had. Only this reply holds
  // it. Yours changes on your account page, with your current password, so a stolen session can't change it here.
  app.post('/users/:id/reset', async (c) => {
    const person = await find(c.req.param('id'))
    if (person.id === c.var.user.id) {
      return c.json({ message: 'Change your own password on your account page.' }, 409)
    }
    if (person.removedAt) {
      return c.json({ message: "Someone removed can't reset their password. Invite them again instead." }, 409)
    }
    const reset = await db
      .transaction()
      .execute(async (trx) =>
        (await maker(trx, c.var.user.id)) ? makeReset(trx, person.id, c.var.user.id) : undefined,
      )
    if (!reset) return c.json({ message: 'Unauthenticated.' }, 401)
    return c.json({ data: { link: linkTo(base(c), 'reset', reset.token), expiresAt: reset.expiresAt } }, 201)
  })

  // The invites waiting, newest first, expired ones included
  app.get('/invites', async (c) => c.json({ data: await findInvites() }))

  // Invite someone, replacing any invite their address had, so its old link stops working. The reply holds the link,
  // as no other does, and says whether it was emailed too.
  app.post('/invites', async (c) => {
    const values = pickValues(inviteSchema, (await c.req.json().catch(() => null)) ?? {}, inputs)
    const report = await validateServerValues(inviteSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const address = values.email.toLowerCase()
    const taken = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', address)
      .where('removed_at', 'is', null)
      .executeTakeFirst()
    if (taken) {
      const fields = { ...report.fields, email: { isValid: false, messages: [emailTaken] } }
      return c.json({ isValid: false, fields }, 422)
    }

    const token = newToken()
    const link = {
      token_hash: hashToken(token),
      invited_by: c.var.user.id,
      expires_at: new Date(Date.now() + inviteLength),
    }
    // A removal deletes the invites its person sent, so one they send meanwhile, such as to their own address, waits
    // for it and is refused
    const made = await db.transaction().execute(
      async (trx) =>
        (await maker(trx, c.var.user.id)) &&
        trx
          .insertInto('invites')
          .values({ id: uuidv7(), email: address, ...link })
          .onConflict((oc) => oc.column('email').doUpdateSet({ ...link, created_at: sql`now()` }))
          .returning('id')
          .executeTakeFirstOrThrow(),
    )
    if (!made) return c.json({ message: 'Unauthenticated.' }, 401)
    const [invite] = await findInvites(made.id)

    const emailed =
      !!url &&
      !!mail &&
      (await sends(mail, 'an invite', inviteEmail(address, c.var.user.name, url, linkTo(url, 'invite', token))))
    return c.json({ data: { ...invite, link: linkTo(base(c), 'invite', token), emailed } }, 201)
  })

  app.delete('/invites/:id', async (c) => {
    const id = c.req.param('id')
    const deleted = isUuid(id) && (await db.deleteFrom('invites').where('id', '=', id).executeTakeFirst())
    if (!deleted || !deleted.numDeletedRows) throw new HTTPException(404)
    return c.body(null, 204)
  })

  // The session a request came with, which changes to your account keep
  const thisSession = (c: Context) => hashToken(getCookie(c, sessionCookie) ?? '')

  // Your account, with how many other browsers you're signed in on
  const account = async (c: Context<AdminEnv>) => {
    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'created_at'])
      .where('id', '=', c.var.user.id)
      .executeTakeFirstOrThrow()
    const { count } = await db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', me.id)
      .where('token_hash', '!=', thisSession(c))
      .where('expires_at', '>', new Date())
      .executeTakeFirstOrThrow()
    return { id: me.id, name: me.name, email: me.email, createdAt: me.created_at, otherSessions: Number(count) }
  }

  app.get('/account', async (c) => c.json({ data: await account(c) }))

  // Change your name, email or password. The last two need your current password, which counts against sign-in's
  // limit, so a stolen session can't guess it either. A new password ends your other sessions, and either change ends
  // a reset link, which went to the old address or is pointless now.
  app.put('/account', async (c) => {
    const me = await db
      .selectFrom('users')
      .select(['id', 'email', 'password_hash'])
      .where('id', '=', c.var.user.id)
      .executeTakeFirstOrThrow()
    const schema = accountSchema(me.email)
    const values = pickValues(schema, (await c.req.json().catch(() => null)) ?? {}, inputs)
    const report = await validateServerValues(schema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const address = values.email.toLowerCase()
    const invalid = (field: string, message: string) =>
      c.json({ isValid: false, fields: { ...report.fields, [field]: { isValid: false, messages: [message] } } }, 422)

    // It's there once the form shows it, when the email or the password changes, and counts as sign-in's attempts do
    if (values.password !== undefined) {
      const key = `${limitKey(clientIp(c, proxies))} ${me.email}`
      const seconds = limits.signIns.hit(key)
      if (seconds) return tooMany(c, seconds, 'Too many wrong passwords. Wait a few minutes, then try again.')
      if (!(await verifyPassword(values.password, me.password_hash))) {
        return invalid('password', "That isn't your current password.")
      }
      limits.signIns.clear(key)
    }
    if (
      address !== me.email &&
      (await db.selectFrom('users').select('id').where('email', '=', address).executeTakeFirst())
    ) {
      return invalid('email', emailTaken)
    }

    const newPassword = values.newPassword ? await hashPassword(values.newPassword) : undefined
    const saved = await db.transaction().execute(async (trx) => {
      // Only while they're who was read, with the password read and not removed since, their row locked as a removal
      // or a reset locks it, so a save under way never undoes either
      const still = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', me.id)
        .where('password_hash', '=', me.password_hash)
        .where('removed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
      if (!still) return false

      await trx
        .updateTable('users')
        .set({
          name: values.name,
          email: address,
          updated_at: new Date(),
          ...(newPassword && { password_hash: newPassword }),
        })
        .where('id', '=', me.id)
        .execute()
      if (newPassword || address !== me.email)
        await trx.deleteFrom('password_resets').where('user_id', '=', me.id).execute()
      if (newPassword) {
        await trx
          .deleteFrom('sessions')
          .where('user_id', '=', me.id)
          .where('token_hash', '!=', thisSession(c))
          .execute()
      }
      return true
    })
    if (!saved) return c.json({ message: 'Unauthenticated.' }, 401)
    return c.json({ data: await account(c) })
  })

  // Sign out everywhere else
  app.delete('/account/sessions', async (c) => {
    await db
      .deleteFrom('sessions')
      .where('user_id', '=', c.var.user.id)
      .where('token_hash', '!=', thisSession(c))
      .execute()
    return c.body(null, 204)
  })

  return app
}
