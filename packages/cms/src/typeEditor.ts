import { inputs, pickValues, validateServerValues } from './core'
import type { AdminEnv } from './entries'
import { isUse, someField, usesOf } from './fields'
import { makeMigration } from './makeMigration'
import { groupSchema, typeSchema } from './schemas'
import { ContentType, SharedGroup, checkGroup, checkType, cycleOf, cycleProblem, loadSchema } from './types'
import { Context, Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { FieldSchema } from 'iight'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Where the type editor writes: the site project's schema/types and migrations folders. Shared groups go in the
// groups folder beside schema/types.
export interface EditorDirs {
  types: string
  migrations: string
}

// The settings' icon is text here, and a picker in the admin
const settingsInputs = { ...inputs, icon: inputs.text }

// A new type's or shared group's id, in the form core gives fields, such as typ_k3x9q2mz
const createId = (prefix: string) =>
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

// A 422 reply with core's report, and each of checkType's or checkGroup's problems under the setting it starts with,
// or under fields for the rest
function problemsReply(
  c: Context<AdminEnv>,
  schema: Array<FieldSchema>,
  report: { isValid: boolean; fields: Record<string, unknown> },
  found: Array<[key: string, message: string]>,
) {
  const problems: Record<string, Array<string>> = {}
  for (const [key, message] of found) {
    const at = schema.some((field) => field.name === key) ? key : 'fields'
    problems[at] = [...(problems[at] ?? []), message]
  }
  if (report.isValid && !found.length) return undefined
  const fieldReports = Object.entries(problems).map(([key, messages]) => [key, { isValid: false, messages }])
  return c.json({ isValid: false, fields: { ...report.fields, ...Object.fromEntries(fieldReports) } }, 422)
}

// The setting a problem starts with, such as name in '"name" must match the file's name'
const keyOf = (problem: string) => problem.match(/^(?:It needs an? )?"(\w+)"/)?.[1] ?? 'fields'

// The admin API for content types and shared groups. Given the site project's folders, as iight dev gives them, the
// type editor can also create, change and delete them, writing their files and a content migration for each change
// (PLAN.md sections 4 and 19). Without them, they're read-only and change through git.
export function typeRoutes(
  types: Map<string, ContentType>,
  groups = new Map<string, SharedGroup>(),
  dirs?: EditorDirs,
) {
  const app = new Hono<AdminEnv>()
  const groupsDir = dirs && join(dirname(dirs.types), 'groups')

  app.get('/types', (c) => c.json({ data: [...types.values()], groups: [...groups.values()], editable: !!dirs }))

  const editable =
    (what: string): MiddlewareHandler<AdminEnv> =>
    async (_c, next) => {
      if (!dirs)
        throw new HTTPException(403, { message: `${what} can only be changed in development, with iight dev.` })
      await next()
    }

  const named = <T>(map: Map<string, T>, name: string) => {
    const found = map.get(name)
    if (!found) throw new HTTPException(404)
    return found
  }

  // The ids of every type or every shared group, and of the one being saved
  const ids = (map: Map<string, { id: string }>, saving?: string) =>
    new Set([...[...map.values()].map((value) => value.id), ...(saving ? [saving] : [])])

  // Change the files, load them all again, and write a migration for the change
  const commit = async (change: () => Promise<void>) => {
    await change()
    const loaded = await loadSchema(dirs!.types)
    types.clear()
    for (const [name, type] of loaded.types) types.set(name, type)
    groups.clear()
    for (const [name, group] of loaded.groups) groups.set(name, group)
    const { file, notes } = await makeMigration(dirs!.migrations, types)
    return { file: file ?? null, notes }
  }

  // Write a file of a folder, which the first shared group makes, renaming it when its name changes
  const write = async (dir: string, value: { name: string }, old?: { name: string }) => {
    const file = join(dir, `${value.name}.json`)
    await mkdir(dir, { recursive: true })
    await writeFile(file, await formatJson(file, value))
    if (old && old.name !== value.name) await rm(join(dir, `${old.name}.json`))
  }

  // Create or replace a type from its settings and fields, renaming its file when its name changes
  const save = async (c: Context<AdminEnv>, old?: ContentType) => {
    const body = await c.req.json().catch(() => ({}))
    const fields = Array.isArray(body?.fields) ? body.fields : []
    const schema = typeSchema(fields)
    const settings = pickValues(schema, body ?? {}, settingsInputs)
    const report = await validateServerValues(schema, settings, settingsInputs)

    // In the order the type files have them, leaving out empty settings
    const type: ContentType = JSON.parse(
      JSON.stringify({
        id: old?.id ?? createId('typ'),
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

    const found: Array<[string, string]> = []
    if (report.isValid) {
      for (const problem of checkType(type, type.name, ids(types, type.id), ids(groups))) {
        found.push([keyOf(problem), problem])
      }
      if ([...types.values()].some((other) => other.name === type.name && other.id !== type.id)) {
        found.push(['name', `Another content type is named ${type.name}.`])
      }
    }
    const invalid = problemsReply(c, schema, report, found)
    if (invalid) return invalid

    const migration = await commit(() => write(dirs!.types, type, old))
    return c.json({ data: types.get(type.name), migration }, old ? 200 : 201)
  }

  app.post('/types', editable('Content types'), (c) => save(c))
  app.put('/types/:type', editable('Content types'), (c) => save(c, named(types, c.req.param('type'))))

  // The type's entries stay, and the migration flags them. Shared groups no type uses yet can link to it too.
  app.delete('/types/:type', editable('Content types'), async (c) => {
    const type = named(types, c.req.param('type'))
    const links = (fields: Array<FieldSchema>) =>
      someField(fields, (field) => field.type === 'relationship' && field.options?.types?.includes(type.id))
    const linking = [
      ...[...types.values()].filter((other) => other.id !== type.id && links(other.fields)).map((other) => other.label),
      ...[...groups.values()].filter((group) => links(group.fields)).map((group) => `the shared group ${group.label}`),
    ]
    if (linking.length) {
      throw new HTTPException(409, {
        message: `Relationship fields in ${linking.join(', ')} link to ${type.label}. Take it out of them first.`,
      })
    }
    return c.json({ migration: await commit(() => rm(join(dirs!.types, `${type.name}.json`))) })
  })

  // Create or replace a shared group from its settings and fields, renaming its file when its name changes. Types see
  // the change as a change to their own fields, so the migration covers every type and path that uses it.
  const saveGroup = async (c: Context<AdminEnv>, old?: SharedGroup) => {
    const body = await c.req.json().catch(() => ({}))
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
      if ([...groups.values()].some((other) => other.name === group.name && other.id !== group.id)) {
        found.push(['name', `Another shared group is named ${group.name}.`])
      }
      // Only a group that passes can be followed through the groups it uses
      const byId = new Map([...groups.values(), group].map((each) => [each.id, each]))
      const through = problems.length ? undefined : cycleOf(group.id, byId)
      if (through) found.push(['fields', cycleProblem(through)])
    }
    const invalid = problemsReply(c, groupSchema, report, found)
    if (invalid) return invalid

    const migration = await commit(() => write(groupsDir!, group, old))
    return c.json({ data: groups.get(group.name), migration }, old ? 200 : 201)
  }

  app.post('/groups', editable('Shared groups'), (c) => saveGroup(c))
  app.put('/groups/:group', editable('Shared groups'), (c) => saveGroup(c, named(groups, c.req.param('group'))))

  app.delete('/groups/:group', editable('Shared groups'), async (c) => {
    const group = named(groups, c.req.param('group'))
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
    return c.json({ migration: await commit(() => rm(join(groupsDir!, `${group.name}.json`))) })
  })

  return app
}
