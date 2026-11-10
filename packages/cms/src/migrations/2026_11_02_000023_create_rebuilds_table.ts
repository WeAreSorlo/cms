import { Kysely } from 'kysely'

// What's due a rebuild and since how many changes, such as entry_relations once a content migration has changed
// entries' values, until a rebuild finishes, so one a restart cuts short is finished at the next start or run. A
// rebuild that began before the last of those changes leaves it due.
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('rebuilds')
    .addColumn('name', 'text', (col) => col.primaryKey())
    .addColumn('due', 'integer', (col) => col.notNull())
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('rebuilds').execute()
}
