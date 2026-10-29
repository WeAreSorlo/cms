import { inputs } from './core'
import { cmsInputs } from './relations'
import type { FieldSchema, Input } from 'iight'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

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
const structures = ['collection', 'hierarchical', 'singleton']

const isText = (value: unknown) => typeof value === 'string' && value.trim() !== ''

// The rule core's schema builder gives field names: a letter, then letters, digits or underscores
const isName = (name: unknown) =>
  inputs.identifier.validateValue(name, { name: 'name', required: true, options: { format: 'mixed' } }).isValid === true

// Check a list of fields or flexible layouts and everything inside them. Each needs a name that's unique beside it,
// an ID that's unique in the type, so content migrations can match it after a rename (PLAN.md section 6), and a type
// from known. Relationship fields name content types by ID, checked against typeIds when it's given.
function checkNodes(
  nodes: unknown,
  kind: 'field' | 'layout',
  path: string,
  ids: Set<unknown>,
  problems: Array<string>,
  known: Record<string, Input>,
  typeIds?: Set<unknown>,
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
    ids.add(node?.id)

    if (kind === 'layout') {
      checkNodes(node?.fields ?? [], 'field', at, ids, problems, known, typeIds)
      continue
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
    if (node?.options?.fields !== undefined) checkNodes(node.options.fields, 'field', at, ids, problems, known, typeIds)
    if (node?.options?.layouts !== undefined) {
      checkNodes(node.options.layouts, 'layout', at, ids, problems, known, typeIds)
    }
  }
}

// What's wrong with a form's fields, which take core's inputs
export function checkFormFields(fields: unknown) {
  const problems: Array<string> = []
  checkNodes(fields, 'field', '', new Set(), problems, inputs)
  return problems
}

// What's wrong with a content type, given the name of its file and, to check what relationship fields link to, the ids
// of every content type
export function checkType(type: any, file: string, typeIds?: Set<unknown>) {
  if (typeof type !== 'object' || type === null || Array.isArray(type)) return ['It must hold a JSON object.']

  const problems = Object.keys(type)
    .filter((key) => !keys.includes(key))
    .map((key) => `"${key}" isn't a content type setting.`)

  if (!isText(type.id)) problems.push('It needs an "id", such as typ_k3x9q2mz.')
  if (!isName(type.name)) problems.push('"name" must be a letter, then letters, digits or underscores.')
  else if (type.name !== file) problems.push(`"name" must match the file's name, ${file}.`)
  if (!isText(type.label)) problems.push('It needs a "label".')
  for (const key of ['singular', 'icon']) {
    if (type[key] !== undefined && !isText(type[key])) problems.push(`"${key}" must be text.`)
  }
  if (!structures.includes(type.structure)) problems.push('"structure" must be collection, hierarchical or singleton.')
  if (type.drafts !== undefined && typeof type.drafts !== 'boolean') problems.push('"drafts" must be true or false.')

  checkNodes(type.fields, 'field', '', new Set(), problems, cmsInputs, typeIds)

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

// Load and check every content type in a folder, throwing one error that lists all their problems
export async function loadTypes(dir: string) {
  const types = new Map<string, ContentType>()
  const problems: Array<string> = []
  const files = existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith('.json')).sort() : []

  // Read them all first, since relationship fields link to the others
  const read = new Map<string, any>()
  for (const file of files) {
    try {
      read.set(file, JSON.parse(await readFile(join(dir, file), 'utf8')))
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`)
    }
  }

  const typeIds = new Set([...read.values()].map((type) => type?.id))
  const ids = new Map<string, string>()
  for (const [file, type] of read) {
    const found = checkType(type, basename(file, '.json'), typeIds)
    if (ids.has(type?.id)) found.push(`Its id, ${type.id}, is also used by ${ids.get(type.id)}.`)
    problems.push(...found.map((problem) => `${file}: ${problem}`))
    if (isText(type?.id)) ids.set(type.id, file)
    types.set(type?.name, type)
  }

  if (problems.length) throw new Error([`The content types in ${dir} have problems:`, ...problems].join('\n  '))
  return types
}
