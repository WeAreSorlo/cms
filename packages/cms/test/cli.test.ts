import { hashToken, verifyPassword } from '../src/passwords'
import { db, url } from './database'
import { setUp } from './fixtures'
import { ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { AddressInfo, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, expect, test } from 'vitest'

// The iight CLI, run from a site project as a site runs it

const bin = fileURLToPath(new URL('../bin/iight.js', import.meta.url))

afterAll(() => db.destroy())

// A site project on the test database, which a command runs in, given what's typed into it, or with typed as a
// function, once it first asks something
async function inSite(args: Array<string>, typed: string | (() => Promise<string>) = '') {
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'iight.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  try {
    const run = promisify(execFile)(process.execPath, [bin, ...args], { cwd: dir })
    if (typeof typed === 'string') run.child.stdin?.end(typed)
    else run.child.stdout?.once('data', async () => run.child.stdin?.end(await typed()))
    return await run
  } finally {
    await rm(dir, { recursive: true })
  }
}

test('user:password sets a new password, signing them out everywhere, and refuses someone removed', async () => {
  const { userId } = await setUp()
  await db
    .insertInto('password_resets')
    .values({ user_id: userId, token_hash: hashToken('link'), expires_at: new Date(Date.now() + 60_000) })
    .execute()

  const { stdout } = await inSite(['user:password', 'Ada@Example.com'], 'a new password\n')
  expect(stdout).toBe('New password: \nSet a new password for ada@example.com, and signed them out everywhere.\n')
  const ada = await db.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow()
  expect(await verifyPassword('a new password', ada.password_hash)).toBe(true)
  expect(await db.selectFrom('sessions').where('user_id', '=', userId).execute()).toEqual([])
  expect(await db.selectFrom('password_resets').where('user_id', '=', userId).execute()).toEqual([])

  // A password too short is refused, as make:user refuses one
  await expect(inSite(['user:password', 'ada@example.com'], 'short\n')).rejects.toMatchObject({
    code: 1,
    stderr: 'New password: This field requires a minimum of 8 character(s).\n',
  })
  await expect(inSite(['user:password', 'nobody@example.com'])).rejects.toMatchObject({
    code: 1,
    stderr: 'nobody@example.com has no account.\n',
  })

  // Removed while it asks, it changes nothing, leaving their password blank
  const removing = async () => {
    await db.updateTable('users').set({ removed_at: new Date(), password_hash: '' }).execute()
    return 'a new password\n'
  }
  await expect(inSite(['user:password', 'ada@example.com'], removing)).rejects.toMatchObject({
    code: 1,
    stderr:
      "ada@example.com was removed meanwhile, so nothing changed. Invite them again from the admin's Users page.\n",
  })
  const blank = await db.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirstOrThrow()
  expect(blank.password_hash).toBe('')

  await expect(inSite(['user:password', 'ada@example.com'])).rejects.toMatchObject({
    code: 1,
    stderr: "ada@example.com was removed. Invite them again from the admin's Users page.\n",
  })
  await expect(inSite(['make:user'], 'Ada\nada@example.com\ncorrect horse\n')).rejects.toMatchObject({
    code: 1,
    stderr:
      "ada@example.com was removed. Invite them again from the admin's Users page, so their history stays theirs.\n",
  })
}, 60_000)

test(".env sets what the environment doesn't, before iight.config.ts loads", async () => {
  // A site project whose config prints what it sees, with a command that needs no database
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(
    join(dir, 'iight.config.ts'),
    'console.log(JSON.stringify({ a: process.env.IIGHT_TEST_A, b: process.env.IIGHT_TEST_B }))\n' +
      "export default { database: { url: 'postgres://localhost/unused' } }\n",
  )
  await writeFile(join(dir, '.env'), 'IIGHT_TEST_A=from the file\nIIGHT_TEST_B="from the file"\n')
  await mkdir(join(dir, 'schema/types'), { recursive: true })

  try {
    const env = { ...process.env, IIGHT_TEST_B: 'from the environment' }
    const { stdout } = await promisify(execFile)(process.execPath, [bin, 'make:migration'], { cwd: dir, env })
    expect(stdout.split('\n')[0]).toBe('{"a":"from the file","b":"from the environment"}')
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)

test('migrate refuses a waiting migration with a TODO left, running nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'iight.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  await mkdir(join(dir, 'migrations'), { recursive: true })
  await writeFile(
    join(dir, 'migrations/2099_12_31_000000_todo.ts'),
    [
      'export const up = ({ entries }) => {',
      '  // TODO: views changed from text to number. Convert its values here, and back in down',
      "  entries.mapField('blog', 'views', (value) => value)",
      '}',
      'export const down = () => {}',
      '',
    ].join('\n'),
  )

  try {
    const run = promisify(execFile)(process.execPath, [bin, 'migrate'], { cwd: dir })
    await expect(run).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        '2099_12_31_000000_todo still has a TODO, at line 2: views changed from text to number. Convert its values ' +
        'here, and back in down.\nFinish each TODO, then delete its TODO comment, and migrate again.\n',
    })
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)

// A port nothing listens on yet
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })

test("dev listens on 127.0.0.1 unless HOST names another address, and other sites can't frame its admin", async () => {
  await setUp()
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'iight.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  await mkdir(join(dir, 'schema/types'), { recursive: true })
  await mkdir(join(dir, 'migrations'), { recursive: true })
  const running: Array<ChildProcess> = []

  // iight dev on a free port, with HOST or without, once it says where the admin is
  const dev = async (host?: string) => {
    const port = await freePort()
    const { HOST, ...env } = process.env
    const child = spawn(process.execPath, [bin, 'dev'], { cwd: dir, env: { ...env, PORT: String(port), HOST: host } })
    running.push(child)
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => String(data).includes('The admin is running') && resolve(undefined))
      child.once('exit', (code) => reject(new Error(`iight dev stopped with ${code}`)))
    })
    return port
  }

  // The admin page's status and frame headers at an address, or refused when nothing listens there
  const admin = async (address: string, port: number) => {
    try {
      const { status, headers } = await fetch(`http://${address}:${port}/admin/`)
      return `${status}, ${headers.get('x-frame-options')}, ${headers.get('content-security-policy')}`
    } catch {
      return 'refused'
    }
  }

  // This machine's address on its network, if it has one, which a server on every address would answer at
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === 'IPv4' && !info.internal)?.address

  try {
    // Without HOST, or with the empty one a .env can leave
    for (const host of [undefined, '']) {
      const local = await dev(host)
      expect(await admin('127.0.0.1', local)).toBe("200, DENY, frame-ancestors 'none'")
      expect(await admin('[::1]', local)).toBe('refused')
      if (lan) expect(await admin(lan, local)).toBe('refused')
    }

    const ipv6 = await dev('::1')
    expect(await admin('[::1]', ipv6)).toBe("200, DENY, frame-ancestors 'none'")
    expect(await admin('127.0.0.1', ipv6)).toBe('refused')
  } finally {
    for (const child of running) child.kill()
    await rm(dir, { recursive: true })
  }
}, 60_000)
