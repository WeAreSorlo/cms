import { type SpawnSyncReturns, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// End to end: a site made from a starter tarball, as GitHub serves main. CREATE_SORLO_TARBALL names one, or the test
// packs HEAD of a clone of WeAreSorlo/starter beside this repo, and without either it skips
const bin = fileURLToPath(new URL('../bin/create-sorlo.js', import.meta.url))
const starter = fileURLToPath(new URL('../../../../starter', import.meta.url))
const given = process.env.CREATE_SORLO_TARBALL

// The site's own database, on the tests' Postgres
const server = process.env.TEST_DATABASE_URL ?? 'postgres://sorlo:sorlo@localhost:5432/sorlo_test'
const database = 'create_sorlo_test'
const site = new URL(server)
site.pathname = `/${database}`
const url = site.href

let folder: string
let result: SpawnSyncReturns<string>
const root = () => join(folder, 'my-test-site')
const read = (file: string) => readFileSync(join(root(), file), 'utf8')
const git = (...args: Array<string>) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' }).trim()

const skip = !given && !existsSync(join(starter, '.git'))
// Vitest drops what a skipped file logs to the console, so straight to stderr
if (skip) {
  process.stderr.write(
    `Skipping create-sorlo's end-to-end test: there's no clone of WeAreSorlo/starter at ${starter}, ` +
      "and CREATE_SORLO_TARBALL doesn't name a tarball.\n",
  )
}

describe.skipIf(skip)('a site from the starter', () => {
  beforeAll(async () => {
    await dropDatabase()
    folder = mkdtempSync(join(tmpdir(), 'create-sorlo-'))
    const tarball = given ? resolve(given) : join(folder, 'starter.tar.gz')
    if (!given) {
      execFileSync('git', ['archive', '--format=tar.gz', '--prefix=starter-main/', '-o', tarball, 'HEAD'], {
        cwd: starter,
      })
    }

    // No terminal, so nothing is asked
    result = spawnSync(process.execPath, [bin, 'my-test-site', '--database-url', url], {
      cwd: folder,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      env: {
        ...process.env,
        CREATE_SORLO_TARBALL: tarball,
        // A first commit whatever this machine's git config says
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Sorlo',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Sorlo',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })
  }, 600_000)

  afterAll(async () => {
    await dropDatabase()
    if (folder) rmSync(folder, { recursive: true, force: true })
  })

  test('runs to the end, with the next steps', () => {
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('cd my-test-site')
    expect(result.stdout).toContain('npm run dev')
  })

  test("is the starter, named after its folder, without the starter's licence", () => {
    expect(JSON.parse(read('package.json')).name).toBe('my-test-site')
    expect(existsSync(join(root(), 'cms/sorlo.config.ts'))).toBe(true)
    expect(existsSync(join(root(), 'node_modules/@sorlo/cms'))).toBe(true)
    expect(existsSync(join(root(), 'LICENSE'))).toBe(false)
  })

  test('has its env files, with the database it was given and the keys setup made', () => {
    const cms = parseEnv(read('cms/.env'))
    const web = parseEnv(read('web/.env.local'))
    expect(cms.DATABASE_URL).toBe(url)
    expect(cms.PREVIEW_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(web.PREVIEW_SECRET).toBe(cms.PREVIEW_SECRET)
    expect(web.SORLO_TOKEN).toBeTruthy()
    expect(web.SORLO_PREVIEW_TOKEN).toBeTruthy()
  })

  test('has the sample content in its own database', async () => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      const { rows } = await client.query('SELECT count(*)::int AS count FROM entries')
      expect(rows[0].count).toBeGreaterThan(0)
    } finally {
      await client.end()
    }
  })

  test("is a git repository with one commit of everything git doesn't ignore", () => {
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(git('branch', '--show-current')).toBe('main')
    expect(git('status', '--porcelain')).toBe('')
    expect(git('ls-files', 'package-lock.json', 'cms/.env', 'web/.env.local')).toBe('package-lock.json')
  })
})

async function dropDatabase() {
  const client = new pg.Client({ connectionString: server })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  } finally {
    await client.end()
  }
}
