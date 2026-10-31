import type { Config } from '.'
import { createApp } from './app'
import { createWorker } from './automations'
import { checkEntries, contentMigrations, loadContentMigrations } from './content'
import { flattenValidationReport, inputs, validateServerValues } from './core'
import { Database, createDb, uuidv7 } from './db'
import { createApiKey } from './delivery'
import { makeMigration } from './makeMigration'
import { loadMigrations, migrate, migrationsDir, rollback, status } from './migrator'
import { hashPassword } from './passwords'
import { rebuildRelations } from './relations'
import { apiKeySchema, apiKeyScopes, userSchema } from './schemas'
import { loadSchema } from './types'
import type { FieldSchema } from 'iight'
import { Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Command = { description: string; run: (db: Kysely<Database>, args: Array<string>) => Promise<void> }

const commands: Record<string, Command> = {
  dev: { description: 'Start the server and admin', run: dev },
  start: { description: 'Start the server and the built admin, for production', run: start },
  migrate: {
    description: "Run pending migrations, or with --check, list entries that don't pass",
    run: async (db, args) => {
      if (args.includes('--check')) return check(db)
      const { cms, content } = await loadAllMigrations()
      const names = await migrate(db, cms, contentMigrations(content))
      console.log(names.length ? names.map((name) => `Migrated ${name}`).join('\n') : 'Nothing to migrate.')
      await afterContentMigrations(db, names, content)
    },
  },
  'migrate:rollback': {
    description: 'Roll back the last batch of migrations',
    run: async (db) => {
      const { cms, content } = await loadAllMigrations()
      const names = await rollback(db, { ...cms, ...contentMigrations(content) })
      console.log(names.length ? names.map((name) => `Rolled back ${name}`).join('\n') : 'Nothing to roll back.')
      // Rolling back the CMS's own migrations can drop entry_relations
      if (!names.some((name) => Object.hasOwn(cms, name))) await afterContentMigrations(db, names, content)
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
    description: 'Write a content migration for the changes to schema/types and schema/groups',
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
  'make:api-key': {
    description: 'Create a key for the delivery API, and with --preview, --types or --submit, one that can do more',
    run: makeApiKey,
  },
}

// Load the site project's content types and shared groups, or list their problems and stop
const loadProjectSchema = () =>
  loadSchema(resolve('schema/types')).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })

const loadProjectTypes = async () => (await loadProjectSchema()).types

// The CMS's migrations and the site project's content migrations, which share the migrations table
async function loadAllMigrations() {
  const cms = await loadMigrations(migrationsDir)
  const content = await loadContentMigrations(resolve('migrations'))
  const clash = Object.keys(content).find((name) => Object.hasOwn(cms, name))
  if (clash) throw new Error(`The content migration ${clash} has the name of one of the CMS's migrations. Rename it.`)
  return { cms, content }
}

// Content migrations change entries' values, so their links in entry_relations are rebuilt from the types
async function afterContentMigrations(db: Kysely<Database>, names: Array<string>, content: object) {
  if (names.some((name) => Object.hasOwn(content, name))) await rebuildRelations(db, await loadProjectTypes())
}

// List every entry whose values no longer pass, in its draft or its live copy, such as after a field's choices
// narrowed, failing if there are any
async function check(db: Kysely<Database>) {
  const types = await loadProjectTypes()
  const failures = await checkEntries(db, types)
  for (const { entry, published, messages } of failures) {
    const titleField = types.get(entry.type)?.titleField
    const title = titleField && entry.values[titleField] ? ` ${entry.values[titleField]}` : ''
    const which = published ? ' (live copy)' : 'archived_at' in entry && entry.archived_at ? ' (archived)' : ''
    console.log(`${entry.type} ${entry.id}${title}${which}`)
    for (const [path, list] of Object.entries(messages)) console.log(`  ${path}: ${list.join(' ')}`)
  }

  const count = new Set(failures.map(({ entry }) => entry.id)).size
  console.log(count ? `${count} ${count === 1 ? "entry doesn't" : "entries don't"} pass.` : 'Every entry passes.')
  if (count) process.exitCode = 1
}

async function dev(db: Kysely<Database>) {
  // Loaded here so the other commands start quickly
  const { getRequestListener } = await import('@hono/node-server')
  const vite = await import('vite')

  // shortcut: types load once, and again after each change in the type editor, so restart after editing a file by hand
  const { types, groups } = await loadProjectSchema()
  const dirs = { types: resolve('schema/types'), migrations: resolve('migrations') }

  const port = Number(process.env.PORT) || 3000
  const server = createServer()
  const admin = await vite.createServer({
    configFile: fileURLToPath(new URL('../admin/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
  })
  const app = createApp(db, types, {
    migrations: () => loadContentMigrations(dirs.migrations),
    groups,
    editor: dirs,
    storage: config.storage,
    media: config.media,
    delivery: config.delivery,
    forms: config.forms,
    versions: config.versions,
  })
  const api = getRequestListener(app.fetch)

  // Hands events on to automations, in this process
  createWorker(db, types, { mail: config.mail, automations: config.automations, webhooks: config.webhooks }).start()

  // Vite serves the admin under /admin, and Hono everything else
  server.on('request', (req, res) => (req.url?.startsWith('/admin') ? admin.middlewares(req, res) : api(req, res)))
  server.listen(port, () => console.log(`The admin is running at http://localhost:${port}/admin/`))
}

// The production server: the admin as npm run build wrote it, and types that change only through git
async function start(db: Kysely<Database>) {
  const { serve } = await import('@hono/node-server')
  const admin = fileURLToPath(new URL('../admin/dist', import.meta.url))
  if (!existsSync(join(admin, 'index.html'))) {
    console.error("The admin hasn't been built. Run npm run build in @iight/cms first.")
    process.exit(1)
  }

  const { types, groups } = await loadProjectSchema()
  // No editor, so the type editor is read-only
  const app = createApp(db, types, {
    migrations: () => loadContentMigrations(resolve('migrations')),
    groups,
    admin,
    storage: config.storage,
    media: config.media,
    delivery: config.delivery,
    forms: config.forms,
    versions: config.versions,
  })

  // Hands events on to automations, in this process
  createWorker(db, types, { mail: config.mail, automations: config.automations, webhooks: config.webhooks }).start()

  // Every interface, unless HOST names one, such as 127.0.0.1 behind a proxy on the same machine
  const port = Number(process.env.PORT) || 3000
  serve({ fetch: app.fetch, port, hostname: process.env.HOST }, () =>
    console.log(`iight is running on port ${port}, with the admin at /admin/`),
  )
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

// A preview key reads drafts, so it belongs on a server, such as the one behind a site's preview mode
async function makeApiKey(db: Kysely<Database>, args: Array<string>) {
  const scopes = apiKeyScopes.map(({ value }) => value).filter((scope) => args.includes(`--${scope}`))
  const preview = scopes.includes('preview')
  const prompt = createPrompt()
  const values = { name: (await prompt.ask(`Name, such as ${preview ? 'Previews' : 'Website'}: `)).trim() }
  prompt.close()

  if (!(await validates(apiKeySchema, values))) return
  const key = await createApiKey(db, values.name, scopes)
  const created = preview
    ? `Created the preview key ${values.name}. It can read drafts, so keep it on a server.`
    : `Created the key ${values.name}.`
  console.log(`${created} Copy it now, since it can't be shown again:\n${key}`)
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

// The servers keep the database, every other command is done with it
if (name !== 'dev' && name !== 'start') await db.destroy()
