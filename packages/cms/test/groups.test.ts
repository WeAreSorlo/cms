import { createApp } from '../src/app'
import { checkEntries } from '../src/content'
import { flattenValidationReport } from '../src/core'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { collapseUses } from '../src/fields'
import { rebuildRelations } from '../src/relations'
import { ContentType, SharedGroup, checkGroup, checkType, loadSchema } from '../src/types'
import { db } from './database'
import { authors, setUp } from './fixtures'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// Shared groups (PLAN.md section 19): their files and checks, how types expand their uses, and entries saved, checked,
// linked and delivered through them

// Sharing fields, which the SEO group uses too
const og: SharedGroup = {
  id: 'grp_og',
  name: 'og',
  label: 'Sharing',
  fields: [
    { id: 'fld_image', type: 'media', name: 'image', options: { types: ['image/*'], maximum: 1 } },
    { id: 'fld_alt', type: 'text', name: 'alt' },
  ],
}

const seo: SharedGroup = {
  id: 'grp_seo',
  name: 'seo',
  label: 'SEO',
  fields: [
    { id: 'fld_title', type: 'text', name: 'title', required: true, options: { maxLength: 60 } },
    { id: 'fld_author', type: 'relationship', name: 'author', options: { types: ['typ_authors'], maximum: 1 } },
    { id: 'fld_share', type: 'shared', name: 'share', label: 'Sharing', options: { group: 'grp_og' } },
  ],
}

// Uses at the top, twice, in a repeater's items and in a flexible layout
const pages: ContentType = {
  id: 'typ_pages',
  name: 'pages',
  label: 'Pages',
  structure: 'collection',
  titleField: 'heading',
  fields: [
    { id: 'fld_heading', type: 'text', name: 'heading', required: true },
    { id: 'fld_seo', type: 'shared', name: 'seo', label: 'Search', options: { group: 'grp_seo' } },
    { id: 'fld_social', type: 'shared', name: 'social', width: 50, options: { group: 'grp_og' } },
    {
      id: 'fld_translations',
      type: 'repeater',
      name: 'translations',
      options: {
        fields: [
          { id: 'fld_language', type: 'text', name: 'language' },
          { id: 'fld_translated', type: 'shared', name: 'seo', options: { group: 'grp_seo' } },
        ],
      },
    },
    {
      id: 'fld_blocks',
      type: 'flexible',
      name: 'blocks',
      options: {
        layouts: [
          {
            id: 'lay_hero',
            name: 'hero',
            fields: [{ id: 'fld_hero_share', type: 'shared', name: 'share', options: { group: 'grp_og' } }],
          },
        ],
      },
    },
  ],
}

// The og group's fields, as a use with this id has them
const ogFields = (use: string) => [
  { id: `${use}.fld_image`, type: 'media', name: 'image', options: { types: ['image/*'], maximum: 1 } },
  { id: `${use}.fld_alt`, type: 'text', name: 'alt' },
]

// The seo group's fields, as a use with this id has them, with the og group's inside
const seoFields = (use: string) => [
  { id: `${use}.fld_title`, type: 'text', name: 'title', required: true, options: { maxLength: 60 } },
  {
    id: `${use}.fld_author`,
    type: 'relationship',
    name: 'author',
    options: { types: ['typ_authors'], maximum: 1 },
  },
  {
    id: `${use}.fld_share`,
    type: 'group',
    name: 'share',
    label: 'Sharing',
    options: { group: 'grp_og', fields: ogFields(`${use}.fld_share`) },
  },
]

// A site project's schema folder with these types and groups, by file name
async function site(types: Record<string, unknown>, groups: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sorlo-groups-'))
  for (const [folder, files] of Object.entries({ types, groups })) {
    await mkdir(join(root, folder))
    for (const [file, value] of Object.entries(files)) {
      await writeFile(join(root, folder, file), typeof value === 'string' ? value : JSON.stringify(value))
    }
  }
  return join(root, 'types')
}

test('loads shared groups beside the types, which come with each use expanded into a group', async () => {
  const dir = await site({ 'authors.json': authors, 'pages.json': pages }, { 'og.json': og, 'seo.json': seo })
  const { types, groups } = await loadSchema(dir)

  // Groups come as their files have them
  expect([...groups]).toEqual([
    ['og', og],
    ['seo', seo],
  ])

  // A use keeps its own settings and becomes a group of its shared group's fields, whose ids, the fields of the
  // groups it uses included, get the use's id in front
  expect(types.get('pages')!.fields).toEqual([
    pages.fields[0],
    {
      id: 'fld_seo',
      type: 'group',
      name: 'seo',
      label: 'Search',
      options: { group: 'grp_seo', fields: seoFields('fld_seo') },
    },
    {
      id: 'fld_social',
      type: 'group',
      name: 'social',
      width: 50,
      options: { group: 'grp_og', fields: ogFields('fld_social') },
    },
    {
      id: 'fld_translations',
      type: 'repeater',
      name: 'translations',
      options: {
        fields: [
          { id: 'fld_language', type: 'text', name: 'language' },
          {
            id: 'fld_translated',
            type: 'group',
            name: 'seo',
            options: { group: 'grp_seo', fields: seoFields('fld_translated') },
          },
        ],
      },
    },
    {
      id: 'fld_blocks',
      type: 'flexible',
      name: 'blocks',
      options: {
        layouts: [
          {
            id: 'lay_hero',
            name: 'hero',
            fields: [
              {
                id: 'fld_hero_share',
                type: 'group',
                name: 'share',
                options: { group: 'grp_og', fields: ogFields('fld_hero_share') },
              },
            ],
          },
        ],
      },
    },
  ])

  // The type editor gets the file back from an expanded type
  expect(collapseUses(types.get('pages')!.fields)).toEqual(pages.fields)

  // A missing groups folder has none
  expect((await loadSchema(await site({ 'authors.json': authors }))).groups.size).toBe(0)
})

test('lists the problems in every type and group at once, under their folders', async () => {
  const dir = await site(
    {
      'authors.json': authors,
      'pages.json': {
        ...pages,
        fields: [
          ...pages.fields,
          { id: 'fld_missing', type: 'shared', name: 'missing', options: { group: 'grp_nope' } },
          { id: 'fld_own', type: 'shared', name: 'own', options: { group: 'grp_seo', fields: [] } },
          { id: 'fld_fake', type: 'group', name: 'fake', options: { group: 'grp_seo', fields: [] } },
          { id: 'fld_a.b', type: 'text', name: 'dotted' },
        ],
      },
    },
    {
      'og.json': og,
      'seo.json': { ...seo, description: 'Search fields' },
      'meta.json': { ...og, name: 'metadata', fields: [] },
      'broken.json': '{ "id": ',
    },
  )
  await expect(loadSchema(dir)).rejects.toThrow(
    [
      [
        `The content types in ${dir} have problems:`,
        'pages.json: Field "missing" must name a shared group by its id in "options.group".',
        `pages.json: Field "own" takes its fields from its shared group, so it can't have its own.`,
        `pages.json: Field "fake" can't name a shared group in "options.group", as only a Shared group field can.`,
        'pages.json: Field "dotted" has a dot in its id, fld_a.b.',
      ].join('\n  '),
      [
        `The shared groups in ${join(dir, '../groups')} have problems:`,
        'broken.json: Unexpected end of JSON input',
        `meta.json: "name" must match the file's name, meta.`,
        'og.json: Its id, grp_og, is also used by meta.json.',
        `seo.json: "description" isn't a shared group setting.`,
      ].join('\n  '),
    ].join('\n'),
  )
})

test('refuses groups that use themselves, directly or through others', async () => {
  const uses = (id: string, group: string) => ({ id, type: 'shared', name: id.slice(4), options: { group } })
  const dir = await site(
    { 'authors.json': authors, 'pages.json': pages },
    {
      'og.json': { ...og, fields: [...og.fields, uses('fld_more', 'grp_seo')] },
      'seo.json': seo,
      'loop.json': { id: 'grp_loop', name: 'loop', label: 'Loop', fields: [uses('fld_again', 'grp_loop')] },
    },
  )
  await expect(loadSchema(dir)).rejects.toThrow(
    [
      `The shared groups in ${join(dir, '../groups')} have problems:`,
      'loop.json: It uses itself.',
      'og.json: It uses itself, through seo.',
      'seo.json: It uses itself, through og.',
    ].join('\n  '),
  )
})

test('checks a group file as it checks a type file', () => {
  const typeIds = new Set(['typ_authors'])
  const groupIds = new Set(['grp_og', 'grp_seo'])
  expect(checkGroup(seo, 'seo', typeIds, groupIds)).toEqual([])
  expect(checkGroup([], 'seo', typeIds, groupIds)).toEqual(['It must hold a JSON object.'])
  expect(checkGroup({ name: 'S E O', fields: {} }, 'seo', typeIds, groupIds)).toEqual([
    'It needs an "id", such as grp_k3x9q2mz.',
    '"name" must be a letter, then letters, digits or underscores.',
    'It needs a "label".',
    '"fields" must be a list.',
  ])

  // Its fields are checked like a type's, links to types included
  const fields = [
    { id: 'fld_title', type: 'text', name: 'title' },
    { id: 'fld_title', type: 'colour', name: 'title' },
    { id: 'fld_editor', type: 'relationship', name: 'editor', options: { types: ['typ_editors'] } },
  ]
  expect(checkGroup({ ...seo, fields }, 'seo', typeIds, groupIds)).toEqual([
    'Field "title" is defined twice.',
    'Field "title" has the same id as another, fld_title.',
    'Field "title" has an unknown type, colour.',
    'Field "editor" must list the ids of content types in "options.types".',
  ])

  // Types check their uses only when they're given the groups' ids, as relationship fields need the types'
  expect(checkType({ ...pages, fields: [pages.fields[1]] }, 'pages', typeIds, new Set())).toEqual([
    'Field "seo" must name a shared group by its id in "options.group".',
    '"titleField" must name a top-level field.',
  ])
})

// Entries saved, checked, linked and delivered through uses
let app: ReturnType<typeof createApp>
let types: Map<string, ContentType>
let cookie: string
let key: string

beforeAll(async () => {
  ;({ cookie } = await setUp())
  key = await createApiKey(db, 'Website')
  const dir = await site({ 'authors.json': authors, 'pages.json': pages }, { 'og.json': og, 'seo.json': seo })
  const schema = await loadSchema(dir)
  types = schema.types
  app = createApp(db, types, { groups: schema.groups })
})
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('media').execute()
})
afterAll(() => db.destroy())

const send = async (method: string, path: string, body?: unknown) => {
  const headers = { cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

const save = (type: string, values: object) => send('POST', `/types/${type}/entries`, { values, publish: true })

const photo = async () => {
  const id = uuidv7()
  await db
    .insertInto('media')
    .values({
      id,
      disk: 'local',
      path: `${id}.png`,
      name: 'photo.png',
      mime: 'image/png',
      size: 1,
      width: 1,
      height: 1,
    })
    .execute()
  return id
}

const gone = "It's been deleted, or isn't of a type this field takes."

test('saving checks and picks values through every use, and records their links by qualified ids', async () => {
  const ada = (await save('authors', { name: 'Ada' })).body.data
  const image = await photo()

  // Each use is checked as a group, its fields' messages under its name, and links through it are checked too
  const invalid = await save('pages', {
    heading: 'Home',
    seo: { title: 'x'.repeat(61), author: image, share: { image: ada.id } },
    translations: [{ language: 'fr', seo: {} }],
  })
  expect(invalid.status).toBe(422)
  expect(flattenValidationReport(invalid.body).messages).toEqual({
    'seo.title': ['This field requires a maximum of 60 character(s).'],
    'seo.author': [gone],
    'seo.share.image': [gone],
    'translations.0.seo.title': ['This field is required.'],
  })

  // Values that aren't the shared group's fields are left out
  const { status, body } = await save('pages', {
    heading: 'Home',
    seo: { title: 'Home', author: ada.id, share: { image, alt: 'A photo', caption: 'Not a field' } },
    social: { image },
    translations: [{ language: 'fr', seo: { title: 'Accueil', author: ada.id } }],
    blocks: [{ _layout: 'hero', share: { image } }],
  })
  expect(status).toBe(201)
  expect(body.data.values.seo).toEqual({ title: 'Home', author: ada.id, share: { image, alt: 'A photo' } })

  // Two uses of a group in one type link through ids of their own
  const relations = await db
    .selectFrom('entry_relations')
    .select(['field_id', 'target_id'])
    .where('entry_id', '=', body.data.id)
    .orderBy('field_id')
    .execute()
  expect(relations).toEqual([
    { field_id: 'fld_hero_share.fld_image', target_id: image },
    { field_id: 'fld_seo.fld_author', target_id: ada.id },
    { field_id: 'fld_seo.fld_share.fld_image', target_id: image },
    { field_id: 'fld_social.fld_image', target_id: image },
    { field_id: 'fld_translated.fld_author', target_id: ada.id },
  ])
  expect((await send('GET', `/entries/${ada.id}/used-by`)).body.data.map((entry: any) => entry.id)).toEqual([
    body.data.id,
  ])

  // with() names a use like any field that holds links, and resolves the links inside it
  const response = await app.request(`/v1/entries/pages?with=${encodeURIComponent('["seo"]')}`, {
    headers: { authorization: `Bearer ${key}` },
  })
  const [delivered] = (await response.json()).data
  expect(delivered.values.seo.author).toMatchObject({ id: ada.id, values: { name: 'Ada' } })
  expect(delivered.values.seo.share).toMatchObject({ image: { id: image, mime: 'image/png' }, alt: 'A photo' })
  expect(delivered.values.social).toEqual({ image })

  // migrate --check and the relations it rebuilds after content migrations see through uses too
  const values = { ...body.data.values, seo: { ...body.data.values.seo, title: 'x'.repeat(61) } }
  await db.updateTable('entries').set({ values }).where('id', '=', body.data.id).execute()
  await db.deleteFrom('entry_relations').execute()
  await rebuildRelations(db, types)
  expect(
    await db.selectFrom('entry_relations').select('field_id').where('entry_id', '=', body.data.id).execute(),
  ).toHaveLength(5)
  expect((await checkEntries(db, types)).map(({ entry, messages }) => [entry.id, messages])).toEqual([
    [body.data.id, { 'seo.title': ['This field requires a maximum of 60 character(s).'] }],
  ])
})
