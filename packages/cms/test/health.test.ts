import { createApp } from '../src/app'
import { createDb } from '../src/db'
import { db, url } from './database'
import { sql } from 'kysely'
import { afterAll, expect, test, vi } from 'vitest'

// A database nothing answers for
const unreachable = createDb('postgres://sorlo:sorlo@127.0.0.1:1/sorlo')

afterAll(async () => {
  await db.destroy()
  await unreachable.destroy()
})

test("answers a host's health checks with no key or session, while the database answers", async () => {
  const up = await createApp(db).request('/health')
  expect(up.status).toBe(200)
  expect(await up.json()).toEqual({ status: 'ok' })

  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const down = await createApp(unreachable).request('/health')
  expect(errors).toHaveBeenCalledWith("The health check couldn't reach the database:", expect.any(Error))
  errors.mockRestore()
  expect(down.status).toBe(503)
  expect(await down.json()).toEqual({ message: "The database can't be reached." })
})

test('logs each request as the servers do, but not the health checks', async () => {
  const lines: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))
  const app = createApp(db, new Map(), { log: true })
  await app.request('/health')
  await app.request('/nowhere?page=2')
  // Without log, as in the tests, nothing
  await createApp(db).request('/nowhere')
  log.mockRestore()

  expect(lines).toEqual([
    '<-- GET /nowhere?page=2',
    expect.stringMatching(/^--> GET \/nowhere\?page=2 \S*404\S* \d+ms$/),
  ])
})

const ended = 'A database connection ended: terminating connection due to administrator command'

test('a connection Postgres ends, as it does when it restarts, is dropped, and the next query opens another', async () => {
  const server = createDb(url)
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(server)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  // How Postgres ends its connections as it shuts down, here for the one the pool keeps idle
  await sql`select pg_terminate_backend(${rows[0].pid})`.execute(db)
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(ended))
  expect(errors).toHaveBeenCalledTimes(1)
  errors.mockRestore()

  const health = await createApp(server).request('/health')
  expect(health.status).toBe(200)
  await server.destroy()
})

test('a connection Postgres ends while a transaction holds it fails the transaction, not the process', async () => {
  const server = createDb(url)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const transaction = server.transaction().execute(async (trx) => {
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)
    // As when Postgres restarts while the worker waits for a webhook inside its transaction
    await sql`select pg_terminate_backend(${rows[0].pid})`.execute(db)
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(ended))
    await sql`select 1`.execute(trx)
  })
  await expect(transaction).rejects.toThrow()
  expect(errors).toHaveBeenCalledTimes(1)
  errors.mockRestore()

  const health = await createApp(server).request('/health')
  expect(health.status).toBe(200)
  await server.destroy()
})
