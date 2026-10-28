import {
  ContentMigration,
  ContentMigrationFile,
  appliedMigrations,
  catchUp,
  checkEntries,
  contentMigrations,
} from '../src/content'
import { uuidv7 } from '../src/db'
import { migrate, rollback } from '../src/migrator'
import { db } from './database'
import { setUp, types } from './fixtures'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

beforeAll(setUp)
beforeEach(async () => {
  await db.deleteFrom('entries').execute()
  await db.deleteFrom('migrations').where('name', 'like', 'content_%').execute()
})
afterAll(() => db.destroy())

// One blog entry's values after a migration's up, run as an old version's catch-up runs it
const apply = (values: object, up: ContentMigration, type = 'blog') => catchUp(type, structuredClone(values), [up])

describe('the helpers', () => {
  test('rename fields at the top, in groups, in every repeater or matrix item, and in a layout', async () => {
    const values = {
      title: 'Hello',
      address: { town: 'Leeds' },
      pets: [{ name: 'Rex' }, { name: 'Tib' }],
      grid: [[{ cell: 1 }, { cell: 2 }], [{ cell: 3 }]],
      blocks: [
        { _layout: 'quote', quote: 'Hi', credit: 'Ada' },
        { _layout: 'text', credit: 'stays' },
      ],
    }

    expect(
      await apply(values, ({ entries }) => {
        entries.renameField('blog', 'title', 'headline')
        entries.renameField('blog', 'address.town', 'address.city')
        entries.renameField('blog', 'pets.name', 'pets.full_name')
        entries.renameField('blog', 'grid.cell', 'grid.value')
        entries.renameField('blog', 'blocks.quote.credit', 'blocks.quote.attribution')
      }),
    ).toEqual({
      headline: 'Hello',
      address: { city: 'Leeds' },
      pets: [{ full_name: 'Rex' }, { full_name: 'Tib' }],
      grid: [[{ value: 1 }, { value: 2 }], [{ value: 3 }]],
      blocks: [
        { _layout: 'quote', quote: 'Hi', attribution: 'Ada' },
        { _layout: 'text', credit: 'stays' },
      ],
    })
  })

  test('move fields into and out of groups, inside each item of a list too', async () => {
    const values = { town: 'Leeds', meta: { seo: { title: 'T' } }, pets: [{ name: 'Rex', vet: { phone: '1' } }] }
    expect(
      await apply(values, ({ entries }) => {
        entries.renameField('blog', 'town', 'address.town')
        entries.renameField('blog', 'meta.seo.title', 'seo_title')
        entries.renameField('blog', 'pets.vet.phone', 'pets.phone')
      }),
    ).toEqual({
      address: { town: 'Leeds' },
      meta: { seo: {} },
      seo_title: 'T',
      pets: [{ name: 'Rex', vet: {}, phone: '1' }],
    })

    // Nothing to move leaves the values alone, and a move into or out of a list is refused
    expect(await apply({}, ({ entries }) => entries.renameField('blog', 'town', 'address.town'))).toEqual({})
    await expect(apply(values, ({ entries }) => entries.renameField('blog', 'pets.name', 'name'))).rejects.toThrow(
      "Can't move a value into or out of the list pets.",
    )
  })

  test('remove, add and map fields, and rename and remove layouts', async () => {
    const values = {
      summary: 'Gone',
      views: '7',
      pets: [{ name: 'Rex' }, { name: 'Tib', age: 3 }],
      blocks: [{ _layout: 'quote', quote: 'Hi' }, { _layout: 'text', body: 'B' }, { _layout: 'old' }],
    }

    expect(
      await apply(values, ({ entries }) => {
        entries.removeField('blog', 'summary')
        entries.mapField('blog', 'views', Number)
        entries.addField('blog', 'pets.age', 0)
        entries.addField('blog', 'featured', false)
        entries.renameLayout('blog', 'blocks.quote', 'blocks.citation')
        entries.removeLayout('blog', 'blocks.old')
      }),
    ).toEqual({
      views: 7,
      featured: false,
      pets: [
        { name: 'Rex', age: 0 },
        { name: 'Tib', age: 3 },
      ],
      blocks: [
        { _layout: 'citation', quote: 'Hi' },
        { _layout: 'text', body: 'B' },
      ],
    })

    await expect(
      apply(values, ({ entries }) => entries.renameLayout('blog', 'blocks.quote', 'other.quote')),
    ).rejects.toThrow("Can't rename blocks.quote to other.quote, outside its flexible field.")
  })

  test("only change the named type's entries, following its renames", async () => {
    const up: ContentMigration = ({ entries }) => {
      entries.renameField('posts', 'title', 'name')
      entries.renameType('posts', 'blog')
      entries.update('blog', (values) => ({ ...values, renamed: true }))
    }
    expect(await apply({ title: 'T' }, up, 'docs')).toEqual({ title: 'T' })

    // An old version of a blog entry starts out as posts, the type's name before the rename
    expect(await apply({ title: 'T' }, up, 'blog')).toEqual({ name: 'T', renamed: true })
  })
})

describe('running content migrations', () => {
  const renameTitle: ContentMigrationFile = {
    up: ({ entries }) => entries.renameField('blog', 'title', 'headline'),
    down: ({ entries }) => entries.renameField('blog', 'headline', 'title'),
  }

  const insert = (count: number, type = 'blog') =>
    db
      .insertInto('entries')
      .values(Array.from({ length: count }, (_, index) => ({ id: uuidv7(), type, values: { title: `Post ${index}` } })))
      .execute()

  test('change every entry, a batch at a time, and roll back', async () => {
    await insert(1203)
    await insert(1, 'docs')
    const files = { content_2026_01_01_000000_blog: renameTitle }

    await migrate(db, contentMigrations(files))
    const rows = await db.selectFrom('entries').select(['type', 'values', 'migration']).orderBy('id').execute()
    expect(rows.filter((row) => row.type === 'blog').every((row) => row.values.headline && !row.values.title)).toBe(
      true,
    )
    expect(rows.find((row) => row.type === 'docs')?.values).toEqual({ title: 'Post 0' })
    expect(new Set(rows.map((row) => row.migration))).toEqual(new Set(['content_2026_01_01_000000_blog']))
    expect(await appliedMigrations(db, files)).toEqual(['content_2026_01_01_000000_blog'])

    await rollback(db, contentMigrations(files))
    const back = await db.selectFrom('entries').select(['values', 'migration']).where('type', '=', 'blog').execute()
    expect(back.every((row) => row.values.title && !row.values.headline && row.migration === null)).toBe(true)
  })

  test('a failing migration changes nothing', async () => {
    await insert(3)
    const failing: ContentMigrationFile = {
      up: ({ entries }) => {
        entries.renameField('blog', 'title', 'headline')
        entries.update('blog', () => {
          throw new Error('Not this one')
        })
      },
      down: () => {},
    }

    await expect(migrate(db, contentMigrations({ content_2026_01_01_000000_fails: failing }))).rejects.toThrow(
      'Not this one',
    )
    expect((await db.selectFrom('entries').select('values').execute()).every((row) => row.values.title)).toBe(true)
  })

  test("won't rename a type onto one that has entries", async () => {
    await insert(1, 'posts')
    await insert(1)
    const rename: ContentMigrationFile = {
      up: ({ entries }) => entries.renameType('posts', 'blog'),
      down: ({ entries }) => entries.renameType('blog', 'posts'),
    }
    await expect(migrate(db, contentMigrations({ content_2026_01_01_000000_posts: rename }))).rejects.toThrow(
      "Can't rename the type posts to blog, which already has entries.",
    )
  })
})

test('--check lists the saved entries that no longer pass, and those of types that are gone', async () => {
  const entry = (type: string, values: object, archived = false) => ({
    id: uuidv7(),
    type,
    values,
    archived_at: archived ? new Date() : null,
  })
  const rows = [
    entry('blog', { title: 'Fine', slug: 'fine' }),
    entry('blog', { slug: 'no-title' }, true),
    entry('events', { name: 'Gone' }),
    entry('home', {}),
  ]
  await db.insertInto('entries').values(rows).execute()
  // Every save writes a version, but opening a singleton doesn't
  const saved = rows.slice(0, 3).map((row) => ({ entry_id: row.id, number: 1, values: row.values }))
  await db.insertInto('entry_versions').values(saved).execute()

  // IDs made in the same millisecond needn't sort in the order they were made
  const failures = await checkEntries(db, types)
  expect(Object.fromEntries(failures.map(({ entry, messages }) => [entry.id, messages]))).toEqual({
    [rows[1].id]: { title: ['This field is required.'] },
    [rows[2].id]: { type: ["There's no content type named events any more."] },
  })
})
