import { Kysely } from 'kysely'

// Whether applying a proposal also published it, as Apply and publish does in the admin's assistant (PLAN.md section 21)
export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable('proposals')
    .addColumn('published', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('proposals').dropColumn('published').execute()
}
