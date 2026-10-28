import { Kysely, sql } from 'kysely'

// Forms live in the database, since marketers make them in production (PLAN.md section 10)
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('forms')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    // What the SDK and generated types call the form. Embeds use the ID, so renaming one breaks no pasted forms.
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('label', 'text', (col) => col.notNull())
    // The current version's fields and number, which form_versions keeps with every version before it
    .addColumn('fields', 'jsonb', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('forms').execute()
}
