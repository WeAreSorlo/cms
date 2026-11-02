import { listView } from '../admin/api'
import { AiError, AiProvider, AiReply, AiRequest } from '../src/ai'
import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { hashToken } from '../src/passwords'
import { ToolContext, callTool, tools } from '../src/tools'
import { type ContentType, checkType } from '../src/types'
import { db } from './database'
import { setUp, types as fixtureTypes } from './fixtures'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { FSDriver } from 'flydrive/drivers/fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, expect, test } from 'vitest'

// Changes through AI (PLAN.md section 21): the write tools, which propose each change in the assistant's chats for the
// person to apply, as a draft or applied and published, and save drafts over MCP for a token with Save drafts. Neither
// the assistant nor MCP ever publishes, unpublishes, archives or deletes, and nothing overwrites a newer edit.

// A type whose entries can show a form
const events: ContentType = {
  id: 'typ_events',
  name: 'events',
  label: 'Events',
  singular: 'Event',
  structure: 'collection',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    { id: 'fld_event_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_event_slug', type: 'identifier', name: 'slug', label: 'Slug', required: true },
    { id: 'fld_event_starts', type: 'datetime', name: 'starts_at', label: 'Starts', required: true },
    { id: 'fld_event_form', type: 'form', name: 'form', label: 'Form' },
  ],
}

// A type whose saves go live, which the write tools leave alone
const notices: ContentType = {
  id: 'typ_notices',
  name: 'notices',
  label: 'Notices',
  structure: 'collection',
  titleField: 'text',
  drafts: false,
  fields: [
    { id: 'fld_notice_text', type: 'text', name: 'text', label: 'Text', required: true },
    { id: 'fld_notice_form', type: 'form', name: 'form', label: 'Form' },
  ],
}

const types = new Map([...fixtureTypes, ['events', events], ['notices', notices]])

// The media library's files, in a folder of their own
const location = join(await mkdtemp(join(tmpdir(), 'iight-changes-')), 'storage')
const storage = { default: 'local', services: { local: () => new FSDriver({ location, visibility: 'public' }) } }

let cookie: string
let userId: string
// A second person, whose chats and proposals are theirs alone
const bob = { id: uuidv7(), cookie: 'iight_session=bob-token' }

beforeAll(async () => {
  ;({ cookie, userId } = await setUp())
  await db
    .insertInto('users')
    .values({ id: bob.id, name: 'Bob', email: 'bob@example.com', password_hash: '' })
    .execute()
  await db
    .insertInto('sessions')
    .values({
      id: uuidv7(),
      user_id: bob.id,
      token_hash: hashToken('bob-token'),
      expires_at: new Date(Date.now() + 60_000),
    })
    .execute()
})

afterAll(() => db.destroy())

type App = ReturnType<typeof createApp>
type Step = (request: AiRequest) => unknown

const reply = (content: AiReply['content'], stop: AiReply['stop'] = 'end', toolCalls: AiReply['toolCalls'] = []) => ({
  content,
  stop,
  toolCalls,
  model: 'fake-model',
  usage: null,
})

const said =
  (text: string): Step =>
  () =>
    reply([{ type: 'text', text }])

// A reply that calls tools, with their inputs made from what the chat has so far
const calls =
  (...calls: Array<{ name: string; input: unknown | ((request: AiRequest) => unknown) }>): Step =>
  (request) => {
    const toolCalls = calls.map(({ name, input }, index) => ({
      id: `toolu_${index}_${Math.random()}`,
      name,
      input: typeof input === 'function' ? input(request) : input,
    }))
    return reply(
      toolCalls.map((call) => ({ type: 'tool_use', ...call })),
      'tools',
      toolCalls,
    )
  }

// The data of the last tool result the chat holds
const lastResult = (request: AiRequest) =>
  JSON.parse(request.messages.at(-1)!.content.find((block) => block.type === 'tool_result')!.content[0].text).data

// The assistant on an app of its own, replying from a script, with MCP on too
function scripted(...script: Array<Step>) {
  const requests: Array<AiRequest> = []
  const provider: AiProvider = {
    async reply(request) {
      requests.push(structuredClone(request))
      return (await (script.shift() ?? said('Done.'))(request)) as AiReply
    },
  }
  return { requests, app: createApp(db, types, { ai: provider, mcp: true, storage }) }
}

const admin = async (app: App, method: string, path: string, body?: unknown, as = cookie) => {
  const headers = { cookie: as, origin: 'http://localhost', 'content-type': 'application/json' }
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

// Sends a message from a page of the admin and waits for the reply's events
async function ask(app: App, chat: string, text: string, as = cookie, page?: Record<string, unknown>) {
  const response = await app.request(`/api/chats/${chat}/messages`, {
    method: 'POST',
    headers: { cookie: as, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ text, page }),
  })
  return (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => ({
      event: /^event: (.*)$/m.exec(chunk)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null'),
    }))
}

const proposalsIn = (events: Awaited<ReturnType<typeof ask>>) =>
  events.flatMap(({ event, data }) => (event === 'step' ? (data.proposals ?? []) : []))

const newChat = async (app: App) => (await admin(app, 'POST', '/chats', {})).body.data.id as string

const post = async (app: App, slug: string, values: Record<string, unknown> = {}, publish = false) => {
  const { body } = await admin(app, 'POST', '/types/blog/entries', {
    values: { title: slug, slug, ...values },
    publish,
  })
  return body.data.id as string
}

const entryOf = async (id: string) =>
  db.selectFrom('entries').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const versionsOf = (id: string) =>
  db.selectFrom('entry_versions').selectAll().where('entry_id', '=', id).orderBy('number').execute()
const eventCount = async () =>
  Number(
    (
      await db
        .selectFrom('events')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()
    ).count,
  )

// A tool as a token calls it, with Save drafts or without
async function asToken(token: string | undefined, name: string, input: unknown) {
  const context: ToolContext = {
    db,
    types,
    migrations: async () => ({}),
    user: { id: userId, email: 'ada@example.com', name: 'Ada' },
    origin: 'http://cms.test',
    ...(token && { writes: { token } }),
  }
  const { content, isError } = await callTool(
    tools.find((tool) => tool.name === name)!,
    context,
    input,
  )
  const texts = content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  const images = content.filter((block) => block.type === 'image')
  return isError ? { error: texts.join('\n') } : { data: JSON.parse(texts[0]).data, note: texts[1], images }
}

async function connect(app: App, token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url, init),
  })
  await client.connect(transport)
  return client
}

test('a token without Save drafts only reads, and one with it saves drafts as its maker, linked to the token', async () => {
  const { app } = scripted()
  const id = await post(app, 'lamp-launch', {}, true)
  const reader = (await admin(app, 'POST', '/tokens', { name: 'Reader' })).body.data
  const writer = (await admin(app, 'POST', '/tokens', { name: 'Claude Desktop', scopes: ['drafts'] })).body.data
  expect(writer.scopes).toEqual(['drafts'])

  const reading = await connect(app, reader.token)
  const offered = (await reading.listTools()).tools.map((tool) => tool.name)
  expect(offered).not.toContain('update_entry')
  expect(reading.getInstructions()).toContain('none of them change anything')
  const refused = await reading
    .callTool({ name: 'update_entry', arguments: { id, values: { title: 'Changed' } } })
    .then(
      (result) => result.isError,
      () => true,
    )
  expect(refused).toBe(true)
  expect((await asToken(undefined, 'update_entry', { id, values: { title: 'Changed' } })).error).toContain(
    'This token can only read.',
  )
  expect((await entryOf(id)).values.title).toBe('lamp-launch')

  const writing = await connect(app, writer.token)
  const listed = (await writing.listTools()).tools
  expect(listed.map((tool) => tool.name)).toEqual(tools.filter((tool) => !tool.assistantOnly).map((tool) => tool.name))
  expect(listed.find((tool) => tool.name === 'create_entry')!.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  })
  expect(listed.find((tool) => tool.name === 'update_entry')!.annotations).toMatchObject({ destructiveHint: true })
  // A second find and replace goes on to more entries
  expect(listed.find((tool) => tool.name === 'replace_text')!.annotations).toMatchObject({
    destructiveHint: true,
    idempotentHint: false,
  })
  expect(writing.getInstructions()).toContain('Nothing here publishes, unpublishes, archives or deletes anything.')

  const saved = await writing.callTool({ name: 'update_entry', arguments: { id, values: { title: 'Lamp launch' } } })
  expect(saved.isError).toBeFalsy()
  const entry = JSON.parse((saved.content as Array<{ text: string }>)[0].text).data
  // A draft, so the live copy stays as it was
  expect(entry).toMatchObject({ status: 'changed', values: { title: 'Lamp launch' } })
  const live = await db.selectFrom('published_entries').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  expect(live.values.title).toBe('lamp-launch')

  const versions = await versionsOf(id)
  expect(versions.at(-1)).toMatchObject({ number: 2, created_by: userId, token_id: writer.id, chat_id: null })
  const listedVersions = (await admin(app, 'GET', `/entries/${id}/versions`)).body.data
  expect(listedVersions[0].via).toEqual({ kind: 'token', id: writer.id, name: 'Claude Desktop' })
  expect(listedVersions[1].via).toBeNull()

  // Revoked, the token's versions keep its name
  await admin(app, 'DELETE', `/tokens/${writer.id}`)
  expect((await admin(app, 'GET', `/entries/${id}/versions`)).body.data[0].via.name).toBe('Claude Desktop')
})

test('no tool publishes, unpublishes, archives or deletes, or touches types without drafts or archived entries', async () => {
  const { app } = scripted()
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Cursor', token_hash: hashToken(token), scopes: ['drafts'] })
    .execute()

  const made = await asToken(token, 'create_entry', { type: 'blog', values: { title: 'New post', slug: 'new-post' } })
  expect(made.data).toMatchObject({ status: 'draft', publishedVersion: null, values: { title: 'New post' } })
  expect(await db.selectFrom('published_entries').select('id').where('id', '=', made.data.id).execute()).toEqual([])
  expect(made.note).toContain('Only a person publishes it')
  // What a publish would still need, since a draft can be unfinished
  const unfinished = await asToken(token, 'create_entry', {
    type: 'events',
    values: { title: 'Meetup', slug: 'meetup' },
  })
  expect(unfinished.note).toContain('values.starts_at: This field is required.')
  // A form field takes a form's id, and a type file can have one
  expect(checkType(events, 'events')).toEqual([])
  const unknown = await asToken(token, 'create_entry', {
    type: 'events',
    values: { title: 'Gig', slug: 'gig', form: uuidv7() },
  })
  expect(unknown.error).toContain("values.form: There's no form with this ID.")

  expect((await asToken(token, 'create_entry', { type: 'notices', values: { text: 'Hi' } })).error).toContain(
    'Notices has no drafts, so its saves go live at once.',
  )
  expect((await asToken(token, 'create_entry', { type: 'home', values: { headline: 'Hi' } })).error).toContain(
    'Homepage has one entry already.',
  )
  const archived = await post(app, 'old-news')
  await admin(app, 'POST', `/entries/${archived}/archive`)
  expect((await asToken(token, 'update_entry', { id: archived, values: { title: 'Back' } })).error).toContain(
    "It's archived.",
  )
  expect((await asToken(token, 'update_entry', { id: made.data.id, values: { title: 'New post' } })).error).toBe(
    'Nothing to change: the entry already holds these values.',
  )
  expect((await asToken(token, 'update_entry', { id: made.data.id, values: { nope: 1 } })).error).toContain(
    'blog has no field named nope.',
  )
  const failed = await asToken(token, 'update_entry', { id: made.data.id, values: { views: 'many' } })
  expect(failed.error).toContain("It doesn't pass its checks:\nvalues.views:")

  // A form made through AI is closed, taking no submissions until a person opens it
  const fields = [{ name: 'email', type: 'email', label: 'Email', required: true }]
  const form = await asToken(token, 'create_form', { label: 'Sign-ups', name: 'sign_ups', fields })
  expect(form.data).toMatchObject({ name: 'sign_ups', open: false })
  const submit = () =>
    app.request(`/v1/forms/${form.data.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lin@example.com' }),
    })
  expect((await submit()).status).toBe(403)
  const changed = await asToken(token, 'update_form', { id: form.data.id, label: 'Sign-ups for the meetup' })
  expect(changed.data).toMatchObject({ label: 'Sign-ups for the meetup', open: false, version: 1 })

  expect((await admin(app, 'POST', `/forms/${form.data.id}/open`)).body.data.open).toBe(true)
  expect((await submit()).status).toBe(201)
  expect((await asToken(token, 'update_form', { id: form.data.id, label: 'Taken over' })).error).toContain(
    "It's taking submissions, so only a person can change it",
  )
  expect((await admin(app, 'POST', `/forms/${form.data.id}/close`)).body.data.open).toBe(false)
})

test('the assistant proposes, and Apply saves the draft as the person, linked to the chat, which others can then read', async () => {
  const id = (await post(scripted().app, 'launch-day', {}, true)) as string
  const { app } = scripted(
    calls({ name: 'update_entry', input: { id, values: { title: 'Launch day!' } } }),
    said('Done.'),
  )
  const chat = await newChat(app)
  const before = await eventCount()

  const events = await ask(app, chat, 'Add an exclamation mark to the title')
  const [proposal] = proposalsIn(events)
  expect(proposal).toMatchObject({
    kind: 'entry',
    targetId: id,
    isNew: false,
    type: 'blog',
    status: 'pending',
    before: { values: { title: 'launch-day' } },
    after: { values: { title: 'Launch day!' } },
    version: null,
    needs: [],
  })
  expect(events.find((event) => event.event === 'step')!.data.text).toBe('Proposed changes to “Launch day!”')

  // Proposing saves nothing: no version, no events
  expect(await versionsOf(id)).toHaveLength(1)
  expect(await eventCount()).toBe(before)

  // Someone else can't apply it, or read the chat, until a version links to it
  expect((await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id] }, bob.cookie)).status).toBe(
    404,
  )
  expect((await admin(app, 'POST', `/chats/${chat}/proposals/skip`, { ids: [proposal.id] }, bob.cookie)).status).toBe(
    404,
  )
  expect((await admin(app, 'GET', `/chats/${chat}`, undefined, bob.cookie)).status).toBe(404)
  expect((await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [] })).status).toBe(400)

  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id] })
  expect(applied.body.data).toEqual([
    { id: proposal.id, status: 200, data: expect.objectContaining({ status: 'applied', version: 2 }) },
  ])
  expect((await entryOf(id)).values.title).toBe('Launch day!')
  expect((await versionsOf(id))[1]).toMatchObject({ number: 2, created_by: userId, chat_id: chat, token_id: null })
  const [latest] = (await admin(app, 'GET', `/entries/${id}/versions`)).body.data
  expect(latest.via).toEqual({ kind: 'chat', id: chat, name: 'Add an exclamation mark to the title' })
  // A draft, with the live copy as it was
  expect((await admin(app, 'GET', `/entries/${id}`)).body.data.status).toBe('changed')

  const again = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id] })
  expect(again.body.data).toEqual([
    {
      id: proposal.id,
      status: 409,
      message: 'It was already applied or skipped.',
      data: expect.objectContaining({ status: 'applied' }),
    },
  ])

  // Linked from a version, the chat opens read-only for anyone signed in
  const read = await admin(app, 'GET', `/chats/${chat}`, undefined, bob.cookie)
  expect(read.body.data).toMatchObject({ id: chat, user: { id: userId, name: 'Ada' } })
  expect(read.body.data.messages[1].parts[0].proposals[0]).toMatchObject({ id: proposal.id, status: 'applied' })
  for (const [method, path, body] of [
    ['PUT', `/chats/${chat}`, { title: 'Mine now' }],
    ['DELETE', `/chats/${chat}`, undefined],
    ['POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id] }],
    ['POST', `/chats/${chat}/proposals/skip`, { ids: [proposal.id] }],
  ] as const) {
    expect((await admin(app, method, path, body, bob.cookie)).status).toBe(404)
  }
  const message = await app.request(`/api/chats/${chat}/messages`, {
    method: 'POST',
    headers: { cookie: bob.cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello' }),
  })
  expect(message.status).toBe(404)
})

test("a proposal never overwrites a newer edit, and the model hears what became of each with the person's next message", async () => {
  const id = await post(scripted().app, 'roadmap', { views: 1 })
  const { app, requests } = scripted(
    calls(
      { name: 'update_entry', input: { id, values: { title: 'Roadmap for 2027' } } },
      { name: 'update_entry', input: { id, values: { views: 2 } } },
    ),
    said('Proposed both.'),
    said('Noted.'),
  )
  const chat = await newChat(app)
  const [title, views] = proposalsIn(await ask(app, chat, 'Fix the title and the views'))

  // Someone saves the title by hand meanwhile
  const edited = await admin(app, 'PUT', `/entries/${id}`, {
    values: { title: 'Roadmap, edited', slug: 'roadmap', views: 1 },
  })
  expect(edited.status).toBe(200)

  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [title.id, views.id] })
  expect(applied.body.data).toEqual([
    {
      id: title.id,
      status: 409,
      message:
        'Not applied: what it changes has been changed since it was proposed. Ask the assistant for a fresh proposal.',
      data: expect.objectContaining({ status: 'stale', version: null }),
    },
    { id: views.id, status: 200, data: expect.objectContaining({ status: 'applied', version: 3 }) },
  ])
  // The hand edit stays, and the views change lands beside it
  expect((await entryOf(id)).values).toMatchObject({ title: 'Roadmap, edited', views: 2 })
  const statuses = await db.selectFrom('proposals').select(['id', 'status']).where('chat_id', '=', chat).execute()
  expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
    [title.id]: 'stale',
    [views.id]: 'applied',
  })

  await ask(app, chat, 'What happened?')
  const told = requests.at(-1)!.messages.at(-1)!.content[0].text
  expect(told).toContain(`Since your last reply, the person applied 1 of your proposals as drafts: ${views.id}.`)
  expect(told).toContain(
    `1 of your proposals couldn't be applied, since what they change was changed after you proposed them: ${title.id}.`,
  )
  expect(told).not.toContain('still wait')
})

test('find and replace proposes each entry it changes, exactly as written, and Apply all saves each', async () => {
  const setup = scripted().app
  const block = (body: string) => [{ _layout: 'text', body }]
  const first = await post(setup, 'launch', {
    title: 'Open to the private preview',
    blocks: block('Join the private preview.'),
  })
  const second = await post(setup, 'pricing', { title: 'Pricing', blocks: block('The private preview is free.') })
  const capital = await post(setup, 'faq', { title: 'Private preview questions' })
  const slugged = await post(setup, 'private-preview-notes', { title: 'Notes' })

  const { app } = scripted(
    calls({ name: 'replace_text', input: { find: 'private preview', replace: 'public beta', types: ['blog'] } }),
  )
  const chat = await newChat(app)
  const events = await ask(app, chat, "Update all references to 'private preview' to 'public beta'")
  const step = events.find((event) => event.event === 'step')!.data
  expect(step.text).toBe('Proposed replacing “private preview” with “public beta” in 2 entries')
  const proposed = step.proposals
  expect(proposed.map((proposal: { targetId: string }) => proposal.targetId).sort()).toEqual([first, second].sort())
  expect(proposed.find((proposal: { targetId: string }) => proposal.targetId === first)).toMatchObject({
    before: { values: { title: 'Open to the private preview', blocks: block('Join the private preview.') } },
    after: { values: { title: 'Open to the public beta', blocks: block('Join the public beta.') } },
  })

  const ids = proposed.map((proposal: { id: string }) => proposal.id)
  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids })
  expect(applied.body.data.map((result: { status: number }) => result.status)).toEqual([200, 200])
  expect((await entryOf(first)).values).toMatchObject({
    title: 'Open to the public beta',
    blocks: block('Join the public beta.'),
  })
  expect((await entryOf(second)).values.blocks).toEqual(block('The public beta is free.'))
  // Other capitals and slugs are left as they are
  expect((await entryOf(capital)).values.title).toBe('Private preview questions')
  expect((await entryOf(slugged)).values.slug).toBe('private-preview-notes')

  // Over MCP, the same call saves the drafts at once, and says what it left
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Cursor', token_hash: hashToken(token), scopes: ['drafts'] })
    .execute()
  const saved = await asToken(token, 'replace_text', { find: 'Private preview', replace: 'Public beta' })
  expect(saved.data).toEqual([{ id: capital, title: 'Public beta questions', replaced: 1 }])
  expect((await versionsOf(capital)).at(-1)).toMatchObject({ token_id: token })
  expect((await asToken(token, 'replace_text', { find: 'nowhere', replace: 'somewhere' })).note).toBe(
    "No entry's text holds “nowhere” exactly as written.\n\n" +
      'Left out Notices, which have no drafts, so their saves go live at once.',
  )
})

test('a page with a form: the form is proposed closed, and applying the entry that shows it makes the form first', async () => {
  const fields = [{ name: 'email', type: 'email', label: 'Email', required: true }]
  const { app } = scripted(
    calls({ name: 'create_form', input: { label: 'Kubecon sign-ups', name: 'kubecon_sign_ups', fields } }),
    calls({
      name: 'create_entry',
      input: (request: AiRequest) => ({
        type: 'events',
        values: {
          title: 'Kubecon stall',
          slug: 'kubecon',
          starts_at: '2026-11-10T09:00',
          form: lastResult(request).id,
        },
      }),
    }),
    said('Proposed a form and its event.'),
  )
  const chat = await newChat(app)
  const [form, entry] = proposalsIn(await ask(app, chat, 'Create a new event page with a form for our Kubecon stall'))
  expect(form).toMatchObject({ kind: 'form', isNew: true, status: 'pending', after: { label: 'Kubecon sign-ups' } })
  expect(entry).toMatchObject({ kind: 'entry', isNew: true, type: 'events', needs: [form.id] })
  expect(entry.after.values.form).toBe(form.targetId)
  expect(await db.selectFrom('forms').select('id').where('id', '=', form.targetId).execute()).toEqual([])

  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [entry.id] })
  expect(applied.body.data.map((result: { id: string; status: number }) => [result.id, result.status])).toEqual([
    [form.id, 200],
    [entry.id, 200],
  ])
  const made = await db.selectFrom('forms').selectAll().where('id', '=', form.targetId).executeTakeFirstOrThrow()
  expect(made).toMatchObject({ name: 'kubecon_sign_ups', open: false, created_by: userId })
  expect((await entryOf(entry.targetId)).values).toMatchObject({ title: 'Kubecon stall', form: form.targetId })

  // Skipping a form skips the entry proposed to show it
  const { app: other } = scripted(
    calls({ name: 'create_form', input: { label: 'Meetup sign-ups', name: 'meetup_sign_ups', fields } }),
    calls({
      name: 'create_entry',
      input: (request: AiRequest) => ({
        type: 'events',
        values: { title: 'Meetup', slug: 'meetup-stall', starts_at: '2026-12-01T18:00', form: lastResult(request).id },
      }),
    }),
  )
  const second = await newChat(other)
  const [skippedForm, skippedEntry] = proposalsIn(await ask(other, second, 'And one for the meetup'))
  const skipped = await admin(other, 'POST', `/chats/${second}/proposals/skip`, { ids: [skippedForm.id] })
  expect(skipped.body.data.map((proposal: { id: string }) => proposal.id).sort()).toEqual(
    [skippedForm.id, skippedEntry.id].sort(),
  )
  expect(await db.selectFrom('entries').select('id').where('id', '=', skippedEntry.targetId).execute()).toEqual([])
})

test('Apply and publish makes the whole draft live as the editor publishes it, and the model hears it was published', async () => {
  const setup = scripted().app
  const id = await post(setup, 'apply-and-publish', {}, true)
  // An edit that isn't live yet, which publishing makes live too
  await admin(setup, 'PUT', `/entries/${id}`, { values: { title: 'Edited, not live', slug: 'apply-and-publish' } })
  const { app, requests } = scripted(
    calls({ name: 'update_entry', input: { id, values: { views: 7 } } }),
    said('Done.'),
    said('Noted.'),
  )
  const chat = await newChat(app)
  const [proposal] = proposalsIn(await ask(app, chat, 'Set the views to 7'))
  expect(proposal).toMatchObject({ entryStatus: 'changed', published: false })

  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id], publish: true })
  expect(applied.body.data).toEqual([
    { id: proposal.id, status: 200, data: expect.objectContaining({ status: 'applied', published: true, version: 3 }) },
  ])
  const live = await db.selectFrom('published_entries').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  expect(live).toMatchObject({ version: 3, values: expect.objectContaining({ title: 'Edited, not live', views: 7 }) })
  expect((await versionsOf(id))[2]).toMatchObject({ number: 3, chat_id: chat, published_by: userId })

  await ask(app, chat, 'Thanks')
  expect(requests.at(-1)!.messages.at(-1)!.content[0].text).toContain(
    `Since your last reply, the person applied and published 1 of your proposals: ${proposal.id}.`,
  )
})

test('a publish that fails its checks saves nothing, and a page published opens the form it shows', async () => {
  const fields = [{ name: 'email', type: 'email', label: 'Email', required: true }]
  const proposeEvent = (name: string, values: Record<string, unknown>) =>
    scripted(
      calls({ name: 'create_form', input: { label: `${name} sign-ups`, name: `${name}_sign_ups`, fields } }),
      calls({
        name: 'create_entry',
        input: (request: AiRequest) => ({ type: 'events', values: { ...values, form: lastResult(request).id } }),
      }),
    )

  // Without a start, the event can be a draft but can't go live
  const { app } = proposeEvent('gig', { title: 'Gig', slug: 'gig-night' })
  const chat = await newChat(app)
  const [form, entry] = proposalsIn(await ask(app, chat, 'A gig page with a form'))
  const failed = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [entry.id], publish: true })
  expect(failed.body.data.map((result: { id: string; status: number }) => [result.id, result.status])).toEqual([
    [form.id, 200],
    [entry.id, 422],
  ])
  expect(failed.body.data[1].message).toContain('starts_at: This field is required.')
  // The form it needed is made, and stays closed, since its page isn't live
  expect(await db.selectFrom('forms').select('open').where('id', '=', form.targetId).executeTakeFirst()).toEqual({
    open: false,
  })
  expect(await db.selectFrom('entries').select('id').where('id', '=', entry.targetId).execute()).toEqual([])
  const draft = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [entry.id] })
  expect(draft.body.data[0]).toMatchObject({ status: 200, data: { status: 'applied', published: false } })

  // With a start it goes live, and its form opens with it
  const { app: other } = proposeEvent('talk', { title: 'Talk', slug: 'talk-night', starts_at: '2026-12-01T18:00' })
  const second = await newChat(other)
  const [talkForm, talk] = proposalsIn(await ask(other, second, 'A talk page with a form'))
  const published = await admin(other, 'POST', `/chats/${second}/proposals/apply`, { ids: [talk.id], publish: true })
  expect(published.body.data.map((result: { data: { published: boolean } }) => result.data.published)).toEqual([
    true,
    true,
  ])
  expect(await db.selectFrom('forms').select('open').where('id', '=', talkForm.targetId).executeTakeFirst()).toEqual({
    open: true,
  })
  expect(await db.selectFrom('published_entries').select('id').where('id', '=', talk.targetId).execute()).toHaveLength(
    1,
  )
})

test("the assistant proposes changes to a type without drafts, which applying publishes, as that type's saves do", async () => {
  const { app, requests } = scripted(
    calls({ name: 'create_entry', input: { type: 'notices', values: { text: 'Closed Friday' } } }),
  )
  const chat = await newChat(app)
  const [proposal] = proposalsIn(await ask(app, chat, 'Add a notice'))
  expect(requests[1].messages.at(-1)!.content[0].content.at(-1).text).toContain(
    'Notices has no drafts, so the person can only apply and publish it.',
  )
  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [proposal.id] })
  expect(applied.body.data[0].data).toMatchObject({ status: 'applied', published: true })
  expect(
    await db.selectFrom('published_entries').select('values').where('id', '=', proposal.targetId).executeTakeFirst(),
  ).toEqual({ values: { text: 'Closed Friday' } })
})

test("a file's details are proposed after view_media shows the images, and applying changes the file at once", async () => {
  const setup = scripted().app
  const upload = async (bytes: Uint8Array | string, name: string) => {
    const body = new FormData()
    body.append('file', new File([bytes as BlobPart], name))
    const response = await setup.request('/api/media', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
      body,
    })
    return (await response.json()).data as { id: string }
  }
  const logo = await upload(
    await sharp({ create: { width: 1200, height: 600, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toBuffer(),
    'acme.png',
  )
  const mark = await upload(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 20'><circle cx='10' cy='10' r='8'/></svg>",
    'mark.svg',
  )
  const terms = await upload('%PDF-1.4\n%%EOF\n', 'terms.pdf')

  const { app, requests } = scripted(
    calls({ name: 'view_media', input: { ids: [logo.id, mark.id, terms.id] } }),
    calls({
      name: 'update_media',
      input: {
        files: [
          { id: logo.id, alt: 'Acme logo' },
          { id: mark.id, alt: 'A black circle' },
          { id: uuidv7(), alt: 'Nothing' },
        ],
      },
    }),
    said('Proposed alt text for both.'),
  )
  const chat = await newChat(app)
  const events = await ask(app, chat, 'Add meaningful alt text to these logos')
  expect(events.filter((event) => event.event === 'step').map((event) => event.data.text)).toEqual([
    'Viewed 2 files',
    'Proposed new details for 2 files',
  ])

  // The model sees each image as the Claude API takes it, scaled to fit 512 pixels, with the SVG drawn
  const [result] = requests[1].messages.at(-1)!.content
  const images = result.content.filter((block: { type: string }) => block.type === 'image')
  expect(images.map((image: { source: { media_type: string } }) => image.source.media_type)).toEqual([
    'image/png',
    'image/png',
  ])
  const sizes = await Promise.all(
    images.map(async (image: { source: { data: string } }) => {
      const { width, height } = await sharp(Buffer.from(image.source.data, 'base64')).metadata()
      return [width, height]
    }),
  )
  expect(sizes).toEqual([
    [512, 256],
    [512, 256],
  ])
  expect(result.content[1].text).toContain("isn't an image")

  const proposed = proposalsIn(events)
  expect(proposed).toEqual([
    expect.objectContaining({ kind: 'media', targetId: logo.id, before: { alt: null }, after: { alt: 'Acme logo' } }),
    expect.objectContaining({
      kind: 'media',
      targetId: mark.id,
      title: 'mark.svg',
      image: expect.stringMatching(/^\/media\//),
    }),
  ])
  expect(requests[2].messages.at(-1)!.content[0].content[1].text).toContain("There's no file with this id.")

  // A file changed by hand meanwhile keeps the change
  const edited = await setup.request(`/api/media/${mark.id}`, {
    method: 'PUT',
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mark.svg', alt: 'Our mark' }),
  })
  expect(edited.status).toBe(200)
  // A file renamed while Apply waits for it keeps its new name, since the proposal doesn't change it
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const renaming = db.transaction().execute(async (trx) => {
    await trx.updateTable('media').set({ name: 'acme-2026.png' }).where('id', '=', logo.id).execute()
    await held
  })
  const before = await eventCount()
  const applying = admin(app, 'POST', `/chats/${chat}/proposals/apply`, {
    ids: proposed.map((file: { id: string }) => file.id),
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  release()
  await renaming
  const applied = await applying
  expect(applied.body.data.map((result: { status: number }) => result.status)).toEqual([200, 409])
  expect(applied.body.data[0].data).toMatchObject({
    status: 'applied',
    published: true,
    image: expect.stringMatching(/^\/media\//),
  })
  expect(applied.body.data[1].data).toMatchObject({ status: 'stale', image: expect.stringMatching(/^\/media\//) })
  const alts = await db
    .selectFrom('media')
    .select(['id', 'name', 'alt'])
    .where('id', 'in', [logo.id, mark.id])
    .execute()
  expect(Object.fromEntries(alts.map((file) => [file.id, [file.name, file.alt]]))).toEqual({
    [logo.id]: ['acme-2026.png', 'Acme logo'],
    [mark.id]: ['mark.svg', 'Our mark'],
  })
  expect(await eventCount()).toBe(before + 1)

  // Over MCP there's no one to apply them, so the tool isn't there
  expect((await asToken(uuidv7(), 'update_media', { files: [{ id: logo.id, alt: 'Changed' }] })).error).toBe(
    "Files' details change on the site at once, so only the admin's assistant proposes them.",
  )
})

test('a list sends the entries "these" means, as the line above the box says, each checked by the server', async () => {
  const setup = scripted().app
  const blog = types.get('blog')!
  const crossing = await post(setup, 'zebra-crossing', { title: 'Zebra crossing' })
  const zoo = await post(setup, 'zebra-zoo', { title: 'Zebra at the zoo' })
  const archived = await post(setup, 'zebra-gone', { title: 'Zebra gone' })
  expect((await admin(setup, 'POST', `/entries/${archived}/archive`)).status).toBe(200)
  const event = await admin(setup, 'POST', '/types/events/entries', {
    values: { title: 'Zebra day', slug: 'zebra-day', starts_at: '2026-12-01T10:00' },
  })

  const { app, requests } = scripted()
  const chat = await newChat(app)
  const sent = async (page: Record<string, unknown>) => {
    await ask(app, chat, 'These?', cookie, page)
    return requests.at(-1)!.messages.at(-1)!.content[0].text as string
  }
  const view = (list: Partial<Parameters<typeof listView>[1]>) =>
    listView(blog, {
      ...{ ticked: [], where: [], order: { createdAt: 'desc' }, searched: false, filtered: false, archived: false },
      ...list,
    })
  // The list's own page of entries, as the admin loads it
  const listOf = async (where: unknown, order: unknown, archived = false) => {
    const query = new URLSearchParams({
      where: JSON.stringify(where),
      order: JSON.stringify(order),
      archived: `${archived}`,
    })
    return (await admin(setup, 'GET', `/types/blog/entries?${query}`)).body
  }

  // Ticked entries, in the order they were ticked
  const ticked = view({ ticked: [zoo, crossing] })
  expect(ticked.label).toBe('Blog posts: 2 ticked')
  expect(await sent(ticked.page)).toContain(
    `on the list of Blog posts, the blog type, and has ticked 2 of its entries, so "these" and "the ticked ones" ` +
      `mean them: ${zoo}, ${crossing}.`,
  )
  // Those that aren't the list's entries now are left out, saying so
  const checked = await sent(view({ ticked: [crossing, archived, event.body.data.id, uuidv7(), 'nope'] }).page)
  expect(checked).toContain(`has ticked 1 of its entries, so "these" and "the ticked ones" mean them: ${crossing}.`)
  expect(checked).toContain("4 of the entries they ticked aren't on the list now, so they're left out.")
  // Ticked entries are never archived ones, whatever else the page says
  const onArchive = await sent({ type: 'blog', ticked: [archived, crossing], archived: true })
  expect(onArchive).toContain(`has ticked 1 of its entries, so "these" and "the ticked ones" mean them: ${crossing}.`)

  // With nothing ticked, the entries the search finds, in the list's order, and never the search itself
  const where = [[{ field: 'values.title', op: 'like', value: 'Zebra' }]]
  const order = { 'values.title': 'asc' }
  const listed = await listOf(where, order)
  expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual([zoo, crossing])
  const searched = view({ where, order, total: listed.pagination.total, searched: true })
  expect(searched.label).toBe('Blog posts: 2 matching your search')
  const found = await sent(searched.page)
  expect(found).toContain(
    `has it filtered to 2 entries, so "these" means them, in the list's order: ${zoo}, ${crossing}.`,
  )
  expect(found).not.toContain('Zebra')
  const archive = view({ where, order, total: (await listOf(where, order, true)).pagination.total, archived: true })
  expect(archive.label).toBe('Blog posts archive: 1 matching your filter')
  expect(await sent(archive.page)).toContain(
    `on the archive of Blog posts, the blog type, and has it filtered to 1 entry, so "these" means them, in the ` +
      `list's order: ${archived}.`,
  )

  // Past 100, ticked or found, only how many
  const many = Array.from({ length: 101 }, () => uuidv7())
  const tooMany = view({ ticked: many })
  expect(tooMany.label).toBe('Blog posts: 101 ticked, too many to send, so tick 100 or fewer')
  const counted = await sent(tooMany.page)
  expect(counted).toContain(
    'has ticked 101 of its entries, too many to name here. If they mean those, ask them to tick 100 or fewer.',
  )
  expect(counted).not.toContain(many[0])
  const crowd = Array.from({ length: 101 }, (_, index) => ({
    id: uuidv7(),
    type: 'blog',
    values: { title: `Crowd ${index}`, slug: `crowd-${index}` },
  }))
  await db.insertInto('entries').values(crowd).execute()
  const crowded = [[{ field: 'values.title', op: 'like', value: 'Crowd' }]]
  const narrow = view({ where: crowded, total: (await listOf(crowded, {})).pagination.total, filtered: true })
  expect(narrow.label).toBe('Blog posts: 101 matching your filter, too many to send, so narrow it to 100 or fewer')
  const crowdedText = await sent(narrow.page)
  expect(crowdedText).toContain(
    'has it filtered to 101 entries, too many to name here. If they mean those, ask them to narrow the search or ' +
      'filter to 100 or fewer.',
  )
  expect(crowdedText).not.toContain(crowd[0].id)
  await db
    .deleteFrom('entries')
    .where(
      'id',
      'in',
      crowd.map((row) => row.id),
    )
    .execute()

  // Nothing ticked and no search or filter, or one the list API turns down, is the type alone
  expect(view({}).label).toBe('Blog posts')
  expect(await sent(view({}).page)).toMatch(/UTC\. The person is on the list of Blog posts, the blog type\.$/)
  expect(await sent({ type: 'blog', where: [[{ field: 'values.nope', op: '=', value: 1 }]] })).toMatch(
    /the blog type\.$/,
  )

  // The media library's file, and a form, when they exist
  const file = uuidv7()
  await db
    .insertInto('media')
    .values({ id: file, disk: 'local', path: 'logo.svg', name: 'logo.svg', mime: 'image/svg+xml', size: 10 })
    .execute()
  expect(await sent({ media: file })).toContain(
    `The person is in the media library and last opened the file with the id ${file}, so "this" means it.`,
  )
  const form = uuidv7()
  await db
    .insertInto('forms')
    .values({ id: form, name: 'page_check', label: 'Page check', fields: '[]', version: 1 })
    .execute()
  expect(await sent({ form })).toContain(`on the page of the form with the id ${form}, so "here" and "this" mean it.`)
  expect(await sent({ media: uuidv7(), form: uuidv7() })).toMatch(/^It's [^.]+ UTC\.$/)
})

test("replace_text changes only the entries given, and names each id it can't change", async () => {
  const setup = scripted().app
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Zed', token_hash: hashToken(token), scopes: ['drafts'] })
    .execute()
  const one = await post(setup, 'sale-one', { title: 'Spring sale one' })
  const two = await post(setup, 'sale-two', { title: 'Spring sale two' })
  const three = await post(setup, 'sale-three', { title: 'Spring sale three' })
  const replacing = { find: 'Spring sale', replace: 'Summer sale' }

  const saved = await asToken(token, 'replace_text', { ...replacing, ids: [two, one] })
  expect(saved.data.map((entry: { id: string }) => entry.id).sort()).toEqual([one, two].sort())
  expect((await entryOf(three)).values.title).toBe('Spring sale three')

  const archived = await post(setup, 'sale-old', { title: 'Spring sale old' })
  await admin(setup, 'POST', `/entries/${archived}/archive`)
  const event = (
    await admin(setup, 'POST', '/types/events/entries', {
      values: { title: 'Spring sale day', slug: 'spring-sale-day', starts_at: '2026-12-01T10:00' },
    })
  ).body.data.id
  const notice = (await admin(setup, 'POST', '/types/notices/entries', { values: { text: 'Spring sale soon' } })).body
    .data.id
  const missing = uuidv7()
  const wrong = await asToken(token, 'replace_text', {
    ...replacing,
    types: ['blog', 'notices'],
    ids: [three, archived, event, notice, missing, 'nope'],
  })
  expect(wrong.error).toBe(
    `Nothing changed: ${archived} is archived; ${event} is an entry of the events type, which isn't one of those ` +
      `named; ${notice} is an entry of the notices type, which has no drafts; ${missing} isn't an entry; nope isn't ` +
      'an entry. Call it again without them.',
  )
  expect((await entryOf(three)).values.title).toBe('Spring sale three')

  // In the admin's assistant, the entries given are the ones proposed
  const { app } = scripted(
    calls({ name: 'replace_text', input: { ...replacing, ids: [three] } }),
    said('Proposed.'),
    calls({ name: 'replace_text', input: { ...replacing, ids: [one, two] } }),
  )
  const chat = await newChat(app)
  const events = await ask(app, chat, 'Replace it in these')
  expect(events.find((event) => event.event === 'step')!.data.text).toBe(
    'Proposed replacing “Spring sale” with “Summer sale” in 1 entry',
  )
  expect(proposalsIn(events).map((proposal: { targetId: string }) => proposal.targetId)).toEqual([three])
  const none = await ask(app, chat, 'And these')
  expect(none.find((event) => event.event === 'step')!.data.text).toBe(
    'Found no “Spring sale” to replace in the 2 entries',
  )
})

// Entries made straight in the database, many at once, each with a title
const many = async (count: number, title: (index: number) => string) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: uuidv7(),
    type: 'blog',
    values: { title: title(index), slug: `many-${uuidv7()}` },
  }))
  await db.insertInto('entries').values(rows).execute()
  return rows.map((row) => row.id)
}
const titlesOf = async (ids: Array<string>) =>
  (await db.selectFrom('entries').select('values').where('id', 'in', ids).execute()).map((row) => row.values.title)

test('find and replace goes through entries in a fixed order from where it stopped, and never replaces twice', async () => {
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Paging', token_hash: hashToken(token), scopes: ['drafts'] })
    .execute()
  // Over MCP each save lands at once, which mustn't move the entries still to come
  const saved = await many(110, (index) => `Zorblax ${index}`)
  const first = await asToken(token, 'replace_text', { find: 'Zorblax', replace: 'Zorblax Corp' })
  expect(first.data).toHaveLength(100)
  const after = /Call it again with after "([0-9a-f-]{36})" for the rest\./.exec(first.note ?? '')?.[1]
  expect(first.note).toContain('10 more entries mention it.')
  const rest = await asToken(token, 'replace_text', { find: 'Zorblax', replace: 'Zorblax Corp', after })
  expect(rest.data).toHaveLength(10)
  expect(rest.note).not.toContain('more entr')
  expect((await titlesOf(saved)).sort()).toEqual(saved.map((_, index) => `Zorblax Corp ${index}`).sort())
  // Text that already reads as the replacement is left alone
  const again = await asToken(token, 'replace_text', { find: 'Zorblax', replace: 'Zorblax Corp' })
  expect(again.data).toEqual([])
  expect(again.note).toContain("No entry's text holds “Zorblax” exactly as written, other than in “Zorblax Corp”.")
  expect((await asToken(token, 'replace_text', { find: 'Zorblax', replace: 'Zorblax Corp', after: 'x' })).error).toBe(
    "after must be the id the last call's note gave.",
  )

  // In a chat, asking again once the first hundred are applied proposes only the rest
  const proposed = await many(110, (index) => `Quxly ${index}`)
  const replacing = { name: 'replace_text', input: { find: 'Quxly', replace: 'Quxly Inc' } }
  const { app } = scripted(calls(replacing), said('Proposed.'), calls(replacing), said('Proposed the rest.'))
  const chat = await newChat(app)
  const hundred = proposalsIn(await ask(app, chat, 'Replace Quxly with Quxly Inc'))
  expect(hundred).toHaveLength(100)
  const ids = hundred.map((proposal: { id: string }) => proposal.id)
  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids })
  expect(applied.body.data.every((result: { status: number }) => result.status === 200)).toBe(true)
  const ten = proposalsIn(await ask(app, chat, 'And the rest'))
  expect(ten.map((proposal: { targetId: string }) => proposal.targetId).sort()).toEqual(
    proposed.filter((id) => !hundred.some((proposal: { targetId: string }) => proposal.targetId === id)).sort(),
  )
  await admin(app, 'POST', `/chats/${chat}/proposals/apply`, {
    ids: ten.map((proposal: { id: string }) => proposal.id),
  })
  expect((await titlesOf(proposed)).sort()).toEqual(proposed.map((_, index) => `Quxly Inc ${index}`).sort())
  await db
    .deleteFrom('entries')
    .where('id', 'in', [...saved, ...proposed])
    .execute()
})

test("a page's form opens exactly when the page goes live, and never on its own in a batch with the page", async () => {
  const fields = [{ name: 'email', type: 'email', label: 'Email', required: true }]
  const form = (name: string) => calls({ name: 'create_form', input: { label: name, name, fields } })
  const entry = (type: string, values: Record<string, unknown>) =>
    calls({
      name: 'create_entry',
      input: (request: AiRequest) => {
        // The form the chat proposed first, whichever results came since
        const made = request.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result')!
        return { type, values: { ...values, form: JSON.parse(made.content[0].text).data.id } }
      },
    })
  const openOf = async (id: string) =>
    db.selectFrom('forms').select(['open', 'first_opened_at']).where('id', '=', id).executeTakeFirstOrThrow()
  const statuses = (body: { data: Array<{ id: string; status: number }> }) =>
    body.data.map((result) => [result.id, result.status])

  // Apply and publish all, in step order, with a page that fails its checks: the form is made but stays closed
  const batch = scripted(form('batch_sign_ups'), entry('events', { title: 'Batch', slug: 'batch-night' }))
  const batchChat = await newChat(batch.app)
  const [batchForm, batchPage] = proposalsIn(await ask(batch.app, batchChat, 'A page with a form'))
  const all = await admin(batch.app, 'POST', `/chats/${batchChat}/proposals/apply`, {
    ids: [batchForm.id, batchPage.id],
    publish: true,
  })
  expect(statuses(all.body)).toEqual([
    [batchForm.id, 200],
    [batchPage.id, 422],
  ])
  expect(await openOf(batchForm.targetId)).toEqual({ open: false, first_opened_at: null })
  // A failed card keeps what it's shown with
  expect(all.body.data[0].data).toMatchObject({ status: 'applied', published: false, title: 'batch_sign_ups' })

  // Retried once the publish can pass, the page goes live and opens the form made for it
  const setup = scripted().app
  const old = await admin(setup, 'POST', '/types/events/entries', {
    values: { title: 'Old night', slug: 'retry-night', starts_at: '2026-12-01T18:00' },
    publish: true,
  })
  await admin(setup, 'PUT', `/entries/${old.body.data.id}`, {
    values: { title: 'Old night', slug: 'old-night', starts_at: '2026-12-01T18:00' },
  })
  const retry = scripted(
    form('retry_sign_ups'),
    entry('events', { title: 'Retry', slug: 'retry-night', starts_at: '2026-12-02T18:00' }),
  )
  const retryChat = await newChat(retry.app)
  const [retryForm, retryPage] = proposalsIn(await ask(retry.app, retryChat, 'A page with a form'))
  const taken = await admin(retry.app, 'POST', `/chats/${retryChat}/proposals/apply`, {
    ids: [retryPage.id],
    publish: true,
  })
  expect(statuses(taken.body)).toEqual([
    [retryForm.id, 200],
    [retryPage.id, 422],
  ])
  expect(await openOf(retryForm.targetId)).toMatchObject({ open: false })
  await admin(setup, 'PUT', `/entries/${old.body.data.id}`, {
    values: { title: 'Old night', slug: 'old-night', starts_at: '2026-12-01T18:00' },
    publish: true,
  })
  const retried = await admin(retry.app, 'POST', `/chats/${retryChat}/proposals/apply`, {
    ids: [retryPage.id],
    publish: true,
  })
  expect(statuses(retried.body)).toEqual([[retryPage.id, 200]])
  expect(await openOf(retryForm.targetId)).toMatchObject({ open: true, first_opened_at: expect.any(Date) })
  expect(
    await db.selectFrom('proposals').select('published').where('id', '=', retryForm.id).executeTakeFirst(),
  ).toEqual({ published: true })

  // Two pages show one new form, and the first fails: the second going live opens it
  const shared = scripted(
    form('shared_sign_ups'),
    entry('events', { title: 'No start', slug: 'no-start' }),
    entry('events', { title: 'Starts', slug: 'starts', starts_at: '2026-12-03T18:00' }),
  )
  const sharedChat = await newChat(shared.app)
  const [sharedForm, failing, passing] = proposalsIn(await ask(shared.app, sharedChat, 'Two pages, one form'))
  const apply = (id: string, publish: boolean) =>
    admin(shared.app, 'POST', `/chats/${sharedChat}/proposals/apply`, { ids: [id], publish })
  expect((await apply(failing.id, true)).body.data.at(-1).status).toBe(422)
  expect(await openOf(sharedForm.targetId)).toMatchObject({ open: false })
  expect((await apply(passing.id, true)).body.data.at(-1).status).toBe(200)
  expect(await openOf(sharedForm.targetId)).toMatchObject({ open: true })

  // A type without drafts goes live once applied, even as a draft, and opens its form
  const notice = scripted(form('notice_sign_ups'), entry('notices', { text: 'Sign up for Friday' }))
  const noticeChat = await newChat(notice.app)
  const [noticeForm, noticePage] = proposalsIn(await ask(notice.app, noticeChat, 'A notice with a form'))
  const live = await admin(notice.app, 'POST', `/chats/${noticeChat}/proposals/apply`, { ids: [noticePage.id] })
  expect(statuses(live.body)).toEqual([
    [noticeForm.id, 200],
    [noticePage.id, 200],
  ])
  expect(live.body.data.map((result: { data: { published: boolean } }) => result.data.published)).toEqual([true, true])
  expect(await openOf(noticeForm.targetId)).toMatchObject({ open: true })
})

test('over MCP, update_form changes only forms that have never been open, and every way of opening one records it', async () => {
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Forms', token_hash: hashToken(token), scopes: ['drafts'] })
    .execute()
  const fields = [{ name: 'email', type: 'email', label: 'Email', required: true }]
  const made = await asToken(token, 'create_form', { label: 'Never open', name: 'never_open', fields })
  const firstOpened = async (id: string) =>
    (await db.selectFrom('forms').select('first_opened_at').where('id', '=', id).executeTakeFirstOrThrow())
      .first_opened_at
  expect(await firstOpened(made.data.id)).toBeNull()
  expect((await asToken(token, 'update_form', { id: made.data.id, label: 'Still never open' })).data).toMatchObject({
    label: 'Still never open',
  })

  // Once it has been open, closing it again doesn't let MCP change it
  const setup = scripted().app
  expect((await admin(setup, 'POST', `/forms/${made.data.id}/open`)).status).toBe(200)
  const opened = await firstOpened(made.data.id)
  expect(opened).toEqual(expect.any(Date))
  await admin(setup, 'POST', `/forms/${made.data.id}/close`)
  await admin(setup, 'POST', `/forms/${made.data.id}/open`)
  expect(await firstOpened(made.data.id)).toEqual(opened)
  await admin(setup, 'POST', `/forms/${made.data.id}/close`)
  expect((await asToken(token, 'update_form', { id: made.data.id, label: 'Changed' })).error).toContain(
    'It has been open before, so a page may show it',
  )
  expect((await admin(setup, 'GET', `/forms/${made.data.id}`)).body.data).not.toHaveProperty('first_opened_at')

  // The admin's assistant still proposes changes to any closed form, which a person applies
  const { app } = scripted(calls({ name: 'update_form', input: { id: made.data.id, label: 'Proposed' } }))
  const chat = await newChat(app)
  const [proposal] = proposalsIn(await ask(app, chat, 'Rename the form'))
  expect(proposal).toMatchObject({ kind: 'form', status: 'pending', after: { label: 'Proposed' } })

  // A form a person makes starts open, and so counts as opened, and so does one applied and published
  const byPerson = await admin(setup, 'POST', '/forms', {
    label: 'By hand',
    name: 'by_hand',
    fields: [{ ...fields[0], id: 'fld_byhand01' }],
  })
  expect(await firstOpened(byPerson.body.data.id)).toEqual(expect.any(Date))
  const { app: other } = scripted(calls({ name: 'create_form', input: { label: 'Applied', name: 'applied', fields } }))
  const second = await newChat(other)
  const [form] = proposalsIn(await ask(other, second, 'A form'))
  await admin(other, 'POST', `/chats/${second}/proposals/apply`, { ids: [form.id], publish: true })
  expect(await firstOpened(form.targetId)).toEqual(expect.any(Date))
})

test('the model hears what became of its proposals even after a reply that failed, and deleted targets turn stale', async () => {
  const setup = scripted().app
  const id = await post(setup, 'outcome-after-failure')
  const gone = await post(setup, 'deleted-since')
  const { app, requests } = scripted(
    calls(
      { name: 'update_entry', input: { id, values: { views: 1 } } },
      { name: 'update_entry', input: { id: gone, values: { views: 2 } } },
    ),
    said('Proposed.'),
    () => {
      throw new AiError('The provider failed.')
    },
    said('Noted.'),
  )
  const chat = await newChat(app)
  const [kept, deleted] = proposalsIn(await ask(app, chat, 'Set the views'))

  // What a proposal changes was deleted since, which makes it stale with a reason
  await admin(setup, 'POST', `/entries/${gone}/archive`)
  expect((await admin(setup, 'DELETE', `/entries/${gone}`)).status).toBe(204)
  const applied = await admin(app, 'POST', `/chats/${chat}/proposals/apply`, { ids: [kept.id, deleted.id] })
  expect(applied.body.data).toMatchObject([
    { id: kept.id, status: 200, data: { status: 'applied', entryStatus: 'draft' } },
    {
      id: deleted.id,
      status: 409,
      message: 'Not applied: what it changes has been deleted since it was proposed.',
      data: { status: 'stale' },
    },
  ])

  // The next reply fails, so its system message never reaches the model, and the one after says it all
  const failed = await ask(app, chat, 'Thanks')
  expect(failed.find((event) => event.event === 'notice')!.data.text).toBe('The provider failed.')
  await ask(app, chat, 'Are you there?')
  const text = requests.at(-1)!.messages.at(-1)!.content[0].text
  expect(text).toContain(`Since your last reply, the person applied 1 of your proposals as drafts: ${kept.id}.`)
  expect(text).toContain(
    `1 of your proposals couldn't be applied, since what they change was changed after you proposed them: ${deleted.id}.`,
  )
})

test('a round another tab beat to the chat leaves none of its proposals waiting, and the model never hears of them', async () => {
  const setup = scripted().app
  const id = await post(setup, 'conflicted')
  let chat = ''
  const { app, requests } = scripted(async (request) => {
    // Another tab writes first, at the position this round's messages would take
    const { count } = await db
      .selectFrom('chat_messages')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('chat_id', '=', chat)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('chat_messages')
      .values({
        chat_id: chat,
        position: Number(count),
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'From another tab' }]),
      })
      .execute()
    return calls({ name: 'update_entry', input: { id, values: { views: 3 } } })(request)
  })
  chat = await newChat(app)
  const events = await ask(app, chat, 'Set the views to 3')
  expect(events.find((event) => event.event === 'notice')).toBeDefined()
  const [row] = await db.selectFrom('proposals').selectAll().where('chat_id', '=', chat).execute()
  expect(row).toMatchObject({ status: 'skipped', decided_at: null })
  await ask(app, chat, 'Did it work?')
  expect(requests.at(-1)!.messages.at(-1)!.content[0].text).not.toContain(row.id)
})
