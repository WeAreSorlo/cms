import { createApp } from '../src/app'
import { contentMigrations } from '../src/content'
import { uuidv7 } from '../src/db'
import { Migration, loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { rebuildRelations } from '../src/relations'
import { migrationRoutes, rebuildLinks, runMigrations } from '../src/runMigrations'
import { tools } from '../src/tools'
import { db } from './database'
import { blog, setUp, types } from './fixtures'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

// The admin's Migrations page (PLAN.md section 6): every migration listed, with what each waiting one does, and in sorlo
// dev, where the type editor is, Run, which runs them as sorlo migrate does, and Check entries, which is
// sorlo migrate --check.

let cookie: string
let userId: string

beforeAll(async () => ({ cookie, userId } = await setUp()))
afterAll(() => db.destroy())

// The site project's migrations folder
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sorlo-site-migrations-'))
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('migrations').where('name', 'like', '2099_%').execute()
  await db.deleteFrom('rebuilds').execute()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true })
})

type App = ReturnType<typeof createApp>

// The server as sorlo dev makes it, with the type editor, or as sorlo start does without it
const site = ({ editor = true, types: loaded = types, finishLinks = false } = {}) =>
  createApp(db, loaded, {
    siteMigrations: dir,
    finishLinks,
    ...(editor && { editor: { types: join(dir, 'types'), migrations: dir } }),
  })

// The types with blog posts' author field renamed, as the type editor's Save leaves them until its migration has run
const renamed = new Map([
  ...types,
  [
    'blog',
    { ...blog, fields: blog.fields.map((field) => (field.id === 'fld_author' ? { ...field, name: 'writer' } : field)) },
  ],
])

// How many changes have made the links due a rebuild, or undefined when none is due
const due = async () =>
  (await db.selectFrom('rebuilds').select('due').where('name', '=', 'entry_relations').executeTakeFirst())?.due

// The database, losing its connection as the given transaction begins
function flaky(failing: number) {
  let count = 0
  return new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') {
        return () =>
          ++count === failing
            ? { execute: async () => Promise.reject(new Error('Connection lost')) }
            : target.transaction()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const send = async (app: App, method: string, path: string, body?: unknown, signedIn = true) => {
  const headers = { origin: 'http://localhost', 'content-type': 'application/json', ...(signedIn && { cookie }) }
  const response = await app.request(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// A content migration's file, whose up and down are the lines given
const write = (name: string, up: Array<string>, down: Array<string> = []) =>
  writeFile(
    join(dir, `${name}.ts`),
    [
      'export const up = ({ entries }) => {',
      ...up,
      '}',
      'export const down = ({ entries }) => {',
      ...down,
      '}',
      '',
    ].join('\n'),
  )

// The list once the run it shows, if any, has finished
async function finished(app: App) {
  for (;;) {
    const { body } = await send(app, 'GET', '/migrations')
    if (body.run?.status !== 'running') return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const entry = (values: object, type = 'blog') => ({ id: uuidv7(), type, values })
const valuesOf = async (id: string) =>
  (await db.selectFrom('entries').select('values').where('id', '=', id).executeTakeFirstOrThrow()).values
const linked = () => db.selectFrom('entry_relations').select(['entry_id', 'field_id', 'target_id']).execute()

// The CMS's last migration as if it hadn't run, by its down
async function unrunLastCmsMigration() {
  const cms = await loadMigrations(migrationsDir)
  const last = Object.keys(cms).sort().at(-1)!
  await cms[last].down(db)
  await db.deleteFrom('migrations').where('name', '=', last).execute()
  return last
}

test("lists every migration, the CMS's then the site's, with what each waiting one does", async () => {
  await write('2099_01_01_000000_blog', [
    "  entries.renameField('blog', 'title', 'headline')",
    "  // Flagged: deletes the values of summary, which down can't bring back. Old versions keep them",
    "  entries.removeField('blog', 'summary')",
    "  entries.addField('blog', 'featured', false)",
    '  // TODO: views changed from text to number. Convert its values here, and back in down',
    "  entries.mapField('blog', 'views', (value) => value)",
    "  entries.renameLayout('blog', 'blocks.text', 'blocks.prose')",
    "  entries.removeLayout('blog', 'blocks.gallery')",
    "  entries.renameType('blog', 'posts')",
    "  entries.update('posts', (values) => values)",
  ])
  await writeFile(join(dir, '2099_01_02_000000_broken.ts'), 'export const up = () => {}\n')
  await writeFile(join(dir, '.snapshot.json'), '{}')

  const { status, body } = await send(site(), 'GET', '/migrations')
  expect(status).toBe(200)
  const cms = Object.keys(await loadMigrations(migrationsDir)).sort()
  expect(body.data.slice(0, cms.length)).toEqual(
    cms.map((name) => ({ name, kind: 'cms', status: 'ran', batch: 1, ranAt: expect.any(String) })),
  )
  expect(body.data.slice(cms.length)).toEqual([
    {
      name: '2099_01_01_000000_blog',
      kind: 'content',
      status: 'waiting',
      batch: null,
      ranAt: null,
      steps: [
        { helper: 'renameField', type: 'blog', from: 'title', to: 'headline' },
        { helper: 'removeField', type: 'blog', path: 'summary' },
        { helper: 'addField', type: 'blog', path: 'featured', value: false },
        { helper: 'mapField', type: 'blog', path: 'views' },
        { helper: 'renameLayout', type: 'blog', from: 'blocks.text', to: 'blocks.prose' },
        { helper: 'removeLayout', type: 'blog', path: 'blocks.gallery' },
        { helper: 'renameType', from: 'blog', to: 'posts' },
        { helper: 'update', type: 'posts' },
      ],
      notes: [
        {
          kind: 'flag',
          line: 3,
          text: "deletes the values of summary, which down can't bring back. Old versions keep them",
        },
        { kind: 'todo', line: 6, text: 'views changed from text to number. Convert its values here, and back in down' },
      ],
      problem: null,
    },
    {
      name: '2099_01_02_000000_broken',
      kind: 'content',
      status: 'waiting',
      batch: null,
      ranAt: null,
      steps: [],
      notes: [],
      problem: 'It must export an up and a down function.',
    },
  ])
  expect(body.waiting).toMatch(/^[0-9a-f]{16}$/)
  expect(body.run).toBeNull()

  // A content migration named like one of the CMS's can't be told apart from it, so it waits with that problem
  await write(cms[0], [])
  const clash = await send(site(), 'GET', '/migrations')
  expect(clash.body.data.find((item: any) => item.kind === 'content' && item.name === cms[0])).toEqual({
    name: cms[0],
    kind: 'content',
    status: 'waiting',
    batch: null,
    ranAt: null,
    steps: [],
    notes: [],
    problem: "It has the name of one of the CMS's migrations. Rename it.",
  })
})

test('a migration that ran is listed with its batch, and nothing waits', async () => {
  const { last } = await db
    .selectFrom('migrations')
    .select((eb) => eb.fn.max('batch').as('last'))
    .executeTakeFirstOrThrow()
  await write('2099_01_01_000000_blog', ["  entries.addField('blog', 'featured', false)"])
  await migrate(db, contentMigrations({ '2099_01_01_000000_blog': { up: () => {}, down: () => {} } }))
  const { body } = await send(site(), 'GET', '/migrations')
  expect(body.data.at(-1)).toEqual({
    name: '2099_01_01_000000_blog',
    kind: 'content',
    status: 'ran',
    batch: Number(last) + 1,
    ranAt: expect.any(String),
  })
  expect(body.waiting).toBeNull()
})

test("Run runs the CMS's waiting migrations, then the site's, as one batch, and rebuilds the links", async () => {
  const last = await unrunLastCmsMigration()
  const author = entry({ name: 'Ada' }, 'authors')
  const post = entry({ title: 'Hello', slug: 'hello', author: author.id })
  await db.insertInto('entries').values([author, post]).execute()
  await write('2099_01_01_000000_blog', ["  entries.renameField('blog', 'title', 'headline')"])
  await write('2099_01_02_000000_blog', ["  entries.addField('blog', 'featured', false)"])

  const app = site()
  const listed = await send(app, 'GET', '/migrations')
  expect(listed.body.data.filter((item: any) => item.status === 'waiting').map((item: any) => item.name)).toEqual([
    last,
    '2099_01_01_000000_blog',
    '2099_01_02_000000_blog',
  ])

  const started = await send(app, 'POST', '/migrations/run', { waiting: listed.body.waiting })
  expect(started.status).toBe(202)
  expect(started.body.data).toMatchObject({
    status: 'running',
    migrations: [last, '2099_01_01_000000_blog', '2099_01_02_000000_blog'],
    startedBy: { id: userId, name: 'Ada' },
    finishedAt: null,
  })

  const done = await finished(app)
  expect(done.run).toMatchObject({
    status: 'done',
    ran: [last, '2099_01_01_000000_blog', '2099_01_02_000000_blog'],
    step: null,
    failed: null,
    finishedAt: expect.any(String),
  })
  expect(done.waiting).toBeNull()
  expect(done.data.every((item: any) => item.status === 'ran')).toBe(true)

  const batches = await db
    .selectFrom('migrations')
    .select(['name', 'batch'])
    .where('name', 'in', [last, '2099_01_01_000000_blog', '2099_01_02_000000_blog'])
    .execute()
  expect(new Set(batches.map((row) => row.batch)).size).toBe(1)
  expect(await valuesOf(post.id)).toEqual({ headline: 'Hello', slug: 'hello', author: author.id, featured: false })
  expect(await linked()).toEqual([{ entry_id: post.id, field_id: 'fld_author', target_id: author.id }])
})

test('a run says what it is doing as it goes, a batch of rows at a time', async () => {
  await db
    .insertInto('entries')
    .values(Array.from({ length: 600 }, (_, index) => entry({ title: `Post ${index}`, slug: `post-${index}` })))
    .execute()
  const name = '2099_01_01_000000_blog'
  const reported: Array<unknown> = []
  const result = await runMigrations(
    db,
    {
      cms: {},
      content: { [name]: { up: ({ entries }) => entries.renameField('blog', 'title', 'headline'), down: () => {} } },
      links: { dir, types: async () => types },
    },
    (progress) => reported.push(structuredClone(progress)),
  )

  expect(result).toEqual({ ran: [name], links: 'rebuilt' })
  const migration = (done: number | null, total: number | null) => ({ kind: 'migration', name, done, total })
  const links = (done: number) => ({ kind: 'links', name: null, done, total: 600 })
  expect(reported).toEqual([
    { ran: [], step: migration(null, null) },
    { ran: [], step: migration(0, 600) },
    { ran: [], step: migration(500, 600) },
    { ran: [], step: migration(600, 600) },
    // Once it has committed
    { ran: [name], step: migration(600, 600) },
    { ran: [name], step: links(0) },
    { ran: [name], step: links(500) },
    { ran: [name], step: links(600) },
    { ran: [name], step: null },
  ])
  expect(await due()).toBeUndefined()
})

test('a failure partway keeps the migrations before it, and the links as they were while the rest wait', async () => {
  vi.spyOn(console, 'error').mockImplementationOnce(() => {})
  const author = entry({ name: 'Ada' }, 'authors')
  const post = entry({ title: 'Hello', slug: 'hello', author: author.id })
  await db.insertInto('entries').values([author, post]).execute()
  const link = { entry_id: post.id, field_id: 'fld_author', target_id: author.id }
  await db.insertInto('entry_relations').values(link).execute()
  await write('2099_01_01_000000_blog', ["  entries.addField('blog', 'featured', true)"])
  await write('2099_01_02_000000_blog', [
    "  entries.renameField('blog', 'author', 'writer')",
    "  entries.update('blog', () => { throw new Error('Not this one') })",
  ])
  await write('2099_01_03_000000_blog', ["  entries.addField('blog', 'views', 1)"])

  // The types already have the rename, as the type editor's Save leaves them until its migration runs
  const app = site({ types: renamed })
  const { body } = await send(app, 'GET', '/migrations')
  expect((await send(app, 'POST', '/migrations/run', { waiting: body.waiting })).status).toBe(202)
  const done = await finished(app)

  expect(done.run).toMatchObject({
    status: 'failed',
    ran: ['2099_01_01_000000_blog'],
    failed: { name: '2099_01_02_000000_blog', message: 'Not this one' },
  })
  expect(done.data.slice(-3).map((item: any) => item.status)).toEqual(['ran', 'waiting', 'waiting'])
  expect(await valuesOf(post.id)).toEqual({ title: 'Hello', slug: 'hello', author: author.id, featured: true })
  // Rebuilt from the types, which are ahead of the values, the post would lose its author's link, and the author
  // could be deleted while the post still names it
  expect(await linked()).toEqual([link])
  expect(await due()).toBe(1)
})

test("a type's change saved while a run goes leaves the links for later, since its migration waits", async () => {
  const author = entry({ name: 'Ada' }, 'authors')
  const post = entry({ title: 'Hello', slug: 'hello', author: author.id })
  await db.insertInto('entries').values([author, post]).execute()
  const link = { entry_id: post.id, field_id: 'fld_author', target_id: author.id }
  await db.insertInto('entry_relations').values(link).execute()

  // While the run's migration goes, the type editor renames the author field and writes the rename's migration
  const live = new Map(types)
  const saved = async () => {
    live.set('blog', renamed.get('blog')!)
    await write('2099_01_02_000000_blog', ["  entries.renameField('blog', 'author', 'writer')"])
  }
  const name = '2099_01_01_000000_blog'
  const result = await runMigrations(db, {
    cms: {},
    content: {
      [name]: {
        up: async ({ entries }) => {
          await saved()
          entries.addField('blog', 'featured', false)
        },
        down: () => {},
      },
    },
    links: { dir, types: async () => live },
  })

  expect(result).toMatchObject({ ran: [name], links: 'waiting' })
  expect(result.failed).toBeUndefined()
  expect(await linked()).toEqual([link])
  expect(await due()).toBe(1)
})

test('a save while the links are rebuilt keeps its own, and the rebuild goes on', async () => {
  // The rebuild takes entries in their IDs' order, and IDs made in the same millisecond sort at random, so the author
  // gets the first ID and the posts the rest, in order. The first post and its author are then in the first batch, and
  // the last post in the last.
  const ids = Array.from({ length: 1201 }, () => uuidv7()).sort()
  const author = { ...entry({ name: 'Ada' }, 'authors'), id: ids[0] }
  const posts = Array.from({ length: 1200 }, (_, index) => ({
    ...entry({ title: `Post ${index}`, slug: `post-${index}`, author: author.id }),
    id: ids[index + 1],
  }))
  await db
    .insertInto('entries')
    .values([author, ...posts])
    .execute()
  const link = (post: { id: string }) => ({ entry_id: post.id, field_id: 'fld_author', target_id: author.id })
  await db.insertInto('entry_relations').values(posts.map(link)).execute()

  // The last post's links held, so the rebuild stops in its last batch, long after its first
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const holding = new Promise<void>((resolve) => (held = resolve))
  const holder = db.transaction().execute(async (trx) => {
    await trx.selectFrom('entry_relations').selectAll().where('entry_id', '=', posts.at(-1)!.id).forUpdate().execute()
    held()
    await released
  })
  await holding
  let firstBatch!: () => void
  const pastFirst = new Promise<void>((resolve) => (firstBatch = resolve))
  const rebuilding = rebuildRelations(db, types, (done) => done >= 500 && firstBatch())
  await pastFirst

  // The first post, which the first batch rebuilt, saves while the rebuild waits in its last
  const values = { ...posts[0].values, title: 'Saved meanwhile' }
  const saving = send(site(), 'PUT', `/entries/${posts[0].id}`, { values })
  const saved = await Promise.race([saving, new Promise((resolve) => setTimeout(() => resolve('waiting'), 5000))])
  release()
  await holder
  await rebuilding
  expect(saved).toMatchObject({ status: 200 })
  const rows = await linked()
  expect(rows).toHaveLength(1200)
  expect(rows.filter((row) => row.entry_id === posts[0].id)).toEqual([
    { entry_id: posts[0].id, field_id: 'fld_author', target_id: author.id },
  ])
}, 20_000)

test('a rebuild of the links leaves alone those of an entry saved since it began', async () => {
  const [ada, grace] = [entry({ name: 'Ada' }, 'authors'), entry({ name: 'Grace' }, 'authors')]
  // Its values still name Ada, and its links, which a save wrote, Grace
  const post = {
    ...entry({ title: 'Hello', slug: 'hello', author: ada.id }),
    updated_at: new Date(Date.now() + 60_000),
  }
  await db.insertInto('entries').values([ada, grace, post]).execute()
  const link = { entry_id: post.id, field_id: 'fld_author', target_id: grace.id }
  await db.insertInto('entry_relations').values(link).execute()

  await rebuildRelations(db, types)
  expect(await linked()).toEqual([link])
})

test('a rebuild of the links that a restart cuts short stays due, and the next start finishes it', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const author = entry({ name: 'Ada' }, 'authors')
  const post = entry({ title: 'Hello', slug: 'hello', author: author.id })
  await db.insertInto('entries').values([author, post]).execute()

  const name = '2099_01_01_000000_blog'
  const result = await runMigrations(
    db,
    {
      cms: {},
      content: { [name]: { up: ({ entries }) => entries.addField('blog', 'featured', false), down: () => {} } },
      links: { dir, types: async () => types },
    },
    ({ step }) => {
      // As a restart would stop it
      if (step?.kind === 'links') throw new Error('Restarted')
    },
  )
  expect(result).toMatchObject({ ran: [name], failed: { name: null, during: 'links' } })
  expect(await linked()).toEqual([])
  expect(await due()).toBe(1)

  // The server starting again finishes it
  site({ finishLinks: true })
  await vi.waitFor(async () => expect(await due()).toBeUndefined())
  expect(await linked()).toEqual([{ entry_id: post.id, field_id: 'fld_author', target_id: author.id }])
})

test('a migration that makes the links due again while they are rebuilt leaves them due', async () => {
  await db.insertInto('rebuilds').values({ name: 'entry_relations', due: 1 }).execute()
  // Another run's migration commits once the rebuild has seen what's due
  const meanwhile = async () => {
    await db.updateTable('rebuilds').set({ due: 2 }).execute()
    return types
  }
  expect(await rebuildLinks(db, { dir, types: meanwhile })).toBe('rebuilt')
  expect(await due()).toBe(2)
})

test('a migration counts as run once it commits, and a failure outside any names none', async () => {
  const table = (name: string): Migration => ({
    up: (db) => db.schema.createTable(name).addColumn('id', 'integer').execute(),
    down: (db) => db.schema.dropTable(name).execute(),
  })
  const links = { dir, types: async () => types }
  try {
    // The database goes as the second migration's transaction begins, after the first committed
    const between = await runMigrations(flaky(2), {
      cms: { '2099_01_01_000000_one': table('runs_one'), '2099_01_02_000000_two': table('runs_two') },
      content: {},
      links,
    })
    expect(between.ran).toEqual(['2099_01_01_000000_one'])
    expect(between.failed).toMatchObject({ name: null, during: 'migrations', message: 'Connection lost' })

    // And before the first starts
    const before = await runMigrations(flaky(1), {
      cms: { '2099_01_03_000000_three': table('runs_three') },
      content: {},
      links,
    })
    expect(before.ran).toEqual([])
    expect(before.failed).toMatchObject({ name: null, during: 'migrations' })
  } finally {
    await db.schema.dropTable('runs_one').ifExists().execute()
  }
})

test("the CMS's own migrations are the ones there when the server started", async () => {
  const cmsDir = await mkdtemp(join(tmpdir(), 'sorlo-cms-migrations-'))
  const migration = 'export const up = async () => {}\nexport const down = async () => {}\n'
  await writeFile(join(cmsDir, '2099_01_01_000000_first.ts'), migration)
  try {
    const routes = migrationRoutes(db, types, { runnable: false, cmsDir })
    await new Promise((resolve) => setTimeout(resolve, 200))
    // A git pull brings another while the server runs
    await writeFile(join(cmsDir, '2099_01_02_000000_second.ts'), migration)
    const { data } = await (await routes.request('/migrations')).json()
    expect(data.map((item: { name: string }) => item.name)).toEqual(['2099_01_01_000000_first'])
  } finally {
    await rm(cmsDir, { recursive: true })
  }
})

test("a file that doesn't load says so with paths from the site's folder, not the server's", async () => {
  await writeFile(
    join(dir, '2099_01_01_000000_broken.ts'),
    "export const up = ({ entries }) => {\n  entries.addField('blog', 'views', 0\n}\nexport const down = () => {}\n",
  )
  const { body } = await send(site({ editor: false }), 'GET', '/migrations')
  const { problem } = body.data.at(-1)
  expect(problem).toContain('2099_01_01_000000_broken.ts')
  expect(problem).not.toContain(dirname(dir))
  expect(problem).not.toContain(dirname(realpathSync(dir)))
})

test("another run taking a migration first is said in words, not in the database's", async () => {
  const name = '2099_01_01_000000_elsewhere'
  // As sorlo migrate in a terminal would, while this run's migration is going
  const elsewhere = { up: async () => void (await db.insertInto('migrations').values({ name, batch: 99 }).execute()) }
  const { ran, failed } = await runMigrations(db, {
    cms: { [name]: { ...elsewhere, down: async () => {} } },
    content: {},
    links: { dir, types: async () => types },
  })
  expect(ran).toEqual([])
  expect(failed).toMatchObject({
    name,
    message: `${name} ran elsewhere while this run went, such as through npx sorlo migrate, so this run stopped there.`,
  })
})

test('Run refuses when nothing waits, when what waits has changed, and while a TODO or a problem is left', async () => {
  const app = site()
  const nothing = await send(app, 'GET', '/migrations')
  expect(await send(app, 'POST', '/migrations/run', { waiting: nothing.body.waiting })).toEqual({
    status: 409,
    body: { message: 'Nothing to migrate.' },
  })

  const changed = {
    status: 409,
    body: {
      message: 'The migrations waiting have changed since the page loaded. Look at them again before running them.',
    },
  }
  await write('2099_01_01_000000_blog', ["  entries.addField('blog', 'featured', false)"])
  const first = await send(app, 'GET', '/migrations')
  // A new one, and an edit to one shown, each change what waits
  await write('2099_01_02_000000_blog', ["  entries.addField('blog', 'views', 0)"])
  expect(await send(app, 'POST', '/migrations/run', { waiting: first.body.waiting })).toEqual(changed)
  const second = await send(app, 'GET', '/migrations')
  await write('2099_01_02_000000_blog', ["  entries.removeField('blog', 'views')"])
  expect(await send(app, 'POST', '/migrations/run', { waiting: second.body.waiting })).toEqual(changed)
  expect(await send(app, 'POST', '/migrations/run', {})).toEqual(changed)

  await write('2099_01_02_000000_blog', [
    '  // TODO: views changed from text to number. Convert its values here, and back in down',
    "  entries.mapField('blog', 'views', (value) => value)",
  ])
  await writeFile(join(dir, '2099_01_03_000000_broken.ts'), 'export const up = () => {}\n')
  const third = await send(app, 'GET', '/migrations')
  expect(await send(app, 'POST', '/migrations/run', { waiting: third.body.waiting })).toEqual({
    status: 409,
    body: {
      message:
        '2099_01_02_000000_blog still has a TODO, at line 2: views changed from text to number. Convert its values ' +
        "here, and back in down. 2099_01_03_000000_broken doesn't load: It must export an up and a down function. " +
        'Finish each TODO, then delete its TODO comment, and run them again.',
    },
  })
  expect(await db.selectFrom('migrations').select('name').where('name', 'like', '2099_%').execute()).toEqual([])
})

test('one run goes at a time, which every page sees', async () => {
  await db
    .insertInto('entries')
    .values(Array.from({ length: 2000 }, (_, index) => entry({ title: `Post ${index}`, slug: `post-${index}` })))
    .execute()
  await write('2099_01_01_000000_blog', ["  entries.renameField('blog', 'title', 'headline')"])
  const app = site()
  const { body } = await send(app, 'GET', '/migrations')

  const [first, second] = await Promise.all([
    send(app, 'POST', '/migrations/run', { waiting: body.waiting }),
    send(app, 'POST', '/migrations/run', { waiting: body.waiting }),
  ])
  expect([first.status, second.status].sort()).toEqual([202, 409])
  expect([first, second].find((reply) => reply.status === 409)!.body).toEqual({
    message: 'Migrations are already running.',
  })
  expect((await send(app, 'GET', '/migrations')).body.run).toMatchObject({ startedBy: { id: userId, name: 'Ada' } })

  const done = await finished(app)
  expect(done.run).toMatchObject({ status: 'done', ran: ['2099_01_01_000000_blog'] })
  expect(await db.selectFrom('migrations').select('name').where('name', 'like', '2099_%').execute()).toHaveLength(1)
})

test('a TODO finished after the server first loaded its file runs as it is now', async () => {
  const post = entry({ title: 'Hello', slug: 'hello', views: '7' })
  await db.insertInto('entries').values(post).execute()
  const name = '2099_01_01_000000_blog'
  await write(name, [
    '  // TODO: views changed from text to number. Convert its values here, and back in down',
    "  entries.mapField('blog', 'views', (value) => value)",
  ])

  const app = site()
  const first = await send(app, 'GET', '/migrations')
  expect((await send(app, 'POST', '/migrations/run', { waiting: first.body.waiting })).status).toBe(409)

  // The developer writes the conversion and deletes the TODO
  await write(name, ["  entries.mapField('blog', 'views', (value) => Number(value))"])
  const second = await send(app, 'GET', '/migrations')
  expect(second.body.data.at(-1)).toMatchObject({ notes: [], steps: [{ helper: 'mapField', path: 'views' }] })
  expect((await send(app, 'POST', '/migrations/run', { waiting: second.body.waiting })).status).toBe(202)
  expect((await finished(app)).run.status).toBe('done')
  expect((await valuesOf(post.id)).views).toBe(7)
})

test("an old version catches up with a migration's code as it is now, not as the server first loaded it", async () => {
  const post = entry({ title: 'Hello', slug: 'hello' })
  await db.insertInto('entries').values(post).execute()
  await db.insertInto('entry_versions').values({ entry_id: post.id, number: 1, values: post.values }).execute()
  const name = '2099_01_01_000000_blog'
  await write(name, ["  entries.renameField('blog', 'title', 'heading')"])

  const app = site()
  // Saving loads the migration, waiting, so the server has the slip
  expect((await send(app, 'PUT', `/entries/${post.id}`, { values: post.values })).status).toBe(409)

  // It's put right before it runs
  const fixed = { up: ({ entries }: any) => entries.renameField('blog', 'title', 'headline'), down: () => {} }
  await write(name, ["  entries.renameField('blog', 'title', 'headline')"])
  await migrate(db, contentMigrations({ [name]: fixed }))

  const { body } = await send(app, 'GET', `/entries/${post.id}/versions/1`)
  expect(body.data.values).toEqual({ headline: 'Hello', slug: 'hello' })
})

test('Check entries lists the drafts and live copies that no longer pass, up to 100, and counts them all', async () => {
  const gone = { ...entry({ name: 'Gone' }, 'events'), archived_at: new Date() }
  const fine = entry({ title: 'Fine', slug: 'fine' })
  await db.insertInto('entries').values([gone, fine]).execute()
  await db
    .insertInto('entry_versions')
    .values([gone, fine].map((row) => ({ entry_id: row.id, number: 1, values: row.values })))
    .execute()
  // The live copy is from before its title was required
  const now = new Date()
  await db
    .insertInto('published_entries')
    .values({ id: fine.id, type: 'blog', values: { slug: 'fine' }, created_at: now, updated_at: now, version: 1 })
    .execute()

  const app = site()
  const { status, body } = await send(app, 'GET', '/migrations/check')
  expect(status).toBe(200)
  expect(body).toEqual({
    data: {
      entries: 2,
      failures: [
        {
          entry: { id: gone.id, type: 'events', title: null, archived: true },
          copy: 'draft',
          messages: { type: ["There's no content type named events any more."] },
        },
        {
          entry: { id: fine.id, type: 'blog', title: null, archived: false },
          copy: 'live',
          messages: { title: ['This field is required.'] },
        },
      ],
    },
  })

  const many = Array.from({ length: 100 }, () => entry({ name: 'Gone' }, 'events'))
  await db.insertInto('entries').values(many).execute()
  await db
    .insertInto('entry_versions')
    .values(many.map((row) => ({ entry_id: row.id, number: 1, values: row.values })))
    .execute()
  const capped = await send(app, 'GET', '/migrations/check')
  expect(capped.body.data.entries).toBe(102)
  expect(capped.body.data.failures).toHaveLength(100)
})

test('only sorlo dev runs and checks, and only someone signed in sees the list', async () => {
  await write('2099_01_01_000000_blog', ["  entries.addField('blog', 'featured', false)"])
  const app = site({ editor: false })
  const { status, body } = await send(app, 'GET', '/migrations')
  expect(status).toBe(200)
  expect(body.data.at(-1)).toMatchObject({ name: '2099_01_01_000000_blog', status: 'waiting' })

  const refused = {
    status: 403,
    body: { message: 'Migrations run from the admin only in development, with sorlo dev. Run npx sorlo migrate.' },
  }
  expect(await send(app, 'POST', '/migrations/run', { waiting: body.waiting })).toEqual(refused)
  expect(await send(app, 'GET', '/migrations/check')).toEqual(refused)
  expect(await send(app, 'GET', '/migrations', undefined, false)).toEqual({
    status: 401,
    body: { message: 'Unauthenticated.' },
  })
})

test('no tool for the assistant or MCP runs, checks or rolls back migrations', () => {
  expect(tools.map((tool) => tool.name).filter((name) => /migrat|rollback/i.test(name))).toEqual([])
})
