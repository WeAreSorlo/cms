import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('automations')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    // The names of the events that run it
    .addColumn('triggers', 'jsonb', (col) => col.notNull())
    // Core's conditional logic, checked against each event's data
    .addColumn('conditions', 'jsonb', (col) => col.notNull())
    // A flexible field's blocks, run in order, each with _layout naming its action type
    .addColumn('actions', 'jsonb', (col) => col.notNull())
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('updated_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('automations').execute()
}
