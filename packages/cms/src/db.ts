import { Generated, Kysely, PostgresDialect } from 'kysely'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'

export interface Database {
  users: {
    id: string
    email: string
    name: string
    password_hash: string
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  sessions: {
    id: string
    user_id: string
    token_hash: string
    expires_at: Date
    created_at: Generated<Date>
  }
}

export function createDb(url: string) {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
}

// Every row's ID. A UUIDv7 (RFC 9562) starts with a millisecond timestamp, so IDs sort by creation time.
// Made here rather than by Postgres, which only has uuidv7() from version 18.
export function uuidv7() {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
