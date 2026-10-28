import type { Config } from '.'
import { createApp } from './app'
import { flattenValidationReport, inputs, validateServerValues } from './core'
import { Database, createDb, uuidv7 } from './db'
import { loadMigrations, migrate, migrationsDir, rollback, status } from './migrator'
import { hashPassword } from './passwords'
import { userSchema } from './schemas'
import { Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const commands: Record<string, { description: string; run: (db: Kysely<Database>) => Promise<void> }> = {
  dev: { description: 'Start the server and admin', run: dev },
  migrate: {
    description: 'Run pending migrations',
    run: async (db) => {
      const names = await migrate(db, await loadMigrations(migrationsDir))
      console.log(names.length ? names.map((name) => `Migrated ${name}`).join('\n') : 'Nothing to migrate.')
    },
  },
  'migrate:rollback': {
    description: 'Roll back the last batch of migrations',
    run: async (db) => {
      const names = await rollback(db, await loadMigrations(migrationsDir))
      console.log(names.length ? names.map((name) => `Rolled back ${name}`).join('\n') : 'Nothing to roll back.')
    },
  },
  'migrate:status': {
    description: 'Show which migrations have run',
    run: async (db) => {
      for (const { name, batch } of await status(db, await loadMigrations(migrationsDir))) {
        console.log(`${(batch ? `Ran, batch ${batch}` : 'Pending').padEnd(16)}${name}`)
      }
    },
  },
  'make:user': { description: 'Create an admin user', run: makeUser },
}

async function dev(db: Kysely<Database>) {
  // Loaded here so the other commands start quickly
  const { getRequestListener } = await import('@hono/node-server')
  const vite = await import('vite')

  const port = Number(process.env.PORT) || 3000
  const server = createServer()
  const admin = await vite.createServer({
    configFile: fileURLToPath(new URL('../admin/vite.config.ts', import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
  })
  const api = getRequestListener(createApp(db).fetch)

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

  // The same core validation a form would run
  const report = await validateServerValues(userSchema, values, inputs)
  if (!report.isValid) {
    for (const [name, messages] of Object.entries(flattenValidationReport(report).messages)) {
      console.error(`${userSchema.find((field) => field.name === name)?.label}: ${messages.join(' ')}`)
    }
    process.exitCode = 1
    return
  }

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
await command.run(db)

// The dev server keeps the database, every other command is done with it
if (name !== 'dev') await db.destroy()
