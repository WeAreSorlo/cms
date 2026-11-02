import type { EventName } from './schemas'
import type { ConditionGroup, FieldSchema } from 'iight'
import { ColumnType, Generated, Kysely, PostgresDialect } from 'kysely'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'

// A jsonb list, written as JSON text, since pg would send an array as a Postgres array
type JsonList<T> = ColumnType<Array<T>, string, string>

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
    // The parent it was saved under. It's no foreign key, so it keeps the ID of a parent deleted since.
    parent_id: string | null
    migration: string | null
    // What people call it, such as Before the rebrand. Named versions are never deleted to keep within the cap.
    name: string | null
    created_by: string | null
    created_at: Generated<Date>
    // The last time it went live, and who published it then
    published_at: Date | null
    published_by: string | null
    // The assistant's chat or the MCP token it was saved through, kept after the chat is deleted (PLAN.md section 21)
    chat_id: string | null
    token_id: string | null
  }
  // Each published entry's live copy, which the delivery API serves (PLAN.md section 17)
  published_entries: {
    id: string
    type: string
    values: Record<string, any>
    parent_id: string | null
    position: number | null
    slug: string | null
    uri: string | null
    migration: string | null
    created_at: Date
    updated_at: Date
    // The number of the draft version it was copied from
    version: number
    published_at: Generated<Date>
    published_by: string | null
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
    // What the key can do besides reading live content: preview reads drafts, types pulls types, and submit skips the
    // forms rate limit
    scopes: Generated<Array<string>>
    // Null for keys from iight make:api-key
    created_by: string | null
    // Written at most once a minute
    last_used_at: Date | null
    created_at: Generated<Date>
  }
  // Each person's tokens for MCP clients, which act as the person (PLAN.md section 21)
  personal_tokens: {
    id: string
    user_id: string
    name: string
    token_hash: string
    // What the token can do besides reading: drafts saves drafts
    scopes: Generated<Array<string>>
    // Written at most once a minute
    last_used_at: Date | null
    created_at: Generated<Date>
    // Revoking keeps the row, so versions saved through the token keep its name
    revoked_at: Date | null
  }
  // Each person's chats with the admin's assistant (PLAN.md section 21)
  chats: {
    id: string
    user_id: string
    // From the first message until the person renames it
    title: string | null
    created_at: Generated<Date>
    // When the last message was sent, which orders the person's chats
    updated_at: Generated<Date>
  }
  // A chat's messages in order, as its model saw them: each of the person's messages, the page it was sent from, then
  // each round of the reply with its tool results. Rows are only ever added.
  chat_messages: {
    chat_id: string
    position: number
    role: 'user' | 'assistant' | 'system'
    // The content blocks exactly as they were sent, or as the provider returned them
    content: JsonList<Record<string, any>>
    // For replies: the model that wrote it, why it stopped (end, tools, length, refused or stopped) and the tokens it
    // took, as the provider counts them
    model: string | null
    stop_reason: string | null
    usage: Record<string, any> | null
    created_at: Generated<Date>
  }
  // The changes the assistant proposes, a row for each entry or form, which the person applies or skips
  proposals: {
    id: string
    chat_id: string
    // The tool call that made it, which the chat shows it under
    tool_use_id: string
    kind: 'entry' | 'form' | 'media'
    // The entry, form or file it changes, or the id a new one is made with
    target_id: string
    is_new: boolean
    // An entry's content type
    type: string | null
    // For an entry, { values, parentId }: a new one's, or only the top-level fields a change sets and a page's parent
    // when it moves, with before holding what they were when it was proposed. For a form, its label, name and fields.
    before: Record<string, any> | null
    after: Record<string, any>
    // The last content migration when it was proposed, which values it fits
    migration: string | null
    status: Generated<'pending' | 'applied' | 'skipped' | 'stale'>
    // The version Apply saved, and whether Apply also published it, opened its form, or changed its file on the site
    version: number | null
    published: Generated<boolean>
    decided_by: string | null
    decided_at: Date | null
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
  // Forms, made in the admin, with their current fields and version number
  forms: {
    id: string
    name: string
    label: string
    fields: JsonList<FieldSchema>
    version: number
    // Whether it takes submissions. Forms made through AI start closed, until a person opens them.
    open: Generated<boolean>
    // When it was first opened, or null for a form that has never taken submissions, which only those MCP changes
    first_opened_at: Date | null
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  form_versions: {
    form_id: string
    number: number
    fields: JsonList<FieldSchema>
    created_by: string | null
    created_at: Generated<Date>
  }
  submissions: {
    id: string
    form_id: string
    form_version: number
    values: Record<string, any>
    ip: string | null
    user_agent: string | null
    referer: string | null
    spam: Generated<boolean>
    created_at: Generated<Date>
    archived_at: Date | null
  }
  // The outbox of changes, which the worker hands on to automations (PLAN.md section 11)
  events: {
    id: string
    name: EventName
    data: Record<string, any>
    created_at: Generated<Date>
    dispatched_at: Date | null
  }
  automations: {
    id: string
    name: string
    triggers: JsonList<EventName>
    // Core's conditional logic, as groups of rules
    conditions: JsonList<ConditionGroup>
    // A flexible field's blocks, each with _layout naming its action type
    actions: JsonList<Record<string, any>>
    created_by: string | null
    updated_by: string | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  // A row for each try of an action, pending until the worker tries it
  automation_runs: {
    id: string
    automation_id: string
    event_id: string
    action: number
    attempt: number
    status: 'pending' | 'succeeded' | 'failed'
    run_at: Generated<Date>
    response: string | null
    error: string | null
    finished_at: Date | null
    created_at: Generated<Date>
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
