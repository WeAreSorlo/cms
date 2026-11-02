import { Kysely, sql } from 'kysely'

// Each person's tokens for MCP clients, which go when the person does (PLAN.md section 21)
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('personal_tokens')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('personal_tokens').execute()
}
