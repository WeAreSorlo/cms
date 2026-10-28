import { Database, isUuid } from './db'
import type { ContentType } from './types'
import { HTTPException } from 'hono/http-exception'
import { ComparisonOperator, ExpressionBuilder, Kysely, SelectQueryBuilder, Selectable, SqlBool, sql } from 'kysely'

// Filtering and sorting entries and media, with legacy's query model. Fields are read with Postgres's jsonb operators,
// so another database needs its own version of this module (PLAN.md section 5).

export type EntryRow = Selectable<Database['entries']>
export type MediaRow = Selectable<Database['media']>

// An entry as the delivery API returns it
export const toEntry = (row: EntryRow) => ({
  id: row.id,
  type: row.type,
  slug: row.slug,
  uri: row.uri,
  parentId: row.parent_id,
  position: row.position,
  values: row.values,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

type Kind = 'uuid' | 'text' | 'integer' | 'timestamp'

// What filters and sorts can name: properties, with their columns and the values they hold, and for entries, the
// type's top-level fields
interface Subject {
  properties: Record<string, [column: string, kind: Kind]>
  type?: ContentType
}

const entrySubject = (type: ContentType): Subject => ({
  type,
  properties: {
    id: ['id', 'uuid'],
    slug: ['slug', 'text'],
    uri: ['uri', 'text'],
    parentId: ['parent_id', 'uuid'],
    position: ['position', 'integer'],
    createdAt: ['created_at', 'timestamp'],
    updatedAt: ['updated_at', 'timestamp'],
  },
})

const mediaSubject: Subject = {
  properties: {
    id: ['id', 'uuid'],
    name: ['name', 'text'],
    mime: ['mime', 'text'],
    size: ['size', 'integer'],
    width: ['width', 'integer'],
    height: ['height', 'integer'],
    alt: ['alt', 'text'],
    caption: ['caption', 'text'],
    createdAt: ['created_at', 'timestamp'],
    updatedAt: ['updated_at', 'timestamp'],
  },
}

const operators = [
  ...['=', '!=', '>', '>=', '<', '<=', 'like', 'not like'],
  ...['in', 'not in', 'between', 'not between', 'exists', 'not exists'],
]

interface Condition {
  field: string
  op: string
  value?: any
}

export interface Query {
  // Groups joined by OR, each a list of conditions that must all match
  where: Array<Array<Condition>>
  order: Record<string, 'asc' | 'desc'>
  page: number
  perPage: number
}

const badRequest = (message: string) => new HTTPException(400, { message })

// Field names cross a trust boundary, so each must be a property or one of the type's top-level fields
// shortcut: no paths into groups, e.g. values.address.town, add them when a site needs them
function target({ properties, type }: Subject, field: unknown) {
  if (typeof field === 'string' && Object.hasOwn(properties, field)) {
    const [column, kind] = properties[field]
    return { column, kind }
  }

  const name = typeof field === 'string' && field.startsWith('values.') ? field.slice('values.'.length) : undefined
  if (name && type?.fields.some((schema) => schema.name === name)) return { name }

  const names = Object.keys(properties).join(', ')
  throw badRequest(
    type
      ? `Unknown field ${JSON.stringify(field)}. Use values.<name> for one of ${type.name}'s fields, or one of ${names}.`
      : `Unknown field ${JSON.stringify(field)}. Use one of ${names}.`,
  )
}

// Whether a value suits a property, or any JSON value for a field
function suits(kind: Kind | undefined, value: unknown) {
  if (kind === 'uuid') return isUuid(value)
  if (kind === 'text') return typeof value === 'string'
  if (kind === 'integer') return Number.isInteger(value)
  if (kind === 'timestamp') return typeof value === 'string' && !isNaN(Date.parse(value))
  return value !== undefined
}

function checkCondition(subject: Subject, condition: any) {
  const { field, op, value } = condition ?? {}
  const { kind } = target(subject, field)
  if (!operators.includes(op))
    throw badRequest(`Unknown operator ${JSON.stringify(op)}. Use one of ${operators.join(', ')}.`)
  if (op.endsWith('exists')) return

  const list = op === 'in' || op === 'not in'
  const range = op === 'between' || op === 'not between'
  const like = op === 'like' || op === 'not like'
  if (list && !(Array.isArray(value) && value.length > 0)) throw badRequest(`${field} ${op} needs a list of values.`)
  if (range && !(Array.isArray(value) && value.length === 2))
    throw badRequest(`${field} ${op} needs a list of two values.`)
  if (like && (kind ?? 'text') !== 'text') throw badRequest(`${field} can't use ${op}.`)
  if (like && typeof value !== 'string') throw badRequest(`${field} ${op} needs text.`)
  if (!(list || range ? value : [value]).every((item: unknown) => suits(kind, item))) {
    throw badRequest(`${field} ${op} needs ${kind ? `a ${kind}` : 'a JSON value'}.`)
  }
}

// Read where, order, page and perPage from a query string, checking every field
function parse(subject: Subject, params: Record<string, string>): Query {
  const json = (name: string, example: string) => {
    const invalid = badRequest(`${name} must be JSON, such as ${example}.`)
    if (params[name] === undefined) return undefined
    try {
      return JSON.parse(params[name])
    } catch {
      throw invalid
    }
  }

  const whereExample = subject.type
    ? '[[{"field":"values.title","op":"=","value":"Hello"}]]'
    : '[[{"field":"name","op":"like","value":"logo"}]]'
  const where = json('where', whereExample) ?? []
  if (!Array.isArray(where) || !where.every((group) => Array.isArray(group) && group.length > 0)) {
    throw badRequest(`where must be a list of condition groups, such as ${whereExample}.`)
  }
  for (const condition of where.flat()) checkCondition(subject, condition)

  const order = json('order', '{"createdAt":"desc"}') ?? {}
  if (typeof order !== 'object' || order === null || Array.isArray(order)) {
    throw badRequest('order must map fields to directions, such as {"createdAt":"desc"}.')
  }
  for (const [field, direction] of Object.entries(order)) {
    target(subject, field)
    if (direction !== 'asc' && direction !== 'desc') throw badRequest(`Sort ${field} asc or desc.`)
  }

  const page = Number(params.page ?? 1)
  if (!Number.isInteger(page) || page < 1) throw badRequest('page must be a whole number from 1.')
  const perPage = Number(params.perPage ?? 15)
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw badRequest('perPage must be a whole number from 1 to 100.')
  }

  return { where, order, page, perPage }
}

// A query for a type's entries, checking every field against the type
export const parseQuery = (type: ContentType, params: Record<string, string>) => parse(entrySubject(type), params)

export const parseMediaQuery = (params: Record<string, string>) => parse(mediaSubject, params)

// What a filter or sort reads: a column, or a field's jsonb value
function read(subject: Subject, field: string) {
  const found = target(subject, field)
  return 'name' in found ? sql`${sql.ref('values')} -> ${found.name}` : sql.ref(found.column)
}

function conditionSql(eb: ExpressionBuilder<any, any>, subject: Subject, { field, op, value }: Condition) {
  const found = target(subject, field)
  const lhs = read(subject, field)

  // Fields compare as jsonb, so numbers, text and booleans each compare as themselves
  const operand = (item: any) =>
    'name' in found ? sql`${JSON.stringify(item)}::jsonb` : found.kind === 'timestamp' ? new Date(item) : item

  switch (op) {
    case 'like':
    case 'not like': {
      // Case-insensitive, as legacy's MySQL was, matching anywhere in the text
      const text = 'name' in found ? sql`${sql.ref('values')} ->> ${found.name}` : lhs
      const pattern = `%${String(value).replace(/[\\%_]/g, '\\$&')}%`
      return eb(text, op === 'like' ? 'ilike' : 'not ilike', pattern)
    }
    case 'in':
    case 'not in':
      return eb(lhs, op, value.map(operand))
    case 'between':
      return eb.between(lhs, operand(value[0]), operand(value[1]))
    case 'not between':
      return eb.not(eb.between(lhs, operand(value[0]), operand(value[1])))
    case 'exists':
    case 'not exists': {
      // Empty as core's isEmptyValue sees it: missing, null, empty text or an empty list
      const empty =
        'name' in found ? sql<SqlBool>`coalesce(${lhs}, 'null') in ('null', '""', '[]')` : sql<SqlBool>`${lhs} is null`
      return op === 'exists' ? eb.not(empty) : empty
    }
    default:
      return eb(lhs, op as ComparisonOperator, operand(value))
  }
}

// Whether an entry has been saved, which every save records with a version. Opening a singleton creates its entry
// without one, and until it's saved its required fields can be empty, so the delivery API serves saved entries only.
export const isSaved = (eb: ExpressionBuilder<Database, 'entries'>) =>
  eb.exists(eb.selectFrom('entry_versions').select('entry_id').whereRef('entry_versions.entry_id', '=', 'entries.id'))

// One page of the rows a select finds, filtered and sorted by the query
async function paginate<Row>(from: SelectQueryBuilder<any, any, {}>, subject: Subject, query: Query) {
  const filtered = from.$if(query.where.length > 0, (qb) =>
    qb.where((eb) => eb.or(query.where.map((group) => eb.and(group.map((item) => conditionSql(eb, subject, item)))))),
  )

  const { total } = await filtered.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow()

  let rows = filtered.selectAll()
  for (const [field, direction] of Object.entries(query.order)) rows = rows.orderBy(read(subject, field), direction)
  const { page, perPage } = query
  const data = await rows
    .orderBy('id')
    .limit(perPage)
    .offset((page - 1) * perPage)
    .execute()

  return {
    data: data as Array<Row>,
    pagination: { page, perPage, total: Number(total), lastPage: Math.max(1, Math.ceil(Number(total) / perPage)) },
  }
}

// One page of a type's live or archived entries
export const listEntries = (
  db: Kysely<Database>,
  type: ContentType,
  query: Query,
  { archived = false, saved = false } = {},
) =>
  paginate<EntryRow>(
    db
      .selectFrom('entries')
      .where('type', '=', type.name)
      .where('archived_at', archived ? 'is not' : 'is', null)
      .$if(saved, (qb) => qb.where(isSaved)),
    entrySubject(type),
    query,
  )

export const listMedia = (db: Kysely<Database>, query: Query) =>
  paginate<MediaRow>(db.selectFrom('media'), mediaSubject, query)
