import { createApp } from '../src/app'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { verifyPassword } from '../src/passwords'
import { firstAccount } from '../src/users'
import { db, resetDb } from './database'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'

// The first account, made in the admin while nobody has one, with the code the server printed as it started

const setup = { code: 'K7QX-M2PD-9VHT-4CWA', show: vi.fn() }
const app = createApp(db, undefined, { firstAccount: setup })

beforeEach(async () => {
  await resetDb()
  await migrate(db, await loadMigrations(migrationsDir))
  setup.show.mockClear()
})
afterAll(() => db.destroy())

const make = (values: object, to = app) =>
  to.request('/api/session/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  })
const isOpen = async (to = app) => (await (await to.request('/api/session/setup')).json()).data.open
const ada = { name: 'Ada', email: 'Ada@Example.com', password: 'correct horse' }
const closed = { message: 'Someone has made the first account already, so sign in.' }

test('makes the first account with the code, signing its person in, and then never again', async () => {
  expect(await isOpen()).toBe(true)
  // In case the server started with people and has none now, so it hasn't printed its code yet
  expect(setup.show).toHaveBeenCalledOnce()

  // In any case, with or without its dashes
  const made = await make({ ...ada, code: 'k7qx m2pd9vht-4cwa' })
  expect(made.status).toBe(200)
  expect(await made.json()).toEqual({ data: { id: expect.any(String), email: 'ada@example.com', name: 'Ada' } })
  const cookie = made.headers.get('set-cookie')!.split(';')[0]
  expect((await app.request('/api/session', { headers: { cookie } })).status).toBe(200)
  const [row] = await db.selectFrom('users').selectAll().execute()
  expect(await verifyPassword('correct horse', row.password_hash)).toBe(true)

  expect(await isOpen()).toBe(false)
  const again = await make({ ...ada, email: 'sam@example.com', code: setup.code })
  expect(again.status).toBe(409)
  expect(await again.json()).toEqual(closed)

  // Removed people keep their rows, so it stays closed once everyone is removed
  await db.updateTable('users').set({ removed_at: new Date(), password_hash: '' }).execute()
  expect(await isOpen()).toBe(false)
})

test('refuses a wrong or missing code, and checks the other fields with it', async () => {
  const wrong = await make({ ...ada, password: 'short', code: 'AAAA-AAAA-AAAA-AAAA' })
  expect(wrong.status).toBe(422)
  const { fields } = await wrong.json()
  expect(fields.code).toEqual({
    isValid: false,
    messages: ["This isn't the code the server printed. It changes each time the server starts, so take the newest."],
  })
  expect(fields.password).toEqual({ isValid: false, messages: ['This field requires a minimum of 8 character(s).'] })

  const missing = await make(ada)
  expect(missing.status).toBe(422)
  expect((await missing.json()).fields.code).toEqual({ isValid: false, messages: ['This field is required.'] })
  expect(await db.selectFrom('users').selectAll().execute()).toEqual([])
})

test('two at once make one account', async () => {
  const replies = await Promise.all([
    make({ ...ada, code: setup.code }),
    make({ name: 'Sam', email: 'sam@example.com', password: 'correct horse', code: setup.code }),
  ])
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409])
  expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(1)
})

test('without a code, as an app made without one, only sorlo make:user makes the first', async () => {
  const plain = createApp(db)
  expect(await isOpen(plain)).toBe(false)
  const refused = await make({ ...ada, code: setup.code }, plain)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual(closed)
})

test('a code is 80 random bits, and its link prints once, at the address the admin is at', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const local = firstAccount('http://localhost:4100/admin/')
    expect(local.code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
    expect(firstAccount('http://localhost:4100/admin/').code).not.toBe(local.code)
    local.show()
    local.show()
    expect(log.mock.calls).toEqual([
      [`No one has an account yet. Make the first at http://localhost:4100/admin/#/setup/${local.code}`],
    ])

    // sorlo start without url in sorlo.config.ts
    const anywhere = firstAccount('/admin/')
    anywhere.show()
    expect(log).toHaveBeenLastCalledWith(
      `No one has an account yet. Make the first on this server's address at /admin/#/setup/${anywhere.code}`,
    )
  } finally {
    log.mockRestore()
  }
})
