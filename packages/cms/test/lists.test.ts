import { entryFields, fieldChoicesOf, filterOf, whereOf } from '../admin/lists'
import { uuidv7 } from '../src/db'
import { listEntries, parseQuery } from '../src/query'
import type { ContentType } from '../src/types'
import { db } from './database'
import { setUp } from './fixtures'
import type { FieldSchema } from 'iight'
import { afterAll, expect, test } from 'vitest'

// A list's filter (PLAN.md section 21): core's conditions over a type's fields, as the list API's where

const fields: Array<FieldSchema> = [
  { id: 'fld_title', type: 'text', name: 'title', label: 'Title' },
  { id: 'fld_views', type: 'number', name: 'views', label: 'Views' },
  { id: 'fld_featured', type: 'boolean', name: 'featured', label: 'Featured' },
  { id: 'fld_published', type: 'date', name: 'published', label: 'Published' },
  {
    id: 'fld_rating',
    type: 'select',
    name: 'rating',
    label: 'Rating',
    options: {
      choices: [
        { value: 1, label: 'One' },
        { value: 2, label: 'Two' },
      ],
    },
  },
  {
    id: 'fld_tags',
    type: 'checkbox',
    name: 'tags',
    label: 'Tags',
    options: {
      choices: [
        { value: 'news', label: 'News' },
        { value: 'tech', label: 'Tech' },
      ],
    },
  },
  { id: 'fld_credits', type: 'repeater', name: 'credits', label: 'Credits', options: { fields: [] } },
  { id: 'fld_author', type: 'relationship', name: 'author', label: 'Author' },
]

const lists = entryFields(fields)
const rule = (field: string, operator: string, value?: string) => ({ field: `values.${field}`, operator, value })
const where = (...groups: Array<Array<object>>) =>
  whereOf(
    lists,
    groups.map((rules) => ({ rules })),
  ).where

afterAll(() => db.destroy())

test('lists the top-level fields rules can compare, by the names the list API gives them', () => {
  expect(fieldChoicesOf(lists)).toEqual([
    { value: 'values.title', label: 'Title', type: 'text' },
    { value: 'values.views', label: 'Views', type: 'number' },
    { value: 'values.featured', label: 'Featured', type: 'boolean' },
    { value: 'values.published', label: 'Published', type: 'date' },
    { value: 'values.rating', label: 'Rating', choices: fields[4].options!.choices },
    { value: 'values.tags', label: 'Tags', choices: fields[5].options!.choices },
  ])
})

test('maps each operator the list API can express, with values as their fields store them', () => {
  expect(where([rule('title', 'equals', 'Hello')])).toEqual([[{ field: 'values.title', op: '=', value: 'Hello' }]])
  expect(where([rule('title', 'contains', 'ell')])).toEqual([[{ field: 'values.title', op: 'like', value: 'ell' }]])
  expect(where([rule('views', 'greaterThan', '5')])).toEqual([[{ field: 'values.views', op: '>', value: 5 }]])
  expect(where([rule('published', 'lessThan', '2026-10-01')])).toEqual([
    [{ field: 'values.published', op: '<', value: '2026-10-01' }],
  ])
  expect(where([rule('featured', 'equals', 'false')])).toEqual([[{ field: 'values.featured', op: '=', value: false }]])
  // Core's controls give text, so a choice's value comes back as the choice has it
  expect(where([rule('rating', 'equals', '2')])).toEqual([[{ field: 'values.rating', op: '=', value: 2 }]])
  // A checkbox's list holds each choice quoted
  expect(where([rule('tags', 'contains', 'news')])).toEqual([[{ field: 'values.tags', op: 'like', value: '"news"' }]])
  expect(where([rule('tags', 'empty')])).toEqual([[{ field: 'values.tags', op: 'not exists' }]])
  expect(where([rule('tags', 'notEmpty')])).toEqual([[{ field: 'values.tags', op: 'exists' }]])
})

test('a rule that missing values pass makes a group for them too, as core matches them', () => {
  const title = { field: 'values.title', op: 'like', value: 'a' }
  const notTwo = { field: 'values.rating', op: '!=', value: 2 }
  const noRating = { field: 'values.rating', op: 'not exists' }
  const noNews = { field: 'values.tags', op: 'not like', value: '"news"' }
  const noTags = { field: 'values.tags', op: 'not exists' }

  expect(where([rule('rating', 'notEquals', '2')])).toEqual([[notTwo], [noRating]])
  expect(where([rule('title', 'contains', 'a'), rule('rating', 'notEquals', '2')])).toEqual([
    [title, notTwo],
    [title, noRating],
  ])
  expect(where([rule('rating', 'notEquals', '2'), rule('tags', 'notContains', 'news')])).toEqual([
    [notTwo, noNews],
    [notTwo, noTags],
    [noRating, noNews],
    [noRating, noTags],
  ])
})

test('joins groups with OR, and adds conditions such as a search to every group', () => {
  const search = { field: 'values.title', op: 'like', value: 'lamp' }
  const filter = [{ rules: [rule('views', 'lessThan', '3')] }, { rules: [rule('featured', 'equals', 'true')] }]

  expect(whereOf(lists, filter, [search]).where).toEqual([
    [search, { field: 'values.views', op: '<', value: 3 }],
    [search, { field: 'values.featured', op: '=', value: true }],
  ])
  expect(whereOf(lists, [], [search]).where).toEqual([[search]])
  expect(whereOf(lists, []).where).toEqual([])
})

test("leaves out rules that aren't finished, and counts those the list API can't express", () => {
  const unfinished = [{}, rule('title', 'equals'), rule('title', 'equals', ' '), rule('views', 'greaterThan', 'many')]
  expect(whereOf(lists, [{ rules: unfinished }])).toEqual({ where: [], left: 0 })

  // like matches anywhere, so starts with has no condition, and a link from before a field went has no field
  const unsupported = [rule('title', 'startsWith', 'He'), rule('gone', 'equals', 'x'), rule('title', 'matches', 'x')]
  expect(whereOf(lists, [{ rules: [...unsupported, rule('views', 'equals', '1')] }, { rules: unsupported }])).toEqual({
    where: [[{ field: 'values.views', op: '=', value: 1 }]],
    left: 6,
  })
})

test("reads the filter from a list's query, ignoring one that isn't a list", () => {
  const filter = [{ rules: [rule('title', 'equals', 'Hello')] }]
  expect(filterOf(new URLSearchParams({ filter: JSON.stringify(filter) }))).toEqual(filter)
  expect(filterOf(new URLSearchParams({ filter: '{"rules":[]}' }))).toEqual([])
  expect(filterOf(new URLSearchParams({ filter: '[{' }))).toEqual([])
  expect(filterOf(new URLSearchParams())).toEqual([])
})

test('the list API finds what the rules match, missing values included', async () => {
  await setUp()
  const type: ContentType = { id: 'typ_lists', name: 'lists', label: 'Lists', structure: 'collection', fields }
  const entries = [
    { title: 'Hello world', views: 10, featured: true, rating: 2, tags: ['news', 'tech'] },
    { title: 'Goodbye', views: 3, featured: false, rating: 1, tags: ['tech'] },
    { title: 'Newsroom', tags: [] },
  ]
  await db
    .insertInto('entries')
    .values(entries.map((values) => ({ id: uuidv7(), type: 'lists', values })))
    .execute()

  const titles = async (...groups: Array<Array<object>>) => {
    const query = parseQuery(type, { where: JSON.stringify(where(...groups)), perPage: '100' })
    const { data } = await listEntries<{ values: { title: string } }>(db.selectFrom('entries'), type, query)
    return data.map((entry) => entry.values.title).sort()
  }

  expect(await titles([rule('tags', 'contains', 'news')])).toEqual(['Hello world'])
  expect(await titles([rule('tags', 'notContains', 'news')])).toEqual(['Goodbye', 'Newsroom'])
  expect(await titles([rule('tags', 'empty')])).toEqual(['Newsroom'])
  expect(await titles([rule('featured', 'notEquals', 'true')])).toEqual(['Goodbye', 'Newsroom'])
  expect(await titles([rule('rating', 'equals', '2')])).toEqual(['Hello world'])
  expect(await titles([rule('views', 'greaterThan', '5')], [rule('title', 'contains', 'GOOD')])).toEqual([
    'Goodbye',
    'Hello world',
  ])
})
