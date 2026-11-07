import { inputs } from './core'
import { expandFields, usesOf } from './fields'
import { cmsInputs } from './relations'
import type { FieldSchema, Input } from '@sorlo/core'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export { expandFields }

// A content type, read from a JSON file in the site project's schema/types folder (PLAN.md section 4)
export interface ContentType {
  id: string
  name: string
  label: string
  singular?: string
  structure: 'collection' | 'hierarchical' | 'singleton'
  // Whether entries are saved as drafts and published when they're ready, true if not given. Without drafts, every save
  // publishes (PLAN.md section 17).
  drafts?: boolean
  icon?: string
  titleField?: string
  slugField?: string
  listColumns?: Array<string>
  fields: Array<FieldSchema>
}

// Fields defined once and used by many types, read from a JSON file in the site project's schema/groups folder. Types
// use one through a Shared group field that names it by id (PLAN.md section 19).
export interface SharedGroup {
  id: string
  name: string
  label: string
  fields: Array<FieldSchema>
}

const keys = [
  'id',
  'name',
  'label',
  'singular',
  'structure',
  'drafts',
  'icon',
  'titleField',
  'slugField',
  'listColumns',
  'fields',
]
const groupKeys = ['id', 'name', 'label', 'fields']
const structures = ['collection', 'hierarchical', 'singleton']

const isText = (value: unknown) => typeof value === 'string' && value.trim() !== ''

// The rule core's schema builder gives field names: a letter, then letters, digits or underscores
const isName = (name: unknown) =>
  inputs.identifier.validateValue(name, { name: 'name', required: true, options: { format: 'mixed' } }).isValid === true

// Check a list of fields or flexible layouts and everything inside them. Each needs a name that's unique beside it,
// an ID that's unique in the type, so content migrations can match it after a rename (PLAN.md section 6), and a type
// from known. Relationship fields name content types by ID, checked against typeIds when it's given. Shared group
// fields name shared groups by ID, checked against groupIds when it's given, as it is for types and shared groups.
function checkNodes(
  nodes: unknown,
  kind: 'field' | 'layout',
  path: string,
  ids: Set<unknown>,
  problems: Array<string>,
  known: Record<string, Input>,
  typeIds?: Set<unknown>,
  groupIds?: Set<unknown>,
) {
  if (!Array.isArray(nodes)) {
    problems.push(path ? `"${path}" must list its ${kind}s.` : '"fields" must be a list.')
    return
  }

  const names = new Set<unknown>()
  for (const node of nodes) {
    const at = path ? `${path}.${node?.name}` : String(node?.name)
    const label = `${kind === 'field' ? 'Field' : 'Layout'} "${at}"`

    if (!isName(node?.name))
      problems.push(`${label} needs a name made of a letter, then letters, digits or underscores.`)
    else if (names.has(node.name)) problems.push(`${label} is defined twice.`)
    names.add(node?.name)

    if (!isText(node?.id))
      problems.push(`${label} needs an "id", such as ${kind === 'field' ? 'fld' : 'lay'}_k3x9q2mz.`)
    else if (ids.has(node.id)) problems.push(`${label} has the same id as another, ${node.id}.`)
    // A use's fields get its id, a dot and theirs, which mustn't match another's
    else if (groupIds && node.id.includes('.')) problems.push(`${label} has a dot in its id, ${node.id}.`)
    ids.add(node?.id)

    if (kind === 'layout') {
      checkNodes(node?.fields ?? [], 'field', at, ids, problems, known, typeIds, groupIds)
      continue
    }

    if (groupIds && node?.type === 'shared') {
      if (!groupIds.has(node.options?.group)) {
        problems.push(`${label} must name a shared group by its id in "options.group".`)
      }
      if (node.options?.fields !== undefined || node.options?.layouts !== undefined) {
        problems.push(`${label} takes its fields from its shared group, so it can't have its own.`)
      }
      continue
    }
    if (groupIds && node?.options?.group !== undefined) {
      problems.push(`${label} can't name a shared group in "options.group", as only a Shared group field can.`)
    }

    if (!Object.hasOwn(known, node?.type)) problems.push(`${label} has an unknown type, ${node?.type}.`)
    else if (node.defaultValue !== undefined) {
      // Checked as optional, so an empty default, or false on a box that must be ticked, isn't a problem
      const validation = known[node.type].validateValue?.(node.defaultValue, { ...node, required: false })
      if (validation?.isValid === false) {
        problems.push([`${label} has an invalid default value.`, ...validation.messages].join(' '))
      }
    }
    const linked = node?.options?.types ?? []
    if (typeIds && node?.type === 'relationship' && !(Array.isArray(linked) && linked.every((id) => typeIds.has(id)))) {
      problems.push(`${label} must list the ids of content types in "options.types".`)
    }
    if (node?.options?.fields !== undefined) {
      checkNodes(node.options.fields, 'field', at, ids, problems, known, typeIds, groupIds)
    }
    if (node?.options?.layouts !== undefined) {
      checkNodes(node.options.layouts, 'layout', at, ids, problems, known, typeIds, groupIds)
    }
  }
}

// What's wrong with the settings that types and shared groups both have: an id, a name matching the file's, a label,
// and no keys but theirs
function checkSettings(value: any, file: string, allowed: Array<string>, kind: string, prefix: string) {
  const problems = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `"${key}" isn't a ${kind} setting.`)

  if (!isText(value.id)) problems.push(`It needs an "id", such as ${prefix}_k3x9q2mz.`)
  if (!isName(value.name)) problems.push('"name" must be a letter, then letters, digits or underscores.')
  else if (value.name !== file) problems.push(`"name" must match the file's name, ${file}.`)
  if (!isText(value.label)) problems.push('It needs a "label".')
  return problems
}

// What's wrong with a form's fields, which take core's inputs
export function checkFormFields(fields: unknown) {
  const problems: Array<string> = []
  checkNodes(fields, 'field', '', new Set(), problems, inputs)
  return problems
}

const isObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)

// What's wrong with a content type, given the name of its file and, to check what relationship and Shared group fields
// name, the ids of every content type and shared group
export function checkType(type: any, file: string, typeIds?: Set<unknown>, groupIds?: Set<unknown>) {
  if (!isObject(type)) return ['It must hold a JSON object.']

  const problems = checkSettings(type, file, keys, 'content type', 'typ')
  for (const key of ['singular', 'icon']) {
    if (type[key] !== undefined && !isText(type[key])) problems.push(`"${key}" must be text.`)
  }
  if (!structures.includes(type.structure)) problems.push('"structure" must be collection, hierarchical or singleton.')
  if (type.drafts !== undefined && typeof type.drafts !== 'boolean') problems.push('"drafts" must be true or false.')

  checkNodes(type.fields, 'field', '', new Set(), problems, cmsInputs, typeIds, groupIds)

  const fields: Array<any> = Array.isArray(type.fields) ? type.fields : []
  const topLevel = (name: unknown) => fields.find((field) => field?.name === name)
  if (type.titleField !== undefined && !topLevel(type.titleField)) {
    problems.push('"titleField" must name a top-level field.')
  }
  if (type.slugField !== undefined && topLevel(type.slugField)?.type !== 'identifier') {
    problems.push('"slugField" must name a top-level identifier field.')
  }
  if (type.listColumns !== undefined && !(Array.isArray(type.listColumns) && type.listColumns.every(topLevel))) {
    problems.push('"listColumns" must list top-level fields.')
  }

  return problems
}

// What's wrong with a shared group, given the name of its file and the ids of every content type and shared group
export function checkGroup(group: any, file: string, typeIds: Set<unknown>, groupIds: Set<unknown>) {
  if (!isObject(group)) return ['It must hold a JSON object.']

  const problems = checkSettings(group, file, groupKeys, 'shared group', 'grp')
  checkNodes(group.fields, 'field', '', new Set(), problems, cmsInputs, typeIds, groupIds)
  return problems
}

// The names of the shared groups through which one uses itself, none when it does so directly, or undefined when it
// doesn't. Groups are by id, and each must have passed checkGroup.
export function cycleOf(id: string, groups: Map<string, SharedGroup>) {
  const seen = new Set<string>()
  const visit = (from: string, through: Array<string>): Array<string> | undefined => {
    for (const used of usesOf(groups.get(from)?.fields ?? [])) {
      if (used === id) return through
      if (seen.has(used) || !groups.has(used)) continue
      seen.add(used)
      const found = visit(used, [...through, groups.get(used)!.name])
      if (found) return found
    }
  }
  return visit(id, [])
}

export const cycleProblem = (through: Array<string>) =>
  `It uses itself${through.length ? `, through ${through.join(' then ')}` : ''}.`

// Every JSON file in a folder by its name, and the problems of those that can't be read
async function readFolder(dir: string, problems: Array<string>) {
  const read = new Map<string, any>()
  const files = existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith('.json')).sort() : []
  for (const file of files) {
    try {
      read.set(file, JSON.parse(await readFile(join(dir, file), 'utf8')))
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`)
    }
  }
  return read
}

// Check each file with check, and that no two share an id, adding their problems to the list
function checkFolder(read: Map<string, any>, problems: Array<string>, check: (value: any, file: string) => string[]) {
  const ids = new Map<string, string>()
  for (const [file, value] of read) {
    const found = check(value, basename(file, '.json'))
    if (ids.has(value?.id)) found.push(`Its id, ${value.id}, is also used by ${ids.get(value.id)}.`)
    problems.push(...found.map((problem) => `${file}: ${problem}`))
    if (isText(value?.id)) ids.set(value.id, file)
  }
}

// Load and check every content type in a folder and every shared group in the groups folder beside it, throwing one
// error that lists all their problems. Types come back by name with their uses of shared groups expanded, and shared
// groups by name as their files have them.
export async function loadSchema(dir: string) {
  const groupsDir = join(dirname(dir), 'groups')
  const problems: Array<string> = []
  const groupProblems: Array<string> = []

  // Read them all first, since relationship fields link to types, and types and groups use groups
  const readTypes = await readFolder(dir, problems)
  const readGroups = await readFolder(groupsDir, groupProblems)
  const typeIds = new Set([...readTypes.values()].map((type) => type?.id))
  const groupIds = new Set([...readGroups.values()].map((group) => group?.id))

  checkFolder(readTypes, problems, (type, file) => checkType(type, file, typeIds, groupIds))
  checkFolder(readGroups, groupProblems, (group, file) => checkGroup(group, file, typeIds, groupIds))
  const byId = new Map<string, SharedGroup>([...readGroups.values()].map((group) => [group?.id, group]))
  if (!groupProblems.length) {
    for (const [file, group] of readGroups) {
      const through = cycleOf(group.id, byId)
      if (through) groupProblems.push(`${file}: ${cycleProblem(through)}`)
    }
  }

  if (problems.length || groupProblems.length) {
    const lists = [
      [`The content types in ${dir} have problems:`, ...problems],
      [`The shared groups in ${groupsDir} have problems:`, ...groupProblems],
    ]
    throw new Error(
      lists
        .filter((list) => list.length > 1)
        .map((list) => list.join('\n  '))
        .join('\n'),
    )
  }

  const types = new Map<string, ContentType>(
    [...readTypes.values()].map((type) => [type.name, { ...type, fields: expandFields(type.fields, byId) }]),
  )
  const groups = new Map<string, SharedGroup>([...readGroups.values()].map((group) => [group.name, group]))
  return { types, groups }
}

// The content types in a folder, as loadSchema loads them
export const loadTypes = async (dir: string) => (await loadSchema(dir)).types
