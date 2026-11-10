import { appliedMigrations, loadContentMigrations } from './content'
import { inputs, pickValues, validateServerValues } from './core'
import type { Database } from './db'
import type { AdminEnv } from './entries'
import { collapseUses, expandFields, isUse, someField, usesOf } from './fields'
import { diffTypes, makeMigration } from './makeMigration'
import { groupSchema, typeSchema } from './schemas'
import { ContentType, SharedGroup, checkGroup, checkType, cycleOf, cycleProblem, loadSchema } from './types'
import type { FieldSchema, ValidationReport } from '@sorlo/core'
import { Context, Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { Kysely } from 'kysely'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// Where the type editor writes: the site project's schema/types and migrations folders. Shared groups go in the
// groups folder beside schema/types.
export interface EditorDirs {
  types: string
  migrations: string
}

// The settings' icon is text here, and a picker in the admin
const settingsInputs = { ...inputs, icon: inputs.text }

// A new type's or shared group's id, in the form core gives fields, such as typ_k3x9q2mz
export const createId = (prefix: string) =>
  `${prefix}_${Array.from(randomBytes(8), (byte) => (byte % 36).toString(36)).join('')}`

// The project's own Prettier lays the file out when it has one, as it would lay out a file written by hand
async function formatJson(file: string, value: unknown) {
  try {
    const prettier = await import('prettier')
    return await prettier.format(JSON.stringify(value), { ...(await prettier.resolveConfig(file)), filepath: file })
  } catch {
    return `${JSON.stringify(value, null, 2)}\n`
  }
}

// Core's report, with each of checkType's or checkGroup's problems under the setting it starts with, or under fields
// for the rest, or nothing when there are none
function problemsOf(
  schema: Array<FieldSchema>,
  report: { isValid: boolean; fields: Record<string, unknown> },
  found: Array<[key: string, message: string]>,
) {
  if (report.isValid && !found.length) return undefined
  const problems: Record<string, Array<string>> = {}
  for (const [key, message] of found) {
    const at = schema.some((field) => field.name === key) ? key : 'fields'
    problems[at] = [...(problems[at] ?? []), message]
  }
  const fieldReports = Object.entries(problems).map(([key, messages]) => [key, { isValid: false, messages }])
  return { isValid: false, fields: { ...report.fields, ...Object.fromEntries(fieldReports) } } as ValidationReport
}

// The setting a problem starts with, such as name in '"name" must match the file's name'
const keyOf = (problem: string) => problem.match(/^(?:It needs an? )?"(\w+)"/)?.[1] ?? 'fields'

// The ids of every type or every shared group, and of the one being saved
const ids = (map: Map<string, { id: string }>, saving?: string) =>
  new Set([...[...map.values()].map((value) => value.id), ...(saving ? [saving] : [])])

const structures = { collection: 'a collection', hierarchical: 'hierarchical', singleton: 'a singleton' }

// Whether two names are one file on a disk that ignores case, as macOS's and Windows' do by default
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const entries = (count: number) => (count === 1 ? 'an entry' : `${count.toLocaleString('en')} entries`)

const gone = (name: string) => `${name} was renamed or deleted since it was opened. Open it again.`

// A type as the type editor's save writes it, from its settings and fields as the editor sends them: in the order the
// type files have them, leaving out empty settings. A new one gets id, or one of its own.
export function typeFrom(body: any, old?: { id: string }, id?: string) {
  const fields = Array.isArray(body?.fields) ? body.fields : []
  const schema = typeSchema(fields)
  const settings = pickValues(schema, body ?? {}, settingsInputs)
  const type: ContentType = JSON.parse(
    JSON.stringify({
      id: old?.id ?? id ?? createId('typ'),
      name: settings.name,
      label: settings.label,
      singular: settings.singular || undefined,
      structure: settings.structure,
      // Drafts are on unless a type says otherwise
      drafts: settings.drafts === false ? false : undefined,
      icon: settings.icon || undefined,
      titleField: settings.titleField || undefined,
      slugField: settings.slugField || undefined,
      listColumns: settings.listColumns?.length ? settings.listColumns : undefined,
      fields,
    }),
  )
  return { type, schema, settings }
}

// What a change keeps of the files it writes, so they can go back as they were
export interface Changes {
  // Keeps a file's contents, or that there was none, before the change first writes it
  keep(file: string): Promise<void>
  // Another step that puts something back
  undo(step: () => Promise<unknown>): void
}

const refill = <T>(map: Map<string, T>, from: Iterable<[string, T]>) => {
  map.clear()
  for (const [name, value] of from) map.set(name, value)
}

// Checking and saving content types and shared groups in the site project's folders, as the type editor's routes and
// the assistant's Apply do. One change runs at a time, so two can't interleave their
// files and migrations.
export function typeSaver(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  groups: Map<string, SharedGroup>,
  dirs: EditorDirs,
) {
  const groupsDir = join(dirname(dirs.types), 'groups')

  let last: Promise<unknown> = Promise.resolve()
  // Runs work once every change before it has finished, whether that worked or not
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const run = last.then(work, work)
    last = run.catch(() => {})
    return run
  }

  // Change the files, load them all again and write a migration for the change, then run after, such as Apply's claim
  // on its proposal. A site with no snapshot yet gets one of the types as they were first, so the change still gets its
  // migration. Every file is kept as it was, or as none, before it's first written, so when anything after fails, such
  // as another type's file that doesn't load, the files, the migrations and the loaded types all go back as they were.
  const commit = async (
    change: (changes: Changes) => Promise<void>,
    after?: (migration: { file: string | null; notes: Array<string> }) => Promise<void>,
  ) => {
    const steps: Array<() => Promise<unknown>> = []
    const kept = new Set<string>()
    const changes: Changes = {
      keep: async (file) => {
        if (kept.has(file)) return
        kept.add(file)
        const contents = existsSync(file) ? await readFile(file, 'utf8') : null
        steps.push(() => (contents === null ? rm(file, { force: true }) : writeFile(file, contents)))
      },
      undo: (step) => void steps.push(step),
    }
    const was = { types: [...types], groups: [...groups] }
    try {
      const snapshot = join(dirs.migrations, '.snapshot.json')
      await changes.keep(snapshot)
      if (!existsSync(snapshot)) await makeMigration(dirs.migrations, types)
      await change(changes)
      const loaded = await loadSchema(dirs.types).catch((error: Error) => {
        throw new HTTPException(409, {
          message: `Nothing was changed, since the site's content types or shared groups don't load. ${error.message}`,
        })
      })
      refill(types, loaded.types)
      refill(groups, loaded.groups)
      const listed = await readdir(dirs.migrations)
      changes.undo(async () => {
        for (const file of await readdir(dirs.migrations)) {
          if (!listed.includes(file)) await rm(join(dirs.migrations, file), { force: true })
        }
      })
      const { file, notes } = await makeMigration(dirs.migrations, types)
      const migration = { file: file ?? null, notes }
      await after?.(migration)
      return migration
    } catch (error) {
      for (const step of steps.reverse()) await step().catch((failed) => console.error(failed))
      refill(types, was.types)
      refill(groups, was.groups)
      throw error
    }
  }

  // Write a file of a folder, which the first shared group makes, renaming it when its name changes. A name that only
  // changes case is the same file on a disk that ignores case, so that file is written, then renamed.
  const write = async (dir: string, value: { name: string }, old: { name: string } | undefined, changes: Changes) => {
    const file = join(dir, `${value.name}.json`)
    const was = old && old.name !== value.name ? join(dir, `${old.name}.json`) : undefined
    await mkdir(dir, { recursive: true })
    await changes.keep(file)
    if (was) await changes.keep(was)
    const contents = await formatJson(file, value)
    if (was && sameName(old!.name, value.name)) {
      await writeFile(was, contents)
      await rename(was, file)
      changes.undo(() => rename(file, was))
    } else {
      await writeFile(file, contents)
      if (was) await rm(was)
    }
  }

  // A type's file as it is on disk, which can differ from the type loaded when someone has edited it by hand since
  const fileOf = async (name: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(join(dirs.types, `${name}.json`), 'utf8'))
    } catch {
      return undefined
    }
  }

  // A file in a folder with this name, whatever its case, other than the one being renamed
  const fileNamed = async (dir: string, name: string, old?: string) =>
    (existsSync(dir) ? await readdir(dir) : []).find(
      (file) => sameName(file, `${name}.json`) && !(old && sameName(file, `${old}.json`)),
    )

  // Whether a content migration in the site project hasn't run yet
  const pending = async () => {
    const files = await loadContentMigrations(dirs.migrations)
    const applied = await appliedMigrations(db, files)
    return Object.keys(files).some((name) => !applied.includes(name))
  }

  const countEntries = async (type: string) =>
    Number(
      (
        await db
          .selectFrom('entries')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('type', '=', type)
          .executeTakeFirstOrThrow()
      ).count,
    )

  // A type from its settings and fields, as the type editor sends them, with what's wrong with it as core's report. A
  // new one gets id, or one of its own. Names are one whatever their case, since a disk may ignore it, and a file the
  // types weren't loaded from, such as one a git pull brought, is never written over. A type with entries keeps its
  // structure, since nothing moves entries from one structure to another, and a name with entries left under it, from a
  // type that's gone or a rename that hasn't run, isn't taken, since a type of that name would take them over.
  const check = async (body: any, old?: ContentType, id?: string) => {
    const { type, schema, settings } = typeFrom(body, old, id)
    const report = await validateServerValues(schema, settings, settingsInputs)

    const found: Array<[string, string]> = []
    if (report.isValid) {
      for (const problem of checkType(type, type.name, ids(types, type.id), ids(groups))) {
        found.push([keyOf(problem), problem])
      }
      const named = [...types.values()].find((other) => sameName(other.name, type.name) && other.id !== type.id)
      const renamed = !old || old.name !== type.name
      const file = renamed && !named && (await fileNamed(dirs.types, type.name, old?.name))
      if (named) found.push(['name', `Another content type is named ${named.name}.`])
      else if (file) {
        found.push([
          'name',
          `schema/types already has ${file}, which sorlo dev hasn't loaded. Restart sorlo dev to load it, or choose ` +
            'another name.',
        ])
      } else if (renamed && !(old && sameName(old.name, type.name))) {
        const left = await countEntries(type.name)
        if (left) {
          found.push([
            'name',
            `${left === 1 ? 'An entry' : `${left.toLocaleString('en')} entries`} under the name ${type.name}, ` +
              `archived ones included, ${left === 1 ? 'belongs' : 'belong'} to no content type now, and a type with ` +
              `that name would take ${left === 1 ? 'it' : 'them'} over. Delete ${left === 1 ? 'it' : 'them'} first, ` +
              'or choose another name.',
          ])
        }
      }
      if (old && type.structure !== old.structure) {
        const count = (await pending()) ? undefined : await countEntries(old.name)
        if (count === undefined) {
          found.push([
            'structure',
            "A content migration hasn't run yet, which may still rename entries of this type, so its structure can " +
              'change only once sorlo migrate has run it.',
          ])
        } else if (count) {
          found.push([
            'structure',
            `${old.label} has ${entries(count)}, archived ones included, so it stays ${structures[old.structure]}, ` +
              'since nothing moves entries from one structure to another. Make a new type for the new structure.',
          ])
        }
      }
    }
    return { type, report: problemsOf(schema, report, found) }
  }

  // Checks a type and writes its file, renaming it when its name changes, then loads the types again and writes a
  // migration for the change. The type it changes is found by name in its turn, since a change before it may have
  // renamed or deleted it. With loaded, the type as the editor loaded it, it saves only while the file still holds
  // that, so a save never writes back over a change made since, through the assistant, in another tab or by hand.
  const save = (body: any, name?: string) =>
    queued(async () => {
      const old = name === undefined ? undefined : types.get(name)
      if (name !== undefined && !old) throw new HTTPException(409, { message: gone(name) })
      if (old && body?.loaded !== undefined) {
        const loaded = body.loaded
        const filed = loaded && { ...loaded, fields: collapseUses(Array.isArray(loaded.fields) ? loaded.fields : []) }
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(filed)), await fileOf(old.name))) {
          throw new HTTPException(409, {
            message:
              `${old.label} has changed since it was opened, through the assistant, in another tab or in its file. ` +
              'Reload the page to see the change, then make yours again.',
          })
        }
      }
      const { type, report } = await check(body, old)
      if (report) return { report }
      const migration = await commit((changes) => write(dirs.types, type, old, changes))
      return { data: types.get(type.name)!, migration }
    })

  // A shared group from its settings and fields, with what's wrong with it as core's report
  const checkSharedGroup = async (body: any, old?: SharedGroup) => {
    const settings = pickValues(groupSchema, body ?? {}, inputs)
    const report = await validateServerValues(groupSchema, settings, inputs)
    const group: SharedGroup = {
      id: old?.id ?? createId('grp'),
      name: settings.name,
      label: settings.label,
      fields: Array.isArray(body?.fields) ? body.fields : [],
    }

    const found: Array<[string, string]> = []
    if (report.isValid) {
      const problems = checkGroup(group, group.name, ids(types), ids(groups, group.id))
      for (const problem of problems) found.push([keyOf(problem), problem])
      const named = [...groups.values()].find((other) => sameName(other.name, group.name) && other.id !== group.id)
      const file = (!old || old.name !== group.name) && !named && (await fileNamed(groupsDir, group.name, old?.name))
      if (named) found.push(['name', `Another shared group is named ${named.name}.`])
      else if (file) {
        found.push([
          'name',
          `schema/groups already has ${file}, which sorlo dev hasn't loaded. Restart sorlo dev to load it, or choose ` +
            'another name.',
        ])
      }
      // Only a group that passes can be followed through the groups it uses
      const byId = new Map([...groups.values(), group].map((each) => [each.id, each]))
      const through = problems.length ? undefined : cycleOf(group.id, byId)
      if (through) found.push(['fields', cycleProblem(through)])
    }
    return { group, report: problemsOf(groupSchema, report, found) }
  }

  // Checks a shared group and writes its file, as save does a type's. Types see the change as a change to their own
  // fields, so the migration covers every type and path that uses it.
  const saveGroup = (body: unknown, name?: string) =>
    queued(async () => {
      const old = name === undefined ? undefined : groups.get(name)
      if (name !== undefined && !old) throw new HTTPException(409, { message: gone(name) })
      const { group, report } = await checkSharedGroup(body, old)
      if (report) return { report }
      const migration = await commit((changes) => write(groupsDir, group, old, changes))
      return { data: groups.get(group.name)!, migration }
    })

  // Deletes a type's or a shared group's file in its turn, after guard, writing a migration for what that changes
  const remove = <T extends ContentType | SharedGroup>(
    kind: 'types' | 'groups',
    name: string,
    guard: (found: T) => void,
  ) =>
    queued(async () => {
      const found = (kind === 'types' ? types : groups).get(name) as T | undefined
      if (!found) throw new HTTPException(409, { message: gone(name) })
      guard(found)
      const file = join(kind === 'types' ? dirs.types : groupsDir, `${found.name}.json`)
      return commit(async (changes) => {
        await changes.keep(file)
        await rm(file)
      })
    })

  // Writes a type's file, as save does once it has checked it
  const writeType = (type: ContentType, old: ContentType | undefined, changes: Changes) =>
    write(dirs.types, type, old, changes)

  return { types, groups, queued, commit, writeType, fileOf, check, save, saveGroup, remove }
}

// What a change to one type needs of a content migration, as make:migration would write it for that change alone:
// nothing, or its flags and TODOs, with no file yet. The types are as their files have them, and shared groups
// they use must exist.
export function migrationFor(before: ContentType, after: ContentType, groups: Map<string, SharedGroup>) {
  const byId = new Map([...groups.values()].map((group) => [group.id, group]))
  const expand = (type: ContentType) => ({ ...type, fields: expandFields(type.fields, byId) })
  const { changes } = diffTypes({ [before.name]: expand(before) }, new Map([[after.name, expand(after)]]))
  return changes.length ? { file: null, notes: changes.flatMap((change) => change.note ?? []) } : null
}

export type TypeSaver = ReturnType<typeof typeSaver>

// The admin API for content types and shared groups. Given the type editor's saves, as sorlo dev gives them, it can
// also create, change and delete them, writing their files and a content migration for each change. Without them,
// they're read-only and change through git.
export function typeRoutes(
  types: Map<string, ContentType>,
  groups = new Map<string, SharedGroup>(),
  saver?: TypeSaver,
  // Whether /mcp, with whether tokens can publish, and the assistant are on, and whether the site emails invites and
  // reset links, which the admin reads here with editable, since the shell waits for this reply
  { mcp = false, ai = false, mail = false }: { mcp?: false | { publish: boolean }; ai?: boolean; mail?: boolean } = {},
) {
  const app = new Hono<AdminEnv>()

  app.get('/types', (c) =>
    c.json({ data: [...types.values()], groups: [...groups.values()], editable: !!saver, mcp, ai, mail }),
  )

  const editable =
    (what: string): MiddlewareHandler<AdminEnv> =>
    async (_c, next) => {
      if (!saver)
        throw new HTTPException(403, { message: `${what} can only be changed in development, with sorlo dev.` })
      await next()
    }

  const named = <T>(map: Map<string, T>, name: string) => {
    if (!map.has(name)) throw new HTTPException(404)
    return name
  }

  // Create or replace a type from its settings and fields, renaming its file when its name changes
  const save = async (c: Context<AdminEnv>, name?: string) => {
    const saved = await saver!.save(await c.req.json().catch(() => ({})), name)
    if (saved.report) return c.json(saved.report, 422)
    return c.json({ data: saved.data, migration: saved.migration }, name ? 200 : 201)
  }

  app.post('/types', editable('Content types'), (c) => save(c))
  app.put('/types/:type', editable('Content types'), (c) => save(c, named(types, c.req.param('type'))))

  // The type's entries stay, and the migration flags them. Shared groups no type uses yet can link to it too.
  app.delete('/types/:type', editable('Content types'), async (c) => {
    const name = named(types, c.req.param('type'))
    const migration = await saver!.remove<ContentType>('types', name, (type) => {
      const links = (fields: Array<FieldSchema>) =>
        someField(fields, (field) => field.type === 'relationship' && field.options?.types?.includes(type.id))
      const linking = [
        ...[...types.values()]
          .filter((other) => other.id !== type.id && links(other.fields))
          .map((other) => other.label),
        ...[...groups.values()]
          .filter((group) => links(group.fields))
          .map((group) => `the shared group ${group.label}`),
      ]
      if (linking.length) {
        throw new HTTPException(409, {
          message: `Relationship fields in ${linking.join(', ')} link to ${type.label}. Take it out of them first.`,
        })
      }
    })
    return c.json({ migration })
  })

  // Create or replace a shared group from its settings and fields, renaming its file when its name changes
  const saveGroup = async (c: Context<AdminEnv>, name?: string) => {
    const saved = await saver!.saveGroup(await c.req.json().catch(() => ({})), name)
    if (saved.report) return c.json(saved.report, 422)
    return c.json({ data: saved.data, migration: saved.migration }, name ? 200 : 201)
  }

  app.post('/groups', editable('Shared groups'), (c) => saveGroup(c))
  app.put('/groups/:group', editable('Shared groups'), (c) => saveGroup(c, named(groups, c.req.param('group'))))

  app.delete('/groups/:group', editable('Shared groups'), async (c) => {
    const name = named(groups, c.req.param('group'))
    const migration = await saver!.remove<SharedGroup>('groups', name, (group) => {
      const using = [
        ...[...types.values()]
          .filter((type) => someField(type.fields, (field) => isUse(field) && field.options!.group === group.id))
          .map((type) => type.label),
        ...[...groups.values()]
          .filter((other) => usesOf(other.fields).includes(group.id))
          .map((other) => `the shared group ${other.label}`),
      ]
      if (using.length) {
        throw new HTTPException(409, {
          message: `${using.join(', ')} ${using.length > 1 ? 'use' : 'uses'} ${group.label}. Take it out of them first.`,
        })
      }
    })
    return c.json({ migration })
  })

  return app
}
