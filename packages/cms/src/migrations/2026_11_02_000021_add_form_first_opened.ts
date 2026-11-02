import { Kysely, sql } from 'kysely'

// When each form was first opened, since a page may show a form that has been open, so MCP, which saves at once,
// changes only forms that have never been (PLAN.md section 21). Every form so far counts as opened.
export async function up(db: Kysely<any>) {
  await db.schema.alterTable('forms').addColumn('first_opened_at', 'timestamptz').execute()
  await db
    .updateTable('forms')
    .set({ first_opened_at: sql`created_at` })
    .execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('forms').dropColumn('first_opened_at').execute()
}
