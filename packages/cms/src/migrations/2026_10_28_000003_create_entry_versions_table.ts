import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('entry_versions')
    .addColumn('entry_id', 'uuid', (col) => col.notNull().references('entries.id').onDelete('cascade'))
    .addColumn('number', 'integer', (col) => col.notNull())
    .addColumn('values', 'jsonb', (col) => col.notNull())
    .addColumn('migration', 'text')
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('entry_versions_pkey', ['entry_id', 'number'])
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('entry_versions').execute()
}
