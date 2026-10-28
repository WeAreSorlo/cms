import { createDb } from '../src/db'
import { sql } from 'kysely'

// compose.yaml creates this database next to the playground's
export const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://iight:iight@localhost:5432/iight_test')

// Drop every table, so each test starts from an empty database
export async function resetDb() {
  await sql`drop schema public cascade`.execute(db)
  await sql`create schema public`.execute(db)
}
