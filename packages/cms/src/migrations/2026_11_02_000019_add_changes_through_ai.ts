import { Kysely, sql } from 'kysely'

// Changes through AI: the assistant's proposals, which a person applies or skips, the chat or MCP
// token behind each version, the Save drafts permission on tokens, and forms that take no submissions until opened
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('proposals')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    // The tool call that made it, which the chat shows it under
    .addColumn('tool_use_id', 'text', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull())
    // The entry or form it changes, or the id a new one is made with
    .addColumn('target_id', 'uuid', (col) => col.notNull())
    .addColumn('is_new', 'boolean', (col) => col.notNull())
    .addColumn('type', 'text')
    .addColumn('before', 'jsonb')
    .addColumn('after', 'jsonb', (col) => col.notNull())
    .addColumn('migration', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('version', 'integer')
    .addColumn('decided_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('decided_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema.createIndex('proposals_chat_id_index').on('proposals').column('chat_id').execute()

  // No foreign keys, as parent_id has none, so a version keeps its link once the chat is deleted or the token revoked
  await db.schema.alterTable('entry_versions').addColumn('chat_id', 'uuid').addColumn('token_id', 'uuid').execute()
  await sql`create index entry_versions_chat_id_index on entry_versions (chat_id) where chat_id is not null`.execute(db)

  // Existing tokens only read. Revoking keeps a token's row, so the versions saved through it keep its name.
  await db.schema
    .alterTable('personal_tokens')
    .addColumn('scopes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'`))
    .addColumn('revoked_at', 'timestamptz')
    .execute()

  // Every existing form keeps taking submissions
  await db.schema
    .alterTable('forms')
    .addColumn('open', 'boolean', (col) => col.notNull().defaultTo(true))
    .execute()
}

export async function down(db: Kysely<any>) {
  // Without open, every form takes submissions, so a closed form would start taking them
  const closed = await db.selectFrom('forms').select('name').where('open', '=', false).execute()
  if (closed.length) {
    throw new Error(
      `Can't roll back while forms are closed, since every form would take submissions: ${closed
        .map((form) => form.name)
        .join(', ')}. Open or delete them first.`,
    )
  }
  await db.schema.alterTable('forms').dropColumn('open').execute()
  // Revoked tokens were only kept for the versions, which lose their links below
  await db.deleteFrom('personal_tokens').where('revoked_at', 'is not', null).execute()
  await db.schema.alterTable('personal_tokens').dropColumn('scopes').dropColumn('revoked_at').execute()
  await db.schema.alterTable('entry_versions').dropColumn('chat_id').dropColumn('token_id').execute()
  await db.schema.dropTable('proposals').execute()
}
