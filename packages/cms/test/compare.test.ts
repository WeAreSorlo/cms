import {
  compare,
  compareParent,
  compareTypes,
  diffLines,
  diffWords,
  linksOf,
  parentField,
  toJson,
} from '../admin/compare'
import type { FieldSchema } from '@sorlo/core'
import { expect, test } from 'vitest'

// Comparing versions (PLAN.md section 20): what changed between two versions' values, worked out in the admin

const fields: Array<FieldSchema> = [
  { id: 'fld_title', type: 'text', name: 'title', label: 'Title' },
  { id: 'fld_views', type: 'number', name: 'views', label: 'Views' },
  { id: 'fld_featured', type: 'boolean', name: 'featured', label: 'Featured' },
  { id: 'fld_body', type: 'textarea', name: 'body', label: 'Body' },
  {
    id: 'fld_seo',
    type: 'group',
    name: 'seo',
    label: 'SEO',
    options: {
      fields: [
        { id: 'fld_seo_title', type: 'text', name: 'title', label: 'Title' },
        {
          id: 'fld_social',
          type: 'group',
          name: 'social',
          label: 'Social',
          options: { fields: [{ id: 'fld_image', type: 'media', name: 'image', label: 'Image' }] },
        },
      ],
    },
  },
  {
    id: 'fld_credits',
    type: 'repeater',
    name: 'credits',
    label: 'Credits',
    options: {
      fields: [
        { id: 'fld_person', type: 'relationship', name: 'person', label: 'Person' },
        { id: 'fld_role', type: 'text', name: 'role', label: 'Role' },
      ],
    },
  },
  {
    id: 'fld_blocks',
    type: 'flexible',
    name: 'blocks',
    label: 'Blocks',
    options: {
      layouts: [
        { id: 'lay_text', name: 'text', label: 'Text', fields: [{ id: 'fld_text', type: 'textarea', name: 'text' }] },
        {
          id: 'lay_gallery',
          name: 'gallery',
          label: 'Gallery',
          fields: [{ id: 'fld_images', type: 'media', name: 'images', label: 'Images' }],
        },
      ],
    },
  },
  {
    id: 'fld_prices',
    type: 'matrix',
    name: 'prices',
    label: 'Prices',
    options: { fields: [{ id: 'fld_price', type: 'number', name: 'price', label: 'Price' }] },
  },
  { id: 'fld_author', type: 'relationship', name: 'author', label: 'Author', options: { maximum: 1 } },
]

// Each change as its path of labels and kind, and each item as its label and kind
const summary = (changes: ReturnType<typeof compare>): Array<unknown> =>
  changes.map((change) => [
    change.labels.join(' › '),
    change.kind,
    ...(change.items ? [change.items.map((item) => [item.label, item.kind, summary(item.changes)])] : []),
  ])

test('compares fields by value, whatever order keys come in, with an empty value the same as none', () => {
  const before = { title: 'Hello', views: 3, featured: false, seo: { title: 'Hi' }, body: '' }
  const after = { seo: { title: 'Hi' }, featured: true, views: 4, title: 'Hello', credits: [] }
  expect(compare(fields, before, before)).toEqual([])
  expect(compare(fields, before, { ...before, seo: { ...before.seo } })).toEqual([])
  expect(compare(fields, before, after)).toEqual([
    { labels: ['Views'], field: fields[1], kind: 'changed', before: 3, after: 4 },
    { labels: ['Featured'], field: fields[2], kind: 'changed', before: false, after: true },
  ])

  // A value set or cleared is added or removed
  expect(summary(compare(fields, { title: 'Hello' }, { views: 1 }))).toEqual([
    ['Title', 'removed'],
    ['Views', 'added'],
  ])
})

test("names a group's fields by their path of labels, at any depth", () => {
  const before = { seo: { title: 'Old', social: { image: 'file-1' } } }
  const after = { seo: { title: 'New', social: { image: 'file-2' } } }
  expect(summary(compare(fields, before, after))).toEqual([
    ['SEO › Title', 'changed'],
    ['SEO › Social › Image', 'changed'],
  ])
})

test('counts every field with a value as added when there is no version before', () => {
  const first = { title: 'Hello', views: 0, featured: false, body: '', seo: { title: 'Hi' }, author: 'entry-1' }
  expect(summary(compare(fields, undefined, first))).toEqual([
    ['Title', 'added'],
    ['Views', 'added'],
    ['Featured', 'added'],
    ['SEO › Title', 'added'],
    ['Author', 'added'],
  ])
})

test("matches a repeater's items by position, listing the changed fields inside each", () => {
  const before = {
    credits: [
      { person: 'ada', role: 'Writer' },
      { person: 'grace', role: 'Editor' },
    ],
  }
  const after = {
    credits: [
      { role: 'Writer', person: 'ada' },
      { person: 'grace', role: 'Copy editor' },
      { person: 'alan', role: 'Photos' },
    ],
  }
  expect(summary(compare(fields, before, after))).toEqual([
    [
      'Credits',
      'changed',
      [
        ['Item 2', 'changed', [['Role', 'changed']]],
        [
          'Item 3',
          'added',
          [
            ['Person', 'added'],
            ['Role', 'added'],
          ],
        ],
      ],
    ],
  ])
  expect(summary(compare(fields, after, before))[0]).toEqual([
    'Credits',
    'changed',
    [
      ['Item 2', 'changed', [['Role', 'changed']]],
      [
        'Item 3',
        'removed',
        [
          ['Person', 'removed'],
          ['Role', 'removed'],
        ],
      ],
    ],
  ])

  // Keys no field reads don't count as changes
  expect(compare(fields, before, { credits: before.credits.map((item) => ({ ...item, _key: 1 })) })).toEqual([])
})

test('matches flexible blocks by position, and a block that swaps its layout is removed and added', () => {
  const before = {
    blocks: [
      { _layout: 'text', text: 'One' },
      { _layout: 'text', text: 'Two' },
    ],
  }
  const after = {
    blocks: [
      { _layout: 'text', text: 'One, edited' },
      { _layout: 'gallery', images: ['file-1'] },
    ],
  }
  expect(summary(compare(fields, before, after))).toEqual([
    [
      'Blocks',
      'changed',
      [
        ['Block 1: Text', 'changed', [['text', 'changed']]],
        ['Block 2: Text', 'removed', [['text', 'removed']]],
        ['Block 2: Gallery', 'added', [['Images', 'added']]],
      ],
    ],
  ])
})

test("matches a matrix's cells by row and column", () => {
  const before = { prices: [[{ price: 1 }, { price: 2 }]] }
  const after = { prices: [[{ price: 1 }, { price: 3 }], [{ price: 4 }]] }
  expect(summary(compare(fields, before, after))).toEqual([
    [
      'Prices',
      'changed',
      [
        ['Row 1, column 2', 'changed', [['Price', 'changed']]],
        ['Row 2, column 1', 'added', [['Price', 'added']]],
      ],
    ],
  ])
})

test('lists the entries, files and forms that changed links name, inside lists too, once each', () => {
  const before = { author: 'ada', credits: [{ person: 'grace' }], seo: { social: { image: 'logo' } } }
  const after = {
    author: 'alan',
    credits: [{ person: 'ada' }],
    seo: { social: { image: 'photo' } },
    blocks: [{ _layout: 'gallery', images: ['photo', 'map'] }],
    form: 'contact',
  }
  const withForm: Array<FieldSchema> = [...fields, { type: 'form', name: 'form', label: 'Form' }]
  expect(linksOf(compare(withForm, before, after))).toEqual({
    entries: ['grace', 'ada', 'alan'],
    files: ['logo', 'photo', 'map'],
    forms: ['contact'],
  })
})

test('a text comparison shows the words added and removed, keeping the spaces and line breaks', () => {
  expect(diffWords('The quick brown fox', 'The quick red fox')).toEqual([
    { kind: 'same', text: 'The quick ' },
    { kind: 'removed', text: 'brown' },
    { kind: 'added', text: 'red' },
    { kind: 'same', text: ' fox' },
  ])
  expect(diffWords('One line.\nTwo lines.', 'One line.\nThen two lines.')).toEqual([
    { kind: 'same', text: 'One line.\n' },
    { kind: 'removed', text: 'Two' },
    { kind: 'added', text: 'Then two' },
    { kind: 'same', text: ' lines.' },
  ])
  expect(diffWords('A b c d', 'A c d e')).toEqual([
    { kind: 'same', text: 'A ' },
    { kind: 'removed', text: 'b ' },
    { kind: 'same', text: 'c d' },
    { kind: 'added', text: ' e' },
  ])
  expect(diffWords('Same', 'Same')).toEqual([{ kind: 'same', text: 'Same' }])
  expect(diffWords('', 'New text')).toEqual([{ kind: 'added', text: 'New text' }])
  expect(diffWords('Old text', '')).toEqual([{ kind: 'removed', text: 'Old text' }])

  // Past the cap, everything between the first and last change shows as removed, then added
  const long = (word: string) => Array.from({ length: 1200 }, (_, index) => `${word}${index}`).join(' ')
  expect(diffWords(`Start ${long('a')} end`, `Start ${long('b')} end`)).toEqual([
    { kind: 'same', text: 'Start ' },
    { kind: 'removed', text: long('a') },
    { kind: 'added', text: long('b') },
    { kind: 'same', text: ' end' },
  ])
})

test('the JSON view shows two versions with their keys in order, a line at a time, with the lines added and removed', () => {
  const before = { title: 'Hello', seo: { title: 'Hi', image: 'a' }, views: 1, tags: ['b', 'a'] }
  const after = { views: 1, tags: ['b', 'a'], seo: { image: 'a', title: 'Hi there' }, title: 'Hello', extra: true }
  // The order Postgres keeps keys in doesn't count, but a list's order does
  expect(toJson(before)).toBe(toJson({ views: 1, tags: ['b', 'a'], title: 'Hello', seo: { image: 'a', title: 'Hi' } }))
  expect(toJson({ tags: ['a', 'b'] })).not.toBe(toJson({ tags: ['b', 'a'] }))

  expect(diffLines(toJson(before), toJson(after))).toEqual([
    { kind: 'same', text: '{\n' },
    { kind: 'added', text: '  "extra": true,\n' },
    { kind: 'same', text: '  "seo": {\n    "image": "a",\n' },
    { kind: 'removed', text: '    "title": "Hi"\n' },
    { kind: 'added', text: '    "title": "Hi there"\n' },
    { kind: 'same', text: '  },\n  "tags": [\n    "b",\n    "a"\n  ],\n  "title": "Hello",\n  "views": 1\n}\n' },
  ])

  // Before a first version there's no JSON, so every line is added
  expect(diffLines(toJson(undefined), toJson({ a: 1 }))).toEqual([{ kind: 'added', text: '{\n  "a": 1\n}\n' }])
  expect(diffLines('', '')).toEqual([])
})

test("a page's move shows as a change of its Parent, where a null parent is the top level", () => {
  expect(compareParent('guide', 'guide')).toEqual([])
  expect(compareParent(null, null)).toEqual([])
  // A first version at the top level has no parent to add
  expect(compareParent(undefined, null)).toEqual([])
  expect(summary(compareParent(undefined, 'guide'))).toEqual([['Parent', 'added']])
  expect(compareParent('guide', null)).toEqual([
    { labels: ['Parent'], field: parentField, kind: 'changed', before: 'guide', after: null },
  ])
  expect(linksOf(compareParent('guide', 'help'))).toEqual({ entries: ['guide', 'help'], files: [], forms: [] })
})

test("a content type's proposal compares its fields by id: renamed, moved, retyped, changed, added and removed", () => {
  const before = {
    id: 'typ_post',
    name: 'post',
    label: 'Posts',
    structure: 'collection',
    titleField: 'title',
    fields: [
      { id: 'fld_title', type: 'text', name: 'title', label: 'Title' },
      { id: 'fld_intro', type: 'text', name: 'intro', label: 'Intro' },
      {
        id: 'fld_tag',
        type: 'select',
        name: 'tag',
        label: 'Tag',
        options: { choices: [{ value: 'a' }, { value: 'b' }] },
      },
      {
        id: 'fld_old',
        type: 'group',
        name: 'old',
        label: 'Old',
        options: { fields: [{ id: 'fld_inner', type: 'text', name: 'inner' }] },
      },
      { id: 'fld_meta', type: 'group', name: 'meta', label: 'Meta', options: { fields: [] } },
    ],
  }
  const after = {
    ...before,
    name: 'article',
    drafts: false,
    fields: [
      { id: 'fld_title', type: 'text', name: 'title', label: 'Title', required: true },
      { id: 'fld_intro', type: 'textarea', name: 'summary', label: 'Summary' },
      {
        id: 'fld_tag',
        type: 'select',
        name: 'tag',
        label: 'Tag',
        options: { choices: [{ value: 'b' }, { value: 'c' }] },
      },
      {
        id: 'fld_meta',
        type: 'group',
        name: 'meta',
        label: 'Meta',
        options: {
          fields: [
            {
              id: 'fld_new',
              type: 'group',
              name: 'extra',
              options: { fields: [{ id: 'fld_deep', type: 'text', name: 'deep' }] },
            },
          ],
        },
      },
    ],
  }
  const names: Record<string, string> = { text: 'Text', textarea: 'Long text', group: 'Group', select: 'Select' }
  expect(compareTypes(before, after, (type) => names[type])).toEqual([
    { labels: ['Name'], kind: 'changed', details: ['post → article'], api: true },
    { labels: ['Drafts'], kind: 'changed', details: ['on → off'], api: false },
    { labels: ['Title'], kind: 'changed', details: ['Now required'], api: false },
    {
      labels: ['Summary'],
      kind: 'changed',
      details: ['Renamed from intro to summary', 'Text → Long text', 'Label Intro → Summary'],
      api: true,
    },
    { labels: ['Tag'], kind: 'changed', details: ['Lost the choice a', 'New choice c'], api: false },
    // A new group counts once, with what's inside it
    { labels: ['Meta', 'extra'], kind: 'added', details: ['Group'], api: false },
    { labels: ['Old'], kind: 'removed', details: [], api: true },
  ])
  expect(compareTypes(before, before)).toEqual([])
})

test("a type's comparison says conditions and choices in words, whatever shape the conditions take", () => {
  const field = { id: 'fld_venue', type: 'group', name: 'venue', label: 'Venue', options: { fields: [] } }
  const choices = { id: 'fld_format', type: 'radio', name: 'format', label: 'Format' }
  const before = {
    fields: [
      { ...field, conditions: [{ field: 'format', operator: 'notEquals', value: 'online' }] },
      { ...choices, options: { choices: [{ value: 'online', label: 'Online' }] } },
    ],
  }
  const after = {
    fields: [
      {
        ...field,
        conditions: [
          { rules: [{ field: 'format', operator: 'equals', value: 'in_person' }] },
          { rules: [{ field: 'venue.name', operator: 'notEmpty' }] },
        ],
      },
      {
        ...choices,
        options: {
          choices: [
            { value: 'online', label: 'On the web' },
            { value: 'hybrid', label: 'Hybrid' },
          ],
        },
      },
    ],
  }
  expect(compareTypes(before, after).map((change) => change.details)).toEqual([
    ['New conditions: format is in_person, or venue.name is not empty'],
    ['New choice Hybrid (hybrid)', 'Relabelled online from Online to On the web'],
  ])
  expect(
    compareTypes(after, {
      ...after,
      fields: [
        after.fields[0],
        {
          ...after.fields[1],
          options: {
            choices: [
              { value: 'online', label: 'Online' },
              { value: 'hybrid', label: 'Hybrid' },
            ],
          },
        },
      ],
    })[0].details,
  ).toEqual(['Relabelled online from On the web to Online'])
})
