import type { MailMessage } from '../src'
import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { limitKey } from '../src/forms'
import { hashPassword, hashToken, verifyPassword } from '../src/passwords'
import { db } from './database'
import { setUp, types } from './fixtures'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'

// Managing people (PLAN.md section 5): invites, removal, reset links, Forgot your password?, your account and the
// limits on guessing

const sent: Array<MailMessage> = []
const mail = { from: 'iight <cms@example.com>', send: async (message: MailMessage) => void sent.push(message) }
const app = createApp(db, types, { url: 'https://cms.example.com', mail, mcp: true })
let ada: { id: string; cookie: string }

beforeAll(async () => {
  const { userId, cookie } = await setUp()
  ada = { id: userId, cookie }
  await db
    .updateTable('users')
    .set({ password_hash: await hashPassword('correct horse') })
    .execute()
})
beforeEach(() => void (sent.length = 0))
afterAll(() => db.destroy())

// Someone signed in, with a session of their own
async function person(name: string, email: string, password_hash = 'unused') {
  const id = uuidv7()
  await db.insertInto('users').values({ id, name, email, password_hash }).execute()
  return { id, cookie: await session(id) }
}

async function session(userId: string) {
  const token = `token-${uuidv7()}`
  await db
    .insertInto('sessions')
    .values({ id: uuidv7(), user_id: userId, token_hash: hashToken(token), expires_at: new Date(Date.now() + 60_000) })
    .execute()
  return `iight_session=${token}`
}

// The admin API as someone signed in
const as =
  (who: { cookie: string }, on = app) =>
  async (method: string, path: string, body?: unknown) => {
    const headers = { cookie: who.cookie, origin: 'http://localhost', 'content-type': 'application/json' }
    const response = await on.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }

// A post from someone not signed in, from an address, as the Node server gives it, to the host a request names
const post = (path: string, values: unknown, ip = '198.51.100.1', on = app, host = 'http://localhost') =>
  on.request(
    `${host}/api${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) },
    { incoming: { socket: { remoteAddress: ip } } },
  )

const cookieFrom = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]
const tokenOf = (link: string) => link.split('/').pop()!
const signedIn = async (cookie: string, on = app) => (await on.request('/api/session', { headers: { cookie } })).status

test('an invite is a link shown once, emailed from the site’s address, which joins with a name and password once', async () => {
  // The request's own address says something else, which neither link takes
  const response = await app.request('http://evil.example/api/invites', {
    method: 'POST',
    headers: { cookie: ada.cookie, origin: 'http://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Sam@Example.com' }),
  })
  expect(response.status).toBe(201)
  const { data } = await response.json()
  expect(data).toEqual({
    id: expect.any(String),
    email: 'sam@example.com',
    invitedBy: { id: ada.id, name: 'Ada' },
    createdAt: expect.any(String),
    expiresAt: expect.any(String),
    restores: null,
    link: expect.stringMatching(/^https:\/\/cms\.example\.com\/admin\/#\/invite\/[\w-]{43}$/),
    emailed: true,
  })
  const days = (new Date(data.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  expect(days).toBeCloseTo(7, 1)

  // Only its hash is kept, and only that reply holds the link
  const token = tokenOf(data.link)
  expect(await db.selectFrom('invites').select('token_hash').execute()).toEqual([{ token_hash: hashToken(token) }])
  expect((await as(ada)('GET', '/invites')).body.data).toEqual([{ ...data, link: undefined, emailed: undefined }])

  expect(sent).toEqual([
    {
      from: 'iight <cms@example.com>',
      to: ['sam@example.com'],
      subject: 'Ada invited you to cms.example.com',
      text: `Ada invited you to edit content at cms.example.com. Choose your name and password within 7 days:\n\n${data.link}\n\nIf you weren't expecting this, you can ignore it.\n`,
      html: expect.stringContaining(`<a href="${data.link}">`),
    },
  ])

  // A form that fails its checks leaves the link to use
  const short = await post('/session/invite', { token, name: 'Sam', password: 'short' })
  expect(short.status).toBe(422)

  const joined = await post('/session/invite', { token, name: 'Sam', password: 'correct horse' })
  expect(joined.status).toBe(200)
  expect(await joined.json()).toEqual({ data: { id: expect.any(String), email: 'sam@example.com', name: 'Sam' } })
  expect(await signedIn(cookieFrom(joined))).toBe(200)
  const sam = await db.selectFrom('users').selectAll().where('email', '=', 'sam@example.com').executeTakeFirstOrThrow()
  expect(sam).toMatchObject({ name: 'Sam', invited_by: ada.id, removed_at: null })
  expect(await verifyPassword('correct horse', sam.password_hash)).toBe(true)

  // Used once
  const again = await post('/session/invite', { token, name: 'Someone else', password: 'correct horse' })
  expect(again.status).toBe(404)
  expect(await again.json()).toEqual({ message: 'This invite has expired or been used. Ask for a new one.' })
  expect(await db.selectFrom('invites').select('id').execute()).toEqual([])
})

test('an invite stops working once it expires, once another replaces it, and once it’s deleted', async () => {
  const invite = async (email: string) => (await as(ada)('POST', '/invites', { email })).body.data
  const join = async (link: string) =>
    (await post('/session/invite', { token: tokenOf(link), name: 'Jo', password: 'correct horse' })).status

  const expired = await invite('jo@example.com')
  await db
    .updateTable('invites')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where('id', '=', expired.id)
    .execute()
  expect(await join(expired.link)).toBe(404)

  // The same address gets a new link, and the old one stops working
  const renewed = await invite('jo@example.com')
  expect(renewed.id).toBe(expired.id)
  expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now())
  const replaced = await invite('jo@example.com')
  expect(await join(renewed.link)).toBe(404)

  expect((await as(ada)('DELETE', `/invites/${replaced.id}`)).status).toBe(204)
  expect(await join(replaced.link)).toBe(404)
  expect((await as(ada)('DELETE', `/invites/${replaced.id}`)).status).toBe(404)

  // A made-up link gets the same reply
  expect(await join('https://cms.example.com/admin/#/invite/made-up')).toBe(404)
})

test('an address with an account can’t be invited, and one that gets an account first can’t join', async () => {
  const taken = await as(ada)('POST', '/invites', { email: 'Ada@example.com' })
  expect(taken.status).toBe(422)
  expect(taken.body.fields.email.messages).toEqual(['This email already has an account.'])

  const { link } = (await as(ada)('POST', '/invites', { email: 'kim@example.com' })).body.data
  await person('Kim', 'kim@example.com')
  const joined = await post('/session/invite', { token: tokenOf(link), name: 'Kim', password: 'correct horse' })
  expect(joined.status).toBe(409)
})

test('without the site’s address, links start from the request’s and nothing is emailed', async () => {
  const plain = createApp(db, types, { mail })
  const { status, body } = await as(ada, plain)('POST', '/invites', { email: 'lee@example.com' })
  expect(status).toBe(201)
  expect(body.data.link).toMatch(/^http:\/\/localhost\/admin\/#\/invite\//)
  expect(body.data.emailed).toBe(false)
  expect(sent).toEqual([])
  expect((await as(ada, plain)('GET', '/types')).body.mail).toBe(false)
  expect((await as(ada)('GET', '/types')).body.mail).toBe(true)

  // A send that fails says so, and logs why, never the email with its link
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failing = createApp(db, types, {
    url: 'https://cms.example.com',
    mail: { from: 'x@example.com', send: async () => Promise.reject(new Error('Mail is down')) },
  })
  const failed = await as(ada, failing)('POST', '/invites', { email: 'lee@example.com' })
  expect(failed.body.data.emailed).toBe(false)
  expect(log).toHaveBeenCalledWith("Couldn't send an invite:", 'Mail is down')
  expect(JSON.stringify(log.mock.calls)).not.toContain(tokenOf(failed.body.data.link))
  log.mockRestore()

  // Anything but an address of the web is refused
  expect(() => createApp(db, types, { url: 'cms.example.com' })).toThrow(
    "url in iight.config.ts needs to be the admin's address, such as https://cms.example.com.",
  )
})

test('removing someone keeps their row and name, and ends their sessions, password, link, tokens and invites', async () => {
  const alex = await person('Alex', 'alex@example.com', await hashPassword('correct horse'))
  const second = await session(alex.id)
  const token = await db
    .insertInto('personal_tokens')
    .values({ id: uuidv7(), user_id: alex.id, name: 'Claude Desktop', token_hash: hashToken('iightpat_alex') })
    .returning('id')
    .executeTakeFirstOrThrow()
  await as(ada)('POST', `/users/${alex.id}/reset`)
  await as(alex)('POST', '/invites', { email: 'alex.again@example.com' })
  const key = (await as(alex)('POST', '/keys', { name: 'Website', scopes: [] })).body.data

  const removed = await as(ada)('POST', `/users/${alex.id}/remove`)
  expect(removed.status).toBe(200)
  expect(removed.body.data).toMatchObject({
    id: alex.id,
    name: 'Alex',
    removedAt: expect.any(String),
    removedBy: { id: ada.id, name: 'Ada' },
  })

  expect(await signedIn(alex.cookie)).toBe(401)
  expect(await signedIn(second)).toBe(401)
  const row = await db.selectFrom('users').selectAll().where('id', '=', alex.id).executeTakeFirstOrThrow()
  expect(row.password_hash).toBe('')
  expect(await db.selectFrom('password_resets').where('user_id', '=', alex.id).execute()).toEqual([])
  expect(await db.selectFrom('invites').where('email', '=', 'alex.again@example.com').execute()).toEqual([])
  // Revoked, keeping the row, so versions saved through it keep its name
  const revoked = await db.selectFrom('personal_tokens').selectAll().where('id', '=', token.id).executeTakeFirst()
  expect(revoked?.revoked_at).toEqual(expect.any(Date))
  // Keys keep working, and say who made them
  const keys = (await as(ada)('GET', '/keys')).body.data
  expect(keys.find((found: { id: string }) => found.id === key.id).createdBy).toEqual({ id: alex.id, name: 'Alex' })

  // Sign-in fails as for an unknown email
  const signIn = await post('/session', { email: 'alex@example.com', password: 'correct horse' })
  expect(signIn.status).toBe(422)
  expect((await signIn.json()).fields.email.messages).toEqual(['These credentials do not match our records.'])

  // Listed as removed, latest first, and never among those who can sign in
  const people = (await as(ada)('GET', '/users')).body.data.map((user: { id: string }) => user.id)
  expect(people).not.toContain(alex.id)
  expect((await as(ada)('GET', '/users?removed=true')).body.data[0]).toMatchObject({ id: alex.id })
  expect((await as(ada)('POST', `/users/${alex.id}/remove`)).status).toBe(409)
  expect((await as(ada)('POST', `/users/${alex.id}/reset`)).status).toBe(409)
})

// How many requests wait for a lock this test holds
const waiting = async () =>
  Number((await sql<{ count: string }>`select count(*) from pg_locks where not granted`.execute(db)).rows[0].count)

test('a sign-in, token, invite, key, reset link or account save racing someone’s removal gets nothing', async () => {
  const cy = await person('Cy', 'cy@example.com', await hashPassword('correct horse'))
  const asCy = as(cy)
  const statusOf = async (sent: { status: number } | Promise<{ status: number }>) => (await sent).status
  // Their last use is written once a minute, so this one keeps the requests below from waiting on that rather than
  // on their routes
  await asCy('GET', '/account')

  // A removal holds their row while it runs, and these wait for it, then find them removed
  let racing: Promise<Array<number>> | undefined
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('users').select('id').where('id', '=', cy.id).forUpdate().execute()
    racing = Promise.all([
      statusOf(post('/session', { email: 'cy@example.com', password: 'correct horse' })),
      statusOf(asCy('POST', '/tokens', { name: 'Racing', scopes: [] })),
      statusOf(asCy('POST', '/invites', { email: 'cy.again@example.com' })),
      statusOf(asCy('POST', '/keys', { name: 'Racing', scopes: [] })),
      statusOf(asCy('POST', `/users/${ada.id}/reset`)),
      statusOf(
        asCy('PUT', '/account', {
          name: 'Cy',
          email: 'cy@example.com',
          newPassword: 'a new password',
          password: 'correct horse',
        }),
      ),
    ])
    await vi.waitFor(async () => expect(await waiting()).toBe(6), { timeout: 10_000 })
    await trx
      .updateTable('users')
      .set({ removed_at: new Date(), removed_by: ada.id, password_hash: '' })
      .where('id', '=', cy.id)
      .execute()
    await trx.deleteFrom('sessions').where('user_id', '=', cy.id).execute()
  })

  expect(await racing!).toEqual([422, 401, 401, 401, 401, 401])
  expect(await db.selectFrom('sessions').where('user_id', '=', cy.id).execute()).toEqual([])
  expect(await db.selectFrom('personal_tokens').where('user_id', '=', cy.id).execute()).toEqual([])
  expect(await db.selectFrom('invites').where('invited_by', '=', cy.id).execute()).toEqual([])
  expect(await db.selectFrom('api_keys').where('created_by', '=', cy.id).execute()).toEqual([])
  expect(await db.selectFrom('password_resets').where('made_by', '=', cy.id).execute()).toEqual([])
  // The save that waited never gave them a password again
  const row = await db.selectFrom('users').select('password_hash').where('id', '=', cy.id).executeTakeFirstOrThrow()
  expect(row.password_hash).toBe('')
})

test('an account save under way never undoes a reset that lands first', async () => {
  const gil = await person('Gil', 'gil@example.com', await hashPassword('correct horse'))
  // Their last use is written once a minute, so the save below waits on its own lock rather than on that
  await as(gil)('GET', '/account')

  // A reset link's use holds their row while it sets a new password, ends every session and starts one of its own
  let saving: Promise<{ status: number }> | undefined
  let reset = ''
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('users').select('id').where('id', '=', gil.id).forUpdate().execute()
    saving = as(gil)('PUT', '/account', {
      name: 'Gil',
      email: 'gil@example.com',
      newPassword: 'a new password',
      password: 'correct horse',
    })
    await vi.waitFor(async () => expect(await waiting()).toBe(1), { timeout: 10_000 })
    await trx.updateTable('users').set({ password_hash: 'set by a reset link' }).where('id', '=', gil.id).execute()
    await trx.deleteFrom('sessions').where('user_id', '=', gil.id).execute()
    reset = `token-${uuidv7()}`
    await trx
      .insertInto('sessions')
      .values({
        id: uuidv7(),
        user_id: gil.id,
        token_hash: hashToken(reset),
        expires_at: new Date(Date.now() + 60_000),
      })
      .execute()
  })

  expect((await saving!).status).toBe(401)
  const row = await db.selectFrom('users').select('password_hash').where('id', '=', gil.id).executeTakeFirstOrThrow()
  expect(row.password_hash).toBe('set by a reset link')
  expect(await signedIn(`iight_session=${reset}`)).toBe(200)
})

test('nobody makes a reset link for themselves, so a stolen session can’t change its password', async () => {
  const before = await db.selectFrom('password_resets').where('user_id', '=', ada.id).execute()
  const mine = await as(ada)('POST', `/users/${ada.id}/reset`)
  expect(mine.status).toBe(409)
  expect(mine.body).toEqual({ message: 'Change your own password on your account page.' })
  expect(await db.selectFrom('password_resets').where('user_id', '=', ada.id).execute()).toEqual(before)
})

test('removing someone deletes the reset links they made for colleagues, and no one else’s', async () => {
  const kit = await person('Kit', 'kit@example.com')
  const len = await person('Len', 'len@example.com')
  const mo = await person('Mo', 'mo@example.com')
  const fromKit = (await as(kit)('POST', `/users/${len.id}/reset`)).body.data.link
  const fromAda = (await as(ada)('POST', `/users/${mo.id}/reset`)).body.data.link
  const makers = await db.selectFrom('password_resets').select(['user_id', 'made_by']).orderBy('user_id').execute()
  expect(makers).toEqual(
    expect.arrayContaining([
      { user_id: len.id, made_by: kit.id },
      { user_id: mo.id, made_by: ada.id },
    ]),
  )

  await as(ada)('POST', `/users/${kit.id}/remove`)
  expect((await post('/session/reset', { token: tokenOf(fromKit), password: 'a new password' })).status).toBe(404)
  expect((await post('/session/reset', { token: tokenOf(fromAda), password: 'a new password' })).status).toBe(200)
})

test('nobody removes themselves, and two people removing each other at once leaves one of them', async () => {
  const mine = await as(ada)('POST', `/users/${ada.id}/remove`)
  expect(mine.status).toBe(409)
  expect(mine.body).toEqual({ message: "You can't remove yourself. Ask someone else to." })

  // Both start while the two rows are held, so each has read the other before either can write
  const bo = await person('Bo', 'bo@example.com')
  const di = await person('Di', 'di@example.com')
  let removals: Promise<Array<{ status: number }>> | undefined
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('users').select('id').where('id', 'in', [bo.id, di.id]).forUpdate().execute()
    removals = Promise.all([as(bo)('POST', `/users/${di.id}/remove`), as(di)('POST', `/users/${bo.id}/remove`)])
    await vi.waitFor(async () => expect(await waiting()).toBe(2), { timeout: 5000 })
  })
  const outcomes = await removals!
  expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 401])
  const left = await db
    .selectFrom('users')
    .select('id')
    .where('id', 'in', [bo.id, di.id])
    .where('removed_at', 'is', null)
    .execute()
  expect(left).toHaveLength(1)
})

test('inviting a removed person’s address brings back their account, history and all', async () => {
  const eve = await person('Eve', 'eve@example.com')
  const entry = uuidv7()
  await db
    .insertInto('entries')
    .values({ id: entry, type: 'blog', values: {}, slug: 'eve', created_by: eve.id })
    .execute()
  await db.insertInto('entry_versions').values({ entry_id: entry, number: 1, values: {}, created_by: eve.id }).execute()
  await as(ada)('POST', `/users/${eve.id}/remove`)
  // History keeps their name while they're removed
  const versions = (await as(ada)('GET', `/entries/${entry}/versions`)).body.data
  expect(versions[0].createdBy).toEqual({ id: eve.id, name: 'Eve' })

  const { data } = (await as(ada)('POST', '/invites', { email: 'eve@example.com' })).body
  expect(data.restores).toEqual({ id: eve.id, name: 'Eve', removedAt: expect.any(String) })
  expect(
    (await as(ada)('GET', '/invites')).body.data.find((found: { id: string }) => found.id === data.id).restores,
  ).toEqual(data.restores)

  const joined = await post('/session/invite', { token: tokenOf(data.link), name: 'Eve Ng', password: 'correct horse' })
  expect(joined.status).toBe(200)
  expect((await joined.json()).data).toEqual({ id: eve.id, email: 'eve@example.com', name: 'Eve Ng' })
  const back = (await as(ada)('GET', `/users/${eve.id}`)).body.data
  expect(back).toMatchObject({ removedAt: null, removedBy: null, invitedBy: { id: ada.id, name: 'Ada' } })
})

test('a colleague’s reset link works once, for an hour, ending every session of theirs and signing them in', async () => {
  const fay = await person('Fay', 'fay@example.com')
  const other = await session(fay.id)

  const made = await as(ada)('POST', `/users/${fay.id}/reset`)
  expect(made.status).toBe(201)
  expect(made.body.data).toEqual({
    link: expect.stringMatching(/^https:\/\/cms\.example\.com\/admin\/#\/reset\/[\w-]{43}$/),
    expiresAt: expect.any(String),
  })
  const minutes = (new Date(made.body.data.expiresAt).getTime() - Date.now()) / 60_000
  expect(minutes).toBeCloseTo(60, 0)
  const token = tokenOf(made.body.data.link)
  expect(await db.selectFrom('password_resets').select('token_hash').where('user_id', '=', fay.id).execute()).toEqual([
    { token_hash: hashToken(token) },
  ])

  const short = await post('/session/reset', { token, password: 'short' })
  expect(short.status).toBe(422)

  const reset = await post('/session/reset', { token, password: 'a new password' })
  expect(reset.status).toBe(200)
  expect(await reset.json()).toEqual({ data: { id: fay.id, email: 'fay@example.com', name: 'Fay' } })
  expect(await signedIn(fay.cookie)).toBe(401)
  expect(await signedIn(other)).toBe(401)
  expect(await signedIn(cookieFrom(reset))).toBe(200)
  expect((await post('/session', { email: 'fay@example.com', password: 'a new password' })).status).toBe(200)

  // Used once, and an expired one is refused too
  const again = await post('/session/reset', { token, password: 'another password' })
  expect(again.status).toBe(404)
  expect(await again.json()).toEqual({ message: 'This link has expired or been used. Ask for a new one.' })
  const expired = tokenOf((await as(ada)('POST', `/users/${fay.id}/reset`)).body.data.link)
  await db
    .updateTable('password_resets')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .execute()
  expect((await post('/session/reset', { token: expired, password: 'another password' })).status).toBe(404)
})

test('Forgot your password? replies the same for every address, and emails a link from the site’s address', async () => {
  const gus = await person('Gus', 'gus@example.com')
  // The request's own address says something else, which the link doesn't take
  const ask = (email: string, ip = '198.51.100.2') => post('/session/forgot', { email }, ip, app, 'http://evil.example')

  const known = await ask('Gus@Example.com')
  const unknown = await ask('nobody@example.com')
  for (const response of [known, unknown]) {
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      message:
        "If that email has an account here, we've sent it a link to choose a new password. It works for an hour.",
    })
  }

  await vi.waitFor(() => expect(sent).toHaveLength(1))
  const [email] = sent
  expect(email).toMatchObject({ to: ['gus@example.com'], subject: 'Reset your password for cms.example.com' })
  const link = email.text.match(/https:\/\/cms\.example\.com\/admin\/#\/reset\/[\w-]{43}/)?.[0]
  expect(link).toBeDefined()
  expect(email.text).not.toContain('evil.example')
  // Nobody made it, so no one's removal deletes it
  const emailed = await db.selectFrom('password_resets').select('made_by').where('user_id', '=', gus.id).execute()
  expect(emailed).toEqual([{ made_by: null }])

  // One email a minute, however many ask, and the link sent still works
  await ask('gus@example.com', '198.51.100.3')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(sent).toHaveLength(1)
  const reset = await post('/session/reset', { token: tokenOf(link!), password: 'a new password' })
  expect(reset.status).toBe(200)
  expect(await signedIn(gus.cookie)).toBe(401)

  // Someone removed gets nothing
  const hal = await person('Hal', 'hal@example.com')
  await as(ada)('POST', `/users/${hal.id}/remove`)
  await ask('hal@example.com')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(sent).toHaveLength(1)
})

test('Forgot your password? replies before looking anything up or sending, and only where the site sends email', async () => {
  await person('Ivy', 'ivy@example.com')
  let sends = 0
  // A send that never finishes, which the reply mustn't wait for
  const stuck = createApp(db, types, {
    url: 'https://cms.example.com',
    mail: { from: 'x@example.com', send: () => (sends++, new Promise(() => {})) },
  })
  const started = performance.now()
  const response = await post('/session/forgot', { email: 'ivy@example.com' }, '198.51.100.4', stuck)
  expect(response.status).toBe(202)
  expect(performance.now() - started).toBeLessThan(1000)
  await vi.waitFor(() => expect(sends).toBe(1))

  const plain = createApp(db, types)
  const off = await post('/session/forgot', { email: 'ivy@example.com' }, '198.51.100.4', plain)
  expect(off.status).toBe(404)
  expect(await off.json()).toEqual({ message: "This site doesn't send email." })

  const invalid = await post('/session/forgot', { email: 'not an email' })
  expect(invalid.status).toBe(422)
})

test('your account changes your name freely, and your email and password with your current password', async () => {
  const jay = await person('Jay', 'jay@example.com', await hashPassword('correct horse'))
  const other = await session(jay.id)
  const account = as(jay)

  expect((await account('GET', '/account')).body.data).toEqual({
    id: jay.id,
    name: 'Jay',
    email: 'jay@example.com',
    createdAt: expect.any(String),
    otherSessions: 1,
  })

  const renamed = await account('PUT', '/account', { name: 'Jay Ross', email: 'jay@example.com' })
  expect(renamed.status).toBe(200)
  expect(renamed.body.data.name).toBe('Jay Ross')

  // A new email needs your current password, which has to be right
  const without = await account('PUT', '/account', { name: 'Jay Ross', email: 'jr@example.com' })
  expect(without.status).toBe(422)
  expect(without.body.fields.password.messages).toEqual(['This field is required.'])
  const wrong = await account('PUT', '/account', { name: 'Jay Ross', email: 'jr@example.com', password: 'wrong' })
  expect(wrong.status).toBe(422)
  expect(wrong.body.fields.password.messages).toEqual(["That isn't your current password."])
  const taken = await account('PUT', '/account', { name: 'Jay', email: 'ada@example.com', password: 'correct horse' })
  expect(taken.body.fields.email.messages).toEqual(['This email already has an account.'])

  // A reset link waiting went to the old address, so a new email ends it
  await as(ada)('POST', `/users/${jay.id}/reset`)
  const moved = await account('PUT', '/account', {
    name: 'Jay Ross',
    email: 'JR@example.com',
    password: 'correct horse',
  })
  expect(moved.status).toBe(200)
  expect(moved.body.data.email).toBe('jr@example.com')
  expect(await db.selectFrom('password_resets').where('user_id', '=', jay.id).execute()).toEqual([])
  expect(await signedIn(other)).toBe(200)

  // A new password ends every other session, and keeps this one
  const changed = await account('PUT', '/account', {
    name: 'Jay Ross',
    email: 'jr@example.com',
    newPassword: 'a new password',
    password: 'correct horse',
  })
  expect(changed.status).toBe(200)
  expect(changed.body.data.otherSessions).toBe(0)
  expect(await signedIn(other)).toBe(401)
  expect(await signedIn(jay.cookie)).toBe(200)
  expect((await post('/session', { email: 'jr@example.com', password: 'a new password' })).status).toBe(200)

  // Sign out everywhere else
  const third = await session(jay.id)
  expect((await account('DELETE', '/account/sessions')).status).toBe(204)
  expect(await signedIn(third)).toBe(401)
  expect(await signedIn(jay.cookie)).toBe(200)
})

test('sign-in counts failures for each email from each address, before hashing, and a success clears them', async () => {
  const limited = createApp(db, types)
  const kai = await person('Kai', 'kai@example.com', await hashPassword('correct horse'))
  const guess = (email: string, password: string, ip: string) => post('/session', { email, password }, ip, limited)

  for (let tries = 0; tries < 9; tries++)
    expect((await guess('kai@example.com', 'wrong', '203.0.113.5')).status).toBe(422)
  // A success clears the count
  expect((await guess('Kai@example.com', 'correct horse', '203.0.113.5')).status).toBe(200)
  for (let tries = 0; tries < 10; tries++)
    expect((await guess('kai@example.com', 'wrong', '203.0.113.5')).status).toBe(422)

  const refused = await guess('kai@example.com', 'correct horse', '203.0.113.5')
  expect(refused.status).toBe(429)
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(500)
  expect(await refused.json()).toEqual({ message: 'Too many failed sign-ins. Wait a few minutes, then try again.' })

  // Another address, or another email from the same one, isn't held up
  expect((await guess('kai@example.com', 'correct horse', '203.0.113.6')).status).toBe(200)
  expect((await guess('ada@example.com', 'correct horse', '203.0.113.5')).status).toBe(200)
  expect(await signedIn(kai.cookie, limited)).toBe(200)

  // An IPv6 address counts by its /64
  for (let tries = 0; tries < 10; tries++) {
    expect((await guess('kai@example.com', 'wrong', `2001:db8:0:7::${tries + 1}`)).status).toBe(422)
  }
  expect((await guess('kai@example.com', 'correct horse', '2001:db8:0:7:ffff::1')).status).toBe(429)
  expect((await guess('kai@example.com', 'correct horse', '2001:db8:0:8::1')).status).toBe(200)
}, 30_000)

test('your current password counts against sign-in’s limit, and so do asks for a reset link', async () => {
  const limited = createApp(db, types, { url: 'https://cms.example.com', mail })
  const lou = await person('Lou', 'lou@example.com', await hashPassword('correct horse'))
  const account = as(lou, limited)
  for (let tries = 0; tries < 10; tries++) {
    expect((await account('PUT', '/account', { name: 'Lou', email: 'x@example.com', password: 'wrong' })).status).toBe(
      422,
    )
  }
  const refused = await account('PUT', '/account', { name: 'Lou', email: 'x@example.com', password: 'correct horse' })
  expect(refused.status).toBe(429)
  expect(refused.body).toEqual({ message: 'Too many wrong passwords. Wait a few minutes, then try again.' })

  for (let tries = 0; tries < 10; tries++) {
    expect((await post('/session/forgot', { email: 'lou@example.com' }, '203.0.113.9', limited)).status).toBe(202)
  }
  const asked = await post('/session/forgot', { email: 'lou@example.com' }, '203.0.113.9', limited)
  expect(asked.status).toBe(429)
  expect(asked.headers.get('retry-after')).toBeTruthy()
}, 30_000)

test('guesses sent at once are counted before any is checked, at sign-in and for your current password', async () => {
  const limited = createApp(db, types)
  const ivo = await person('Ivo', 'ivo@example.com', await hashPassword('correct horse'))
  // In the order they come back: those refused come back before any hash is done
  const inOrder = async (sends: Array<() => Promise<number>>) => {
    const order: Array<number> = []
    await Promise.all(sends.map((send) => send().then((status) => void order.push(status))))
    return order
  }

  const guesses = await inOrder(
    Array.from(
      { length: 15 },
      () => async () =>
        (await post('/session', { email: 'ivo@example.com', password: 'wrong' }, '203.0.113.20', limited)).status,
    ),
  )
  expect(guesses).toEqual([...Array(5).fill(429), ...Array(10).fill(422)])

  const account = as(ivo, limited)
  const wrong = await inOrder(
    Array.from(
      { length: 15 },
      () => async () =>
        (await account('PUT', '/account', { name: 'Ivo', email: 'ivo.new@example.com', password: 'wrong' })).status,
    ),
  )
  expect(wrong).toEqual([...Array(5).fill(429), ...Array(10).fill(422)])
}, 60_000)

test('an IPv4 address written as IPv6 counts as itself, from a socket or through proxies', async () => {
  expect(limitKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
  expect(limitKey('::FFFF:c633:6407')).toBe('198.51.100.7')
  expect(limitKey('::ffff:c633:6408')).toBe('198.51.100.8')
  expect(limitKey('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64')

  // Two visitors through the same pair of proxies, the inner one written as IPv6, each with a limit of their own
  const limited = createApp(db, types)
  const through = (visitor: string) =>
    limited.request(
      '/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `${visitor}, ::ffff:10.0.0.2` },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
      },
      { incoming: { socket: { remoteAddress: '::ffff:10.0.0.1' } } },
    )
  for (let tries = 0; tries < 10; tries++) expect((await through('::ffff:198.51.100.7')).status).toBe(422)
  expect((await through('198.51.100.7')).status).toBe(429)
  expect((await through('::ffff:198.51.100.8')).status).toBe(422)
}, 30_000)

test('sign-in counts the visitor a proxy iight.config.ts lists forwards for', async () => {
  const behind = createApp(db, types, { proxies: ['198.51.100.0/24'] })
  const guess = (visitor: string) =>
    behind.request(
      '/api/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': visitor },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
      },
      { incoming: { socket: { remoteAddress: '198.51.100.7' } } },
    )
  for (let tries = 0; tries < 10; tries++) expect((await guess('192.0.2.1')).status).toBe(422)
  expect((await guess('192.0.2.1')).status).toBe(429)
  expect((await guess('192.0.2.2')).status).toBe(422)
}, 30_000)

test('Forgot your password? takes 20 asks a minute from an address, whatever the emails', async () => {
  const limited = createApp(db, types, { url: 'https://cms.example.com', mail })
  for (let asks = 0; asks < 20; asks++) {
    expect(
      (await post('/session/forgot', { email: `nobody${asks}@example.com` }, '203.0.113.30', limited)).status,
    ).toBe(202)
  }
  const refused = await post('/session/forgot', { email: 'nobody-else@example.com' }, '203.0.113.30', limited)
  expect(refused.status).toBe(429)
  expect(refused.headers.get('retry-after')).toBeTruthy()
  expect((await post('/session/forgot', { email: 'nobody-else@example.com' }, '203.0.113.31', limited)).status).toBe(
    202,
  )
})

test('Forgot your password? holds at most 50 links waiting to be emailed, then asks for a minute', async () => {
  // People whose emails never finish sending, so each link waits until the send gives up after 10 seconds
  const waitingPeople = Array.from({ length: 51 }, (_, index) => ({
    id: uuidv7(),
    name: `Waiting ${index}`,
    email: `waiting${index}@example.com`,
    password_hash: 'unused',
  }))
  await db.insertInto('users').values(waitingPeople).execute()
  let sending = 0
  const stuck = createApp(db, types, {
    url: 'https://cms.example.com',
    mail: { from: 'x@example.com', send: () => (sending++, new Promise(() => {})) },
  })

  const asks = waitingPeople
    .slice(0, 50)
    .map((person, index) => post('/session/forgot', { email: person.email }, `203.0.113.${100 + index}`, stuck))
  expect((await Promise.all(asks)).map((response) => response.status)).toEqual(Array(50).fill(202))
  const over = await post('/session/forgot', { email: waitingPeople[50].email }, '198.51.100.200', stuck)
  expect(over.status).toBe(429)
  expect(over.headers.get('retry-after')).toBe('60')
  expect(await over.json()).toEqual({ message: 'Too many requests right now. Wait a minute, then try again.' })
  await vi.waitFor(() => expect(sending).toBe(50))
})
