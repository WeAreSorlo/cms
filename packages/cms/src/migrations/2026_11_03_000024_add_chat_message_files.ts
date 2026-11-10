import { Kysely, sql } from 'kysely'

// The media files the person attached to a message to the assistant, in the order they attached them, for the admin to
// show, since the message's content holds what the model was sent. Null on every other message.
// Not a foreign key, since a file deleted later stays in what the model was sent.
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('chat_messages')
    .addColumn('files', sql`uuid[]`)
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('chat_messages').dropColumn('files').execute()
}
