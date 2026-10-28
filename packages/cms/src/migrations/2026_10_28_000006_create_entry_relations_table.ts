import { Kysely } from 'kysely'

// What each entry's relationship and media fields link to, rebuilt on every save, since JSON can't hold foreign keys
// (PLAN.md section 5). A target is an entry or a media file, and their UUIDv7s never clash.
export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('entry_relations')
    .addColumn('entry_id', 'uuid', (col) => col.notNull().references('entries.id').onDelete('cascade'))
    // The linking field's stable id, which survives renames and moves
    .addColumn('field_id', 'text', (col) => col.notNull())
    .addColumn('target_id', 'uuid', (col) => col.notNull())
    .addPrimaryKeyConstraint('entry_relations_pkey', ['entry_id', 'field_id', 'target_id'])
    .execute()

  // For "used by", and for refusing to delete what's still linked
  await db.schema.createIndex('entry_relations_target_index').on('entry_relations').column('target_id').execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable('entry_relations').execute()
}
