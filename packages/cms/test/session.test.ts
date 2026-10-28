import { createApp } from '../src/app'
import { createDb, uuidv7 } from '../src/db'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { hashPassword } from '../src/passwords'
import { db, resetDb } from './database'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const app = createApp(db)

beforeAll(async () => {
  await resetDb()
  await migrate(db, await loadMigrations(migrationsDir))
  await db
    .insertInto('users')
    .values({ id: uuidv7(), name: 'Ada', email: 'ada@example.com', password_hash: await hashPassword('correct horse') })
    .execute()
})

afterAll(() => db.destroy())

const signIn = (values: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(values),
  })

const cookieFrom = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]

test('replies with core’s report when fields are missing', async () => {
  const response = await signIn({})

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    isValid: false,
    fields: {
      email: { isValid: false, messages: ['This field is required.'] },
      password: { isValid: false, messages: ['This field is required.'] },
    },
  })
})

test('rejects wrong credentials without saying which part was wrong', async () => {
  for (const values of [
    { email: 'ada@example.com', password: 'wrong' },
    { email: 'nobody@example.com', password: 'correct horse' },
  ]) {
    const response = await signIn(values)

    expect(response.status).toBe(422)
    expect((await response.json()).fields.email).toEqual({
      isValid: false,
      messages: ['These credentials do not match our records.'],
    })
    expect(response.headers.get('set-cookie')).toBeNull()
  }
})

test('signs in with a session cookie, then signs out', async () => {
  const response = await signIn({ email: 'Ada@Example.com', password: 'correct horse' })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: { id: expect.any(String), email: 'ada@example.com', name: 'Ada' } })
  expect(response.headers.get('set-cookie')).toMatch(
    /^iight_session=[\w-]{43}; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/,
  )

  // Only a hash of the token is stored
  const cookie = cookieFrom(response)
  const token = cookie.split('=')[1]
  expect(await db.selectFrom('sessions').where('token_hash', '=', token).executeTakeFirst()).toBeUndefined()

  const current = await app.request('/api/session', { headers: { cookie } })
  expect((await current.json()).data.email).toBe('ada@example.com')

  // Browsers send an Origin header with a DELETE
  const signOut = await app.request('/api/session', {
    method: 'DELETE',
    headers: { cookie, origin: 'http://localhost' },
  })
  expect(signOut.status).toBe(204)
  expect((await app.request('/api/session', { headers: { cookie } })).status).toBe(401)
})

test('marks the cookie Secure behind HTTPS', async () => {
  const response = await signIn(
    { email: 'ada@example.com', password: 'correct horse' },
    { 'x-forwarded-proto': 'https' },
  )
  expect(response.headers.get('set-cookie')).toContain('; Secure')
})

test('ignores expired sessions', async () => {
  const cookie = cookieFrom(await signIn({ email: 'ada@example.com', password: 'correct horse' }))
  await db
    .updateTable('sessions')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .execute()

  expect((await app.request('/api/session', { headers: { cookie } })).status).toBe(401)
})

test('refuses form posts from other sites', async () => {
  const response = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://example.org' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }),
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ message: 'Forbidden' })
})

test('replies { message } to unknown routes and server errors', async () => {
  const notFound = await app.request('/api/nope')
  expect(notFound.status).toBe(404)
  expect(await notFound.json()).toEqual({ message: 'Not Found' })

  // Nothing listens on port 1, so the session lookup throws
  const unreachable = createDb('postgres://iight:iight@127.0.0.1:1/iight')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = await createApp(unreachable).request('/api/session', { headers: { cookie: 'iight_session=x' } })

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ message: 'Server Error' })
  expect(log).toHaveBeenCalled()

  log.mockRestore()
  await unreachable.destroy()
})
