import type { VersionOptions } from '.'
import type { ContentMigrationFile } from './content'
import { inputs, pickValues, validateServerValues } from './core'
import { type Database, transaction } from './db'
import { archive, entrySaver, findEntry, merge, restore, unpublish } from './entries'
import {
  type EntryChange,
  type HookSettings,
  Refusal,
  type Run,
  type SiteHooks,
  type Sorlo,
  type WriteOptions,
  Write,
  busyKey,
  depthKey,
  maxDepth,
  refusalOf,
  siteHooks,
} from './hooks'
import { findMedia, saveMediaDetails, toAdminMedia } from './media'
import { listEntries, parseQuery, toAdminEntry, withStatus } from './query'
import { mediaSchema } from './schemas'
import type { ContentType } from './types'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'

export interface SorloSources {
  db: Kysely<Database>
  types: Map<string, ContentType>
  migrations: () => Promise<Record<string, ContentMigrationFile>>
  versions?: VersionOptions
}

// The site's hooks with the sorlo API their writes use, which writes as the admin's routes do, checks and hooks
// included. Warns of hooks for types the site doesn't have, since the type editor can add one.
export function hookRuntime(settings: HookSettings = {}, sources: SorloSources): SiteHooks {
  const hooks = siteHooks(settings)
  for (const name of Object.keys(settings.contentHooks ?? {})) {
    if (name !== '*' && !sources.types.has(name)) {
      console.warn(`contentHooks.${name} in sorlo.config.ts names no content type, so they never run.`)
    }
  }
  hooks.sorlo = (run) => sorloApi(hooks, sources, run)
  return hooks
}

const missing = (error: unknown) => {
  if (error instanceof HTTPException && error.status === 404) return null
  throw error
}

function sorloApi(hooks: SiteHooks, { db: own, types, migrations, versions }: SorloSources, run: Run): Sorlo {
  // A before hook's reads and writes go through its write's transaction, so they see what it has done so far, and its
  // writes, as savepoints, go with it: they commit with it, and its failure takes them back
  const db = run.trx ?? own
  const { migrated, saveEntry } = entrySaver(db, types, migrations, versions)
  const origin = run.origin ?? ''
  const context = run.context ?? {}

  // A write as the person behind the hook's, in the same context, or a refusal: with no person, without
  // skipPermissions, or past maxDepth, which is likely a loop. A refused write throws a ValidationError with its report.
  const writing = async <T>(
    options: WriteOptions | undefined,
    id: string | null,
    work: (write: Write) => Promise<T>,
  ) => {
    if (!run.user && !options?.skipPermissions) {
      throw new Error(
        `No person is behind this ${run.source} write, so sorlo can only read. Pass { skipPermissions: true } to write.`,
      )
    }
    // Its versions would say they're from before the migration, which would then run on them again
    if (run.trx && run.source === 'migration') {
      throw new Error(
        "A content migration's before hooks can only read through sorlo while it runs. Write in afterSave, which runs once it commits.",
      )
    }
    if ((context[depthKey] ?? 0) >= maxDepth) {
      throw new Error(`Hooks wrote through sorlo ${maxDepth} deep, which is likely a loop. Use context to stop it.`)
    }
    if (id && context[busyKey]?.has(id.toLowerCase())) {
      throw new Error(
        `${id} is being saved, and its own before hooks can't write it, since the save writes it after them. Return values from beforeSave, or write it in an after hook.`,
      )
    }
    context[depthKey] = (context[depthKey] ?? 0) + 1
    try {
      const write = new Write(hooks, { ...run, context })
      const data = await work(write)
      return { data, ...write.reply }
    } catch (error) {
      if (error instanceof Refusal) throw refusalOf(error.report)
      throw error
    } finally {
      context[depthKey]--
    }
  }

  const entry = async (id: string) => toAdminEntry((await findEntry(db, types, id)).row)

  // Saves through the editor's save, replying the entry, or refusing with core's report
  const save = async (
    type: ContentType,
    write: Write,
    publish: boolean | undefined,
    sent: Parameters<typeof saveEntry>[4],
    id?: string,
  ) => {
    const live = type.drafts === false || publish === true
    const saved = await saveEntry(type, run.user?.id ?? null, await migrated(), live, sent, id, { write })
    if (saved.report) throw new Refusal(saved.report)
    return entry(saved.id)
  }

  // An entry that can change, which an archived one can't
  const changing = async (id: string) => {
    const found = await findEntry(db, types, id)
    if (found.row.archived_at)
      throw new HTTPException(409, { message: 'This entry is archived. Restore it to edit it.' })
    return found
  }

  return {
    entries: {
      get: (id) => entry(id).catch(missing),
      list: async (name, { archived = false, where, order, page, perPage } = {}) => {
        const type = types.get(name)
        if (!type) throw new Error(`There's no content type named ${name}.`)
        const params = Object.fromEntries(
          Object.entries({ where, order, page, perPage })
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]),
        )
        const from = withStatus(db).where('archived_at', archived ? 'is not' : 'is', null)
        const { data, pagination } = await listEntries<any>(from, type, parseQuery(type, params))
        return { data: data.map(toAdminEntry), pagination }
      },
      create: (name, { values, parentId = null, publish }: EntryChange, options) =>
        writing(options, null, (write) => {
          const type = types.get(name)
          if (!type) throw new Error(`There's no content type named ${name}.`)
          if (type.structure === 'singleton') throw new Error(`${type.label} is a singleton, so update its entry.`)
          const parent = type.structure === 'hierarchical' ? parentId : null
          return save(type, write, publish, () => ({ values, parentId: parent }), undefined)
        }),
      update: (id, { values, parentId, publish }: EntryChange, options) =>
        writing(options, id, async (write) => {
          const { type } = await changing(id)
          return save(
            type,
            write,
            publish,
            (saved) => ({
              values: values ? merge(type.fields, saved!.values, values) : saved!.values,
              parentId: type.structure === 'hierarchical' && parentId !== undefined ? parentId : saved!.parent_id,
            }),
            id,
          )
        }),
      publish: (id, options) =>
        writing(options, id, async (write) => {
          const { type } = await changing(id)
          return save(type, write, true, (saved) => ({ values: saved!.values, parentId: saved!.parent_id }), id)
        }),
      unpublish: (id, options) =>
        writing(options, id, async (write) => {
          const { row, type } = await findEntry(db, types, id)
          if (type.drafts === false)
            throw new Error(`${type.label} has no drafts, so its entries are live until archived.`)
          await transaction(db, (trx) => unpublish(trx, [row.id], write))
          await write.flush()
          return entry(row.id)
        }),
      archive: (id, options) =>
        writing(options, id, async (write) => {
          const { row } = await findEntry(db, types, id)
          await transaction(db, (trx) => archive(trx, [row.id], write))
          await write.flush()
          return entry(row.id)
        }),
      restore: (id, options) =>
        writing(options, id, async (write) => {
          const { row } = await findEntry(db, types, id)
          await transaction(db, (trx) => restore(trx, row, write))
          await write.flush()
          return entry(row.id)
        }),
    },
    media: {
      get: (id) =>
        findMedia(db, id)
          .then((row) => toAdminMedia(row, origin))
          .catch(missing),
      update: (id, changes, options) =>
        writing(options, id, async (write) => {
          const row = await findMedia(db, id)
          const values = pickValues(
            mediaSchema,
            { name: row.name, alt: row.alt, caption: row.caption, ...changes },
            inputs,
          )
          const report = await validateServerValues(mediaSchema, values, inputs)
          if (!report.isValid) throw new Refusal(report)
          return toAdminMedia(await saveMediaDetails(db, row.id, values, origin, { write }), origin)
        }),
    },
  }
}
