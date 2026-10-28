import { Kysely, sql } from 'kysely'

// A row for each schema a form has had, written whenever its fields change, so each submission can be shown with the
// fields it was checked against
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('form_versions')
    .addColumn('form_id', 'uuid', (col) => col.notNull().references('forms.id').onDelete('cascade'))
    .addColumn('number', 'integer', (col) => col.notNull())
    .addColumn('fields', 'jsonb', (col) => col.notNull())
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('form_versions_pkey', ['form_id', 'number'])
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('form_versions').execute()
}
