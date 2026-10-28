import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable('media')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    // The FlyDrive service that stores the file, named in iight.config.ts, and the file's key there
    .addColumn('disk', 'text', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('mime', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    // An image's size, and null for other files
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('alt', 'text')
    .addColumn('caption', 'text')
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

// The stored files stay on their disks
export async function down(db: Kysely<any>) {
  await db.schema.dropTable('media').execute()
}
