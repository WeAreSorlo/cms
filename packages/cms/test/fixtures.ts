import { uuidv7 } from '../src/db'
import { loadMigrations, migrate, migrationsDir } from '../src/migrator'
import { hashToken } from '../src/passwords'
import type { ContentType } from '../src/types'
import { db, resetDb } from './database'
import type { FieldSchema } from 'iight'

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
          {
            id: 'lay_gallery',
            name: 'gallery',
            fields: [{ id: 'fld_images', type: 'media', name: 'images', required: true, options: { minimum: 1 } }],
          },
        ],
      },
    },
    {
      id: 'fld_author',
      type: 'relationship',
      name: 'author',
      label: 'Author',
      options: { types: ['typ_authors'], maximum: 1 },
    },
    { id: 'fld_cover', type: 'media', name: 'cover', label: 'Cover', options: { types: ['image/*'], maximum: 1 } },
    { id: 'fld_related', type: 'relationship', name: 'related', options: { types: ['typ_blog'], maximum: 3 } },
    {
      id: 'fld_credits',
      type: 'repeater',
      name: 'credits',
      options: {
        fields: [
          {
            id: 'fld_person',
            type: 'relationship',
            name: 'person',
            required: true,
            options: { types: ['typ_authors'], maximum: 1 },
          },
          { id: 'fld_role', type: 'text', name: 'role' },
        ],
      },
    },
  ],
}

// Linked from blog posts
export const authors: ContentType = {
  id: 'typ_authors',
  name: 'authors',
  label: 'Authors',
  structure: 'collection',
  titleField: 'name',
  fields: [
    { id: 'fld_name', type: 'text', name: 'name', label: 'Name', required: true },
    { id: 'fld_avatar', type: 'media', name: 'avatar', options: { types: ['image/*'], maximum: 1 } },
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

export const types = new Map([blog, docs, home, authors].map((type) => [type.name, type]))

// A form's fields, with a list of choices, a group and a hidden value that post differently from a plain HTML form,
// and a repeater that needs JavaScript
export const contactFields: Array<FieldSchema> = [
  { id: 'fld_intro', type: 'content', name: 'intro', options: { content: 'We reply within a day.' } },
  { id: 'fld_name', type: 'text', name: 'name', label: 'Name', required: true },
  { id: 'fld_email', type: 'email', name: 'email', label: 'Email', required: true },
  {
    id: 'fld_topics',
    type: 'checkbox',
    name: 'topics',
    label: 'Topics',
    options: {
      choices: [
        { value: 'sales', label: 'Sales' },
        { value: 'support', label: 'Support' },
      ],
    },
  },
  { id: 'fld_size', type: 'number', name: 'size', label: 'Team size', options: { min: 1 } },
  { id: 'fld_subscribe', type: 'boolean', name: 'subscribe', label: 'Subscribe' },
  {
    id: 'fld_address',
    type: 'group',
    name: 'address',
    label: 'Address',
    options: { fields: [{ id: 'fld_town', type: 'text', name: 'town', label: 'Town', required: true }] },
  },
  { id: 'fld_source', type: 'hidden', name: 'source', options: { value: 'website' } },
  {
    id: 'fld_guests',
    type: 'repeater',
    name: 'guests',
    label: 'Guests',
    options: { fields: [{ id: 'fld_guest', type: 'text', name: 'guest' }] },
  },
]

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
