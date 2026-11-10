import { Kysely, sql } from 'kysely'

// Proposals of content types, which the assistant makes in development: target_id holds a type's
// typ_ id, which isn't a uuid, and wrote the content migration Apply wrote for one. before and after become json, which
// keeps their keys in order, so Apply writes a type's file with its fields' keys as they were rather than as jsonb
// sorts them, and a small change makes a small diff.
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('proposals')
    .alterColumn('target_id', (col) => col.setDataType('text'))
    .alterColumn('before', (col) => col.setDataType('json'))
    .alterColumn('after', (col) => col.setDataType('json'))
    .execute()
  await db.schema.alterTable('proposals').addColumn('wrote', 'jsonb').execute()
}

export async function down(db: Kysely<any>) {
  // A content type's id can't be a uuid, so its proposals have nowhere to go
  const types = await db.selectFrom('proposals').select('id').where('kind', '=', 'type').execute()
  if (types.length) {
    throw new Error(
      `Can't roll back while proposals of content types exist, since their ids aren't uuids: ${types.length} of them. ` +
        "Delete them first, with the chats they're in.",
    )
  }
  await db.schema.alterTable('proposals').dropColumn('wrote').execute()
  await sql`
    alter table proposals
      alter column target_id type uuid using target_id::uuid,
      alter column before type jsonb using before::jsonb,
      alter column after type jsonb using after::jsonb
  `.execute(db)
}
