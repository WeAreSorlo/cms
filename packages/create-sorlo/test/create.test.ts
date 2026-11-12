import {
  checkApiKey,
  checkDatabaseUrl,
  checkFolder,
  packageName,
  packageSpec,
  parseOptions,
  providers,
  withProvider,
  withVariable,
} from '../src/create'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterAll, describe, expect, test } from 'vitest'

describe('the arguments', () => {
  test('a folder and a database URL, with the URL in either form', () => {
    expect(parseOptions(['my-site', '--database-url', 'postgres://localhost/site'])).toEqual({
      folder: 'my-site',
      databaseUrl: 'postgres://localhost/site',
      help: false,
    })
    expect(parseOptions(['--database-url=postgres://localhost/site'])).toEqual({
      folder: undefined,
      databaseUrl: 'postgres://localhost/site',
      help: false,
    })
  })

  test('none, leaving the questions or their defaults', () => {
    expect(parseOptions([])).toEqual({ folder: undefined, databaseUrl: undefined, help: false })
  })

  test('help', () => {
    expect(parseOptions(['--help']).help).toBe(true)
    expect(parseOptions(['-h']).help).toBe(true)
  })

  test('refuses a second folder, an option it lacks and a URL left out', () => {
    expect(() => parseOptions(['one', 'two'])).toThrow('Give one folder, not 2.')
    expect(() => parseOptions(['--skip-samples'])).toThrow("Unknown option '--skip-samples'")
    expect(() => parseOptions(['my-site', '--database-url'])).toThrow('argument missing')
  })
})

describe('the folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-sorlo-'))
  afterAll(() => rmSync(root, { recursive: true }))

  test("takes one that's empty or not there yet", () => {
    mkdirSync(join(root, 'empty'))
    expect(checkFolder(join(root, 'empty'))).toBeUndefined()
    expect(checkFolder(join(root, 'new'))).toBeUndefined()
  })

  test('refuses one with anything in it, and a file', () => {
    mkdirSync(join(root, 'full'))
    writeFileSync(join(root, 'full/.gitkeep'), '')
    expect(checkFolder(join(root, 'full'))).toBe(
      `${join(root, 'full')} isn't empty. Choose a new folder, or an empty one.`,
    )
    expect(checkFolder(join(root, 'full/.gitkeep'))).toBe(`${join(root, 'full/.gitkeep')} is a file.`)
  })
})

describe('the database URL', () => {
  test.each([
    'postgres://sorlo:sorlo@localhost:5432/site',
    'postgresql://localhost/site',
    'postgres://ada:p%40ss@db.example.com/site?sslmode=require',
  ])('takes %s', (url) => {
    expect(checkDatabaseUrl(url)).toBeUndefined()
  })

  test.each([
    '',
    'localhost:5432/site',
    'mysql://localhost/site',
    'postgres://localhost/my site',
    'postgres://localhost/site\nWEB_URL=https://example.com',
  ])('refuses %j', (url) => {
    expect(checkDatabaseUrl(url)).toBe('Give a Postgres URL, such as postgres://user:password@localhost:5432/my_site.')
  })
})

describe("cms/.env's DATABASE_URL", () => {
  const example = [
    '# Postgres: the database compose.yaml makes',
    'DATABASE_URL=postgres://sorlo:sorlo@localhost:5432/sorlo_starter',
    'APP_URL=http://localhost:4100',
    'PREVIEW_SECRET=',
    '',
  ].join('\n')

  test("replaces the example's, keeping every other line", () => {
    expect(withVariable(example, 'DATABASE_URL', 'postgres://ada@db.example.com/site')).toBe(
      example.replace('postgres://sorlo:sorlo@localhost:5432/sorlo_starter', 'postgres://ada@db.example.com/site'),
    )
  })

  test('is added when the example has none', () => {
    expect(withVariable('APP_URL=http://localhost:4100\n', 'DATABASE_URL', 'postgres://db/site')).toBe(
      'APP_URL=http://localhost:4100\nDATABASE_URL=postgres://db/site\n',
    )
  })

  test("reads back as given, $ and & included, through Node's own parser, as sorlo reads .env", () => {
    const url = 'postgres://ada:pa$&ss@db.example.com:6543/site?sslmode=require'
    expect(parseEnv(withVariable(example, 'DATABASE_URL', url)).DATABASE_URL).toBe(url)
  })
})

describe('the AI provider', () => {
  const [anthropic] = providers
  const config = [
    "import { defineConfig } from '@sorlo/cms'",
    "import type { MailOptions } from '@sorlo/cms'",
    "import nodemailer from 'nodemailer'",
    '',
    'export default defineConfig({',
    '  mail: mail(),',
    "  // ai: the admin's assistant, off until it has a provider",
    '})',
    '',
  ].join('\n')

  test('goes in the config on the line left for it, with its import among the others in order', () => {
    expect(withProvider(config, anthropic)).toBe(
      [
        "import { anthropic } from '@sorlo/ai-anthropic'",
        "import { defineConfig } from '@sorlo/cms'",
        "import type { MailOptions } from '@sorlo/cms'",
        "import nodemailer from 'nodemailer'",
        '',
        'export default defineConfig({',
        '  mail: mail(),',
        '  ai: anthropic(),',
        '})',
        '',
      ].join('\n'),
    )
    const last = { ...anthropic, package: 'zed-ai', provider: 'zed' }
    expect(withProvider(config, last)).toContain("import nodemailer from 'nodemailer'\nimport { zed } from 'zed-ai'\n")
  })

  test("isn't written into a config without the line", () => {
    expect(withProvider(config.replace(/.*\/\/ ai:.*\n/, ''), anthropic)).toBeUndefined()
  })

  test('sets the key on the line the example leaves commented out, in its place', () => {
    const example = '# The key of the provider ai uses\n# ANTHROPIC_API_KEY=\nSMTP_URL=\n'
    expect(withVariable(example, 'ANTHROPIC_API_KEY', 'sk-ant-api03-abc_DEF-123')).toBe(
      '# The key of the provider ai uses\nANTHROPIC_API_KEY=sk-ant-api03-abc_DEF-123\nSMTP_URL=\n',
    )
  })

  test.each(['', 'sk-ant-api03-abc_DEF-123', 'AIza.Sy-x:y/z+='])('takes the key %j', (key) => {
    expect(checkApiKey(key)).toBeUndefined()
  })

  test.each(['a key', 'a\nSMTP_URL=x', '"quoted"', "it's", 'a#b', 'a\\b'])('refuses the key %j', (key) => {
    expect(checkApiKey(key)).toBe("Give the key as it is. It can't have spaces, quotes, # or \\.")
  })

  const root = mkdtempSync(join(tmpdir(), 'create-sorlo-'))
  afterAll(() => rmSync(root, { recursive: true }))

  test("installs the provider's package at the version of the site's CMS, which it's released with", () => {
    expect(packageSpec(root, '@sorlo/ai-anthropic')).toBe('@sorlo/ai-anthropic@latest')
    mkdirSync(join(root, 'node_modules/@sorlo/cms'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@sorlo/cms/package.json'), JSON.stringify({ version: '0.2.0' }))
    expect(packageSpec(root, '@sorlo/ai-anthropic')).toBe('@sorlo/ai-anthropic@0.2.0')
  })
})

describe("the root package.json's name", () => {
  test.each([
    ['my-site', 'my-site'],
    ['My Site', 'my-site'],
    ['Café & Bar', 'caf-bar'],
    ['example.com', 'example.com'],
    ['.hidden', 'hidden'],
    ['___', ''],
  ])('from %j is %j', (folder, name) => {
    expect(packageName(folder)).toBe(name)
  })
})
