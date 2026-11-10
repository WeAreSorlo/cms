import { Kysely, sql } from 'kysely'

// Each person's chats with the admin's assistant, which go when the person does, and their messages, which are only
// ever added to
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('chats')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('title', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema.createIndex('chats_user_id_updated_at_index').on('chats').columns(['user_id', 'updated_at']).execute()

  await db.schema
    .createTable('chat_messages')
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('role', 'text', (col) => col.notNull())
    // json rather than jsonb, so the text is kept as written, keys in their order, since the model's provider needs
    // earlier messages sent back exactly as they were
    .addColumn('content', 'json', (col) => col.notNull())
    .addColumn('model', 'text')
    .addColumn('stop_reason', 'text')
    .addColumn('usage', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('chat_messages_pkey', ['chat_id', 'position'])
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('chat_messages').execute()
  await db.schema.dropTable('chats').execute()
}
