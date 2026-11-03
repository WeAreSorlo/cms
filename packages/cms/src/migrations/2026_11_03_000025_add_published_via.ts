import { Kysely } from 'kysely'

// How each version was last published, as chat_id and token_id say how it was saved: the assistant's chat whose Apply
// and publish made it live, or the MCP token with Publish changes (PLAN.md section 21). No foreign keys, as those two
// have none. Nothing is backfilled, so earlier publishes read as a person's in the editor.
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('entry_versions')
    .addColumn('published_chat_id', 'uuid')
    .addColumn('published_token_id', 'uuid')
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema
    .alterTable('entry_versions')
    .dropColumn('published_chat_id')
    .dropColumn('published_token_id')
    .execute()
}
