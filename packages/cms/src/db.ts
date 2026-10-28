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
  entries: {
    id: string
    type: string
    values: Record<string, any>
    parent_id: string | null
    position: number | null
    slug: string | null
    uri: string | null
    // The last content migration the values have been through (PLAN.md section 6)
    migration: string | null
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
    archived_at: Date | null
  }
  entry_versions: {
    entry_id: string
    number: number
    values: Record<string, any>
    migration: string | null
    created_by: string | null
    created_at: Generated<Date>
  }
  // What each entry's relationship and media fields link to, rebuilt on every save
  entry_relations: {
    entry_id: string
    field_id: string
    target_id: string
  }
  api_keys: {
    id: string
    name: string
    token_hash: string
    created_at: Generated<Date>
  }
  media: {
    id: string
    // The FlyDrive service that stores the file, and the file's key there
    disk: string
    path: string
    name: string
    mime: string
    size: number
    width: number | null
    height: number | null
    alt: string | null
    caption: string | null
    created_by: string | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  // Both kinds of migration that have run, made by migrator.ts
  migrations: {
    id: Generated<number>
    name: string
    batch: number
    migrated_at: Generated<Date>
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

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
