import { Kysely, sql } from 'kysely'

// Who made each key and when it was last used, for the admin's API keys page
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('api_keys')
    // Null for keys from sorlo make:api-key
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('last_used_at', 'timestamptz')
    .execute()

  // Every key could pull types and skip the forms rate limit, which now take the types and submit scopes
  await sql`update api_keys set scopes = scopes || '{types,submit}'`.execute(db)
}

export async function down(db: Kysely<any>) {
  await sql`update api_keys set scopes = array_remove(array_remove(scopes, 'types'), 'submit')`.execute(db)
  await db.schema.alterTable('api_keys').dropColumn('created_by').dropColumn('last_used_at').execute()
}
