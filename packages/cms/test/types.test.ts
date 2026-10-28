import { checkType, loadTypes } from '../src/types'
import { blog, docs, home } from './fixtures'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iight-types-'))
})
afterEach(() => rm(dir, { recursive: true }))

const write = (files: Record<string, unknown>) =>
  Promise.all(
    Object.entries(files).map(([file, type]) =>
      writeFile(join(dir, file), typeof type === 'string' ? type : JSON.stringify(type)),
    ),
  )

test('loads every type in the folder by name, and none from a missing folder', async () => {
  await write({ 'blog.json': blog, 'docs.json': docs, 'home.json': home, 'notes.txt': 'not a type' })

  const types = await loadTypes(dir)
  expect([...types.keys()]).toEqual(['blog', 'docs', 'home'])
  expect(types.get('blog')).toEqual(blog)

  expect((await loadTypes(join(dir, 'missing'))).size).toBe(0)
})

test('lists the problems in every file at once', async () => {
  await write({ 'broken.json': '{ "id": ', 'blog.json': blog, 'news.json': { ...blog, name: 'news' } })

  await expect(loadTypes(dir)).rejects.toThrow(
    [
      `The content types in ${dir} have problems:`,
      'broken.json: Unexpected end of JSON input',
      'news.json: Its id, typ_blog, is also used by blog.json.',
    ].join('\n  '),
  )
})

test('checks the settings', () => {
  expect(checkType([], 'blog')).toEqual(['It must hold a JSON object.'])
  expect(
    checkType(
      {
        name: 'blog posts',
        structure: 'list',
        icon: 7,
        titleFeild: 'title',
        titleField: 'heading',
        slugField: 'title',
        listColumns: ['title', 'author'],
        fields: blog.fields,
      },
      'blog posts',
    ),
  ).toEqual([
    `"titleFeild" isn't a content type setting.`,
    'It needs an "id", such as typ_k3x9q2mz.',
    '"name" must be a letter, then letters, digits or underscores.',
    'It needs a "label".',
    '"icon" must be text.',
    '"structure" must be collection, hierarchical or singleton.',
    '"titleField" must name a top-level field.',
    '"slugField" must name a top-level identifier field.',
    '"listColumns" must list top-level fields.',
  ])
  expect(checkType(blog, 'news')).toEqual([`"name" must match the file's name, news.`])
})

test('checks every field and layout, however deeply nested', () => {
  const fields = [
    { id: 'fld_a', type: 'text', name: 'title' },
    { id: 'fld_a', type: 'text', name: 'title' },
    { type: 'colour', name: 'first name' },
    {
      id: 'fld_group',
      type: 'group',
      name: 'address',
      options: { fields: [{ type: 'text', name: 'town' }] },
    },
    {
      id: 'fld_blocks',
      type: 'flexible',
      name: 'blocks',
      options: { layouts: [{ name: 'hero', fields: [{ id: 'fld_heading', type: 'text', name: '_layout' }] }, {}] },
    },
    { id: 'fld_list', type: 'repeater', name: 'list', options: { fields: 'title' } },
  ]

  expect(
    checkType({ ...blog, titleField: undefined, slugField: undefined, listColumns: undefined, fields }, 'blog'),
  ).toEqual([
    'Field "title" is defined twice.',
    'Field "title" has the same id as another, fld_a.',
    'Field "first name" needs a name made of a letter, then letters, digits or underscores.',
    'Field "first name" needs an "id", such as fld_k3x9q2mz.',
    'Field "first name" has an unknown type, colour.',
    'Field "address.town" needs an "id", such as fld_k3x9q2mz.',
    'Layout "blocks.hero" needs an "id", such as lay_k3x9q2mz.',
    'Field "blocks.hero._layout" needs a name made of a letter, then letters, digits or underscores.',
    'Layout "blocks.undefined" needs a name made of a letter, then letters, digits or underscores.',
    'Layout "blocks.undefined" needs an "id", such as lay_k3x9q2mz.',
    '"list" must list its fields.',
  ])
})

test('checks default values with their inputs, at any depth', () => {
  const fields = [
    { id: 'fld_email', type: 'email', name: 'email', defaultValue: 'nope' },
    // A default only has to be a value the input accepts, not fill a required field
    { id: 'fld_terms', type: 'boolean', name: 'terms', required: true, defaultValue: false },
    { id: 'fld_title', type: 'text', name: 'title', required: true, defaultValue: '' },
    {
      id: 'fld_links',
      type: 'repeater',
      name: 'links',
      options: { fields: [{ id: 'fld_url', type: 'url', name: 'url', defaultValue: 'example' }] },
    },
  ]

  expect(
    checkType({ ...blog, titleField: undefined, slugField: undefined, listColumns: undefined, fields }, 'blog'),
  ).toEqual([
    'Field "email" has an invalid default value. A valid email address required.',
    'Field "links.url" has an invalid default value. A valid URL required.',
  ])
})
