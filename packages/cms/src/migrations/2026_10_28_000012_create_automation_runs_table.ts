import { Kysely, sql } from 'kysely'

// The delivery log: a row for each try of each action, and the queue of tries still to come
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('automation_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('automation_id', 'uuid', (col) => col.notNull().references('automations.id').onDelete('cascade'))
    .addColumn('event_id', 'uuid', (col) => col.notNull().references('events.id').onDelete('cascade'))
    // The action's place in the automation's actions, from 0
    .addColumn('action', 'integer', (col) => col.notNull())
    // Which try this is, from 1
    .addColumn('attempt', 'integer', (col) => col.notNull())
    // pending until it's tried, then succeeded or failed
    .addColumn('status', 'text', (col) => col.notNull())
    // When it's due
    .addColumn('run_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // What came back, such as a webhook's reply, and why it failed
    .addColumn('response', 'text')
    .addColumn('error', 'text')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // For the worker, which takes the pending runs that are due
  await db.schema
    .createIndex('automation_runs_pending_index')
    .on('automation_runs')
    .column('run_at')
    .where(sql.ref('status'), '=', 'pending')
    .execute()
  // For an automation's runs page, newest first
  await db.schema
    .createIndex('automation_runs_automation_index')
    .on('automation_runs')
    .columns(['automation_id', 'id'])
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('automation_runs').execute()
}
