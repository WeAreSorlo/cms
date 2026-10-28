import type { Config } from '.'
import { createApp } from './app'
import { checkEntries, contentMigrations, loadContentMigrations } from './content'
import { flattenValidationReport, inputs, validateServerValues } from './core'
import { Database, createDb, uuidv7 } from './db'
import { createApiKey } from './delivery'
import { makeMigration } from './makeMigration'
import { loadMigrations, migrate, migrationsDir, rollback, status } from './migrator'
import { hashPassword } from './passwords'
import { apiKeySchema, userSchema } from './schemas'
import { loadTypes } from './types'
import type { FieldSchema } from 'iight'
import { Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Command = { description: string; run: (db: Kysely<Database>, args: Array<string>) => Promise<void> }

const commands: Record<string, Command> = {
  dev: { description: 'Start the server and admin', run: dev },
  migrate: {
    description: "Run pending migrations, or with --check, list entries that don't pass",
    run: async (db, args) => {
      if (args.includes('--check')) return check(db)
      const { cms, content } = await loadAllMigrations()
      const names = await migrate(db, cms, contentMigrations(content))
      console.log(names.length ? names.map((name) => `Migrated ${name}`).join('\n') : 'Nothing to migrate.')
    },
  },
  'migrate:rollback': {
    description: 'Roll back the last batch of migrations',
    run: async (db) => {
      const { cms, content } = await loadAllMigrations()
      const names = await rollback(db, { ...cms, ...contentMigrations(content) })
      console.log(names.length ? names.map((name) => `Rolled back ${name}`).join('\n') : 'Nothing to roll back.')
    },
  },
  'migrate:status': {
    description: 'Show which migrations have run',
    run: async (db) => {
      const { cms, content } = await loadAllMigrations()
      for (const [heading, migrations] of [
        ['CMS migrations', cms],
        ['Content migrations', contentMigrations(content)],
      ] as const) {
        const rows = await status(db, migrations)
        console.log(heading)
        for (const { name, batch } of rows)
          console.log(`${(batch ? `Ran, batch ${batch}` : 'Pending').padEnd(16)}${name}`)
        if (!rows.length) console.log('None yet')
      }
    },
  },
  'make:migration': {
    description: 'Write a content migration for the changes to schema/types',
    run: async (_db, [name]) => {
      const types = await loadProjectTypes()
      const { file, notes, created, updated } = await makeMigration(resolve('migrations'), types, name).catch(
        (error) => {
          console.error(error.message)
          process.exit(1)
        },
      )
      if (created)
        console.log('Created migrations/.snapshot.json from schema/types. Changes from now on get migrations.')
      else if (file) console.log([`Created migrations/${file}`, ...notes.map((note) => `  ${note}`)].join('\n'))
      else
        console.log(updated ? 'Nothing needs a migration. Updated migrations/.snapshot.json.' : 'Nothing has changed.')
    },
  },
  'make:user': { description: 'Create an admin user', run: makeUser },
  'make:api-key': { description: 'Create a key for the delivery API', run: makeApiKey },
}

// Load the site project's content types, or list their problems and stop
const loadProjectTypes = () =>
  loadTypes(resolve('schema/types')).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })

// The CMS's migrations and the site project's content migrations, which share the migrations table
async function loadAllMigrations() {
  const cms = await loadMigrations(migrationsDir)
  const content = await loadContentMigrations(resolve('migrations'))
  const clash = Object.keys(content).find((name) => Object.hasOwn(cms, name))
  if (clash) throw new Error(`The content migration ${clash} has the name of one of the CMS's migrations. Rename it.`)
  return { cms, content }
}

// List every entry whose values no longer pass, such as after a field's choices narrowed, failing if there are any
async function check(db: Kysely<Database>) {
  const types = await loadProjectTypes()
  const failures = await checkEntries(db, types)
  for (const { entry, messages } of failures) {
    const titleField = types.get(entry.type)?.titleField
    const title = titleField && entry.values[titleField] ? ` ${entry.values[titleField]}` : ''
    console.log(`${entry.type} ${entry.id}${title}${entry.archived_at ? ' (archived)' : ''}`)
    for (const [path, list] of Object.entries(messages)) console.log(`  ${path}: ${list.join(' ')}`)
  }

  const count = failures.length
  console.log(count ? `${count} ${count === 1 ? "entry doesn't" : "entries don't"} pass.` : 'Every entry passes.')
  if (count) process.exitCode = 1
}

async function dev(db: Kysely<Database>) {
  // Loaded here so the other commands start quickly
  const { getRequestListener } = await import('@hono/node-server')
  const vite = await import('vite')

  // shortcut: types load once, and again after each change in the type editor, so restart after editing a file by hand
  const types = await loadProjectTypes()
  const dirs = { types: resolve('schema/types'), migrations: resolve('migrations') }

  const port = Number(process.env.PORT) || 3000
  const server = createServer()
  const admin = await vite.createServer({
    configFile: fileURLToPath(new URL('../admin/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
  })
  const app = createApp(db, types, { migrations: () => loadContentMigrations(dirs.migrations), editor: dirs })
  const api = getRequestListener(app.fetch)

  // Vite serves the admin under /admin, and Hono everything else
  server.on('request', (req, res) => (req.url?.startsWith('/admin') ? admin.middlewares(req, res) : api(req, res)))
  server.listen(port, () => console.log(`The admin is running at http://localhost:${port}/admin/`))
}

async function makeUser(db: Kysely<Database>) {
  const prompt = createPrompt()
  const values = {
    name: (await prompt.ask('Name: ')).trim(),
    email: (await prompt.ask('Email: ')).trim(),
    password: await prompt.ask('Password: ', true),
  }
  prompt.close()

  if (!(await validates(userSchema, values))) return

  const email = values.email.toLowerCase()
  if (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()) {
    console.error(`${email} already has an account.`)
    process.exitCode = 1
    return
  }

  await db
    .insertInto('users')
    .values({ id: uuidv7(), name: values.name, email, password_hash: await hashPassword(values.password) })
    .execute()
  console.log(`Created ${email}, who can now sign in at /admin/.`)
}

async function makeApiKey(db: Kysely<Database>) {
  const prompt = createPrompt()
  const values = { name: (await prompt.ask('Name, such as Website: ')).trim() }
  prompt.close()

  if (!(await validates(apiKeySchema, values))) return
  console.log(
    `Created the key ${values.name}. Copy it now, since it can't be shown again:\n${await createApiKey(db, values.name)}`,
  )
}

// Run the same core validation a form would, printing what's wrong
async function validates(schema: Array<FieldSchema>, values: Record<string, string>) {
  const report = await validateServerValues(schema, values, inputs)
  for (const [name, messages] of Object.entries(flattenValidationReport(report).messages)) {
    console.error(`${schema.find((field) => field.name === name)?.label}: ${messages.join(' ')}`)
  }
  if (!report.isValid) process.exitCode = 1
  return report.isValid
}

// Ask questions on the terminal, without echoing the answers to hidden ones
function createPrompt() {
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk)
      callback()
    },
  })

  // No history, so the up arrow can't bring back a password
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY, historySize: 0 })
  rl.on('SIGINT', () => process.exit(130))

  // Iterating keeps lines that arrive before they're asked for, as piped input does
  const lines = rl[Symbol.asyncIterator]()

  return {
    async ask(question: string, hidden = false) {
      rl.setPrompt(question)
      rl.prompt()
      muted = hidden
      const { value } = await lines.next()
      if (muted) process.stdout.write('\n')
      muted = false
      return value ?? ''
    },
    close: () => rl.close(),
  }
}

const [name = ''] = process.argv.slice(2)
const command = Object.hasOwn(commands, name) ? commands[name] : undefined

if (!command) {
  const list = Object.entries(commands).map(([name, { description }]) => `  ${name.padEnd(18)}${description}`)
  console.log(['Usage: iight <command>', '', ...list].join('\n'))
  process.exit(name ? 1 : 0)
}

const configFile = resolve('iight.config.ts')
if (!existsSync(configFile)) {
  console.error(`There's no iight.config.ts in ${process.cwd()}. Run iight from your site project.`)
  process.exit(1)
}

const config: Config = (await import(pathToFileURL(configFile).href)).default
const db = createDb(config.database.url)
await command.run(db, process.argv.slice(3))

// The dev server keeps the database, every other command is done with it
if (name !== 'dev') await db.destroy()
