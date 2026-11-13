import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { registerPlugins } from '../src/plugins'
import { ToolContext, callTool, tools } from '../src/tools'
import type { ContentType } from '../src/types'
import { typesFile } from '../src/typescript'
import { db } from './database'
import { setUp, types as fixtureTypes } from './fixtures'
import { lexical } from '@sorlo/field-lexical/plugin'
import { FSDriver } from 'flydrive/drivers/fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// The rich text field, lexical, which the CMS includes from @sorlo/field-lexical: the server's checks of its trees, its
// links in entry_relations, its delivery as HTML, or as JSON with blocks, which with() resolves, the site's
// entryLinks, its types and find and replace

const callout = {
  id: 'lay_callout',
  name: 'callout',
  label: 'Callout',
  fields: [
    { id: 'fld_callout_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_callout_image', type: 'media', name: 'image', label: 'Image', options: { maximum: 1 } },
  ],
}

const articles: ContentType = {
  id: 'typ_articles',
  name: 'articles',
  label: 'Articles',
  structure: 'collection',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    { id: 'fld_article_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_article_slug', type: 'identifier', name: 'slug', label: 'Slug', required: true },
    { id: 'fld_article_body', type: 'lexical', name: 'body', label: 'Body' },
    {
      id: 'fld_article_aside',
      type: 'group',
      name: 'aside',
      label: 'Aside',
      options: { fields: [{ id: 'fld_aside_note', type: 'lexical', name: 'note', label: 'Note' }] },
    },
    {
      id: 'fld_article_content',
      type: 'lexical',
      name: 'content',
      label: 'Content',
      options: { output: 'json', layouts: [callout] },
    },
  ],
}

const types = new Map([...fixtureTypes, ['articles', articles]])
const location = join(tmpdir(), 'sorlo-rich-text')
const storage = { default: 'local', services: { local: () => new FSDriver({ location, visibility: 'public' }) } }
const app = createApp(db, types, { storage })
let cookie: string
let userId: string
let key: string

beforeAll(async () => {
  ;({ cookie, userId } = await setUp())
  key = await createApiKey(db, 'Website')
})
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('media').execute()
})
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { cookie, origin: 'http://localhost' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

const deliver = async (path: string) => {
  const response = await app.request(`/v1${path}`, { headers: { authorization: `Bearer ${key}` } })
  return { status: response.status, body: await response.json() }
}

const save = async (type: string, values: object, publish = true) => {
  const { status, body } = await send('POST', `/types/${type}/entries`, { values, publish })
  expect(status, JSON.stringify(body)).toBe(201)
  return body.data
}

const file = async (name: string, mime = 'image/png') => {
  const id = uuidv7()
  await db
    .insertInto('media')
    .values({ id, disk: 'local', path: `${id}.png`, name, mime, size: 100, width: 10, height: 10, alt: 'Alt' })
    .execute()
  return id
}

const text = (value: string, format = 0) => ({ type: 'text', text: value, format, version: 1 })
const paragraph = (...children: Array<object>) => ({ type: 'paragraph', version: 1, children })
const tree = (...children: Array<object>) => ({ root: { type: 'root', version: 1, children } })
const linkTo = (entry: string, label: string) => ({ type: 'entrylink', version: 1, entry, children: [text(label)] })

test('the server checks trees, refusing unknown nodes and unsafe links, and checks blocks’ fields', async () => {
  const refused = async (values: object) => {
    const { status, body } = await send('POST', '/types/articles/entries', {
      values: { title: 'A', slug: `a-${uuidv7()}`, ...values },
      publish: true,
    })
    expect(status).toBe(422)
    return body.messages ?? body
  }
  expect(JSON.stringify(await refused({ body: tree({ type: 'script', children: [] }) }))).toContain('Invalid value.')
  expect(
    JSON.stringify(
      await refused({ body: tree(paragraph({ type: 'link', url: 'javascript:alert(1)', children: [text('x')] })) }),
    ),
  ).toContain('Invalid value.')
  expect(JSON.stringify(await refused({ content: tree({ type: 'block', block: { _layout: 'callout' } }) }))).toContain(
    'This field is required.',
  )

  // A block whose layout has gone is left out, as a flexible field's is
  const saved = await save('articles', {
    title: 'B',
    slug: 'b',
    content: tree(paragraph(text('Kept')), { type: 'block', block: { _layout: 'gone' } }),
  })
  expect(saved.values.content.root.children.map((node: { type: string }) => node.type)).toEqual(['paragraph'])
})

test('links inside rich text are in entry_relations, so Used by lists the entries holding them', async () => {
  const photo = await file('photo.png')
  const target = await save('blog', { title: 'Target', slug: 'target' })
  const article = await save('articles', {
    title: 'Holder',
    slug: 'holder',
    body: tree(paragraph(linkTo(target.id, 'the target'))),
    content: tree({ type: 'block', block: { _layout: 'callout', title: 'Look', image: photo } }),
  })
  const usedBy = async (path: string) => (await send('GET', path)).body.data.map((entry: { id: string }) => entry.id)
  expect(await usedBy(`/entries/${target.id}/used-by`)).toEqual([article.id])
  expect(await usedBy(`/media/${photo}/used-by`)).toEqual([article.id])
})

test('delivery writes rich text as HTML, at any depth, linking to live entries by their slug and to files by URL', async () => {
  const photo = await file('photo.png')
  const live = await save('blog', { title: 'Live', slug: 'live-post' })
  const draft = await save('blog', { title: 'Draft', slug: 'draft-post' }, false)
  await save('articles', {
    title: 'Article',
    slug: 'article',
    body: tree(
      { type: 'heading', tag: 'h2', version: 1, children: [text('Hello & welcome')] },
      paragraph(text('See '), linkTo(live.id, 'this'), text(' and '), linkTo(draft.id, 'that'), text('!', 1)),
      { type: 'media', version: 1, media: photo },
    ),
    aside: { note: tree(paragraph(text('Aside', 2))) },
  })

  const { body } = await deliver('/entries/articles/slug/article')
  expect(body.data.values.body).toBe(
    '<h2>Hello &amp; welcome</h2>' +
      `<p>See <a href="/live-post" data-entry="${live.id}">this</a> and that<strong>!</strong></p>` +
      `<img src="http://localhost/media/${photo}/photo.png" alt="Alt" width="10" height="10">`,
  )
  expect(body.data.values.aside).toEqual({ note: '<p><em>Aside</em></p>' })
})

test('rich text delivered as JSON comes as stored, and with() swaps its IDs, in the text and in blocks, for what they link to', async () => {
  const photo = await file('photo.png')
  const live = await save('blog', { title: 'Live', slug: 'live-post' })
  const content = tree(
    paragraph(linkTo(live.id, 'this')),
    { type: 'media', version: 1, media: photo },
    { type: 'block', version: 1, block: { _layout: 'callout', title: 'Look', image: photo } },
  )
  await save('articles', { title: 'Article', slug: 'article', content })

  const plain = await deliver('/entries/articles/slug/article')
  expect(plain.body.data.values.content).toEqual(content)

  const resolved = (await deliver('/entries/articles/slug/article?with=["content"]')).body.data.values.content
  const [first, media, block] = resolved.root.children
  expect(first.children[0].entry).toMatchObject({ id: live.id, slug: 'live-post' })
  expect(media.media).toMatchObject({ id: photo, url: `http://localhost/media/${photo}/photo.png` })
  expect(block.block).toMatchObject({ _layout: 'callout', title: 'Look', image: { id: photo } })
})

test('lexical() in plugins sets where entry links go, and only takes the fields the CMS includes from it', async () => {
  const live = await save('blog', { title: 'Live', slug: 'live-post' })
  await save('articles', { title: 'Article', slug: 'article', body: tree(paragraph(linkTo(live.id, 'this'))) })

  expect(
    registerPlugins([{ ...lexical(), fields: { ...lexical().fields, rating: lexical().fields.lexical } }]),
  ).toEqual(["rating, from @sorlo/field-lexical, isn't one of the fields the CMS includes from it."])
  expect(registerPlugins([lexical({ entryLinks: { blog: ({ entry }) => `/blog/${entry.slug}` } })])).toEqual([])
  try {
    const { body } = await deliver('/entries/articles/slug/article')
    expect(body.data.values.body).toBe(`<p><a href="/blog/live-post" data-entry="${live.id}">this</a></p>`)
  } finally {
    registerPlugins([lexical()])
  }
})

test('types rich text as the HTML string it’s delivered as, or as its tree for JSON', () => {
  const file = typesFile(types)
  expect(file).toMatch(/body\?: string \| null/)
  expect(file).toContain("content?: { root: { type: 'root'; children: Array<{ type: 'block'; version: number; block:")
})

test('find and replace reaches rich text’s text nodes and modular blocks’ fields, and leaves links alone', async () => {
  const article = await save('articles', {
    title: 'Article',
    slug: 'article',
    body: tree(paragraph(text('Acme rocks'), { type: 'link', url: 'https://acme.test', children: [text('Acme')] })),
    content: tree({ type: 'block', block: { _layout: 'callout', title: 'Acme inside' } }),
  })
  const token = uuidv7()
  await db
    .insertInto('personal_tokens')
    .values({ id: token, user_id: userId, name: 'Tool', token_hash: uuidv7(), scopes: ['drafts'] })
    .execute()
  const context: ToolContext = {
    db,
    types,
    migrations: async () => ({}),
    user: { id: userId, email: 'ada@example.com', name: 'Ada' },
    origin: 'http://cms.test',
    writes: { token },
  }
  const { isError, content } = await callTool(
    tools.find((tool) => tool.name === 'replace_text')!,
    context,
    {
      find: 'Acme',
      replace: 'Sorlo',
      types: ['articles'],
    },
  )
  expect(isError, JSON.stringify(content)).toBeFalsy()
  const { values } = (await send('GET', `/entries/${article.id}`)).body.data
  expect(values.body).toEqual(
    tree(paragraph(text('Sorlo rocks'), { type: 'link', url: 'https://acme.test', children: [text('Sorlo')] })),
  )
  expect(values.content.root.children[0].block.title).toBe('Sorlo inside')
})
