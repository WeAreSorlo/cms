import { type MediaOptions, type Storage, defaultMediaTypes } from '.'
import { checkAutomation } from './automations'
import { type ContentMigrationFile, appliedMigrations, catchUpFrom, checkEntries } from './content'
import { flattenValidationReport } from './core'
import { Database, isUuid } from './db'
import { checkForm } from './forms'
import { checkFile } from './media'
import { type EntryRow, type PublishedRow, isSaved } from './query'
import { saveRelations } from './relations'
import type { ContentType } from './types'
import type { ValidationReport } from '@sorlo/forms'
import { DriveManager } from 'flydrive'
import { Kysely } from 'kysely'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// sorlo export and sorlo import: a site's content as a folder, which a starter keeps in git and loads as it's set up.
// Every record is a JSON file named by its ID, so diffs stay small and IDs, which links, media fields, form fields and
// automations' rules hold, keep working.

// The folder's format, by which a later CMS reads older folders and refuses newer ones
const format = 1

// What an export writes in its folder, which the next replaces, leaving anything else there alone
const parts = ['export.json', 'entries', 'media', 'forms', 'automations']

// Why an export or import didn't go, as lines to print, having changed nothing
export class Refused extends Error {}

// What an export or import went through
export interface Moved {
  entries: number
  media: number
  forms: number
  automations: number
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const iso = (date: Date | null) => date && date.toISOString()

// A folder as the messages name it, from where the command runs, such as content/
const shown = (dir: string) => `${relative(process.cwd(), dir) || '.'}/`

// Such as 12 entries, 3 files, 1 form and 1 automation
export function summary({ entries, media, forms, automations }: Moved) {
  const count = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`
  return `${count(entries, 'entry', 'entries')}, ${count(media, 'file', 'files')}, ${count(forms, 'form', 'forms')} and ${count(automations, 'automation', 'automations')}`
}

// An entry as its file has it: the draft's columns, and its live copy, which holds only publishedAt when it's the
// draft as it stands, as it is for most published entries, so values aren't written twice
function entryFile(row: EntryRow, live: PublishedRow | undefined) {
  const draft = { parentId: row.parent_id, position: row.position, slug: row.slug, uri: row.uri, values: row.values }
  const copy = live && {
    parentId: live.parent_id,
    position: live.position,
    slug: live.slug,
    uri: live.uri,
    values: live.values,
  }
  const same = live && isDeepStrictEqual(copy, draft) && live.updated_at.getTime() === row.updated_at.getTime()
  return {
    id: row.id,
    ...draft,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: iso(row.archived_at),
    takenDownAt: iso(row.taken_down_at),
    live: !live
      ? null
      : same
        ? { publishedAt: iso(live.published_at) }
        : { ...copy, updatedAt: iso(live.updated_at), publishedAt: iso(live.published_at) },
  }
}

// Writes the site's content to a folder, from one snapshot: every saved entry with its draft and live copy, archived
// ones too, every media file with its details, every form and every automation. It goes into a folder that's empty or
// holds an earlier export, never one with anything else, so a mistyped folder can't empty a project. It's written
// beside the folder first, so a failure leaves the folder as it was. It gives what it wrote, and the automations whose
// files hold a webhook's signing secret or headers.
export async function exportContent(
  db: Kysely<Database>,
  storage: Storage,
  dir: string,
  migrations: Record<string, ContentMigrationFile>,
) {
  if (existsSync(dir)) {
    const found = await readdir(dir).catch(() => {
      throw new Refused(`${shown(dir).slice(0, -1)} isn't a folder.`)
    })
    // Such as .DS_Store or .gitkeep
    if (found.some((name) => !name.startsWith('.')) && !found.includes('export.json')) {
      throw new Refused(`${shown(dir)} holds files that aren't an export. Choose an empty folder or an earlier export.`)
    }
  }

  // shortcut: every row is held in memory, and each file in turn, so stream them when sites outgrow that
  const read = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => ({
      migration: (await appliedMigrations(trx, migrations)).at(-1) ?? null,
      entries: await trx.selectFrom('entries').selectAll().where(isSaved).orderBy('id').execute(),
      live: await trx.selectFrom('published_entries').selectAll().execute(),
      media: await trx.selectFrom('media').selectAll().orderBy('id').execute(),
      forms: await trx.selectFrom('forms').selectAll().orderBy('id').execute(),
      automations: await trx.selectFrom('automations').selectAll().orderBy('id').execute(),
    }))
    .catch((error) => {
      if (error?.code !== '42P01') throw error
      throw new Refused("This site's database doesn't have the CMS's tables yet, so it has no content.")
    })

  await mkdir(dirname(dir), { recursive: true })
  const temp = await mkdtemp(join(dirname(dir), `.${basename(dir)}-`))
  const write = async (path: string, data: string | Uint8Array) => {
    await mkdir(dirname(join(temp, path)), { recursive: true })
    await writeFile(join(temp, path), data)
  }

  try {
    const live = new Map(read.live.map((row) => [row.id, row]))
    for (const row of read.entries) {
      // A type's name is a letter, then letters, digits or underscores, so it names a folder safely
      if (!/^[A-Za-z]\w*$/.test(row.type))
        throw new Refused(`The entry ${row.id}'s type, ${row.type}, can't name a folder.`)
      await write(`entries/${row.type}/${row.id}.json`, json(entryFile(row, live.get(row.id))))
    }

    const drive = new DriveManager(storage)
    for (const row of read.media) {
      const { id, name, alt, caption } = row
      await write(
        `media/${id}.json`,
        json({ id, name, alt, caption, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }),
      )
      const bytes = await Promise.resolve()
        .then(() => drive.use(row.disk).getBytes(row.path))
        .catch((error) => {
          const why = error instanceof Error ? error.message : String(error)
          throw new Refused(`Couldn't read ${name}, the file ${id}, from storage: ${why}`)
        })
      // Named as it's stored, by its ID and the type its content was checked as
      await write(`media/${id}${extname(row.path)}`, bytes)
    }

    for (const row of read.forms) {
      const { id, name, label, open, fields } = row
      const firstOpenedAt = iso(row.first_opened_at)
      const times = { createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
      await write(`forms/${id}.json`, json({ id, name, label, open, firstOpenedAt, fields, ...times }))
    }

    const secrets: Array<string> = []
    for (const row of read.automations) {
      const { id, name, triggers, conditions, actions } = row
      const times = { createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
      await write(`automations/${id}.json`, json({ id, name, triggers, conditions, actions, ...times }))
      const holds = actions.some((action) => action._layout === 'webhook' && (action.secret || action.headers?.length))
      if (holds) secrets.push(`${shown(dir)}automations/${id}.json`)
    }

    // No time, so exporting content that hasn't changed changes no file
    await write('export.json', json({ format, migration: read.migration }))

    await mkdir(dir, { recursive: true })
    for (const part of parts) {
      await rm(join(dir, part), { recursive: true, force: true })
      if (existsSync(join(temp, part))) await rename(join(temp, part), join(dir, part))
    }
    const moved: Moved = {
      entries: read.entries.length,
      media: read.media.length,
      forms: read.forms.length,
      automations: read.automations.length,
    }
    return { moved, secrets }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

// The kinds a record's fields must be, ending in ? where null will do
const kinds: Record<string, (value: unknown) => boolean> = {
  uuid: isUuid,
  date: (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
  text: (value) => typeof value === 'string',
  integer: Number.isInteger,
  boolean: (value) => typeof value === 'boolean',
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  list: Array.isArray,
}

// The fields of a record that aren't the kinds they must be, as a problem with its file, or none
function misfits(file: string, record: Record<string, unknown>, fields: Record<string, string>) {
  const wrong = Object.entries(fields)
    .filter(
      ([key, kind]) => !(kind.endsWith('?') && record[key] === null) && !kinds[kind.replace('?', '')](record[key]),
    )
    .map(([key]) => key)
  if (!wrong.length) return []
  return [`${file}: ${wrong.join(', ')} ${wrong.length === 1 ? "isn't" : "aren't"} what an export writes.`]
}

// A report's messages, each with the file and the field it's about
const reported = (file: string, report: ValidationReport) =>
  Object.entries(flattenValidationReport(report).messages).map(([path, list]) => `${file}: ${path}: ${list.join(' ')}`)

// The JSON files of a folder in the export, read, with their paths from the export's folder, or problems with them.
// Each must be an object whose id is its file's name.
async function records(dir: string, folder: string, problems: Array<string>) {
  const found = existsSync(join(dir, folder)) ? (await readdir(join(dir, folder))).sort() : []
  const read: Array<{ file: string; data: Record<string, any> }> = []
  for (const name of found.filter((name) => name.endsWith('.json'))) {
    const file = `${folder}/${name}`
    try {
      const data = JSON.parse(await readFile(join(dir, file), 'utf8'))
      if (typeof data !== 'object' || data === null || Array.isArray(data) || data.id !== basename(name, '.json')) {
        problems.push(`${file}: its id needs to be its file's name.`)
      } else read.push({ file, data })
    } catch (error) {
      problems.push(`${file} isn't JSON: ${error instanceof Error ? error.message : error}`)
    }
  }
  return read
}

// Each item after its parent, or a problem with its file for a parent that isn't among them, or that's under it
function parentsFirst<T extends { id: string; file: string }>(
  items: Array<T>,
  parentOf: (item: T) => string | null,
  problems: Array<string>,
  // Such as its parent, 0193…, isn't an entry in the export
  missing: (parentId: string) => string,
) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const depths = new Map<string, number>()
  const depthOf = (item: T, path: Set<string>): number => {
    if (depths.has(item.id)) return depths.get(item.id)!
    const parentId = parentOf(item)
    const parent = parentId === null ? undefined : byId.get(parentId)
    let depth = 0
    if (parentId !== null && !parent) problems.push(`${item.file}: ${missing(parentId)}`)
    else if (parent && path.has(parent.id)) problems.push(`${item.file}: it's under itself.`)
    else if (parent) depth = depthOf(parent, new Set([...path, item.id])) + 1
    depths.set(item.id, depth)
    return depth
  }
  for (const item of items) depthOf(item, new Set([item.id]))
  return [...items].sort((a, b) => depths.get(a.id)! - depths.get(b.id)!)
}

export interface ImportSources {
  types: Map<string, ContentType>
  // The site's content migrations, which values from before the newest of them go through
  migrations: Record<string, ContentMigrationFile>
  storage: Storage
  media?: MediaOptions
}

// Loads an export into a site with no entries, media, forms or automations, all or nothing. Values from before the
// site's newest content migrations go through those migrations' ups, as restoring an old version does. Every record
// passes what the admin checks: drafts what a save checks, live copies what a publish does, forms and automations what
// saving one does, and files what an upload does. An entry gets a version for its live copy and one more for a draft
// that differs, with no person, and nothing writes events, so no automation runs for it. The files go into storage
// last, and are deleted again when the import fails after all.
export async function importContent(
  db: Kysely<Database>,
  dir: string,
  { types, migrations, storage, media = {} }: ImportSources,
): Promise<Moved> {
  const text = await readFile(join(dir, 'export.json'), 'utf8').catch((error) => {
    throw new Refused(
      error?.code === 'ENOENT'
        ? `${shown(dir)} isn't an export, since it has no export.json.`
        : `${shown(dir)}export.json can't be read: ${error.message}`,
    )
  })
  let manifest: any
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Refused(`${shown(dir)}export.json isn't JSON: ${error instanceof Error ? error.message : error}`)
  }
  if (typeof manifest?.format === 'number' && manifest.format > format) {
    throw new Refused(
      `${shown(dir)} was exported by a newer Sorlo, in format ${manifest.format}. Update Sorlo to import it.`,
    )
  }
  if (manifest?.format !== format || !(manifest.migration === null || typeof manifest.migration === 'string')) {
    throw new Refused(`${shown(dir)}export.json isn't what an export writes.`)
  }

  const existing: Array<string> = []
  for (const table of ['entries', 'media', 'forms', 'automations'] as const) {
    const found = await db
      .selectFrom(table)
      .select('id')
      .limit(1)
      .executeTakeFirst()
      .catch((error) => {
        if (error?.code !== '42P01') throw error
        throw new Refused("This site's database doesn't have the CMS's tables yet. Migrate, then import again.")
      })
    if (found) existing.push(table)
  }
  if (existing.length) {
    const has = existing.length > 1 ? `${existing.slice(0, -1).join(', ')} and ${existing.at(-1)}` : existing[0]
    throw new Refused(
      `This site has ${has} already. Import only goes into a site without any entries, media, forms or automations.`,
    )
  }

  // Values from before this site's newest content migrations go through them
  const applied = await appliedMigrations(db, migrations)
  const since = manifest.migration === null ? 0 : applied.indexOf(manifest.migration) + 1
  if (since === 0 && manifest.migration !== null) {
    throw new Refused(
      `${shown(dir)} was exported after the content migration ${manifest.migration}, which hasn't run here. Migrate, then import again.`,
    )
  }
  const forward = await catchUpFrom(applied.slice(since).map((name) => migrations[name].up))
  const migration = applied.at(-1) ?? null

  const problems: Array<string> = []

  // Entries, each in the folder of the type it had then, with their values and their live copies' brought up to date
  interface Imported {
    file: string
    id: string
    type: string
    values: Record<string, any>
    data: Record<string, any>
    // Whether the live copy differs from the draft, and so has a version of its own
    differs: boolean
    live: null | {
      parentId: string | null
      position: number | null
      slug: string | null
      uri: string | null
      values: Record<string, any>
      updatedAt: string
      publishedAt: string
    }
  }
  const entries: Array<Imported> = []
  const folders = existsSync(join(dir, 'entries')) ? (await readdir(join(dir, 'entries'))).sort() : []
  for (const folder of folders.filter((name) => !name.startsWith('.'))) {
    for (const { file, data } of await records(dir, `entries/${folder}`, problems)) {
      const shape = {
        parentId: 'uuid?',
        position: 'integer?',
        slug: 'text?',
        uri: 'text?',
        values: 'object',
        createdAt: 'date',
        updatedAt: 'date',
        archivedAt: 'date?',
        takenDownAt: 'date?',
      }
      const wrong = misfits(file, data, shape)
      const live = data.live
      const full = live && 'values' in live
      if (!wrong.length && live !== null) {
        const liveShape = { publishedAt: 'date' }
        const fullShape = {
          parentId: 'uuid?',
          position: 'integer?',
          slug: 'text?',
          uri: 'text?',
          values: 'object',
          updatedAt: 'date',
        }
        wrong.push(
          ...(kinds.object(live)
            ? misfits(`${file} live`, live, full ? { ...fullShape, ...liveShape } : liveShape)
            : [`${file}: live isn't what an export writes.`]),
        )
      }
      if (!wrong.length && live && data.archivedAt) wrong.push(`${file}: it's archived, so it can't be live.`)
      problems.push(...wrong)
      if (wrong.length) continue

      const draft = forward(folder, data.values)
      if (!types.has(draft.type)) {
        problems.push(`${file}: this site has no content type named ${draft.type}.`)
        continue
      }
      entries.push({
        file,
        id: data.id,
        type: draft.type,
        values: draft.values,
        data,
        differs: !!full,
        live: live && {
          parentId: full ? live.parentId : data.parentId,
          position: full ? live.position : data.position,
          slug: full ? live.slug : data.slug,
          uri: full ? live.uri : data.uri,
          values: full ? forward(folder, live.values).values : draft.values,
          updatedAt: full ? live.updatedAt : data.updatedAt,
          publishedAt: live.publishedAt,
        },
      })
    }
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id.toLowerCase())) problems.push(`${entry.file}: another entry has its id.`)
    ids.add(entry.id.toLowerCase())
  }
  // Drafts sit under drafts, and a live copy only under a live parent
  const drafts = parentsFirst(
    entries,
    (entry) => entry.data.parentId,
    problems,
    (parentId) => `its parent, ${parentId}, isn't an entry in the export.`,
  )
  const lives = parentsFirst(
    entries.filter((entry) => entry.live),
    (entry) => entry.live!.parentId,
    problems,
    (parentId) => `its live parent, ${parentId}, isn't live in the export.`,
  )

  // Files, each beside its details and named by its ID, checked as an upload is
  const { types: mediaTypes = defaultMediaTypes, maxFileSize = 50 * 1024 ** 2 } = media
  const files = existsSync(join(dir, 'media')) ? await readdir(join(dir, 'media')) : []
  type Checked = NonNullable<Awaited<ReturnType<typeof checkFile>>['file']>
  const uploads: Array<Checked & { data: Record<string, any>; source: string }> = []
  for (const { file, data } of await records(dir, 'media', problems)) {
    const wrong = misfits(file, data, {
      name: 'text',
      alt: 'text?',
      caption: 'text?',
      createdAt: 'date',
      updatedAt: 'date',
    })
    problems.push(...wrong)
    const source = files.find((name) => !name.endsWith('.json') && basename(name, extname(name)) === data.id)
    if (wrong.length) continue
    if (!source) {
      problems.push(`${file}: its file, media/${data.id} with its extension, isn't beside it.`)
      continue
    }
    const bytes = await readFile(join(dir, 'media', source))
    if (bytes.length > maxFileSize) {
      problems.push(`media/${source}: it's larger than media.maxFileSize in sorlo.config.ts.`)
      continue
    }
    const checked = await checkFile(bytes, data.name, mediaTypes)
    if (!checked.file) problems.push(`media/${source}: ${checked.problem}`)
    else uploads.push({ data, source, ...checked.file })
  }

  const forms = await records(dir, 'forms', problems)
  for (const { file, data } of forms) {
    problems.push(
      ...misfits(file, data, {
        name: 'text',
        label: 'text',
        open: 'boolean',
        firstOpenedAt: 'date?',
        fields: 'list',
        createdAt: 'date',
        updatedAt: 'date',
      }),
    )
  }
  const automations = await records(dir, 'automations', problems)
  for (const { file, data } of automations) {
    problems.push(
      ...misfits(file, data, {
        name: 'text',
        triggers: 'list',
        conditions: 'list',
        actions: 'list',
        createdAt: 'date',
        updatedAt: 'date',
      }),
    )
  }
  if (problems.length) throw new Refused(problems.join('\n'))

  const drive = new DriveManager(storage)
  const disk = String(storage.default)
  const stored: Array<string> = []
  try {
    await db.transaction().execute(async (trx) => {
      // Forms first, which entries' form fields and automations' rules name
      for (const { file, data } of forms) {
        const checked = await checkForm(trx, { name: data.name, label: data.label, fields: data.fields })
        if (checked.report) {
          problems.push(...reported(file, checked.report))
          continue
        }
        const fields = JSON.stringify(checked.form.fields)
        const times = { created_at: new Date(data.createdAt), updated_at: new Date(data.updatedAt) }
        await trx
          .insertInto('forms')
          .values({
            id: data.id,
            name: checked.form.name,
            label: checked.form.label,
            fields,
            version: 1,
            open: data.open,
            first_opened_at: data.firstOpenedAt && new Date(data.firstOpenedAt),
            ...times,
          })
          .execute()
        await trx
          .insertInto('form_versions')
          .values({ form_id: data.id, number: 1, fields, created_at: times.updated_at })
          .execute()
      }

      for (const { file, data } of automations) {
        const checked = await checkAutomation(trx, types, data)
        if (checked.report) problems.push(...reported(file, checked.report))
        else {
          await trx
            .insertInto('automations')
            .values({
              id: data.id,
              ...checked.values,
              created_at: new Date(data.createdAt),
              updated_at: new Date(data.updatedAt),
            })
            .execute()
        }
      }

      for (const { data, ext, name, mime, size, width, height } of uploads) {
        await trx
          .insertInto('media')
          .values({
            id: data.id,
            disk,
            path: `${data.id}.${ext}`,
            name,
            mime,
            size,
            width,
            height,
            alt: data.alt || null,
            caption: data.caption || null,
            created_at: new Date(data.createdAt),
            updated_at: new Date(data.updatedAt),
          })
          .execute()
      }

      for (const entry of drafts) {
        const { data } = entry
        await trx
          .insertInto('entries')
          .values({
            id: entry.id,
            type: entry.type,
            values: entry.values,
            parent_id: data.parentId,
            position: data.position,
            slug: data.slug,
            uri: data.uri,
            migration,
            created_at: new Date(data.createdAt),
            updated_at: new Date(data.updatedAt),
            archived_at: data.archivedAt && new Date(data.archivedAt),
            taken_down_at: data.takenDownAt && new Date(data.takenDownAt),
          })
          .execute()

        // The live copy's version, then the draft's when it differs, so the entry's status reads as it did
        const { live, differs } = entry
        const version = (values: object, parentId: string | null, savedAt: string) => ({
          entry_id: entry.id,
          values,
          parent_id: parentId,
          migration,
          created_at: new Date(savedAt),
        })
        const versions = [
          ...(live && differs
            ? [
                {
                  ...version(live.values, live.parentId, live.updatedAt),
                  number: 1,
                  published_at: new Date(live.publishedAt),
                },
              ]
            : []),
          {
            ...version(entry.values, data.parentId, data.updatedAt),
            number: differs ? 2 : 1,
            published_at: live && !differs ? new Date(live.publishedAt) : null,
          },
        ]
        await trx.insertInto('entry_versions').values(versions).execute()
        await saveRelations(trx, types.get(entry.type)!, entry.id, entry.values)
      }

      for (const entry of lives) {
        const live = entry.live!
        await trx
          .insertInto('published_entries')
          .values({
            id: entry.id,
            type: entry.type,
            values: live.values,
            parent_id: live.parentId,
            position: live.position,
            slug: live.slug,
            uri: live.uri,
            migration,
            created_at: new Date(entry.data.createdAt),
            updated_at: new Date(live.updatedAt),
            version: 1,
            published_at: new Date(live.publishedAt),
          })
          .execute()
      }

      // What migrate --check checks, in the transaction, so it sees what's imported
      const files = new Map(entries.map((entry) => [entry.id.toLowerCase(), entry.file]))
      for (const { entry, published, messages } of await checkEntries(trx, types)) {
        const file = `${files.get(entry.id)}${published ? ' live' : ''}`
        problems.push(...Object.entries(messages).map(([path, list]) => `${file}: ${path}: ${list.join(' ')}`))
      }
      if (problems.length) throw new Refused(problems.join('\n'))

      for (const { data, ext, source } of uploads) {
        const path = `${data.id}.${ext}`
        await drive.use(disk).put(path, await readFile(join(dir, 'media', source)))
        stored.push(path)
      }
    })
  } catch (error) {
    await Promise.all(
      stored.map((path) =>
        drive
          .use(disk)
          .delete(path)
          .catch(() => {}),
      ),
    )
    // Two records the export holds can't share what the database keeps unique, such as two pages' slugs under one parent
    const { code, detail } = (error ?? {}) as { code?: string; detail?: string }
    if (code === '23505') throw new Refused(`Two records in ${shown(dir)} share what must be unique: ${detail}`)
    throw error
  }

  return { entries: entries.length, media: uploads.length, forms: forms.length, automations: automations.length }
}
