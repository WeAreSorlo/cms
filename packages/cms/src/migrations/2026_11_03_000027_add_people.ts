import { Kysely, sql } from 'kysely'

// Managing people (PLAN.md section 5): when each person last used the admin, who invited and who removed them, the
// invites waiting to be accepted, and each person's reset link. Removing someone keeps their row, so everything that
// points at them keeps their name.
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('users')
    .addColumn('last_active_at', 'timestamptz')
    .addColumn('invited_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('removed_at', 'timestamptz')
    .addColumn('removed_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .execute()

  // One for each address, whose link a new invite replaces
  await db.schema
    .createTable('invites')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('invited_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // One for each person, whose link a new one replaces
  await db.schema
    .createTable('password_resets')
    .addColumn('user_id', 'uuid', (col) => col.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

// Removed people keep the blank passwords their removal gave them, so they still can't sign in
export async function down(db: Kysely<any>) {
  await db.schema.dropTable('password_resets').execute()
  await db.schema.dropTable('invites').execute()
  await db.schema
    .alterTable('users')
    .dropColumn('last_active_at')
    .dropColumn('invited_by')
    .dropColumn('removed_at')
    .dropColumn('removed_by')
    .execute()
}
