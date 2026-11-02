import { type ContentMigrationFile, callsOf, checkEntries, contentMigrations } from './content'
import type { Database } from './db'
import type { AdminEnv } from './entries'
import { notesOf } from './makeMigration'
import {
  type MigrationFile,
  type Migrations,
  loadMigrations,
  migrateWith,
  migrationsDir,
  ranMigrations,
  readMigrations,
} from './migrator'
import { rebuildRelations } from './relations'
import type { ContentType } from './types'
import { Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Running migrations, as iight migrate does and, in iight dev, the admin's Migrations page (PLAN.md section 6)

// What a run is doing: a migration, by name, or rebuilding entry_relations once content migrations have run, with how
// many rows it has done of how many, which the CMS's own migrations don't count
export interface RunStep {
  kind: 'migration' | 'links'
  name: string | null
  done: number | null
  total: number | null
}

export interface RunResult {
  // The migrations that ran, in order, each committed
  ran: Array<string>
  // The migration that failed, which changed nothing, or null for a failure outside any migration: before one starts,
  // such as with the database down, or once every migration has run, as the links are rebuilt
  failed?: { name: string | null; message: string; error: unknown; during: 'migrations' | 'links' }
  // Whether entry_relations was rebuilt, or is due one that waits for the content migrations still waiting
  links?: 'rebuilt' | 'waiting'
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Where a rebuild of entry_relations finds what it needs: the site project's migrations folder, the types, and the
// type editor's turns, when it has them
export interface LinkSources {
  dir: string
  types: () => Promise<Map<string, ContentType>>
  queued?: <T>(work: () => Promise<T>) => Promise<T>
}

// Rebuild entry_relations once content migrations have changed entries' values since it was last rebuilt, which they
// record in their transactions, so a rebuild a restart cut short is finished by the next run or start. It waits while
// any content migration does, since the types already have its change and the entries' values don't: rebuilt from them,
// every link of a field it renames would go, and a file still linked could be deleted. It replies whether it rebuilt or
// waits, or nothing when no rebuild is due, and leaves one due when another migration ran while it went.
export async function rebuildLinks(
  db: Kysely<Database>,
  { dir, types, queued = (work) => work() }: LinkSources,
  progress?: (done: number, total: number) => void,
): Promise<RunResult['links']> {
  const due = await db
    .selectFrom('rebuilds')
    .select('due')
    .where('name', '=', 'entry_relations')
    .executeTakeFirst()
    // A database whose CMS migrations haven't made the table yet has nothing due
    .catch((error) => {
      if ((error as { code?: string })?.code === '42P01') return undefined
      throw error
    })
  if (!due) return undefined
  // In the type editor's turn, so no change to a type is between its file and its migration, and the types come first,
  // so a change saved after them is among those that wait
  const sources = await queued(async () => {
    const loaded = new Map(await types())
    const ran = new Set((await ranMigrations(db)).map((row) => row.name))
    return (await readMigrations(dir)).some((file) => !ran.has(file.name)) ? undefined : loaded
  })
  if (!sources) return 'waiting'
  await rebuildRelations(db, sources, progress)
  await db.deleteFrom('rebuilds').where('name', '=', 'entry_relations').where('due', '=', due.due).execute()
  return 'rebuilt'
}

// What stopped a migration. Another run, such as iight migrate in a terminal, running the same migration first fails
// this one on the migration's unique name, which the database's own message doesn't explain.
function failureOf(name: string | undefined, error: unknown) {
  const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string }
  return code === '23505' && constraint === 'migrations_name_key'
    ? `${name} ran elsewhere while this run went, such as through npx iight migrate, so this run stopped there.`
    : messageOf(error)
}

// Run every waiting migration as one batch: the CMS's own, then the site project's content migrations, each in its own
// transaction. A migration that throws changes nothing, and those after it don't run. Then entry_relations is rebuilt
// once it's due and no content migration waits, as rebuildLinks has it. It reports what has run, each once it has
// committed, and what it's doing as it goes.
export async function runMigrations(
  db: Kysely<Database>,
  {
    cms,
    content,
    links,
  }: {
    cms: Migrations
    content: Record<string, ContentMigrationFile>
    links: LinkSources
  },
  report: (progress: { ran: Array<string>; step: RunStep | null }) => void = () => {},
): Promise<RunResult> {
  const clash = Object.keys(content).find((name) => Object.hasOwn(cms, name))
  if (clash) throw new Error(`The content migration ${clash} has the name of one of the CMS's migrations. Rename it.`)

  const ran: Array<string> = []
  // The migration whose transaction is open, if any
  let running: string | undefined
  let step: RunStep | null = null
  const show = (next: RunStep | null) => report({ ran: [...ran], step: (step = next) })
  const rows = (done: number, total: number) => show({ kind: 'migration', name: running!, done, total })

  let failed: RunResult['failed']
  try {
    await migrateWith(db, [cms, contentMigrations(content, rows)], {
      starting: (name) => {
        running = name
        show({ kind: 'migration', name, done: null, total: null })
      },
      // Once its transaction has committed, so one whose commit fails is never counted
      ran: (name) => {
        running = undefined
        ran.push(name)
        show(step)
      },
    })
  } catch (error) {
    failed = { name: running ?? null, message: failureOf(running, error), error, during: 'migrations' }
  }

  let rebuilt: RunResult['links']
  try {
    rebuilt = await rebuildLinks(db, links, (done, total) => show({ kind: 'links', name: null, done, total }))
  } catch (error) {
    failed ??= {
      name: null,
      message: `Rebuilding the links between entries failed: ${messageOf(error)}`,
      error,
      during: 'links',
    }
  }
  show(null)
  return { ran, failed, links: rebuilt }
}

type Notes = ReturnType<typeof notesOf>

// A waiting migration's TODOs, which stop it running: make:migration's stubs change nothing, so running one would mark
// it as run with nothing converted, and nothing would run it again
export const todosIn = (name: string, notes: Notes) =>
  notes
    .filter((note) => note.kind === 'todo')
    .map((note) => `${name} still has a TODO, at line ${note.line}: ${note.text}.`)

// What a waiting content migration does, from its up's helper calls, its flags and TODOs, or why it doesn't load
interface Described {
  steps: Array<Record<string, unknown>>
  notes: Notes
  problem: string | null
  // The file as loaded, which a run runs
  file?: ContentMigrationFile
}

// A migration as the Migrations page lists it, in the order iight migrate runs them
type Listed = {
  name: string
  kind: 'cms' | 'content'
  status: 'waiting' | 'ran'
  batch: number | null
  ranAt: Date | null
} & Partial<Omit<Described, 'file'>>

// A run, as the page follows it. Runs live in this server's memory, so a restart forgets the last.
interface Run {
  status: 'running' | 'done' | 'failed'
  // What it runs, in order, and which of them have run
  migrations: Array<string>
  ran: Array<string>
  step: RunStep | null
  failed: { name: string | null; message: string } | null
  startedBy: { id: string; name: string }
  startedAt: Date
  finishedAt: Date | null
}

// The admin's Migrations page: every migration, which anyone signed in can list under iight start too, and in iight dev,
// where runnable is true, Run and Check entries. One run goes at a time, in the background, which the page follows.
export function migrationRoutes(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  {
    dir,
    runnable,
    queued,
    finish = false,
    cmsDir = migrationsDir,
  }: {
    // The site project's migrations folder
    dir?: string
    // Whether its migrations run from here
    runnable: boolean
    // The type editor's turns, which a rebuild of the links takes one of to see the types and what waits
    queued?: LinkSources['queued']
    // Whether to finish a rebuild of the links a run left due, as the servers do as they start
    finish?: boolean
    // Where the CMS's own migrations are
    cmsDir?: string
  },
) {
  const app = new Hono<AdminEnv>()
  const links: LinkSources = { dir: dir ?? '', types: async () => types, queued }

  // The CMS's own migrations as this server's code shipped them, loaded as it starts rather than whatever a git pull
  // has put in the package's folder since, so the database never gets ahead of the code that's running
  const cms = loadMigrations(cmsDir)
  cms.catch(() => {})
  const cmsMigrations = () => cms

  // Paths in a loader's messages are the site's own, which anyone signed in can read under iight start too, so they
  // name files from the site's folder, such as migrations/2026_11_02_181947_blog.ts
  const site = dir && dirname(dir)
  // The folder as given and as the disk names it, such as /private/tmp for /tmp on macOS
  const roots = site ? [...new Set([site, existsSync(site) ? realpathSync(site) : site])] : []
  const relative = (message: string) =>
    roots.reduce(
      (text, root) => text.replaceAll(`${pathToFileURL(root).href}/`, '').replaceAll(`${root}${sep}`, ''),
      message,
    )

  // A rebuild a restart cut short, which the next start finishes once nothing waits
  if (finish) {
    void rebuildLinks(db, links).then(
      (rebuilt) => rebuilt === 'rebuilt' && console.log('Rebuilt the links between entries, which a run left due.'),
      (error) => console.error('Rebuilding the links between entries failed:', error),
    )
  }

  // What each version of a waiting file does, so following a run doesn't declare its steps again
  const described = new Map<string, Promise<Described>>()
  const describe = (file: MigrationFile<ContentMigrationFile>) => {
    const key = `${file.name}?${file.hash}`
    if (!described.has(key)) {
      const found = (async (): Promise<Described> => {
        try {
          const loaded = await file.load()
          if (typeof loaded.up !== 'function' || typeof loaded.down !== 'function') {
            throw new Error('It must export an up and a down function.')
          }
          return { steps: await callsOf(loaded.up), notes: notesOf(file.text), problem: null, file: loaded }
        } catch (error) {
          // A file that doesn't load is looked at again, since what it imports may be fixed without it changing
          described.delete(key)
          return { steps: [], notes: [], problem: relative(messageOf(error)) }
        }
      })()
      described.set(key, found)
    }
    return described.get(key)!
  }

  // Every migration, the CMS's then the site's, each in name order, with what each waiting content migration does,
  // and waiting, a hash of the waiting migrations and their files, which Run sends back
  const list = async () => {
    const [migrations, files, rows] = await Promise.all([
      cmsMigrations(),
      dir ? readMigrations<ContentMigrationFile>(dir) : [],
      ranMigrations(db),
    ])
    const ran = new Map(rows.map((row) => [row.name, row]))
    const statusOf = (name: string) => {
      const row = ran.get(name)
      return row
        ? { status: 'ran' as const, batch: row.batch, ranAt: row.migrated_at }
        : { status: 'waiting' as const, batch: null, ranAt: null }
    }

    const content: Record<string, ContentMigrationFile> = {}
    const data: Array<Listed> = Object.keys(migrations)
      .sort()
      .map((name) => ({ name, kind: 'cms', ...statusOf(name) }))
    for (const file of files) {
      // One named like a CMS migration can't be told apart from it, so it waits, as iight migrate refuses it too
      if (Object.hasOwn(migrations, file.name)) {
        const problem = "It has the name of one of the CMS's migrations. Rename it."
        data.push({
          name: file.name,
          kind: 'content',
          status: 'waiting',
          batch: null,
          ranAt: null,
          steps: [],
          notes: [],
          problem,
        })
        continue
      }
      const listed: Listed = { name: file.name, kind: 'content', ...statusOf(file.name) }
      if (listed.status === 'ran') {
        data.push(listed)
        continue
      }
      const { file: loaded, ...what } = await describe(file)
      if (loaded) content[file.name] = loaded
      data.push({ ...listed, ...what })
    }

    const hashes = new Map(files.map((file) => [file.name, file.hash]))
    const waiting = data
      .filter((item) => item.status === 'waiting')
      .map((item) => [item.kind, item.name, item.kind === 'content' ? hashes.get(item.name) : null])
    const hash = waiting.length ? createHash('sha256').update(JSON.stringify(waiting)).digest('hex').slice(0, 16) : null
    return { data, waiting: hash, content }
  }

  let run: Run | undefined
  // Set from the moment Run is asked for until it's refused or done, so two at once can't both start
  let busy = false

  // The run as it was before the list is read, so a run that ends meanwhile still shows as running with a list from
  // before its last migration, and the page asks again
  app.get('/migrations', async (c) => {
    const shown = run ? structuredClone(run) : null
    const { data, waiting } = await list()
    return c.json({ data, waiting, run: shown })
  })

  const dev: MiddlewareHandler<AdminEnv> = async (_c, next) => {
    if (!runnable) {
      throw new HTTPException(403, {
        message: 'Migrations run from the admin only in development, with iight dev. Run npx iight migrate.',
      })
    }
    await next()
  }

  // Runs every waiting migration, as iight migrate does, once it knows the page showed what's waiting now. It replies as
  // the run starts, and the run goes on whether or not the page stays.
  app.post('/migrations/run', dev, async (c) => {
    if (busy) throw new HTTPException(409, { message: 'Migrations are already running.' })
    busy = true
    try {
      const sent = await c.req.json().catch(() => ({}))
      const { data, waiting, content } = await list()
      const pending = data.filter((item) => item.status === 'waiting')
      if (!pending.length) throw new HTTPException(409, { message: 'Nothing to migrate.' })
      if (sent?.waiting !== waiting) {
        throw new HTTPException(409, {
          message: 'The migrations waiting have changed since the page loaded. Look at them again before running them.',
        })
      }
      const todos = pending.flatMap((item) => todosIn(item.name, item.notes ?? []))
      // A loader's own message may not end its sentence
      const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)
      const problems = pending.flatMap((item) =>
        item.problem ? [ended(`${item.name} doesn't load: ${item.problem}`)] : [],
      )
      if (todos.length || problems.length) {
        const advice = todos.length
          ? 'Finish each TODO, then delete its TODO comment, and run them again.'
          : 'Fix it, then run them again.'
        throw new HTTPException(409, { message: [...todos, ...problems, advice].join(' ') })
      }

      const user = c.get('user')
      const started: Run = {
        status: 'running',
        migrations: pending.map((item) => item.name),
        ran: [],
        step: null,
        failed: null,
        startedBy: { id: user.id, name: user.name },
        startedAt: new Date(),
        finishedAt: null,
      }
      run = started
      void (async () => {
        try {
          const result = await runMigrations(db, { cms: await cmsMigrations(), content, links }, (progress) =>
            Object.assign(started, progress),
          )
          started.ran = result.ran
          if (result.failed) {
            console.error(result.failed.error)
            started.failed = { name: result.failed.name, message: result.failed.message }
          }
        } catch (error) {
          console.error(error)
          started.failed = { name: null, message: messageOf(error) }
        } finally {
          started.status = started.failed ? 'failed' : 'done'
          started.step = null
          started.finishedAt = new Date()
          busy = false
        }
      })()
      return c.json({ data: started }, 202)
    } catch (error) {
      busy = false
      throw error
    }
  })

  // What iight migrate --check lists: every saved entry's draft and live copy that doesn't pass, up to 100 of them
  app.get('/migrations/check', dev, async (c) => {
    const failures = await checkEntries(db, types)
    const titleOf = (entry: { type: string; values: Record<string, unknown> }) => {
      const field = types.get(entry.type)?.titleField
      const title = field ? entry.values[field] : undefined
      return title === undefined || title === null || title === '' ? null : String(title)
    }
    return c.json({
      data: {
        entries: new Set(failures.map(({ entry }) => entry.id)).size,
        failures: failures.slice(0, 100).map(({ entry, published, messages }) => ({
          entry: {
            id: entry.id,
            type: entry.type,
            title: titleOf(entry),
            archived: 'archived_at' in entry && !!entry.archived_at,
          },
          copy: published ? 'live' : 'draft',
          messages,
        })),
      },
    })
  })

  return app
}
