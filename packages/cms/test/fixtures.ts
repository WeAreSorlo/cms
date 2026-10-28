import { uuidv7 } from '../src/db'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { hashToken } from '../src/passwords'
import type { ContentType } from '../src/types'
import { db, resetDb } from './database'

// One content type of each structure
export const blog: ContentType = {
  id: 'typ_blog',
  name: 'blog',
  label: 'Blog posts',
  structure: 'collection',
  titleField: 'title',
  slugField: 'slug',
  listColumns: ['title', 'published_at'],
  fields: [
    { id: 'fld_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_slug', type: 'identifier', name: 'slug', label: 'Slug', required: true, options: { source: 'title' } },
    { id: 'fld_published', type: 'date', name: 'published_at', label: 'Published' },
    { id: 'fld_featured', type: 'boolean', name: 'featured', label: 'Featured' },
    { id: 'fld_views', type: 'number', name: 'views', label: 'Views' },
    {
      id: 'fld_blocks',
      type: 'flexible',
      name: 'blocks',
      label: 'Blocks',
      options: {
        layouts: [
          {
            id: 'lay_text',
            name: 'text',
            fields: [{ id: 'fld_body', type: 'textarea', name: 'body', required: true }],
          },
        ],
      },
    },
  ],
}

export const docs: ContentType = {
  id: 'typ_docs',
  name: 'docs',
  label: 'Docs',
  structure: 'hierarchical',
  titleField: 'title',
  slugField: 'slug',
  fields: [
    { id: 'fld_doc_title', type: 'text', name: 'title', label: 'Title', required: true },
    { id: 'fld_doc_slug', type: 'identifier', name: 'slug', label: 'Slug', required: true },
  ],
}

export const home: ContentType = {
  id: 'typ_home',
  name: 'home',
  label: 'Homepage',
  structure: 'singleton',
  fields: [
    { id: 'fld_headline', type: 'text', name: 'headline', label: 'Headline', required: true },
    { id: 'fld_intro', type: 'textarea', name: 'intro', label: 'Intro', defaultValue: 'Welcome' },
  ],
}

export const types = new Map([blog, docs, home].map((type) => [type.name, type]))

// A migrated database with a signed-in user, returning the user's ID and session cookie
export async function setUp() {
  await resetDb()
  await migrate(db, await loadMigrations(migrationsDir))

  const id = uuidv7()
  await db.insertInto('users').values({ id, name: 'Ada', email: 'ada@example.com', password_hash: 'unused' }).execute()
  await db
    .insertInto('sessions')
    .values({
      id: uuidv7(),
      user_id: id,
      token_hash: hashToken('test-token'),
      expires_at: new Date(Date.now() + 60_000),
    })
    .execute()

  return { userId: id, cookie: 'iight_session=test-token' }
}
