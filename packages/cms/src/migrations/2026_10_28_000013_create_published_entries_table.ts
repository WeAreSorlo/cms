import { Kysely, sql } from 'kysely'

// Each published entry's live copy, which the delivery API serves while the entry's draft changes (PLAN.md section 17)
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('published_entries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().references('entries.id').onDelete('cascade'))
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('values', 'jsonb', (col) => col.notNull())
    // A live page's parent is live too
    .addColumn('parent_id', 'uuid', (col) => col.references('published_entries.id').onDelete('cascade'))
    .addColumn('position', 'integer')
    .addColumn('slug', 'text')
    .addColumn('uri', 'text')
    .addColumn('migration', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    // The number of the draft version it was copied from
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('published_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('published_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .execute()

  // A draft can take a slug that a live entry keeps until it's published again, so live slugs are unique on their own
  await db.schema
    .createIndex('published_entries_slug_unique')
    .on('published_entries')
    .columns(['type', 'parent_id', 'slug'])
    .unique()
    .nullsNotDistinct()
    .where('slug', 'is not', null)
    .execute()

  await db.schema.createIndex('published_entries_uri_index').on('published_entries').columns(['type', 'uri']).execute()
  await db.schema
    .createIndex('published_entries_parent_index')
    .on('published_entries')
    .columns(['type', 'parent_id', 'position'])
    .execute()

  // Such as preview, which lets a key read drafts
  await db.schema
    .alterTable('api_keys')
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .execute()

  // The delivery API served every saved entry that isn't archived, so each stays live as it stands, published by
  // whoever saved its newest version, when they saved it
  await sql`
    insert into published_entries
      (id, type, "values", parent_id, position, slug, uri, migration, created_at, updated_at, version, published_at, published_by)
    select entries.id, entries.type, entries."values", entries.parent_id, entries.position, entries.slug, entries.uri,
      entries.migration, entries.created_at, entries.updated_at, newest.number, newest.created_at, newest.created_by
    from entries
    join lateral (
      select number, created_at, created_by from entry_versions where entry_id = entries.id order by number desc limit 1
    ) newest on true
    where entries.archived_at is null
  `.execute(db)
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('api_keys').dropColumn('scopes').execute()
  await db.schema.dropTable('published_entries').execute()
}
