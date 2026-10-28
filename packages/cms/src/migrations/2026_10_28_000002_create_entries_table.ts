import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('entries')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('values', 'jsonb', (col) => col.notNull())
    // Only archived entries are deleted, and an archived entry's descendants are archived with it
    .addColumn('parent_id', 'uuid', (col) => col.references('entries.id').onDelete('cascade'))
    .addColumn('position', 'integer')
    .addColumn('slug', 'text')
    .addColumn('uri', 'text')
    .addColumn('migration', 'text')
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .execute()

  // Slugs are unique among siblings, archived ones included, and top-level entries share a null parent.
  // Localisation will add locale to this index (PLAN.md section 15).
  await db.schema
    .createIndex('entries_slug_unique')
    .on('entries')
    .columns(['type', 'parent_id', 'slug'])
    .unique()
    .nullsNotDistinct()
    .where('slug', 'is not', null)
    .execute()

  await db.schema.createIndex('entries_uri_index').on('entries').columns(['type', 'uri']).execute()
  await db.schema.createIndex('entries_parent_index').on('entries').columns(['type', 'parent_id', 'position']).execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('entries').execute()
}
