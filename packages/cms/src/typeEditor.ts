import { inputs, pickValues, validateServerValues } from './core'
import type { AdminEnv } from './entries'
import { someField } from './fields'
import { makeMigration } from './makeMigration'
import { typeSchema } from './schemas'
import { ContentType, checkType, loadTypes } from './types'
import { Context, Hono, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Where the type editor writes: the site project's schema/types and migrations folders
export interface EditorDirs {
  types: string
  migrations: string
}

// A new type's id, in the form core gives fields, such as typ_k3x9q2mz
const createTypeId = () => `typ_${Array.from(randomBytes(8), (byte) => (byte % 36).toString(36)).join('')}`

// The project's own Prettier lays the file out when it has one, as it would lay out a file written by hand
async function formatJson(file: string, value: unknown) {
  try {
    const prettier = await import('prettier')
    return await prettier.format(JSON.stringify(value), { ...(await prettier.resolveConfig(file)), filepath: file })
  } catch {
    return `${JSON.stringify(value, null, 2)}\n`
  }
}

// The admin API for content types. Given the site project's folders, as iight dev gives them, the type editor can
// also create, change and delete types, writing their files and a content migration for each change (PLAN.md section
// 4). Without them, types are read-only and change through git.
export function typeRoutes(types: Map<string, ContentType>, dirs?: EditorDirs) {
  const app = new Hono<AdminEnv>()

  app.get('/types', (c) => c.json({ data: [...types.values()], editable: dirs !== undefined }))

  const editable: MiddlewareHandler<AdminEnv> = async (_c, next) => {
    if (!dirs)
      throw new HTTPException(403, { message: 'Content types can only be changed in development, with iight dev.' })
    await next()
  }

  const named = (name: string) => {
    const type = types.get(name)
    if (!type) throw new HTTPException(404)
    return type
  }

  // Change the type files, load them all again, and write a migration for the change
  const commit = async (change: () => Promise<void>) => {
    await change()
    const loaded = await loadTypes(dirs!.types)
    types.clear()
    for (const [name, type] of loaded) types.set(name, type)
    const { file, notes } = await makeMigration(dirs!.migrations, types)
    return { file: file ?? null, notes }
  }

  // Create or replace a type from its settings and fields, renaming its file when its name changes
  const save = async (c: Context<AdminEnv>, old?: ContentType) => {
    const body = await c.req.json().catch(() => ({}))
    const fields = Array.isArray(body?.fields) ? body.fields : []
    const schema = typeSchema(fields)
    const settings = pickValues(schema, body ?? {}, inputs)
    const report = await validateServerValues(schema, settings, inputs)

    // In the order the type files have them, leaving out empty settings
    const type: ContentType = JSON.parse(
      JSON.stringify({
        id: old?.id ?? createTypeId(),
        name: settings.name,
        label: settings.label,
        singular: settings.singular || undefined,
        structure: settings.structure,
        icon: settings.icon || undefined,
        titleField: settings.titleField || undefined,
        slugField: settings.slugField || undefined,
        listColumns: settings.listColumns?.length ? settings.listColumns : undefined,
        fields,
      }),
    )

    // Each of checkType's problems goes under the setting it starts with, and the rest under fields
    const problems: Record<string, Array<string>> = {}
    const add = (key: string, message: string) => (problems[key] = [...(problems[key] ?? []), message])
    if (report.isValid) {
      const typeIds = new Set([...[...types.values()].map((other) => other.id), type.id])
      for (const problem of checkType(type, type.name, typeIds)) {
        const key = problem.match(/^(?:It needs an? )?"(\w+)"/)?.[1]
        add(key && schema.some((field) => field.name === key) ? key : 'fields', problem)
      }
      if ([...types.values()].some((other) => other.name === type.name && other.id !== type.id)) {
        add('name', `Another content type is named ${type.name}.`)
      }
    }
    if (!report.isValid || Object.keys(problems).length) {
      const fieldReports = Object.entries(problems).map(([key, messages]) => [key, { isValid: false, messages }])
      return c.json({ isValid: false, fields: { ...report.fields, ...Object.fromEntries(fieldReports) } }, 422)
    }

    const migration = await commit(async () => {
      const file = join(dirs!.types, `${type.name}.json`)
      await writeFile(file, await formatJson(file, type))
      if (old && old.name !== type.name) await rm(join(dirs!.types, `${old.name}.json`))
    })
    return c.json({ data: types.get(type.name), migration }, old ? 200 : 201)
  }

  app.post('/types', editable, (c) => save(c))
  app.put('/types/:type', editable, (c) => save(c, named(c.req.param('type'))))

  // The type's entries stay, and the migration flags them
  app.delete('/types/:type', editable, async (c) => {
    const type = named(c.req.param('type'))
    const linking = [...types.values()].filter(
      (other) =>
        other.id !== type.id &&
        someField(other.fields, (field) => field.type === 'relationship' && field.options?.types?.includes(type.id)),
    )
    if (linking.length) {
      const labels = linking.map((other) => other.label).join(', ')
      throw new HTTPException(409, {
        message: `Relationship fields in ${labels} link to ${type.label}. Take it out of them first.`,
      })
    }
    return c.json({ migration: await commit(() => rm(join(dirs!.types, `${type.name}.json`))) })
  })

  return app
}
