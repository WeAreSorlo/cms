import { createApp } from '../src/app'
import { ContentMigrationFile, contentMigrations } from '../src/content'
import { migrate, rollback } from '../src/migrator'
import type { ContentType } from '../src/types'
import { db } from './database'
import { blog, setUp, types } from './fixtures'
import { afterAll, beforeAll, expect, test } from 'vitest'

let cookie: string
beforeAll(async () => ({ cookie } = await setUp()))
afterAll(() => db.destroy())

// The blog type once its title is renamed, and the content migration that renames it
const renamed: ContentType = {
  ...blog,
  titleField: 'headline',
  listColumns: ['headline'],
  fields: blog.fields.map((field) => (field.name === 'title' ? { ...field, name: 'headline' } : field)),
}
const files: Record<string, ContentMigrationFile> = {
  '2026_10_28_120000_blog': {
    up: ({ entries }) => entries.renameField('blog', 'title', 'headline'),
    down: ({ entries }) => entries.renameField('blog', 'headline', 'title'),
  },
}
// The site before the migration was written, once it's been written but not run or been rolled back, and once it's run
const fresh = createApp(db, types)
const before = createApp(db, types, { migrations: async () => files })
const after = createApp(db, new Map([...types, ['blog', renamed]]), { migrations: async () => files })

const send = async (app: typeof before, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { cookie, origin: 'http://localhost', 'content-type': 'application/json' }
  const response = await app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

const markers = async () =>
  (await db.selectFrom('entry_versions').select('migration').orderBy('number').execute()).map((row) => row.migration)

test('restoring a version first runs the content migrations that ran after it was saved', async () => {
  const created = await send(fresh, 'POST', '/types/blog/entries', { values: { title: 'Hello', slug: 'hello' } })
  const id = created.body.data.id
  expect(await markers()).toEqual([null])

  await migrate(db, contentMigrations(files))
  const entry = (await send(after, 'GET', `/entries/${id}`)).body.data
  expect(entry.values).toMatchObject({ headline: 'Hello', slug: 'hello' })
  expect(entry.values).not.toHaveProperty('title')

  // Version 1 was saved before the rename, so it comes back renamed
  const first = await send(after, 'GET', `/entries/${id}/versions/1`)
  expect(first.body.data.values).toMatchObject({ headline: 'Hello', slug: 'hello' })
  expect(first.body.data.values).not.toHaveProperty('title')

  // A save records the migration its values have been through, so its version is already up to date
  const saved = await send(after, 'PUT', `/entries/${id}`, { values: { headline: 'Hello again', slug: 'hello' } })
  expect(saved.status).toBe(200)
  expect(await markers()).toEqual([null, '2026_10_28_120000_blog'])
  expect((await send(after, 'GET', `/entries/${id}/versions/2`)).body.data.values).toMatchObject({
    headline: 'Hello again',
  })

  // Rolled back, version 1 is as it was saved, and version 2 waits for the migration to run again, as saves do
  await rollback(db, contentMigrations(files))
  expect(await send(before, 'PUT', `/entries/${id}`, { values: { title: 'Hello', slug: 'hello' } })).toEqual({
    status: 409,
    body: { message: "Run iight migrate first. The content migration 2026_10_28_120000_blog hasn't run yet." },
  })
  expect((await send(before, 'GET', `/entries/${id}/versions/1`)).body.data.values).toMatchObject({ title: 'Hello' })
  expect(await send(before, 'GET', `/entries/${id}/versions/2`)).toEqual({
    status: 409,
    body: {
      message:
        'Version 2 was saved after the content migration 2026_10_28_120000_blog, which has been rolled back. Migrate again to restore it.',
    },
  })
})
