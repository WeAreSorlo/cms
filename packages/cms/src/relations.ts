import type { FieldLinks, LinkedRecords, Plugin } from '.'
import { inputs, pickValues, validationError } from './core'
import { Database, isUuid } from './db'
import { allows, form, holdsOne, idsOf, isLink, media, relationship, shared, someField } from './fields'
import { toMedia } from './media'
import { Delivered, deliveredEntries, toEntry } from './query'
import type { ContentType } from './types'
import { lexical } from '@sorlo/field-lexical/plugin'
import { markdown } from '@sorlo/field-markdown/validation'
import type { FieldSchema, Input, InputPickFields, InputPickValue, InputSchema } from '@sorlo/forms'
import { HTTPException } from 'hono/http-exception'
import { Kysely, SqlBool, sql } from 'kysely'

// The fields the CMS includes as plugins, from packages of their own, which a site lists in its plugins only for their
// settings, such as lexical({ entryLinks })
export const builtInPlugins: Array<Plugin> = [lexical()]

// A plugin's fields as the server has them, with a component that renders nothing
export const serverFields = (plugin: Plugin) =>
  Object.fromEntries(
    Object.entries(plugin.fields ?? {}).map(([type, field]) => [type, { ...field, default: () => null }]),
  )

// Core's inputs, the CMS's own and the fields it includes, such as Markdown and rich text, which the server never
// renders. The admin adds their pickers and editors. Types have no Shared group fields once they load, so only their
// files' checks meet one.
export const cmsInputs: Record<string, Input & FieldLinks> = {
  ...inputs,
  markdown: { ...markdown, default: () => null },
  ...Object.assign({}, ...builtInPlugins.map(serverFields)),
  relationship: { ...relationship, default: () => null },
  media: { ...media, default: () => null },
  form: { ...form, default: () => null },
  shared: { ...shared, default: () => null },
}

// The names of the content types a relationship field takes, which is all of them when it lists none
export function allowedTypes(types: Map<string, ContentType>, schema: InputSchema) {
  const ids: Array<string> = schema.options?.types ?? []
  return [...types.values()].filter((type) => !ids.length || ids.includes(type.id)).map((type) => type.name)
}

// Whether with() can name a field: a relationship or media field, or one whose input resolves the links in its value,
// such as rich text delivered as JSON
export const resolvesLinks = (field: FieldSchema) => isLink(field) || !!cmsInputs[field.type]?.resolve

// A type's top-level fields that with() can name, or that hold some
export const linkFields = (type: ContentType) => type.fields.filter((field) => someField([field], resolvesLinks))

// Inputs with each field that links within its value, such as rich text, calling found with what it links to as
// pickValues reaches it, before its own pickValue
const withOwnLinks = (
  all: Record<string, Input & FieldLinks>,
  found: (schema: InputSchema, links: { entries: Array<string>; media: Array<string> }) => void,
) =>
  Object.fromEntries(
    Object.entries(all).map(([type, input]) => [
      type,
      !input.links
        ? input
        : {
            ...input,
            pickValue: ((value, schema, pickFields) => {
              found(schema, input.links!(value, schema))
              return input.pickValue ? input.pickValue(value, schema, pickFields) : value
            }) as InputPickValue,
          },
    ]),
  )

const fitsMedia = (schema: InputSchema, mime: string) =>
  !schema.options?.types?.length || allows(schema.options.types, mime)

// cmsInputs, with the relationship and media fields' values picked by these, so pickValues visits every link in a set
// of values, inside groups, repeaters and flexible blocks too
const walking = (relationshipPick: InputPickValue, mediaPick = relationshipPick) => ({
  ...cmsInputs,
  relationship: { ...cmsInputs.relationship, pickValue: relationshipPick },
  media: { ...cmsInputs.media, pickValue: mediaPick },
})

// cmsInputs, with server checks that each ID is an entry of a type the field takes, a file of a type it takes, or a
// form, which can be one proposed in the same chat and not made yet. Archived entries count, so archiving one doesn't
// stop the entries that link to it from saving.
export function serverInputs(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  pendingForms: Array<string> = [],
): Record<string, Input> {
  const check =
    (
      find: (ids: Array<string>) => Promise<Array<{ id: string }>>,
      fits: (row: any, schema: InputSchema) => boolean = () => true,
      validate = relationship.validateValue,
    ) =>
    async (value: unknown, schema: InputSchema) => {
      const validation = validate(value, schema)
      const ids = idsOf(value)
      if (!validation.isValid || !ids.length) return validation

      const rows = ids.every(isUuid) ? await find(ids) : []
      if (ids.every((id) => rows.some((row) => row.id === id && fits(row, schema)))) return validation
      if (validate === form.validateValue) return validationError(value, "There's no form with this ID.")
      return validationError(
        value,
        holdsOne(schema)
          ? "It's been deleted, or isn't of a type this field takes."
          : "Some of them have been deleted, or aren't of a type this field takes.",
      )
    }

  return {
    ...cmsInputs,
    relationship: {
      ...cmsInputs.relationship,
      validateServerValue: check(
        (ids) => db.selectFrom('entries').select(['id', 'type']).where('id', 'in', ids).execute(),
        (row, schema) => allowedTypes(types, schema).includes(row.type),
      ),
    },
    media: {
      ...cmsInputs.media,
      validateServerValue: check(
        (ids) => db.selectFrom('media').select(['id', 'mime']).where('id', 'in', ids).execute(),
        (row, schema) => fitsMedia(schema, row.mime),
      ),
    },
    form: {
      ...cmsInputs.form,
      validateServerValue: check(
        async (ids) => [
          ...(await db.selectFrom('forms').select('id').where('id', 'in', ids).execute()),
          ...pendingForms.map((id) => ({ id })),
        ],
        undefined,
        form.validateValue,
      ),
    },
  }
}

type Relation = Database['entry_relations']

// What an entry's relationship and media fields link to, and the links in fields such as rich text, as rows of
// entry_relations
function relationsOf(type: ContentType, entryId: string, values: Record<string, any>) {
  const rows = new Map<string, Relation>()
  const add = (schema: InputSchema, ids: Array<string>) => {
    for (const id of ids.filter(isUuid)) {
      rows.set(`${schema.id} ${id}`, { entry_id: entryId, field_id: String(schema.id), target_id: id })
    }
  }
  const collect: InputPickValue = (value, schema) => (add(schema, idsOf(value)), value)
  pickValues(
    type.fields,
    values,
    withOwnLinks(walking(collect), (schema, links) => add(schema, [...links.entries, ...links.media])),
  )
  return [...rows.values()]
}

// The forms an entry's form fields name, at any depth
export function formsOf(type: ContentType, values: Record<string, any>) {
  const ids = new Set<string>()
  const collect: InputPickValue = (value) => {
    for (const id of idsOf(value)) ids.add(id)
    return value
  }
  pickValues(type.fields, values, { ...cmsInputs, form: { ...cmsInputs.form, pickValue: collect } })
  return [...ids]
}

const insertRelations = (trx: Kysely<Database>, rows: Array<Relation>) =>
  sql`
    insert into entry_relations (entry_id, field_id, target_id)
    select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as data (entry_id uuid, field_id text, target_id uuid)
  `.execute(trx)

// Rebuild an entry's rows of entry_relations from its values, as every save does
export async function saveRelations(
  trx: Kysely<Database>,
  type: ContentType,
  entryId: string,
  values: Record<string, any>,
) {
  await trx.deleteFrom('entry_relations').where('entry_id', '=', entryId).execute()
  await insertRelations(trx, relationsOf(type, entryId, values))
}

// Rebuild entry_relations for every entry of a type that still exists, 500 at a time, after content migrations have
// changed their values. Each batch is a transaction of its own that locks the entries it rebuilds, as a save locks the
// entry it saves while it rewrites its links, so the two never write one entry's links at once: a batch skips an entry
// a save holds, and leaves alone those saved since the rebuild began, whose saves rebuilt their links.
export async function rebuildRelations(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  // Called with how many entries are done of how many, as each batch is
  progress?: (done: number, total: number) => void,
) {
  if (types.size === 0) return
  const names = [...types.keys()]
  // As text, which keeps the database's microseconds
  const { began } = (await sql<{ began: string }>`select now()::text as began`.execute(db)).rows[0]
  const total = progress
    ? Number(
        (
          await db
            .selectFrom('entries')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('type', 'in', names)
            .executeTakeFirstOrThrow()
        ).count,
      )
    : 0
  let done = 0
  progress?.(done, total)
  for (let after: string | undefined; ;) {
    const rows = await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('entries')
        .select(['id', 'type', 'values', sql<boolean>`updated_at < ${began}::timestamptz`.as('unsaved')])
        .where('type', 'in', names)
        .$if(after !== undefined, (qb) => qb.where('id', '>', after!))
        .orderBy('id')
        .limit(500)
        .forUpdate()
        .skipLocked()
        .execute()
      const rebuilt = rows.filter((row) => row.unsaved)
      if (rebuilt.length) {
        await trx
          .deleteFrom('entry_relations')
          .where(
            'entry_id',
            'in',
            rebuilt.map((row) => row.id),
          )
          .execute()
        await insertRelations(
          trx,
          rebuilt.flatMap((row) => relationsOf(types.get(row.type)!, row.id, row.values)),
        )
      }
      return rows
    })
    progress?.((done += rows.length), total)
    if (rows.length < 500) return
    after = rows.at(-1)!.id
  }
}

const badRequest = (message: string) => new HTTPException(400, { message })

// The fields a delivery request's with names, as a JSON list, and how many levels of links its depth asks for
export function parseWith(
  type: ContentType,
  params: Record<string, string>,
  { depth, maxDepth }: { depth: number; maxDepth: number },
) {
  if (params.with === undefined) return undefined
  const fields = linkFields(type).map((field) => field.name)
  const example = JSON.stringify(fields.length ? fields.slice(0, 2) : ['author'])

  let names: unknown
  try {
    names = JSON.parse(params.with)
  } catch {}
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw badRequest(`with must be a JSON list of fields, such as ${example}.`)
  }
  const unknown = names.find((name) => !fields.includes(name))
  if (unknown !== undefined) {
    throw badRequest(
      fields.length
        ? `with can't name ${JSON.stringify(unknown)}. Use ${fields.join(', ')}, which hold ${type.name}'s links.`
        : `${type.name} has no relationship or media fields for with to name.`,
    )
  }

  const levels = Number(params.depth ?? depth)
  if (!Number.isInteger(levels) || levels < 1 || levels > maxDepth) {
    throw badRequest(`depth must be a whole number from 1 to ${maxDepth}.`)
  }
  return { names, depth: levels }
}

type Entry = ReturnType<typeof toEntry>

// Calls found with the IDs each relationship and media field in some values holds, and those in the values of fields
// that resolve their own links, such as rich text delivered as JSON, once for each place it sits, inside groups, repeaters and
// flexible blocks too. Each container's pickValue finds its items, as in pickValues, but without pickValues' condition
// scopes, which visit every field again, so fields that conditions hide are visited too.
function eachLink(
  fields: Array<FieldSchema>,
  values: Record<string, any>,
  found: (media: boolean, ids: Array<string>) => void,
) {
  const inside: InputPickFields = (children, items) => {
    eachLink(children, items, found)
    return {}
  }
  for (const field of fields) {
    const value = values?.[field.name] === undefined ? field.defaultValue : values[field.name]
    const input = cmsInputs[field.type]
    if (isLink(field)) {
      found(field.type === 'media', idsOf(value).filter(isUuid))
      continue
    }
    if (input?.resolve && input.links) {
      const links = input.links(value, field)
      found(false, links.entries.filter(isUuid))
      found(true, links.media.filter(isUuid))
    }
    input?.pickValue?.(value, field, inside)
  }
}

const among = (ids: Iterable<string>) => sql<SqlBool>`id = any(${[...ids]}::uuid[])`

// The entries and files with some IDs, as the delivery API returns them, each kind in one query. Entries are live
// copies, or for a preview, drafts, and those it doesn't serve, such as unpublished or archived ones, are left out.
async function loadLinked(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  origin: string,
  entryIds: Iterable<string>,
  mediaIds: Iterable<string>,
  draft: boolean,
) {
  const [entries, files] = [[...entryIds], [...mediaIds]]
  return {
    entries: new Map(
      (entries.length === 0
        ? []
        : await deliveredEntries(db, draft)
            .selectAll()
            .$castTo<Delivered>()
            .where(among(entries))
            // Entries of a type that's been removed stay in the database, but the API doesn't serve them
            .where('type', 'in', [...types.keys()])
            .execute()
      ).map((row) => [row.id, toEntry(row)]),
    ),
    media: new Map(
      (files.length === 0 ? [] : await db.selectFrom('media').selectAll().where(among(files)).execute()).map((row) => [
        row.id,
        toMedia(row, origin),
      ]),
    ),
  }
}

const delivers = (field: FieldSchema) => !!cmsInputs[field.type]?.deliver

// Values with each field whose input delivers its own, such as rich text, changed by change, at any depth, through
// each container's pickValue, as eachLink walks them. The rest stay as they are.
function mapDelivered(
  fields: Array<FieldSchema>,
  values: Record<string, any>,
  change: (field: FieldSchema, value: unknown) => unknown,
) {
  const changed: Record<string, unknown> = {}
  const inside: InputPickFields = (children, items) => ({ ...items, ...mapDelivered(children, items, change) })
  for (const field of fields) {
    if (!values || !Object.hasOwn(values, field.name)) continue
    const value = values[field.name]
    const input = cmsInputs[field.type]
    if (input?.deliver) changed[field.name] = change(field, value)
    else if (input?.pickValue && typeof value === 'object' && value !== null && someField([field], delivers)) {
      changed[field.name] = input.pickValue(value, field, inside)
    }
  }
  return changed
}

// Entries with the fields whose inputs deliver their own written out, such as rich text as HTML, given the entries and
// files they link to, which load first, each kind in one query
export async function deliverValues(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  origin: string,
  entries: Iterable<Entry>,
  draft = false,
) {
  const delivering = [...entries].flatMap((entry) => {
    const fields = (types.get(entry.type)?.fields ?? []).filter((field) => someField([field], delivers))
    return fields.length ? [{ entry, fields }] : []
  })
  if (!delivering.length) return

  const entryIds = new Set<string>()
  const mediaIds = new Set<string>()
  for (const { entry, fields } of delivering) {
    mapDelivered(fields, entry.values, (field, value) => {
      const links = cmsInputs[field.type].links?.(value, field)
      for (const id of links?.entries.filter(isUuid) ?? []) entryIds.add(id)
      for (const id of links?.media.filter(isUuid) ?? []) mediaIds.add(id)
      return value
    })
  }
  const found: LinkedRecords = await loadLinked(db, types, origin, entryIds, mediaIds, draft)
  for (const { entry, fields } of delivering) {
    entry.values = {
      ...entry.values,
      ...mapDelivered(fields, entry.values, (field, value) => cmsInputs[field.type].deliver!(value, field, found)),
    }
  }
}

// Swap the IDs in some fields of entries for what they link to, as the delivery API's with does. The named fields go
// first, then every link of the entries they hold, a level at a time down to depth. Each level loads its entries in one
// query and its media in another, whatever their types, and pickValues walks the groups, repeaters and flexible blocks
// in between. Links go to live copies, or for a preview, to drafts. Entries the delivery
// API doesn't serve, such as unpublished or archived ones, are left out, which is null in a field that holds one. A reply
// that would hold more than maxLinks of them, counting every place it shows one, is refused before its level's queries,
// since a record linked from several places is written out at each, and a few entries that link to each other can make
// a reply of gigabytes.
export async function resolveLinks(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  origin: string,
  entries: Array<Entry>,
  names: Array<string>,
  depth: number,
  maxLinks: number,
  draft = false,
) {
  // Each entry of a level, with how many places the reply shows it
  let level = entries.map((entry) => ({ entry, names: names as Array<string> | undefined, shown: 1 }))
  let copies = 0
  for (let remaining = depth; remaining > 0 && level.length > 0; remaining--) {
    // Fields an entry has no value for stay out, since pickValues would fill them with defaults
    const fieldsOf = (entry: Entry, names?: Array<string>) =>
      linkFields(types.get(entry.type)!).filter(
        (field) => (!names || names.includes(field.name)) && Object.hasOwn(entry.values, field.name),
      )

    // The first pass collects the IDs, each entry's with the places the reply will show it, and counts the copies, as
    // a link shows up wherever the entry holding it does. Links in hidden fields count too, and IDs count before
    // they're looked up, which can only refuse a reply early.
    const entryIds = new Map<string, number>()
    const mediaIds = new Set<string>()
    for (const { entry, names, shown } of level) {
      eachLink(fieldsOf(entry, names), entry.values, (media, ids) => {
        for (const id of ids) {
          copies += shown
          if (media) mediaIds.add(id)
          else entryIds.set(id, (entryIds.get(id) ?? 0) + shown)
        }
      })
    }
    if (copies > maxLinks) {
      throw badRequest(
        `This reply would hold more than ${maxLinks.toLocaleString('en')} linked entries and files. ` +
          'Ask for fewer with perPage, depth or with.',
      )
    }

    const found = await loadLinked(db, types, origin, entryIds.keys(), mediaIds, draft)
    const { entries: linked, media: files } = found
    // Linked entries are delivered as any is, such as with their rich text as HTML
    await deliverValues(db, types, origin, linked.values(), draft)

    // The second swaps each ID for its record
    const swap =
      <T>(found: Map<string, T>, fits: (record: T, schema: InputSchema) => boolean): InputPickValue =>
      (value, schema) => {
        const records = idsOf(value).flatMap((id) => {
          const record = found.get(id)
          return record && fits(record, schema) ? [record] : []
        })
        return holdsOne(schema) ? (records[0] ?? null) : records
      }
    const inputs = Object.fromEntries(
      Object.entries(
        walking(
          swap(linked, (entry, schema) => allowedTypes(types, schema).includes(entry.type)),
          swap(files, (file, schema) => fitsMedia(schema, file.mime)),
        ),
      ).map(([type, input]) => [
        type,
        // Fields that resolve their own links do so once their containers' picks have resolved those inside them
        !input.resolve
          ? input
          : {
              ...input,
              pickValue: ((value, schema, pickFields) =>
                input.resolve!(
                  input.pickValue ? input.pickValue(value, schema, pickFields) : value,
                  schema,
                  found,
                )) as InputPickValue,
            },
      ]),
    )
    for (const { entry, names } of level) {
      entry.values = { ...entry.values, ...pickValues(fieldsOf(entry, names), entry.values, inputs) }
    }

    // An entry linked from several places is one record, resolved once for all of them. One linked only by an ID in
    // capitals, which Postgres finds but returns in lowercase, is never swapped in, so nothing shows it.
    level = [...linked.values()].map((entry) => ({ entry, names: undefined, shown: entryIds.get(entry.id) ?? 0 }))
  }
  return entries
}
