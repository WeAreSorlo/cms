import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('submissions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('form_id', 'uuid', (col) => col.notNull())
    // The version of the form's fields the values were checked against
    .addColumn('form_version', 'integer', (col) => col.notNull())
    .addColumn('values', 'jsonb', (col) => col.notNull())
    // Who sent it, as far as the request shows
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .addColumn('referer', 'text')
    // Filled in the honeypot field, so it's kept out of the inbox
    .addColumn('spam', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .addForeignKeyConstraint(
      'submissions_form_version_fkey',
      ['form_id', 'form_version'],
      'form_versions',
      ['form_id', 'number'],
      (cb) => cb.onDelete('cascade'),
    )
    .execute()

  // For a form's inbox, newest first
  await db.schema.createIndex('submissions_form_index').on('submissions').columns(['form_id', 'created_at']).execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('submissions').execute()
}
