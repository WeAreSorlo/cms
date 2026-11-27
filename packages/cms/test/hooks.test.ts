import { ValidationError } from '../src'
import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { readVersion } from '../src/entries'
import { type HookSettings, siteHooks } from '../src/hooks'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { hashToken } from '../src/passwords'
import { runMigrations } from '../src/runMigrations'
import { hookRuntime } from '../src/sorlo'
import { tools } from '../src/tools'
import { exportContent, importContent } from '../src/transfer'
import type { ContentType } from '../src/types'
import { db, resetDb } from './database'
import { contactFields, setUp, types } from './fixtures'
import { FSDriver } from 'flydrive/drivers/fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

// Lifecycle hooks: contentHooks, mediaHooks and formHooks around every write, with plugins' hooks first

// Notes, with a worked-out reading time, a list and a flag for templates, which can't be published
const notes: ContentType = {
  id: 'typ_notes',
  name: 'notes',
  label: 'Notes',
  structure: 'collection',
  titleField: 'title',
  fields: [
    { id: 'fld_note_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_note_body', type: 'textarea', name: 'body', label: 'Body' },
    { id: 'fld_note_minutes', type: 'number', name: 'minutes', label: 'Reading time', options: { min: 0 } },
    { id: 'fld_note_summary', type: 'text', name: 'summary', label: 'Summary', required: true },
    {
      id: 'fld_note_tags',
      type: 'repeater',
      name: 'tags',
      options: { fields: [{ id: 'fld_note_tag', type: 'text', name: 'label', options: { maxLength: 10 } }] },
    },
    { id: 'fld_note_template', type: 'boolean', name: 'template', label: 'Template' },
  ],
}
const all = new Map([...types, ['notes', notes]])

let cookie: string
let root: string
const storage = () => ({
  default: 'local',
  services: { local: () => new FSDriver({ location: join(root, 'storage'), visibility: 'public' }) },
})

// What the hooks saw, in the order they ran
let calls: Array<string>
let errors: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sorlo-hooks-'))
})
beforeEach(async () => {
  ;({ cookie } = await setUp())
  calls = []
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errors.mockRestore())
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await db.destroy()
})

const appWith = (hooks: HookSettings) => createApp(db, all, { hooks, storage: storage() })

// The admin API, as the signed-in person
const call = async (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) => {
  const response = await app.request(`/api${path}`, {
    method,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

const draft = { title: 'Hello', body: 'one two three', summary: 'Hi' }
const create = (app: ReturnType<typeof createApp>, values: Record<string, any> = draft, publish = false) =>
  call(app, 'POST', '/types/notes/entries', { values, publish })

test('before hooks run in order, the plugins’ first, then * and the type’s own, each on the values before', async () => {
  const add =
    (name: string) =>
    ({ values }: { values: Record<string, any> }) => {
      calls.push(name)
      return { ...values, summary: `${values.summary} ${name}` }
    }
  const app = appWith({
    plugins: [
      { name: 'first', contentHooks: { '*': { beforeSave: add('plugin *') }, notes: { beforeSave: add('plugin') } } },
    ],
    contentHooks: {
      notes: { beforeSave: add('site') },
      '*': { beforeSave: add('site *') },
      blog: { beforeSave: add('blog') },
    },
  })

  const { status, body } = await create(app)
  expect(status).toBe(201)
  expect(calls).toEqual(['plugin *', 'plugin', 'site *', 'site'])
  expect(body.data.values.summary).toBe('Hi plugin * plugin site * site')
})

test('a worked-out value is a field beforeSave fills in, keeping one changed by hand', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        beforeSave: ({ values, original }) => {
          const worked = Math.ceil(String(values.body ?? '').split(/\s+/).length / 200)
          // Someone changed it by hand in this save
          if (original && values.minutes !== original.minutes) return
          return { ...values, minutes: worked }
        },
      },
    },
  })
  const { body } = await create(app)
  expect(body.data.values.minutes).toBe(1)

  const kept = await call(app, 'PUT', `/entries/${body.data.id}`, { values: { ...body.data.values, minutes: 9 } })
  expect(kept.body.data.values.minutes).toBe(9)
})

test('a refusal merges into core’s report as a 422, by dotted path, with _entry for the whole entry', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        beforeSave: () => {
          throw new ValidationError({ title: 'Titles must be unique.', 'tags.1.label': 'Not this tag.', _entry: 'No.' })
        },
      },
    },
  })
  const { status, body } = await create(app, { ...draft, tags: [{ label: 'a' }, { label: 'b' }] })
  expect(status).toBe(422)
  expect(body.isValid).toBe(false)
  expect(body.fields.title).toMatchObject({ isValid: false, messages: ['Titles must be unique.'] })
  expect(body.fields._entry).toEqual({ isValid: false, messages: ['No.'] })
  expect(body.fields.tags.isValid).toBe(false)
  expect(body.fields.tags.children[1].fields.label).toMatchObject({ isValid: false, messages: ['Not this tag.'] })
  expect(body.fields.tags.children[0].fields.label.isValid).toBe(true)
  expect(await db.selectFrom('entries').select('id').where('type', '=', 'notes').execute()).toEqual([])
})

test('before hooks run only on values that pass core’s checks', async () => {
  const app = appWith({ contentHooks: { notes: { beforeSave: () => void calls.push('ran') } } })
  expect((await create(app, { ...draft, tags: [{ label: 'far too long' }] })).status).toBe(422)
  expect(calls).toEqual([])
})

test('values a hook returns are checked again in the save’s mode, failing as a server error naming the hook', async () => {
  const clear = ({ values }: { values: Record<string, any> }) => ({ ...values, summary: '' })
  const app = appWith({ contentHooks: { notes: { beforeSave: clear } } })

  // A draft can be unfinished
  expect((await create(app)).status).toBe(201)

  // A publish can't, and nor can values that fail any check
  const published = await create(app, draft, true)
  expect(published.status).toBe(500)
  expect(published.body.message).toBe(
    "contentHooks.notes.beforeSave in sorlo.config.ts returned values that don't pass their checks. The server's log says why.",
  )
  expect(errors.mock.calls.flat().join('\n')).toContain('summary:')

  const long = appWith({
    contentHooks: { notes: { beforeSave: ({ values }) => ({ ...values, tags: [{ label: 'far too long' }] }) } },
  })
  expect((await create(long)).status).toBe(500)
  expect(await db.selectFrom('entries').select('id').where('type', '=', 'notes').execute()).toHaveLength(1)
})

test('another error a before hook throws fails the write as a server error naming the hook', async () => {
  const app = appWith({
    plugins: [
      {
        name: 'broken',
        contentHooks: {
          '*': {
            beforeSave: () => {
              throw new Error('Oops')
            },
          },
        },
      },
    ],
  })
  const { status, body } = await create(app)
  expect(status).toBe(500)
  expect(body.message).toBe("contentHooks['*'].beforeSave from the plugin broken failed. The server's log says why.")
})

test('after hooks run once the write commits, and their errors leave the reply a success', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        afterSave: async ({ entry, operation }) => {
          // Another connection sees its version, so it has committed
          const saved = await db
            .selectFrom('entry_versions')
            .select('number')
            .where('entry_id', '=', entry!.id)
            .execute()
          calls.push(`${operation} ${saved.length} ${entry!.status}`)
          throw new Error('After')
        },
        afterPublish: () => void calls.push('published'),
      },
    },
  })
  const { status, body } = await create(app, draft, true)
  expect(status).toBe(201)
  expect(calls).toEqual(['create 1 published', 'published'])
  expect(errors.mock.calls.flat().join('\n')).toContain(
    'contentHooks.notes.afterSave in sorlo.config.ts failed after the write',
  )

  // A save that changes nothing runs no save hooks
  calls = []
  await call(app, 'PUT', `/entries/${body.data.id}`, { values: body.data.values })
  expect(calls).toEqual([])
})

test('warnings come back beside a successful save, nested as core’s report is', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        beforeSave: ({ warn }) => {
          warn('title', 'Titles over 60 characters get cut.')
          warn('tags.0.label', 'An odd tag.')
        },
        afterSave: ({ warn }) => warn('_entry', 'Another note has these dates.'),
      },
    },
  })
  const { status, body } = await create(app, { ...draft, tags: [{ label: 'a' }] })
  expect(status).toBe(201)
  expect(body.warnings).toEqual({
    fields: {
      title: { messages: ['Titles over 60 characters get cut.'] },
      tags: { messages: [], children: [{ fields: { label: { messages: ['An odd tag.'] } } }] },
      _entry: { messages: ['Another note has these dates.'] },
    },
  })
  // None without a warning
  expect((await create(appWith({}))).body.warnings).toBeUndefined()
})

test('beforePublish refuses entries that mustn’t go live, merged into the publish’s report', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        beforePublish: ({ values }) => {
          if (values.template) throw new ValidationError({ template: 'Templates are only for duplicating.' })
        },
      },
    },
  })
  const template = (await create(app, { ...draft, template: true })).body.data
  const published = await call(app, 'PUT', `/entries/${template.id}`, { values: template.values, publish: true })
  expect(published.status).toBe(422)
  expect(published.body.fields.template.messages).toEqual(['Templates are only for duplicating.'])
  expect((await call(app, 'GET', `/entries/${template.id}`)).body.data.status).toBe('draft')
})

test('archive, restore and unpublish hooks refuse with a 422 report, one bulk row at a time', async () => {
  const keep = new Set<string>()
  const app = appWith({
    contentHooks: {
      '*': {
        beforeArchive: ({ entry }) => {
          if (keep.has(entry!.id)) throw new ValidationError({ _entry: 'This one stays.' })
        },
        afterArchive: ({ entry, source }) => void calls.push(`archived ${entry!.archivedAt !== null} ${source}`),
        // The live copy's values, not the draft's
        beforeUnpublish: ({ values }) => void calls.push(`unpublishing ${values.title}`),
        afterUnpublish: ({ entry, values }) => void calls.push(`unpublished ${entry!.status} ${values.title}`),
        afterRestore: () => void calls.push('restored'),
      },
    },
  })
  const one = (await create(app, draft, true)).body.data
  const two = (await create(app, { ...draft, title: 'Two' })).body.data
  keep.add(one.id)

  const refused = await call(app, 'POST', `/entries/${one.id}/archive`)
  expect(refused.status).toBe(422)
  expect(refused.body).toEqual({
    isValid: false,
    fields: { _entry: { isValid: false, messages: ['This one stays.'] } },
  })

  const bulk = await call(app, 'POST', '/types/notes/entries/archive', { ids: [one.id, two.id] })
  expect(bulk.body.data.map((row: any) => row.status)).toEqual([422, 200])
  expect(bulk.body.data[0].report.fields._entry.messages).toEqual(['This one stays.'])
  expect(calls).toEqual(['archived true bulk'])

  await call(app, 'POST', `/entries/${two.id}/restore`)
  await call(app, 'PUT', `/entries/${one.id}`, { values: { ...one.values, title: 'Changed' } })
  await call(app, 'POST', `/entries/${one.id}/unpublish`)
  expect(calls).toEqual(['archived true bulk', 'restored', 'unpublishing Hello', 'unpublished draft Hello'])
})

test('sorlo reads and writes as the person, through the same checks and hooks, sharing context to stop loops', async () => {
  const app = appWith({
    contentHooks: {
      notes: {
        beforeSave: ({ values, context }) => {
          calls.push(`save ${context.counting ? 'counted' : 'sent'}`)
          return values
        },
        afterSave: async ({ entry, sorlo, context, user }) => {
          if (context.counting) return
          context.counting = true
          const found = await sorlo.entries.get(entry!.id)
          const { data } = await sorlo.entries.update(entry!.id, {
            values: { minutes: (found!.values.minutes ?? 0) + 1 },
          })
          calls.push(`updated by ${data.updatedBy === user!.id} to ${data.values.minutes}`)
          const listed = await sorlo.entries.list('notes', {
            where: [[{ field: 'values.title', op: '=', value: 'Hello' }]],
          })
          calls.push(`listed ${listed.data.length}`)
        },
      },
    },
  })
  const { body } = await create(app)
  expect(calls).toEqual(['save sent', 'save counted', 'updated by true to 1', 'listed 1'])
  expect((await call(app, 'GET', `/entries/${body.data.id}`)).body.data.values.minutes).toBe(1)
})

test('sorlo stops writes nested past five deep, and a before hook writing its own entry', async () => {
  const looping = appWith({
    contentHooks: {
      notes: {
        afterSave: async ({ entry, sorlo }) => {
          calls.push('loop')
          await sorlo.entries.update(entry!.id, { values: { minutes: calls.length } })
        },
      },
    },
  })
  expect((await create(looping)).status).toBe(201)
  expect(calls).toHaveLength(6)
  expect(errors.mock.calls.flat().join('\n')).toContain('deep, which is likely a loop')

  const own = appWith({
    contentHooks: {
      notes: {
        beforeSave: async ({ entry, sorlo, values }) => {
          if (entry) await sorlo.entries.update(entry.id, { values: { minutes: 3 } })
          return values
        },
      },
    },
  })
  const saved = (await create(own)).body.data
  const again = await call(own, 'PUT', `/entries/${saved.id}`, { values: { ...saved.values, title: 'Again' } })
  expect(again.status).toBe(500)
  expect(errors.mock.calls.flat().join('\n')).toContain("its own before hooks can't write it")
})

test('a before hook writes through the save’s own transaction, so a child page under its own page finishes', async () => {
  const app = appWith({
    contentHooks: {
      docs: {
        beforeSave: async ({ entry, sorlo, context }) => {
          if (!entry || context.made) return
          context.made = true
          // The save holds its page, which a child's link to it needs
          const { data } = await sorlo.entries.create('docs', {
            values: { title: 'Child', slug: 'child' },
            parentId: entry.id,
          })
          // It sees the child, which hasn't committed yet
          calls.push(`made ${(await sorlo.entries.get(data.id))?.parentId === entry.id}`)
        },
      },
    },
  })
  const page = (await call(app, 'POST', '/types/docs/entries', { values: { title: 'Guide', slug: 'guide' } })).body.data
  const saved = await call(app, 'PUT', `/entries/${page.id}`, { values: { title: 'Guide', slug: 'guide-2' } })
  expect(saved.status).toBe(200)
  expect(calls).toEqual(['made true'])
  const child = await db
    .selectFrom('entries')
    .select(['parent_id', 'uri'])
    .where('slug', '=', 'child')
    .executeTakeFirstOrThrow()
  expect(child).toEqual({ parent_id: page.id, uri: 'guide-2/child' })
})

test('a write refused by a later hook takes back what earlier hooks wrote through sorlo', async () => {
  const app = appWith({
    plugins: [
      {
        name: 'logger',
        contentHooks: {
          notes: {
            beforeSave: async ({ values, sorlo, context }) => {
              if (context.logged) return
              context.logged = true
              await sorlo.entries.create('notes', { values: { title: `Log of ${values.title}`, summary: 'Log' } })
            },
          },
        },
      },
    ],
    contentHooks: {
      notes: {
        beforeSave: ({ values }) => {
          if (values.title === 'No') throw new ValidationError({ title: 'Not this one.' })
        },
      },
    },
  })
  expect((await create(app, { ...draft, title: 'No' })).status).toBe(422)
  expect(await db.selectFrom('entries').select('id').where('type', '=', 'notes').execute()).toEqual([])
  expect((await create(app)).status).toBe(201)
  expect(await db.selectFrom('entries').select('id').where('type', '=', 'notes').execute()).toHaveLength(2)
})

test('a content migration’s before hooks can read through sorlo, but not write', async () => {
  await create(appWith({}))
  const results: Array<string> = []
  const hooks = hookRuntime(
    {
      contentHooks: {
        notes: {
          beforeSave: async ({ sorlo, entry }) => {
            results.push(`read ${(await sorlo.entries.get(entry!.id))?.values.body}`)
            await sorlo.entries
              .update(entry!.id, { values: {} }, { skipPermissions: true })
              .catch((error) => results.push(error.message))
          },
        },
      },
    },
    { db, types: all, migrations: async () => ({}) },
  )
  const result = await runMigrations(db, {
    cms: {},
    content: {
      '2099_01_01_000000_hooked': {
        up: ({ entries }) => entries.mapField('notes', 'body', (body: string) => `${body} four`),
        down: () => {},
        hooks: true,
      },
    },
    links: { dir: join(root, 'none'), types: async () => all },
    hooks,
  })
  expect(result.failed).toBeUndefined()
  expect(results).toEqual([
    'read one two three four',
    "A content migration's before hooks can only read through sorlo while it runs. Write in afterSave, which runs once it commits.",
  ])
})

test('MCP’s publish_entries replies with the title its hooks saved', async () => {
  const token = uuidv7()
  const user = await db.selectFrom('users').select('id').executeTakeFirstOrThrow()
  await db
    .insertInto('personal_tokens')
    .values({
      id: token,
      user_id: user.id,
      name: 'Cursor',
      token_hash: hashToken(token),
      scopes: ['drafts', 'publish'],
    })
    .execute()
  const settings: HookSettings = {
    contentHooks: { notes: { beforeSave: ({ values }) => ({ ...values, title: 'Worked out' }) } },
  }
  const hooks = hookRuntime(settings, { db, types: all, migrations: async () => ({}) })
  const note = (await create(appWith({}))).body.data
  const publish = tools.find((tool) => tool.name === 'publish_entries')!
  const context = {
    db,
    types: all,
    migrations: async () => ({}),
    user: { id: user.id, email: 'ada@example.com', name: 'Ada' },
    origin: '',
    writes: { token, publish: true },
    hooks,
  }
  const input = publish.input.parse({ entries: [{ id: note.id, version: note.version, values: { title: 'Sent' } }] })
  const reply = await publish.run(context, input)
  expect(reply.data).toEqual([{ id: note.id, title: 'Worked out', version: 2 }])
})

test('a write sorlo makes that fails its checks throws a ValidationError with its report', async () => {
  let caught: unknown
  const app = appWith({
    contentHooks: {
      notes: {
        afterSave: async ({ sorlo, context }) => {
          if (context.done) return
          context.done = true
          try {
            await sorlo.entries.create('notes', { values: { body: 'no title' }, publish: true })
          } catch (error) {
            caught = error
          }
        },
      },
    },
  })
  await create(app)
  expect(caught).toBeInstanceOf(ValidationError)
  expect((caught as ValidationError).report.fields.title.isValid).toBe(false)
})

test('media hooks run on uploads and on files’ details', async () => {
  const app = appWith({
    mediaHooks: {
      beforeSave: ({ values, operation }) => {
        calls.push(operation)
        if (values.caption === 'refuse') throw new ValidationError({ caption: 'Not this caption.' })
        return { ...values, alt: values.alt ?? 'Worked out' }
      },
      afterSave: ({ entry }) => void calls.push(`saved ${entry!.alt}`),
    },
  })
  const body = new FormData()
  // A 1×1 transparent GIF
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  body.append('file', new File([gif], 'dot.gif'))
  const uploaded = await app.request('/api/media', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost' },
    body,
  })
  const file = (await uploaded.json()).data
  expect(file.alt).toBe('Worked out')

  const refused = await call(app, 'PUT', `/media/${file.id}`, { name: 'dot.gif', caption: 'refuse' })
  expect(refused.status).toBe(422)
  expect(refused.body.fields.caption.messages).toEqual(['Not this caption.'])
  expect(calls).toEqual(['create', 'saved Worked out', 'update'])
})

test('form hooks run on submissions by form name and *, and on archiving them, but not for a bot’s', async () => {
  const app = appWith({
    formHooks: {
      '*': { afterSave: ({ entry, user, source }) => void calls.push(`saved ${entry!.spam} ${user} ${source}`) },
      contact: {
        beforeSave: ({ values }) => {
          if (values.email.endsWith('@example.org')) throw new ValidationError({ email: 'Use a work address.' })
          return { ...values, name: values.name.trim() }
        },
        beforeArchive: () => void calls.push('archiving'),
        afterRestore: () => void calls.push('restored'),
      },
    },
  })
  const form = (await call(app, 'POST', '/forms', { label: 'Contact us', name: 'contact', fields: contactFields })).body
    .data
  await call(app, 'POST', `/forms/${form.id}/open`)
  const submit = (values: Record<string, any>) =>
    app.request(
      `/v1/forms/contact`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) },
      { incoming: { socket: { remoteAddress: `203.0.113.${calls.length + 1}` } } },
    )
  const valid = { name: ' Ada ', email: 'ada@example.com', address: { town: 'Leeds' } }

  const refused = await submit({ ...valid, email: 'ada@example.org' })
  expect(refused.status).toBe(422)
  expect((await refused.json()).fields.email.messages).toEqual(['Use a work address.'])

  const sent = await submit(valid)
  expect(sent.status).toBe(201)
  const { data } = await sent.json()
  expect(data.values.name).toBe('Ada')
  expect(calls).toEqual(['saved false null api'])

  // A bot that fills in the honeypot never reaches the hooks
  expect((await submit({ ...valid, _website: 'spam' })).status).toBe(201)
  expect(calls).toEqual(['saved false null api'])

  await call(app, 'POST', `/submissions/${data.id}/archive`)
  await call(app, 'POST', `/submissions/${data.id}/archive`)
  await call(app, 'POST', `/submissions/${data.id}/restore`)
  expect(calls).toEqual(['saved false null api', 'archiving', 'restored'])
})

test('with no person behind a write, sorlo writes only with skipPermissions', async () => {
  const results: Array<string> = []
  const app = appWith({
    formHooks: {
      contact: {
        afterSave: async ({ sorlo, values }) => {
          await sorlo.entries
            .create('notes', { values: { title: values.name, summary: 'Lead' } })
            .catch((error) => results.push(error.message))
          const { data } = await sorlo.entries.create(
            'notes',
            { values: { title: values.name, summary: 'Lead' } },
            { skipPermissions: true },
          )
          results.push(`made ${data.createdBy}`)
        },
      },
    },
  })
  const form = (await call(app, 'POST', '/forms', { label: 'Contact us', name: 'contact', fields: contactFields })).body
    .data
  await call(app, 'POST', `/forms/${form.id}/open`)
  await app.request(
    '/v1/forms/contact',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' } }),
    },
    { incoming: { socket: { remoteAddress: '203.0.113.9' } } },
  )
  expect(results).toEqual([
    'No person is behind this api write, so sorlo can only read. Pass { skipPermissions: true } to write.',
    'made null',
  ])
})

test('imports run the hooks by default, and skip them when left out', async () => {
  const app = appWith({})
  await create(app, { ...draft, title: 'Imported' }, true)
  const dir = join(root, 'export')
  await exportContent(db, storage(), dir, {})

  const fresh = async () => {
    await resetDb()
    await migrate(db, await loadMigrations(migrationsDir))
  }
  const settings: HookSettings = {
    contentHooks: {
      notes: {
        beforeSave: ({ values, source, operation }) => {
          calls.push(`${operation} ${source}`)
          return { ...values, minutes: 7 }
        },
        beforePublish: () => void calls.push('publish'),
        afterSave: () => void calls.push('after'),
      },
    },
  }
  const hooks = hookRuntime(settings, { db, types: all, migrations: async () => ({}) })

  await fresh()
  await importContent(db, dir, { types: all, migrations: {}, storage: storage(), hooks })
  expect(calls).toEqual(['create import', 'publish', 'after'])
  const live = await db.selectFrom('published_entries').select('values').executeTakeFirstOrThrow()
  expect(live.values.minutes).toBe(7)
  const version = await db.selectFrom('entry_versions').select('values').executeTakeFirstOrThrow()
  expect(version.values.minutes).toBe(7)

  calls = []
  await fresh()
  await importContent(db, dir, { types: all, migrations: {}, storage: storage() })
  expect(calls).toEqual([])
  expect((await db.selectFrom('entries').select('values').executeTakeFirstOrThrow()).values.minutes).toBeUndefined()
})

test('an import that fails after a hook wrote through sorlo leaves nothing behind', async () => {
  const app = appWith({})
  await create(app, { ...draft, title: 'First' })
  await create(app, { ...draft, title: 'Second' })
  const dir = join(root, 'failing')
  await exportContent(db, storage(), dir, {})
  await resetDb()
  await migrate(db, await loadMigrations(migrationsDir))

  const hooks = hookRuntime(
    {
      contentHooks: {
        notes: {
          beforeSave: async ({ values, sorlo, context }) => {
            if (values.title === 'Second') throw new ValidationError({ title: 'Not this one.' })
            if (context.wrote) return
            context.wrote = true
            const made = { values: { title: 'Made', summary: 'By a hook' } }
            await sorlo.entries.create('notes', made, { skipPermissions: true })
            calls.push('wrote')
          },
        },
      },
    },
    { db, types: all, migrations: async () => ({}) },
  )
  const importing = importContent(db, dir, { types: all, migrations: {}, storage: storage(), hooks })
  await expect(importing).rejects.toThrow('Not this one.')
  expect(calls).toEqual(['wrote'])
  expect(await db.selectFrom('entries').select('id').execute()).toEqual([])
  expect(await db.selectFrom('entry_versions').select('entry_id').execute()).toEqual([])
})

test('content migrations skip the hooks unless they opt in', async () => {
  const app = appWith({})
  await create(app, draft, true)
  const settings: HookSettings = {
    contentHooks: {
      notes: {
        beforeSave: ({ values, original, source }) => {
          calls.push(`${source} ${original!.body}`)
          return { ...values, minutes: String(values.body).length }
        },
        afterSave: () => void calls.push('after'),
      },
    },
  }
  const hooks = hookRuntime(settings, { db, types: all, migrations: async () => ({}) })
  const longer = (hooks?: true) => ({
    up: ({ entries }: any) => entries.mapField('notes', 'body', (body: string) => `${body} four`),
    down: () => {},
    hooks,
  })
  const links = { dir: join(root, 'none'), types: async () => all }

  await runMigrations(db, { cms: {}, content: { '2099_01_01_000000_plain': longer() }, links, hooks })
  expect(calls).toEqual([])

  const result = await runMigrations(db, {
    cms: {},
    content: { '2099_01_01_000000_plain': longer(), '2099_01_02_000000_hooked': longer(true) },
    links,
    hooks,
  })
  expect(result.failed).toBeUndefined()
  // The draft and the live copy each, then afterSave for the draft once it commits
  expect(calls).toEqual(['migration one two three four', 'migration one two three four', 'after'])
  const minutes = 'one two three four four'.length
  expect((await db.selectFrom('entries').select('values').executeTakeFirstOrThrow()).values.minutes).toBe(minutes)
  expect((await db.selectFrom('published_entries').select('values').executeTakeFirstOrThrow()).values.minutes).toBe(
    minutes,
  )

  // Its version holds what the hook made, as of the migration, so it reads as the entry does
  const version = await db.selectFrom('entry_versions').selectAll().executeTakeFirstOrThrow()
  expect(version).toMatchObject({ migration: '2099_01_02_000000_hooked', values: { minutes } })
  const files = { '2099_01_01_000000_plain': longer(), '2099_01_02_000000_hooked': longer(true) }
  const read = await readVersion(db, async () => files, { id: version.entry_id, type: 'notes' }, version.number)
  expect(read.values).toEqual((await db.selectFrom('entries').select('values').executeTakeFirstOrThrow()).values)
})

test('hooks are checked as the servers start', () => {
  expect(() => siteHooks({ contentHooks: { notes: { beforeSaving: () => {} } as any } })).toThrow(
    "contentHooks.notes.beforeSaving in sorlo.config.ts isn't a hook.",
  )
  expect(() => siteHooks({ mediaHooks: { beforePublish: () => {} } as any })).toThrow(
    "mediaHooks.beforePublish in sorlo.config.ts isn't a hook. They're beforeSave, afterSave.",
  )
  expect(() => siteHooks({ formHooks: { '*': { afterSave: 'no' } } as any })).toThrow(
    "formHooks['*'].afterSave in sorlo.config.ts needs to be a function.",
  )
})
