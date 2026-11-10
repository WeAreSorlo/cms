import { Kysely, sql } from 'kysely'

// When a person last took each entry off the live site, by unpublishing or archiving it or a page above it, which only
// a person's publish clears. A token with Publish changes never publishes an entry while it's set,
// whatever its versions say, since the version cap and deleting versions can lose the ones that went live. It's in no
// reply. Entries that were live and aren't now are marked, since only people could take entries down before.
export async function up(db: Kysely<any>) {
  await db.schema.alterTable('entries').addColumn('taken_down_at', 'timestamptz').execute()
  await sql`
    update entries set taken_down_at = now()
    where not exists (select 1 from published_entries live where live.id = entries.id)
      and exists (select 1 from entry_versions version where version.entry_id = entries.id and version.published_at is not null)
  `.execute(db)
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('entries').dropColumn('taken_down_at').execute()
}
