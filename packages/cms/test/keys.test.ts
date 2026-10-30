import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { db, url } from './database'
import { contactFields, setUp, types } from './fixtures'
import { sql } from 'kysely'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

// API keys on the admin's API keys page, and what each scope lets a key do (PLAN.md section 16)

const app = createApp(db, types)
let cookie: string
let userId: string

beforeAll(async () => {
  ;({ cookie, userId } = await setUp())
})

afterAll(() => db.destroy())

const admin = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { ...headers, origin: 'http://localhost', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

// The status a request with a key gets
const use = async (path: string, token: string, init: RequestInit = {}) =>
  (await app.request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })).status

const lastUsed = async (name: string) =>
  (await db.selectFrom('api_keys').select('last_used_at').where('name', '=', name).executeTakeFirstOrThrow())
    .last_used_at

test('anyone signed in lists, makes, edits and revokes keys, and only the reply that makes one holds its token', async () => {
  for (const [method, path] of [
    ['GET', '/keys'],
    ['POST', '/keys'],
    ['PUT', `/keys/${uuidv7()}`],
    ['DELETE', `/keys/${uuidv7()}`],
  ]) {
    const body = method === 'GET' ? undefined : {}
    expect(await admin(method, path, body, {})).toEqual({ status: 401, body: { message: 'Unauthenticated.' } })
  }

  const fromCli = await createApiKey(db, 'Command line')
  const made = await admin('POST', '/keys', { name: 'Website', scopes: ['submit', 'preview', 'submit'] })
  expect(made).toEqual({
    status: 201,
    body: {
      data: {
        id: expect.any(String),
        name: 'Website',
        // In the checkbox's order, each once
        scopes: ['preview', 'submit'],
        createdAt: expect.any(String),
        createdBy: { id: userId, name: 'Ada' },
        lastUsedAt: null,
        token: expect.stringMatching(/^iight_[\w-]{43}$/),
      },
    },
  })
  const { id, token } = made.body.data
  expect(await use('/v1/entries/blog?status=draft', token)).toBe(200)

  // Keys from the CLI have no user, and no reply but the one above holds a token or its hash
  const listed = await admin('GET', '/keys')
  expect(listed.body.data).toEqual([
    {
      id: expect.any(String),
      name: 'Command line',
      scopes: [],
      createdAt: expect.any(String),
      createdBy: null,
      lastUsedAt: null,
    },
    { ...made.body.data, token: undefined, lastUsedAt: expect.any(String) },
  ])
  expect(JSON.stringify(listed.body)).not.toMatch(/token|iight_/)

  // Editing changes what the key can do, and keeps the key itself
  const edited = await admin('PUT', `/keys/${id}`, { name: 'Site', scopes: ['types'] })
  expect(edited.body).toEqual({ data: { ...listed.body.data[1], name: 'Site', scopes: ['types'] } })
  expect(await use('/v1/entries/blog?status=draft', token)).toBe(403)
  expect(await use('/types', token)).toBe(200)

  for (const body of [{}, { name: '' }, { name: 'Site', scopes: ['admin'] }, { name: 'Site', scopes: 5 }]) {
    expect((await admin('POST', '/keys', body)).status).toBe(422)
    expect((await admin('PUT', `/keys/${id}`, body)).status).toBe(422)
  }
  expect((await admin('PUT', '/keys/nope', { name: 'Site' })).status).toBe(404)
  expect((await admin('PUT', `/keys/${uuidv7()}`, { name: 'Site' })).status).toBe(404)

  // Revoked, it's refused at once, everywhere
  expect(await admin('DELETE', `/keys/${id}`)).toEqual({ status: 204, body: null })
  expect(await use('/v1/entries/blog', token)).toBe(401)
  expect(await use('/types', token)).toBe(401)
  expect((await admin('DELETE', `/keys/${id}`)).status).toBe(404)
  expect((await admin('GET', '/keys')).body.data.map((key: any) => key.name)).toEqual(['Command line'])
  expect(await use('/v1/entries/blog', fromCli)).toBe(200)

  // A key outlives the user who made it
  const grace = uuidv7()
  await db
    .insertInto('users')
    .values({ id: grace, name: 'Grace', email: 'grace@example.com', password_hash: 'x' })
    .execute()
  await db
    .insertInto('api_keys')
    .values({ id: uuidv7(), name: 'Old site', token_hash: 'x', created_by: grace })
    .execute()
  await db.deleteFrom('users').where('id', '=', grace).execute()
  expect((await admin('GET', '/keys')).body.data.find((key: any) => key.name === 'Old site').createdBy).toBeNull()
})

test("a key is marked as used by each request it's sent with, at most once a minute", async () => {
  await admin('POST', '/forms', { label: 'Contact us', name: 'contact', fields: contactFields })
  const deliveryKey = await createApiKey(db, 'Delivery')
  const typesKey = await createApiKey(db, 'Types')
  const formsKey = await createApiKey(db, 'Forms')
  expect(await lastUsed('Delivery')).toBeNull()

  // Refused requests count too, since the key was sent and found
  expect(await use('/v1/entries/blog', deliveryKey)).toBe(200)
  expect(await use('/types', typesKey)).toBe(403)
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
  expect(await use('/v1/forms/contact', formsKey, post)).toBe(422)
  for (const name of ['Delivery', 'Types', 'Forms']) expect(await lastUsed(name)).toBeInstanceOf(Date)

  // Sets the key's last use to a number of seconds before the database's time
  const usedAgo = async (seconds: number) =>
    (
      await db
        .updateTable('api_keys')
        .set({ last_used_at: sql`now() - ${`${seconds} seconds`}::interval` })
        .where('name', '=', 'Delivery')
        .returning('last_used_at')
        .executeTakeFirstOrThrow()
    ).last_used_at

  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    // Within the minute, this process doesn't write it again, though the database would take it
    const old = await usedAgo(120)
    expect(await use('/v1/media', deliveryKey)).toBe(200)
    expect(await lastUsed('Delivery')).toEqual(old)

    // After the minute, nor does it while another process has written it in the last one
    vi.advanceTimersByTime(60_000)
    const recent = await usedAgo(30)
    expect(await use('/v1/entries/blog', deliveryKey)).toBe(200)
    expect(await lastUsed('Delivery')).toEqual(recent)

    // Once both are a minute old, it is
    vi.advanceTimersByTime(60_000)
    const older = await usedAgo(60)
    expect(await use('/v1/entries/blog', deliveryKey)).toBe(200)
    expect((await lastUsed('Delivery'))!.getTime()).toBeGreaterThan(older!.getTime())
  } finally {
    vi.useRealTimers()
  }
})

test('iight make:api-key --types --submit makes a key that pulls types and skips the forms rate limit', async () => {
  // A site project with just enough config for the command
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'iight.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  const bin = fileURLToPath(new URL('../bin/iight.js', import.meta.url))

  try {
    const running = promisify(execFile)(process.execPath, [bin, 'make:api-key', '--submit', '--types'], { cwd: dir })
    running.child.stdin!.end('Server\n')
    const { stdout } = await running
    expect(stdout).toContain("Created the key Server. Copy it now, since it can't be shown again:")
    expect(await use('/types', stdout.trim().split('\n').at(-1)!)).toBe(200)
    expect(
      await db.selectFrom('api_keys').select(['scopes', 'created_by']).where('name', '=', 'Server').execute(),
    ).toEqual([{ scopes: ['types', 'submit'], created_by: null }])
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)
