import { Kysely } from 'kysely'

// Who made each reset link for a colleague, null for one sent by email, so removing someone deletes the links they made
// (PLAN.md section 22). Links made before this have no maker, as an emailed one has none.
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('password_resets')
    .addColumn('made_by', 'uuid', (col) => col.references('users.id').onDelete('cascade'))
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('password_resets').dropColumn('made_by').execute()
}
