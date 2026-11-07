import { ContentMigrationFile, catchUp } from '../src/content'
import { makeMigration } from '../src/makeMigration'
import { type ContentType, type SharedGroup, expandFields } from '../src/types'
import type { FieldSchema } from '@sorlo/core'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const blog: ContentType = {
  id: 'typ_blog',
  name: 'blog',
  label: 'Blog posts',
  structure: 'collection',
  fields: [
    { id: 'fld_title', type: 'text', name: 'title', label: 'Title' },
    { id: 'fld_summary', type: 'textarea', name: 'summary' },
    {
      id: 'fld_category',
      type: 'select',
      name: 'category',
      options: { choices: [{ value: 'news' }, { label: 'Old', choices: [{ value: 'draft' }, { value: 'idea' }] }] },
    },
    {
      id: 'fld_address',
      type: 'group',
      name: 'address',
      options: { fields: [{ id: 'fld_town', type: 'text', name: 'town' }] },
    },
    {
      id: 'fld_pets',
      type: 'repeater',
      name: 'pets',
      options: { fields: [{ id: 'fld_pet', type: 'text', name: 'name' }] },
    },
    {
      id: 'fld_blocks',
      type: 'flexible',
      name: 'blocks',
      options: {
        layouts: [
          {
            id: 'lay_quote',
            name: 'quote',
            fields: [
              { id: 'fld_quote', type: 'textarea', name: 'quote' },
              { id: 'fld_credit', type: 'text', name: 'credit' },
            ],
          },
          { id: 'lay_text', name: 'text', fields: [{ id: 'fld_body', type: 'textarea', name: 'body' }] },
        ],
      },
    },
  ],
}

const docs: ContentType = { id: 'typ_docs', name: 'docs', label: 'Docs', structure: 'hierarchical', fields: [] }

// A blog entry's values with something in every field
const values = () => ({
  title: 'Hello',
  summary: 'Short',
  category: 'news',
  address: { town: 'Leeds' },
  pets: [{ name: 'Rex' }, { name: 'Tib' }],
  blocks: [
    { _layout: 'quote', quote: 'Hi', credit: 'Ada' },
    { _layout: 'text', body: 'Body' },
  ],
})

// A copy of a type, with every field and layout found by id for changing
function edit(type: ContentType, change: (find: (id: string) => any, type: ContentType) => void) {
  const copy = structuredClone(type)
  const all = (list: Array<any> = []): Array<any> =>
    list.flatMap((node) => [node, ...all(node.fields), ...all(node.options?.fields), ...all(node.options?.layouts)])
  change((id) => all(copy.fields).find((node) => node.id === id), copy)
  return copy
}

// Where a node sits, so a test can move it: the list it's in, and its index there
function remove(fields: Array<FieldSchema>, id: string): any {
  for (const [index, node] of fields.entries()) {
    if (node.id === id) return fields.splice(index, 1)[0]
    const found = remove(node.options?.fields ?? [], id) ?? remove(node.options?.layouts ?? [], id)
    const inLayout = (node as any).fields && remove((node as any).fields, id)
    if (found ?? inLayout) return found ?? inLayout
  }
}

// The migration make:migration writes for going from one set of types to another
async function migration(before: Array<ContentType>, after: Array<ContentType>, name?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-migrations-'))
  await makeMigration(dir, new Map(before.map((type) => [type.name, type])))
  const made = await makeMigration(dir, new Map(after.map((type) => [type.name, type])), name)
  const file: ContentMigrationFile | undefined = made.file && (await import(join(dir, made.file)))
  const source = made.file ? await readFile(join(dir, made.file), 'utf8') : ''
  return { ...made, dir, file: file!, source }
}

// Run up on a blog entry's values, then down on the result, as an old version's catch-up would
async function roundTrip(file: ContentMigrationFile, start: object = values(), type = 'blog') {
  const up = await catchUp(type, structuredClone(start), [file.up])
  return { up, down: await catchUp(type, structuredClone(up), [file.down]) }
}

test('the first run writes the snapshot, and later ones only write migrations for changes to values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-migrations-'))
  const types = new Map([['blog', blog]])
  expect(await makeMigration(dir, types)).toEqual({ file: undefined, notes: [], created: true, updated: true })
  expect(JSON.parse(await readFile(join(dir, '.snapshot.json'), 'utf8'))).toEqual({ blog })
  expect(await makeMigration(dir, types)).toEqual({ file: undefined, notes: [], created: false, updated: false })

  // A new label or an optional field without a default changes no values, so only the snapshot changes
  const relabelled = edit(blog, (find) => {
    find('fld_title').label = 'Headline'
    find('fld_address').options.fields.push({ id: 'fld_country', type: 'text', name: 'country' })
  })
  expect(await makeMigration(dir, new Map([['blog', relabelled]]))).toEqual({
    file: undefined,
    notes: [],
    created: false,
    updated: true,
  })
  expect(JSON.parse(await readFile(join(dir, '.snapshot.json'), 'utf8'))).toEqual({ blog: relabelled })
  expect(await readdir(dir)).toEqual(['.snapshot.json'])
})

test('renamed fields and layouts get renames both ways', async () => {
  const renamed = edit(blog, (find) => {
    find('fld_title').name = 'headline'
    find('fld_town').name = 'city'
    find('fld_pet').name = 'full_name'
    find('fld_credit').name = 'attribution'
    find('lay_quote').name = 'citation'
  })
  const { file, source, notes } = await migration([blog], [renamed])

  expect(notes).toEqual([])
  expect(source)
    .toBe(`// Made by sorlo make:migration. Content migrations only change entries' values, so old versions can run them too
import type { ContentMigration } from '@sorlo/cms'

export const up: ContentMigration = ({ entries }) => {
  entries.renameField('blog', 'title', 'headline')
  entries.renameField('blog', 'address.town', 'address.city')
  entries.renameField('blog', 'pets.name', 'pets.full_name')
  entries.renameLayout('blog', 'blocks.quote', 'blocks.citation')
  entries.renameField('blog', 'blocks.citation.credit', 'blocks.citation.attribution')
}

export const down: ContentMigration = ({ entries }) => {
  entries.renameField('blog', 'blocks.citation.attribution', 'blocks.citation.credit')
  entries.renameLayout('blog', 'blocks.citation', 'blocks.quote')
  entries.renameField('blog', 'pets.full_name', 'pets.name')
  entries.renameField('blog', 'address.city', 'address.town')
  entries.renameField('blog', 'headline', 'title')
}
`)

  const { up, down } = await roundTrip(file)
  expect(up).toEqual({
    headline: 'Hello',
    summary: 'Short',
    category: 'news',
    address: { city: 'Leeds' },
    pets: [{ full_name: 'Rex' }, { full_name: 'Tib' }],
    blocks: [
      { _layout: 'citation', quote: 'Hi', attribution: 'Ada' },
      { _layout: 'text', body: 'Body' },
    ],
  })
  expect(down).toEqual(values())
})

test('fields moved into and out of groups move their values', async () => {
  const moved = edit(blog, (_find, type) => {
    // summary goes into address, and town comes out to the top, into a new group named location
    const summary = remove(type.fields, 'fld_summary')
    const town = remove(type.fields, 'fld_town')
    type.fields.find((field) => field.id === 'fld_address')!.options!.fields!.push(summary)
    type.fields.push({ id: 'fld_location', type: 'group', name: 'location', options: { fields: [town] } })
  })
  const { file, source } = await migration([blog], [moved])

  expect(source).toContain("entries.renameField('blog', 'summary', 'address.summary')")
  expect(source).toContain("entries.renameField('blog', 'address.town', 'location.town')")
  const { up, down } = await roundTrip(file)
  expect(up).toMatchObject({ address: { summary: 'Short' }, location: { town: 'Leeds' } })
  expect(up).not.toHaveProperty('summary')
  expect(down).toEqual({ ...values(), location: {} })
})

test("a move across a list gets a TODO, since a rename can't split or merge values", async () => {
  const moved = edit(blog, (_find, type) => type.fields.push(remove(type.fields, 'fld_pet')))
  const { source, notes } = await migration([blog], [moved])

  const note =
    "TODO: pets.name moved to name, which a rename can't do across lists or layouts. Move it here, and back in down"
  expect(notes).toEqual([note])
  expect(source).toContain(`  // ${note}\n  entries.update('blog', (values) => values)\n`)
  expect(source).toContain(`  // TODO: move name back to pets.name\n  entries.update('blog', (values) => values)\n`)
})

test("removed fields and layouts are deleted and flagged, since down can't bring them back", async () => {
  const removed = edit(blog, (_find, type) => {
    remove(type.fields, 'fld_summary')
    remove(type.fields, 'lay_text')
    remove(type.fields, 'fld_credit')
  })
  const { file, source, notes } = await migration([blog], [removed])

  expect(notes).toEqual([
    "Flagged: deletes the values of summary, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of blocks.quote.credit, which down can't bring back. Old versions keep them",
    "Flagged: deletes every blocks.text block, which down can't bring back. Old versions keep them",
  ])
  expect(source).toContain("entries.removeField('blog', 'blocks.quote.credit')")
  expect(source).toContain("entries.removeLayout('blog', 'blocks.text')")
  expect(source).toContain("  // The values of summary can't come back\n")

  const { up } = await roundTrip(file)
  expect(up).toEqual({ ...values(), summary: undefined, blocks: [{ _layout: 'quote', quote: 'Hi' }] })
})

test('a changed field type gets a stub with a TODO', async () => {
  const retyped = edit(blog, (find) => (find('fld_town').type = 'number'))
  const { source, notes } = await migration([blog], [retyped])

  const note = 'TODO: address.town changed from text to number. Convert its values here, and back in down'
  expect(notes).toEqual([note])
  expect(source).toContain(`  // ${note}\n  entries.mapField('blog', 'address.town', (value) => value)\n`)
  expect(source).toContain(
    `  // TODO: convert address.town back to text\n  entries.mapField('blog', 'address.town', (value) => value)\n`,
  )
})

test('narrowed choices and settings are flagged for --check, widened ones and new looks are not', async () => {
  const narrowed = edit(blog, (find) => {
    find('fld_category').options.choices = [{ value: 'news' }, { value: 'event' }, { choices: [{ value: 'idea' }] }]
    find('fld_title').required = true
    find('fld_title').options = { maxLength: 80, placeholder: 'A title' }
    find('fld_summary').options = { rows: 3 }
  })
  const { source, notes } = await migration([blog], [narrowed])

  expect(notes).toEqual([
    'Flagged: title is now required and has a new maxLength, so some entries may not pass. Run sorlo migrate --check',
    'Flagged: category lost the choice draft, so some entries may not pass. Run sorlo migrate --check',
  ])
  expect(source).toContain('export const down: ContentMigration = ({ entries }) => {\n  // Nothing to undo\n}')
})

test("a line break in a choice value can't end a note's comment and add code to the migration", async () => {
  const before = edit(blog, (find) => {
    find('fld_category').options.choices.push(
      { value: 'a\nglobalThis.injected = true //' },
      { value: 'b globalThis.injected = true //' },
    )
  })
  const { file, source } = await migration([before], [blog])
  await roundTrip(file)

  expect(globalThis).not.toHaveProperty('injected')
  expect(source).toContain(
    '  // Flagged: category lost the choices a globalThis.injected = true //, b globalThis.injected = true //, so some',
  )
})

test('new fields with a default fill it in, and new required ones without a default are flagged', async () => {
  const added = edit(blog, (find, type) => {
    type.fields.push({ id: 'fld_featured', type: 'boolean', name: 'featured', defaultValue: false })
    type.fields.push({ id: 'fld_kind', type: 'text', name: 'kind', required: true })
    find('fld_pets').options.fields.push({ id: 'fld_legs', type: 'number', name: 'legs', defaultValue: 4 })
    find('lay_quote').fields.push({ id: 'fld_style', type: 'text', name: 'style', defaultValue: "it's plain" })
    // A new group's fields have nothing to fill
    type.fields.push({
      id: 'fld_seo',
      type: 'group',
      name: 'seo',
      options: { fields: [{ id: 'fld_seo_title', type: 'text', name: 'title', defaultValue: 'x', required: true }] },
    })
  })
  const { file, source, notes } = await migration([blog], [added])

  expect(notes).toEqual([
    'Flagged: kind is new and required, so entries saved before it have no value. Run sorlo migrate --check',
  ])
  expect(source).toContain(`entries.addField('blog', 'blocks.quote.style', "it's plain")`)
  const { up, down } = await roundTrip(file)
  expect(up).toEqual({
    ...values(),
    featured: false,
    pets: [
      { name: 'Rex', legs: 4 },
      { name: 'Tib', legs: 4 },
    ],
    blocks: [
      { _layout: 'quote', quote: 'Hi', credit: 'Ada', style: "it's plain" },
      { _layout: 'text', body: 'Body' },
    ],
  })
  expect(down).toEqual(values())
})

test('renamed types are renamed, removed ones are flagged, and two types can swap names', async () => {
  const posts = edit(blog, (find, type) => {
    type.name = 'posts'
    find('fld_title').name = 'name'
  })
  const { file, source, notes } = await migration([blog, docs], [posts])

  expect(notes).toEqual([
    'Flagged: the type docs is gone, but its entries stay until you delete them. sorlo migrate --check lists them',
  ])
  expect(source).toContain(
    "  entries.renameType('blog', 'posts')\n  entries.renameField('posts', 'title', 'name')\n  // Flagged: the type docs",
  )
  expect(source).toContain("  entries.renameField('posts', 'name', 'title')\n  entries.renameType('posts', 'blog')\n}")
  expect((await roundTrip(file)).up).toMatchObject({ name: 'Hello' })

  // The old blog becomes docs, with its title renamed, and the old docs becomes blog
  const swap = edit(blog, (find, type) => {
    type.name = 'docs'
    find('fld_title').name = 'headline'
  })
  const swapped = await migration([blog, docs], [swap, { ...docs, name: 'blog' }])
  expect(swapped.source).toContain(
    "  entries.renameType('blog', '_typ_blog')\n  entries.renameType('docs', 'blog')\n  entries.renameType('_typ_blog', 'docs')\n",
  )
  expect(await catchUp('docs', { title: 'A blog post' }, [swapped.file.up])).toEqual({ headline: 'A blog post' })
  expect(await catchUp('blog', { title: 'A docs page' }, [swapped.file.up])).toEqual({ title: 'A docs page' })
})

test("swapped names, and names taken from removed fields, don't overwrite values", async () => {
  // title and summary swap names, category is removed and pets takes its name, and address becomes old_address, giving
  // way to a new group named address that takes its town. A stale old_address key is overwritten.
  const changed = edit(blog, (find, type) => {
    find('fld_title').name = 'summary'
    find('fld_summary').name = 'title'
    remove(type.fields, 'fld_category')
    find('fld_pets').name = 'category'
    const address = remove(type.fields, 'fld_address')
    address.name = 'old_address'
    address.options.fields.push({ id: 'fld_street', type: 'text', name: 'street' })
    type.fields.push({
      id: 'fld_new_address',
      type: 'group',
      name: 'address',
      options: { fields: [address.options.fields[0]] },
    })
    remove(address.options.fields, 'fld_town')
    type.fields.push(address)
  })
  const { file, source } = await migration([blog], [changed])
  expect(source).toContain(
    "  // Flagged: deletes the values of category, which down can't bring back. Old versions keep them\n" +
      "  entries.removeField('blog', 'category')\n  entries.renameField('blog', 'pets', 'category')\n",
  )

  const { up, down } = await roundTrip(file, { ...values(), old_address: 'stale' })
  expect(up).toEqual({
    title: 'Short',
    summary: 'Hello',
    category: values().pets,
    address: { town: 'Leeds' },
    old_address: {},
    blocks: values().blocks,
  })
  const { category, ...rest } = values()
  expect(down).toEqual(rest)
})

test('migrations are named for the time and the types, or a name given, and sort in the order they were made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sorlo-migrations-'))
  await makeMigration(dir, new Map([['blog', blog]]))
  const first = edit(blog, (find) => (find('fld_title').name = 'headline'))
  const second = edit(first, (find) => (find('fld_title').name = 'name'))

  const one = await makeMigration(dir, new Map([['blog', first]]))
  const two = await makeMigration(dir, new Map([['blog', second]]), 'rename_headline')
  expect(one.file).toMatch(/^\d{4}_\d\d_\d\d_\d{6}_blog\.ts$/)
  expect(two.file).toMatch(/^\d{4}_\d\d_\d\d_\d{6}_rename_headline\.ts$/)
  expect(two.file!.slice(0, 17) > one.file!.slice(0, 17)).toBe(true)

  await expect(makeMigration(dir, new Map([['blog', blog]]), 'no spaces')).rejects.toThrow(
    'A migration name can only have letters, digits and underscores.',
  )
})

// Shared groups (PLAN.md section 19). make:migration diffs types as they load, with each use of a shared group
// expanded, so these are expanded as loadSchema expands them.
const expand = (type: ContentType, ...groups: Array<SharedGroup>) => ({
  ...type,
  fields: expandFields(type.fields, new Map(groups.map((group) => [group.id, group]))),
})

const seo: SharedGroup = {
  id: 'grp_seo',
  name: 'seo',
  label: 'SEO',
  fields: [
    { id: 'fld_t', type: 'text', name: 'title' },
    { id: 'fld_d', type: 'textarea', name: 'description' },
    { id: 'fld_k', type: 'text', name: 'keywords' },
  ],
}

const use = (id: string, name: string, group = 'grp_seo') => ({ id, type: 'shared', name, options: { group } })

// Uses of the SEO group at the top of pages, and in news's items and its hero blocks
const pages: ContentType = {
  id: 'typ_pages',
  name: 'pages',
  label: 'Pages',
  structure: 'collection',
  fields: [{ id: 'fld_heading', type: 'text', name: 'heading' }, use('fld_seo', 'seo')],
}

const news: ContentType = {
  id: 'typ_news',
  name: 'news',
  label: 'News',
  structure: 'collection',
  fields: [
    { id: 'fld_items', type: 'repeater', name: 'items', options: { fields: [use('fld_item_seo', 'meta')] } },
    {
      id: 'fld_sections',
      type: 'flexible',
      name: 'sections',
      options: { layouts: [{ id: 'lay_hero', name: 'hero', fields: [use('fld_hero_seo', 'seo')] }] },
    },
  ],
}

test('a change to a shared group writes one migration for every type and path that uses it', async () => {
  const changed: SharedGroup = {
    ...seo,
    fields: [
      { ...seo.fields[0], name: 'headline' },
      seo.fields[1],
      { id: 'fld_n', type: 'boolean', name: 'noindex', defaultValue: false },
    ],
  }
  const { file, source, notes } = await migration(
    [expand(news, seo), expand(pages, seo)],
    [expand(news, changed), expand(pages, changed)],
  )

  expect(file).toBeDefined()
  expect(notes).toEqual([
    "Flagged: deletes the values of items.meta.keywords, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of sections.hero.seo.keywords, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of seo.keywords, which down can't bring back. Old versions keep them",
  ])
  for (const line of [
    "entries.renameField('news', 'items.meta.title', 'items.meta.headline')",
    "entries.renameField('news', 'sections.hero.seo.title', 'sections.hero.seo.headline')",
    "entries.addField('news', 'items.meta.noindex', false)",
    "entries.addField('news', 'sections.hero.seo.noindex', false)",
    "entries.renameField('pages', 'seo.title', 'seo.headline')",
    "entries.removeField('pages', 'seo.keywords')",
    "entries.addField('pages', 'seo.noindex', false)",
  ]) {
    expect(source).toContain(line)
  }

  const article = {
    items: [{ meta: { title: 'One', description: 'First', keywords: 'a' } }, { meta: { title: 'Two' } }],
    sections: [{ _layout: 'hero', seo: { title: 'Hero', keywords: 'b' } }],
  }
  const { up, down } = await roundTrip(file, article, 'news')
  expect(up).toEqual({
    items: [
      { meta: { headline: 'One', description: 'First', noindex: false } },
      { meta: { headline: 'Two', noindex: false } },
    ],
    sections: [{ _layout: 'hero', seo: { headline: 'Hero', noindex: false } }],
  })
  expect(down).toEqual({
    items: [{ meta: { title: 'One', description: 'First' } }, { meta: { title: 'Two' } }],
    sections: [{ _layout: 'hero', seo: { title: 'Hero' } }],
  })
  expect((await roundTrip(file, { heading: 'Home', seo: { title: 'Home' } }, 'pages')).up).toEqual({
    heading: 'Home',
    seo: { headline: 'Home', noindex: false },
  })
})

test("making a type's own group shared changes no values, since its fields match the new group's", async () => {
  // The type editor's Make shared gives the group the copy's fields, and the use the copy's id and name
  const own: ContentType = {
    ...pages,
    fields: [pages.fields[0], { id: 'fld_seo', type: 'group', name: 'seo', options: { fields: seo.fields } }],
  }
  const made = await migration([own], [expand(pages, seo)])
  expect(made).toMatchObject({ file: undefined, notes: [], updated: true })
})

test('using a shared group in place of a copy keeps the values whose names match, and flags the rest', async () => {
  const copy: ContentType = {
    id: 'typ_events',
    name: 'events',
    label: 'Events',
    structure: 'collection',
    fields: [
      { id: 'fld_name', type: 'text', name: 'name' },
      {
        id: 'fld_event_seo',
        type: 'group',
        name: 'seo',
        label: 'Search',
        options: {
          fields: [
            { id: 'fld_event_title', type: 'text', name: 'title', options: { maxLength: 60 } },
            { id: 'fld_summary', type: 'textarea', name: 'summary' },
            { id: 'fld_event_keywords', type: 'textarea', name: 'keywords' },
          ],
        },
      },
    ],
  }
  // The type editor's Use shared group keeps the copy's id and its own settings
  const using = { ...copy, fields: [copy.fields[0], { ...use('fld_event_seo', 'seo'), label: 'Search' }] }
  const { file, source, notes } = await migration([copy], [expand(using, seo)])

  // Matched fields are flagged for their changed settings and types, as any field is
  expect(notes).toEqual([
    "Flagged: deletes the values of seo.summary, which down can't bring back. Old versions keep them",
    'Flagged: seo.title has a new maxLength, so some entries may not pass. Run sorlo migrate --check',
    'TODO: seo.keywords changed from textarea to text. Convert its values here, and back in down',
  ])
  expect(source).not.toContain("'seo.title'")

  const event = { name: 'Launch', seo: { title: 'Launch day', summary: 'Gone', keywords: 'rockets' } }
  expect((await roundTrip(file, event, 'events')).up).toEqual({
    name: 'Launch',
    seo: { title: 'Launch day', keywords: 'rockets' },
  })
})

test('swapping one shared group for another matches fields by name, even where their ids are the same', async () => {
  // Its title has the id of seo's keywords, as in a group file copied from another and edited
  const meta: SharedGroup = {
    id: 'grp_meta',
    name: 'meta',
    label: 'Meta',
    fields: [
      { id: 'fld_k', type: 'text', name: 'title' },
      { id: 'fld_x', type: 'text', name: 'extra' },
    ],
  }
  const swapped = { ...pages, fields: [pages.fields[0], use('fld_seo', 'seo', 'grp_meta')] }
  const { file, notes } = await migration([expand(pages, seo)], [expand(swapped, meta)])

  expect(notes).toEqual([
    "Flagged: deletes the values of seo.description, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of seo.keywords, which down can't bring back. Old versions keep them",
  ])
  const page = { heading: 'Home', seo: { title: 'Welcome', description: 'Hi', keywords: 'home' } }
  expect((await roundTrip(file, page, 'pages')).up).toEqual({ heading: 'Home', seo: { title: 'Welcome' } })
})

test("a copy in a list's items or a layout keeps its values when swapped, the groups inside it matched by path", async () => {
  const og: SharedGroup = {
    id: 'grp_og',
    name: 'og',
    label: 'Sharing',
    fields: [
      { id: 'fld_image', type: 'url', name: 'image' },
      { id: 'fld_alt', type: 'text', name: 'alt' },
    ],
  }
  const card: SharedGroup = {
    id: 'grp_card',
    name: 'card',
    label: 'Card',
    fields: [{ id: 'fld_card_title', type: 'text', name: 'title' }, use('fld_card_share', 'share', 'grp_og')],
  }
  // A card of its own, holding a group of its own, in news's items and in its hero layout
  const ownCard = (id: string) => ({
    id,
    type: 'group',
    name: 'card',
    options: {
      fields: [
        { id: `${id}_title`, type: 'text', name: 'title' },
        {
          id: `${id}_share`,
          type: 'group',
          name: 'share',
          options: {
            fields: [
              { id: `${id}_image`, type: 'url', name: 'image' },
              { id: `${id}_caption`, type: 'text', name: 'caption' },
            ],
          },
        },
      ],
    },
  })
  const layout = (field: object) => ({ id: 'lay_hero', name: 'hero', fields: [field] })
  const own: ContentType = {
    ...news,
    fields: [
      { id: 'fld_items', type: 'repeater', name: 'items', options: { fields: [ownCard('fld_item_card')] } },
      { id: 'fld_sections', type: 'flexible', name: 'sections', options: { layouts: [layout(ownCard('fld_hero'))] } },
    ],
  }
  const using: ContentType = {
    ...news,
    fields: [
      {
        id: 'fld_items',
        type: 'repeater',
        name: 'items',
        options: { fields: [use('fld_item_card', 'card', 'grp_card')] },
      },
      {
        id: 'fld_sections',
        type: 'flexible',
        name: 'sections',
        options: { layouts: [layout(use('fld_hero', 'card', 'grp_card'))] },
      },
    ],
  }
  const { file, notes } = await migration([own], [expand(using, card, og)])

  expect(notes).toEqual([
    "Flagged: deletes the values of items.card.share.caption, which down can't bring back. Old versions keep them",
    "Flagged: deletes the values of sections.hero.card.share.caption, which down can't bring back. Old versions keep them",
  ])
  const share = { image: 'https://example.com/a.png', caption: 'A' }
  const { up } = await roundTrip(
    file,
    { items: [{ card: { title: 'One', share } }], sections: [{ _layout: 'hero', card: { title: 'Two', share } }] },
    'news',
  )
  expect(up).toEqual({
    items: [{ card: { title: 'One', share: { image: share.image } } }],
    sections: [{ _layout: 'hero', card: { title: 'Two', share: { image: share.image } } }],
  })
})
