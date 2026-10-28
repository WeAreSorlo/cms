import { Kysely, sql } from 'kysely'

// The outbox: each change writes its event in its own transaction, and the worker hands it on to the automations it
// triggers (PLAN.md section 11)
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    // Such as entry.created or submission.created
    .addColumn('name', 'text', (col) => col.notNull())
    // The record the event is about, such as { entry }, as it was when the change was made
    .addColumn('data', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // When the worker queued its automations' runs
    .addColumn('dispatched_at', 'timestamptz')
    .execute()

  // For the worker, which looks for the events it hasn't dispatched yet
  await db.schema
    .createIndex('events_undispatched_index')
    .on('events')
    .column('id')
    .where(sql.ref('dispatched_at'), 'is', null)
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('events').execute()
}
