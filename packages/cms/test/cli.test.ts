import { agentRules } from '../src/agents'
import { uuidv7 } from '../src/db'
import { hashToken, verifyPassword } from '../src/passwords'
import { db, resetDb, url } from './database'
import { contactFields, setUp } from './fixtures'
import { ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { AddressInfo, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, expect, test } from 'vitest'

// The Sorlo CLI, run from a site project as a site runs it

const bin = fileURLToPath(new URL('../bin/sorlo.js', import.meta.url))

afterAll(() => db.destroy())

// A site project on the test database, which a command runs in, given what's typed into it, or with typed as a
// function, once it first asks something
async function inSite(args: Array<string>, typed: string | (() => Promise<string>) = '') {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
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

test(".env sets what the environment doesn't, before sorlo.config.ts loads", async () => {
  // A site project whose config prints what it sees, with a command that needs no database
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(
    join(dir, 'sorlo.config.ts'),
    'console.log(JSON.stringify({ a: process.env.SORLO_TEST_A, b: process.env.SORLO_TEST_B }))\n' +
      "export default { database: { url: 'postgres://localhost/unused' } }\n",
  )
  await writeFile(join(dir, '.env'), 'SORLO_TEST_A=from the file\nSORLO_TEST_B="from the file"\n')
  await mkdir(join(dir, 'schema/types'), { recursive: true })

  try {
    const env = { ...process.env, SORLO_TEST_B: 'from the environment' }
    const { stdout } = await promisify(execFile)(process.execPath, [bin, 'make:migration'], { cwd: dir, env })
    expect(stdout.split('\n')[0]).toBe('{"a":"from the file","b":"from the environment"}')
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)

test('start loads sorlo.config.ts with NODE_ENV production, unless the environment sets it, as next start does', async () => {
  // A config that prints what it sees, then stops the command before it needs a database or a port
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(
    join(dir, 'sorlo.config.ts'),
    "console.log(process.env.NODE_ENV ?? 'unset')\nthrow new Error('Stop')\n",
  )
  // Vitest sets NODE_ENV itself
  const env = { ...process.env }
  delete env.NODE_ENV
  const seen = async (command: string, extra: Record<string, string> = {}) => {
    const run = promisify(execFile)(process.execPath, [bin, command], { cwd: dir, env: { ...env, ...extra } })
    const { stdout } = await run.catch((error: { stdout: string }) => error)
    return stdout.split('\n')[0]
  }

  try {
    expect(await seen('start')).toBe('production')
    expect(await seen('start', { NODE_ENV: 'staging' })).toBe('staging')
    expect(await seen('dev')).toBe('unset')
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)

test('migrate refuses a waiting migration with a TODO left, running nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
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
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  await mkdir(join(dir, 'schema/types'), { recursive: true })
  await mkdir(join(dir, 'migrations'), { recursive: true })
  const running: Array<ChildProcess> = []

  // sorlo dev on a free port, with HOST or without, once it says where the admin is
  const dev = async (host?: string) => {
    const port = await freePort()
    const { HOST, ...env } = process.env
    const child = spawn(process.execPath, [bin, 'dev'], { cwd: dir, env: { ...env, PORT: String(port), HOST: host } })
    running.push(child)
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => String(data).includes('The admin is running') && resolve(undefined))
      child.once('exit', (code) => reject(new Error(`sorlo dev stopped with ${code}`)))
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

test('dev stops cleanly on SIGTERM, as start does when a host stops its container, and on one Ctrl-C through npm', async () => {
  await setUp()
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), `export default { database: { url: ${JSON.stringify(url)} } }\n`)
  await mkdir(join(dir, 'schema/types'), { recursive: true })

  try {
    // npm passes Ctrl-C on to what it runs, which the terminal has sent it too, so one press arrives two or three times
    for (const signals of [['SIGTERM'], ['SIGINT', 'SIGINT', 'SIGINT']] as const) {
      const { HOST, ...env } = process.env
      const child = spawn(process.execPath, [bin, 'dev'], { cwd: dir, env: { ...env, PORT: String(await freePort()) } })
      let stdout = ''
      child.stdout.on('data', (data) => (stdout += data))
      await new Promise((resolve, reject) => {
        child.stdout.on('data', () => stdout.includes('The admin is running') && resolve(undefined))
        child.once('exit', (code) => reject(new Error(`sorlo dev stopped with ${code}`)))
      })

      const exited = new Promise((resolve) => child.once('exit', resolve))
      for (const signal of signals) {
        child.kill(signal)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(await exited, signals.join(', ')).toBe(0)
      expect(stdout).toContain('Stopping…\nStopped.\n')
    }
  } finally {
    await rm(dir, { recursive: true })
  }
}, 60_000)

// A site project on the test database, with its media on a disk in it, for commands that use storage
async function siteWithStorage() {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  const driver = import.meta.resolve('flydrive/drivers/fs')
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(
    join(dir, 'sorlo.config.ts'),
    [
      `import { FSDriver } from ${JSON.stringify(driver)}`,
      'export default {',
      `  database: { url: ${JSON.stringify(url)} },`,
      "  storage: { default: 'local', services: { local: () => new FSDriver({ location: new URL('./storage/', import.meta.url), visibility: 'public' }) } },",
      '}',
      '',
    ].join('\n'),
  )
  await mkdir(join(dir, 'schema/types'), { recursive: true })
  return dir
}

// A command in a site project, settled as its exit code and what it printed
const run = (dir: string, args: Array<string>) =>
  promisify(execFile)(process.execPath, [bin, ...args], { cwd: dir }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  )

test('export and import say what they moved, and why they changed nothing', async () => {
  await setUp()
  const fields = JSON.stringify(contactFields)
  const form = { id: uuidv7(), name: 'contact', label: 'Contact us', fields, version: 1 }
  await db.insertInto('forms').values(form).execute()
  await db.insertInto('form_versions').values({ form_id: form.id, number: 1, fields }).execute()
  const dir = await siteWithStorage()
  try {
    expect(await run(dir, ['export'])).toEqual({
      code: 0,
      stdout: 'Exported 0 entries, 0 files, 1 form and 0 automations to content/.\n',
      stderr: '',
    })
    expect(await run(dir, ['import'])).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'This site has forms already. Import only goes into a site without any entries, media, forms or automations.\n' +
        'Nothing was imported.\n',
    })

    await db.deleteFrom('forms').execute()
    expect(await run(dir, ['import', 'content/'])).toEqual({
      code: 0,
      stdout: 'Imported 0 entries, 0 files, 1 form and 0 automations from content/.\n',
      stderr: '',
    })
    expect(await run(dir, ['export', '.'])).toEqual({
      code: 1,
      stdout: '',
      stderr:
        "./ holds files that aren't an export. Choose an empty folder or an earlier export.\nNothing was exported.\n",
    })
  } finally {
    await rm(dir, { recursive: true })
  }
}, 60_000)

// sorlo dev or start on a port, settled once it says where it's running or exits
const serve = (dir: string, command: 'dev' | 'start', port: number) => {
  const { HOST, ...env } = process.env
  const child = spawn(process.execPath, [bin, command], { cwd: dir, env: { ...env, PORT: String(port) } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => (stdout += data))
  child.stderr.on('data', (data) => (stderr += data))
  const started = new Promise<{ code: number | null }>((resolve) => {
    child.stdout.on('data', () => /The admin is running|Sorlo is running/.test(stdout) && resolve({ code: null }))
    child.once('exit', (code) => resolve({ code }))
  })
  return { child, started, output: () => ({ stdout, stderr }) }
}

test('dev runs what migrate would as it starts, then prints the link that makes the first account', async () => {
  await resetDb()
  const dir = await siteWithStorage()
  const port = await freePort()
  const dev = serve(dir, 'dev', port)
  try {
    expect(await dev.started).toEqual({ code: null })
    // The link follows the line saying where the admin is, once nobody is found
    for (let tries = 0; !dev.output().stdout.includes('No one has an account yet'); tries++) {
      if (tries > 100) throw new Error(dev.output().stdout)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const { stdout } = dev.output()
    expect(stdout).toContain('Migrated 2026_10_28_000000_create_users_table\n')
    const [, link, code] = stdout.match(/Make the first at (\S+#\/setup\/(\S+))\n/)!
    expect(link).toBe(`http://localhost:${port}/admin/#/setup/${code}`)

    const made = await fetch(`http://127.0.0.1:${port}/api/session/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: 'correct horse', code }),
    })
    expect(made.status).toBe(200)
  } finally {
    dev.child.kill()
    await rm(dir, { recursive: true })
  }
}, 60_000)

test("dev keeps Sorlo's notes for coding agents in AGENTS.md, refreshing them in place, unless agentRules is false", async () => {
  await setUp()
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-site-'))
  const config = (more = '') => `export default { database: { url: ${JSON.stringify(url)} }${more} }\n`
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'sorlo.config.ts'), config())
  await mkdir(join(dir, 'schema/types'), { recursive: true })
  const agents = join(dir, 'AGENTS.md')

  // What sorlo dev printed, once it says where the admin is
  const start = async () => {
    const dev = serve(dir, 'dev', await freePort())
    try {
      expect(await dev.started).toEqual({ code: null })
      return dev.output().stdout
    } finally {
      dev.child.kill()
    }
  }

  try {
    expect(await start()).toContain("Added Sorlo's notes for coding agents to AGENTS.md.")
    expect(await readFile(agents, 'utf8')).toBe(`${agentRules}\n`)

    // A person's own notes around an older copy of Sorlo's, which only gets replaced, and only once
    const old = '<!-- BEGIN:sorlo-agent-rules -->\n\nRead the old docs.\n\n<!-- END:sorlo-agent-rules -->'
    await writeFile(agents, `# Our notes\n\nKeep replies short.\n\n${old}\n\n## Deploys\n\nAsk first.\n`)
    // And a CLAUDE.md that doesn't import AGENTS.md, which Claude Code would read instead
    await writeFile(join(dir, 'CLAUDE.md'), '# Ours\n')
    expect(await start()).toContain(
      "Updated Sorlo's notes for coding agents in AGENTS.md.\nClaude Code reads CLAUDE.md here instead of AGENTS.md. " +
        'Add a line with @AGENTS.md to CLAUDE.md so it sees these notes.\n',
    )
    const updated = `# Our notes\n\nKeep replies short.\n\n${agentRules}\n\n## Deploys\n\nAsk first.\n`
    expect(await readFile(agents, 'utf8')).toBe(updated)
    expect(await start()).not.toContain('AGENTS.md')
    expect(await readFile(agents, 'utf8')).toBe(updated)

    // Turned off, it makes no file
    await rm(agents)
    await writeFile(join(dir, 'sorlo.config.ts'), config(', agentRules: false'))
    expect(await start()).not.toContain('AGENTS.md')
    expect(existsSync(agents)).toBe(false)
  } finally {
    await rm(dir, { recursive: true })
  }
}, 60_000)

test('dev starts with a TODO left in a waiting migration, running none of them, as migrate refuses to', async () => {
  await resetDb()
  const dir = await siteWithStorage()
  await mkdir(join(dir, 'migrations'))
  await writeFile(
    join(dir, 'migrations/2099_12_31_000000_todo.ts'),
    ['export const up = () => {', '  // TODO: convert the values', '}', 'export const down = () => {}', ''].join('\n'),
  )
  const dev = serve(dir, 'dev', await freePort())
  try {
    expect(await dev.started).toEqual({ code: null })
    // Vite's own warnings can follow, in this workspace
    expect(dev.output().stderr).toMatch(/^2099_12_31_000000_todo still has a TODO, at line 2: convert the values\.\n/)
    expect(dev.output().stderr).toContain(
      'Finish each TODO, then delete its TODO comment, and run them from the Migrations page.\n',
    )
    expect(dev.output().stdout).not.toContain('Migrated')
  } finally {
    dev.child.kill()
    await rm(dir, { recursive: true })
  }
}, 60_000)

// start serves the built admin, which npm run build makes
const built = existsSync(fileURLToPath(new URL('../admin/dist/index.html', import.meta.url)))

test('a port in use stops dev and start with what to do, rather than a stack trace', async () => {
  await setUp()
  const dir = await siteWithStorage()
  // Taken where each listens: dev on 127.0.0.1, and start on every address
  const commands: Array<['dev' | 'start', string | undefined]> = [['dev', '127.0.0.1']]
  if (built) commands.push(['start', undefined])
  try {
    for (const [command, host] of commands) {
      const taken = createServer()
      const port = await new Promise<number>((resolve) =>
        taken.listen(0, host, () => resolve((taken.address() as AddressInfo).port)),
      )
      const server = serve(dir, command, port)
      try {
        expect(await server.started, command).toEqual({ code: 1 })
        // After any warnings of Vite's, in this workspace, and with no stack trace
        const { stderr } = server.output()
        expect(stderr, command).toContain(
          `Port ${port} is in use, by another Sorlo server or something else. Stop it, or choose another port with ` +
            `PORT, such as PORT=${port + 1}.\n`,
        )
        expect(stderr, command).not.toMatch(/^\s+at /m)
      } finally {
        server.child.kill()
        taken.close()
      }
    }
  } finally {
    await rm(dir, { recursive: true })
  }
}, 60_000)
