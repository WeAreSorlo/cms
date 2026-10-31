import { Kysely, sql } from 'kysely'

// Names for versions, and when each last went live and who published it then (PLAN.md section 20)
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('entry_versions')
    .addColumn('name', 'text')
    .addColumn('published_at', 'timestamptz')
    .addColumn('published_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .execute()

  // Only the live copies record a publish, so each live version gets its live copy's
  await sql`
    update entry_versions set published_at = live.published_at, published_by = live.published_by
    from published_entries live
    where live.id = entry_versions.entry_id and live.version = entry_versions.number
  `.execute(db)
}

export async function down(db: Kysely<any>) {
  await db.schema
    .alterTable('entry_versions')
    .dropColumn('name')
    .dropColumn('published_at')
    .dropColumn('published_by')
    .execute()
}
