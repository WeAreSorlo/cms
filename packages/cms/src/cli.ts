import type { Config } from '.'
import { anthropic } from './ai'
import { adminHeaders, createApp } from './app'
import { createWorker } from './automations'
import { type ContentMigrationFile, checkEntries, contentMigrations, loadContentMigrations } from './content'
import { flattenValidationReport, inputs, validateServerValues } from './core'
import { Database, createDb, uuidv7 } from './db'
import { createApiKey } from './delivery'
import { makeMigration, notesOf } from './makeMigration'
import { loadMigrations, migrationsDir, ranMigrations, readMigrations, rollback, status } from './migrator'
import { hashPassword } from './passwords'
import { rebuildLinks, runMigrations, todosIn } from './runMigrations'
import { apiKeySchema, apiKeyScopes, resetSchema, userSchema } from './schemas'
import { Refused, exportContent, importContent, summary } from './transfer'
import { loadSchema } from './types'
import { firstAccount } from './users'
import type { FieldSchema } from '@sorlo/forms'
import { Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
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
      const result = await migrateAll(db, 'migrate again')
      if (result === 'refused' || result === 'failed') process.exitCode = 1
      if (result === 'idle') console.log('Nothing to migrate.')
    },
  },
  'migrate:rollback': {
    description: 'Roll back the last batch of migrations',
    run: async (db) => {
      const { cms, content } = await loadAllMigrations()
      const names = await rollback(db, { ...cms, ...contentMigrations(content) })
      console.log(names.length ? names.map((name) => `Rolled back ${name}`).join('\n') : 'Nothing to roll back.')
      // Rolling back the CMS's own migrations can drop entry_relations and rebuilds
      if (names.some((name) => Object.hasOwn(cms, name))) return
      const links = await rebuildLinks(db, projectLinks)
      if (links === 'rebuilt') console.log('Rebuilt the links between entries.')
      if (links === 'waiting') console.log(linksWait)
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
  export: {
    description: 'Write the content to a folder, content unless named, for sorlo import',
    run: (db, [folder = 'content']) =>
      transfer('exported', async () => {
        const { content } = await loadAllMigrations()
        const { moved, secrets } = await exportContent(db, config.storage, resolve(folder), content)
        console.log(`Exported ${summary(moved)} to ${folder.replace(/\/+$/, '')}/.`)
        if (secrets.length) {
          console.log(
            [
              "These hold webhooks' signing secrets or headers, as automations have them:",
              ...secrets.map((file) => `  ${file}`),
              'Keep the folder private, or blank them before committing it. Import makes a new signing secret for a webhook without one.',
            ].join('\n'),
          )
        }
      }),
  },
  import: {
    description: 'Load an export, from content unless named, into a site with no content yet',
    run: (db, [folder = 'content']) =>
      transfer('imported', async () => {
        const { content } = await loadAllMigrations()
        const moved = await importContent(db, resolve(folder), {
          types: await loadProjectTypes(),
          migrations: content,
          storage: config.storage,
          media: config.media,
        })
        console.log(`Imported ${summary(moved)} from ${folder.replace(/\/+$/, '')}/.`)
      }),
  },
  'make:user': { description: 'Create an admin user', run: makeUser },
  'user:password': { description: "Set someone's password, signing them out everywhere", run: setPassword },
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

// Runs an export or an import, printing why it was refused, which changed nothing, rather than a stack trace
async function transfer(what: 'exported' | 'imported', work: () => Promise<void>) {
  try {
    await work()
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    console.error(`${error.message}\nNothing was ${what}.`)
    process.exitCode = 1
  }
}

// The CMS's migrations and the site project's content migrations, which share the migrations table, with the files the
// content migrations were loaded from
async function loadAllMigrations() {
  const cms = await loadMigrations(migrationsDir)
  const files = await readMigrations<ContentMigrationFile>(resolve('migrations'))
  const content = await loadContentMigrations(files)
  const clash = Object.keys(content).find((name) => Object.hasOwn(cms, name))
  if (clash) throw new Error(`The content migration ${clash} has the name of one of the CMS's migrations. Rename it.`)
  return { cms, content, files }
}

// Where a rebuild of the links between entries finds the types and what waits, which content migrations make due
const projectLinks = { dir: resolve('migrations'), types: loadProjectTypes }

const linksWait = 'The links between entries are rebuilt once every content migration has run.'

// Run every waiting migration as one batch, as sorlo migrate does and sorlo dev as it starts, printing what happened:
// refused for a TODO left in a waiting migration, which runs none, failed, ran, or idle for nothing to do. next is
// how to run them once the TODOs are done.
async function migrateAll(db: Kysely<Database>, next: string) {
  const { cms, content, files } = await loadAllMigrations()

  // A TODO left in a waiting migration means its stub, which changes nothing, would run. Its text is the one its
  // module was loaded from, so what's checked is what runs.
  const ran = new Set((await ranMigrations(db)).map((row) => row.name))
  const todos = files.filter((file) => !ran.has(file.name)).flatMap((file) => todosIn(file.name, notesOf(file.text)))
  if (todos.length) {
    console.error([...todos, `Finish each TODO, then delete its TODO comment, and ${next}.`].join('\n'))
    return 'refused'
  }

  const { ran: names, failed, links } = await runMigrations(db, { cms, content, links: projectLinks })
  if (names.length) console.log(names.map((name) => `Migrated ${name}`).join('\n'))
  if (links === 'rebuilt') console.log('Rebuilt the links between entries.')
  if (failed) {
    const what = failed.name
      ? `${failed.name} failed and changed nothing, and the migrations after it didn't run.`
      : failed.during === 'links'
        ? 'Rebuilding the links between entries failed. The next migrate, or start of the server, rebuilds them.'
        : 'The migrations stopped before the next one started, so it and those after it still wait.'
    console.error(what, failed.error)
  }
  if (links === 'waiting') console.log(linksWait)
  return failed ? 'failed' : names.length || links ? 'ran' : 'idle'
}

// Where both servers listen unless PORT names another, clear of the 3000 that frontends usually take
const defaultPort = 4100

// Listens, or stops with what to do when the port is taken, rather than a stack trace
function listen(server: Server, port: number, host: string | undefined, listening: () => void) {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error
    console.error(
      `Port ${port} is in use, by another Sorlo server or something else. Stop it, or choose another port with PORT, ` +
        `such as PORT=${port + 1}.`,
    )
    process.exit(1)
  })
  server.listen(port, host, listening)
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

  // shortcut: types load once, and again after each change in the type editor, so restart after editing a file by hand
  const { types, groups } = await loadProjectSchema()
  const dirs = { types: resolve('schema/types'), migrations: resolve('migrations') }

  // What sorlo migrate would run, first. The server starts whatever happens, so the Migrations page can show what
  // still waits, and a database that isn't up yet gets a line rather than a stack trace.
  await migrateAll(db, 'run them from the Migrations page').catch((error) =>
    console.error(`Couldn't run the migrations: ${error instanceof Error ? error.message : error}`),
  )

  const port = Number(process.env.PORT) || defaultPort
  const admin = `http://localhost:${port}/admin/`
  const setup = firstAccount(admin)
  const server = createServer()
  // Vite serves the admin from its source, which only the CMS's own workspace has. A site's is the built one.
  const viteConfig = fileURLToPath(new URL('../admin/vite.config.ts', import.meta.url))
  const vite = existsSync(viteConfig)
    ? await (
        await import('vite')
      ).createServer({
        configFile: viteConfig,
        server: { middlewareMode: true, hmr: { server } },
      })
    : undefined
  const app = createApp(db, types, {
    siteMigrations: dirs.migrations,
    finishLinks: true,
    groups,
    editor: dirs,
    storage: config.storage,
    media: config.media,
    delivery: config.delivery,
    forms: config.forms,
    versions: config.versions,
    mcp: config.mcp,
    ai: config.ai && anthropic(config.ai),
    url: config.url,
    mail: config.mail,
    proxies: config.proxies,
    firstAccount: setup,
    previews: config.previews,
    admin: vite ? undefined : builtAdmin(),
    log: true,
  })
  const api = getRequestListener(app.fetch)

  // Hands events on to automations, in this process
  const worker = createWorker(db, types, {
    mail: config.mail,
    automations: config.automations,
    webhooks: config.webhooks,
  })
  const working = worker.start()

  // Vite serves the admin under /admin, where it runs, and Hono everything else
  server.on('request', (req, res) => {
    if (!vite || !req.url?.startsWith('/admin')) return api(req, res)
    for (const [name, value] of Object.entries(adminHeaders)) res.setHeader(name, value)
    vite.middlewares(req, res)
  })
  // Only this machine, unless HOST names another address, such as 0.0.0.0 in a container. Not localhost, which Node can
  // bind to ::1 alone, refusing 127.0.0.1. An empty HOST, as a .env can leave it, names none.
  listen(server, port, process.env.HOST || '127.0.0.1', async () => {
    console.log(`The admin is running at ${admin}`)
    if (await nobodyYet(db)) setup.show()
  })
  stopOnSignals(db, server, worker, working, vite)
}

// The admin as npm run build wrote it, which a packed CMS carries
function builtAdmin() {
  const admin = fileURLToPath(new URL('../admin/dist', import.meta.url))
  if (!existsSync(join(admin, 'index.html'))) {
    console.error("The admin hasn't been built. Run npm run build in @sorlo/cms first.")
    process.exit(1)
  }
  return admin
}

// The production server: the admin as npm run build wrote it, and types that change only through git
async function start(db: Kysely<Database>) {
  const { createAdaptorServer } = await import('@hono/node-server')
  const admin = builtAdmin()

  const { types, groups } = await loadProjectSchema()
  if (config.url === undefined) {
    console.warn("Set url in sorlo.config.ts, so file URLs and emailed links don't come from requests' Host headers.")
  }
  // The first account's link starts from the site's address, or else from wherever the person reaches the server
  const setup = firstAccount(
    config.url && URL.canParse(config.url) ? `${new URL(config.url).origin}/admin/` : '/admin/',
  )
  // No editor, so the type editor is read-only, and the Migrations page lists migrations without running them
  const app = createApp(db, types, {
    siteMigrations: resolve('migrations'),
    finishLinks: true,
    groups,
    admin,
    storage: config.storage,
    media: config.media,
    delivery: config.delivery,
    forms: config.forms,
    versions: config.versions,
    mcp: config.mcp,
    ai: config.ai && anthropic(config.ai),
    url: config.url,
    mail: config.mail,
    proxies: config.proxies,
    firstAccount: setup,
    previews: config.previews,
    log: true,
  })

  // Hands events on to automations, in this process
  const worker = createWorker(db, types, {
    mail: config.mail,
    automations: config.automations,
    webhooks: config.webhooks,
  })
  const working = worker.start()

  // Every interface, as a container needs, unless HOST names one, such as 127.0.0.1 behind a proxy on the same
  // machine. An empty HOST names none.
  const port = Number(process.env.PORT) || defaultPort
  const hostname = process.env.HOST || undefined
  // An HTTP/1 server, since it isn't given HTTP/2's createServer
  const server = createAdaptorServer({ fetch: app.fetch, hostname }) as Server
  listen(server, port, hostname, async () => {
    console.log(`Sorlo is running on port ${port}, with the admin at /admin/`)
    if (await nobodyYet(db)) setup.show()
  })
  stopOnSignals(db, server, worker, working)
}

// Whether nobody has an account yet, so the first can be made in the admin. A database that can't say, such as one
// without its tables yet, counts as having people, since its admin can't make anyone.
const nobodyYet = (db: Kysely<Database>) =>
  db
    .selectFrom('users')
    .select('id')
    .limit(1)
    .executeTakeFirst()
    .then(
      (user) => !user,
      () => false,
    )

// Stops on SIGTERM, as hosts stop a container, or SIGINT, as Ctrl-C does: no new connections, the worker's run
// finished, such as a webhook it's waiting for, what's still open after 5 seconds ended, such as a chat's streaming
// reply, which then stops as when its person leaves, and the database closed. A second signal exits at once.
function stopOnSignals(
  db: Kysely<Database>,
  server: Server,
  worker: { stop: () => void },
  working: Promise<void>,
  vite?: { close: () => Promise<void> },
) {
  let stoppedAt: number | undefined
  const stop = async () => {
    // npm passes Ctrl-C on to the command it runs, which the terminal has sent it too, so one press arrives two or three
    // times at once. Only a signal a second later is a second one.
    if (stoppedAt !== undefined) {
      if (Date.now() - stoppedAt > 1000) process.exit(1)
      return
    }
    stoppedAt = Date.now()
    console.log('Stopping…')
    const closed = new Promise((resolve) => server.close(resolve))
    let cut = false
    const cutting = setTimeout(() => {
      cut = true
      server.closeAllConnections()
    }, 5000)
    worker.stop()
    await Promise.all([closed, working, vite?.close()])
    clearTimeout(cutting)
    // shortcut: a second for what cut requests do as they end, such as a chat storing the reply it had written, before
    // the database closes. Wait for those requests themselves if a second turns out to be short.
    if (cut) await new Promise((resolve) => setTimeout(resolve, 1000))
    await db.destroy()
    console.log('Stopped.')
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
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
  const existing = await db.selectFrom('users').select('removed_at').where('email', '=', email).executeTakeFirst()
  if (existing) {
    console.error(
      existing.removed_at
        ? `${email} was removed. Invite them again from the admin's Users page, so their history stays theirs.`
        : `${email} already has an account.`,
    )
    process.exitCode = 1
    return
  }

  await db
    .insertInto('users')
    .values({ id: uuidv7(), name: values.name, email, password_hash: await hashPassword(values.password) })
    .execute()
  console.log(`Created ${email}, who can now sign in at /admin/.`)
}

// The way back in for a site whose only person forgot their password and that sends no email.
// Someone removed comes back by invite instead.
async function setPassword(db: Kysely<Database>, [given = '']: Array<string>) {
  const email = given.trim().toLowerCase()
  const user = email
    ? await db.selectFrom('users').select(['id', 'removed_at']).where('email', '=', email).executeTakeFirst()
    : undefined
  if (!user || user.removed_at) {
    console.error(
      !email
        ? 'Give the email of the account, as in sorlo user:password ada@example.com.'
        : user
          ? `${email} was removed. Invite them again from the admin's Users page.`
          : `${email} has no account.`,
    )
    process.exitCode = 1
    return
  }

  const prompt = createPrompt()
  const values = { password: await prompt.ask('New password: ', true) }
  prompt.close()
  if (!(await validates(resetSchema, values))) return

  // Only someone still there, since a removal during the prompt blanked their password
  const passwordHash = await hashPassword(values.password)
  const changed = await db.transaction().execute(async (trx) => {
    const { numUpdatedRows } = await trx
      .updateTable('users')
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where('id', '=', user.id)
      .where('removed_at', 'is', null)
      .executeTakeFirstOrThrow()
    if (!numUpdatedRows) return false
    await trx.deleteFrom('sessions').where('user_id', '=', user.id).execute()
    await trx.deleteFrom('password_resets').where('user_id', '=', user.id).execute()
    return true
  })
  if (!changed) {
    console.error(`${email} was removed meanwhile, so nothing changed. Invite them again from the admin's Users page.`)
    process.exitCode = 1
    return
  }
  console.log(`Set a new password for ${email}, and signed them out everywhere.`)
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
  console.log(['Usage: sorlo <command>', '', ...list].join('\n'))
  process.exit(name ? 1 : 0)
}

const configFile = resolve('sorlo.config.ts')
if (!existsSync(configFile)) {
  console.error(`There's no sorlo.config.ts in ${process.cwd()}. Run sorlo from your site project.`)
  process.exit(1)
}

// The site project's .env, such as for ANTHROPIC_API_KEY or DATABASE_URL, which never replaces what the environment
// already sets
const envFile = resolve('.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const config: Config = (await import(pathToFileURL(configFile).href)).default
const db = createDb(config.database.url)
await command.run(db, process.argv.slice(3))

// The servers keep the database, every other command is done with it
if (name !== 'dev' && name !== 'start') await db.destroy()
