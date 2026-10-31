import { Kysely, sql } from 'kysely'

// The parent each version was saved under, so a page's moves show in its history (PLAN.md section 20). It's no foreign
// key, so a version keeps the ID of a parent deleted since.
export async function up(db: Kysely<any>) {
  await db.schema.alterTable('entry_versions').addColumn('parent_id', 'uuid').execute()

  // Nothing recorded parents before, so each version takes the parent its entry has now, as the user chose
  await sql`
    update entry_versions set parent_id = entries.parent_id
    from entries
    where entries.id = entry_versions.entry_id and entries.parent_id is not null
  `.execute(db)
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('entry_versions').dropColumn('parent_id').execute()
}
