import { idsOf } from '../src/fields'
import { FieldSchema, isEmptyValue, normaliseConditions } from '@sorlo/core'

// What changed between two versions of an entry (PLAN.md section 20), from their values and the type's fields

export type Kind = 'added' | 'removed' | 'changed'

// A field whose value changed, named by its labels from the top, such as SEO › Title
export interface Change {
  labels: Array<string>
  field: FieldSchema
  kind: Kind
  before: unknown
  after: unknown
  // A repeater's items, a flexible field's blocks or a matrix's cells that changed, matched by position
  items?: Array<ItemChange>
}

// An item with the changes inside it: all of its fields when it's added or removed
export interface ItemChange {
  label: string
  kind: Kind
  changes: Array<Change>
}

// Whether two JSON values are the same, whatever order their keys are in, since Postgres reorders them
export const same = (a: any, b: any): boolean =>
  a === b ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    Array.isArray(a) === Array.isArray(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => same(a[key], b[key])))

const label = (field: { name: string; label?: string }) => field.label || field.name

// A list field's items as they're matched: by index, or for a matrix, by row and column
function itemsOf(field: FieldSchema, value: unknown) {
  const list = Array.isArray(value) ? value : []
  if (field.type === 'matrix') {
    return list.flatMap((row, r) =>
      (Array.isArray(row) ? row : []).map((cell, c) => ({
        key: `${r},${c}`,
        label: `Row ${r + 1}, column ${c + 1}`,
        fields: field.options?.fields ?? [],
        values: cell,
      })),
    )
  }
  return list.map((item, index) => {
    if (field.type !== 'flexible') {
      return { key: `${index}`, label: `Item ${index + 1}`, fields: field.options?.fields ?? [], values: item }
    }
    const layout = (field.options?.layouts ?? []).find((layout: { name: string }) => layout.name === item?._layout)
    return {
      // A block that swaps its layout is another block, so it's removed and added
      key: `${index} ${item?._layout}`,
      label: `Block ${index + 1}: ${layout ? label(layout) : item?._layout}`,
      fields: layout?.fields ?? [],
      values: item,
    }
  })
}

const lists = new Set(['repeater', 'flexible', 'matrix'])

// The items of a list field that were added, removed or changed, in order
function compareItems(field: FieldSchema, before: unknown, after: unknown): Array<ItemChange> {
  const old = new Map(itemsOf(field, before).map((item) => [item.key, item]))
  const now = new Map(itemsOf(field, after).map((item) => [item.key, item]))
  const keys = [...new Set([...old.keys(), ...now.keys()])].sort((a, b) => {
    const [x, y] = [a, b].map((key) => key.split(/[, ]/).map(Number))
    return x[0] - y[0] || (x[1] || 0) - (y[1] || 0) || (old.has(a) ? -1 : 1)
  })

  return keys.flatMap((key): Array<ItemChange> => {
    const [was, is] = [old.get(key), now.get(key)]
    if (was && is) {
      const changes = compare(was.fields, was.values, is.values)
      return changes.length ? [{ label: is.label, kind: 'changed', changes }] : []
    }
    const item = (was ?? is)!
    const kind = was ? 'removed' : 'added'
    return [
      {
        label: item.label,
        kind,
        changes: was ? compare(item.fields, item.values, {}) : compare(item.fields, {}, item.values),
      },
    ]
  })
}

// A page's parent, compared as a link, so its parents' titles load as other links' do
export const parentField: FieldSchema = {
  name: 'parentId',
  label: 'Parent',
  type: 'relationship',
  options: { maximum: 1 },
}

// A page's move between two versions, where a null parent is the top level. With no version before, a parent is added.
export const compareParent = (before: string | null | undefined, after: string | null): Array<Change> =>
  before === after || (before === undefined && after === null)
    ? []
    : [{ labels: ['Parent'], field: parentField, kind: before === undefined ? 'added' : 'changed', before, after }]

// The fields whose values differ between two versions, at any depth: a group's fields by their path of labels, and a
// list's items by position. With no version before, as for a first version, every field with a value is added.
export function compare(
  fields: Array<FieldSchema>,
  before: any,
  after: any,
  labels: Array<string> = [],
): Array<Change> {
  return fields.flatMap((field): Array<Change> => {
    const at = [...labels, label(field)]
    const [was, is] = [before?.[field.name], after?.[field.name]]
    if (field.type === 'group') return compare(field.options?.fields ?? [], was, is, at)
    if (same(was, is) || (isEmptyValue(was) && isEmptyValue(is))) return []

    const kind = isEmptyValue(was) ? 'added' : isEmptyValue(is) ? 'removed' : 'changed'
    if (!lists.has(field.type)) return [{ labels: at, field, kind, before: was, after: is }]
    // Keys no field reads don't count
    const items = compareItems(field, was, is)
    return items.length ? [{ labels: at, field, kind, before: was, after: is, items }] : []
  })
}

// The entries, files and forms that changed links name, inside lists too, for loading their titles, names and labels
export function linksOf(changes: Array<Change>): {
  entries: Array<string>
  files: Array<string>
  forms: Array<string>
} {
  const entries = new Set<string>()
  const files = new Set<string>()
  const forms = new Set<string>()
  const walk = (changes: Array<Change>) => {
    for (const change of changes) {
      const into = { relationship: entries, media: files, form: forms }[change.field.type]
      for (const id of [...idsOf(change.before), ...idsOf(change.after)]) into?.add(id)
      for (const item of change.items ?? []) walk(item.changes)
    }
  }
  walk(changes)
  return { entries: [...entries], files: [...files], forms: [...forms] }
}

export interface Part {
  text: string
  kind: 'same' | 'added' | 'removed'
}

// The tokens two lists share and those added and removed, in order, with each run of one kind joined into a part. Only
// what lies between the first and last change is compared token by token.
// shortcut: past a million pairs of tokens between the first and last change, that stretch shows as removed then
// added, switch to Myers' diff when entries hold texts that long and change all through
function diff(a: Array<string>, b: Array<string>): Array<Part> {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const [x, y] = [a.slice(start, a.length - end), b.slice(start, b.length - end)]

  const parts: Array<Part> = []
  const push = (kind: Part['kind'], text: string) => {
    const last = parts.at(-1)
    if (last?.kind === kind) last.text += text
    else if (text) parts.push({ kind, text })
  }
  push('same', a.slice(0, start).join(''))

  const [n, m] = [x.length, y.length]
  if (n * m > 1_000_000) {
    push('removed', x.join(''))
    push('added', y.join(''))
  } else {
    // The length of the longest run of tokens the rest of x and the rest of y share, for each pair of starting points
    const width = m + 1
    const shared = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        shared[i * width + j] =
          x[i] === y[j]
            ? shared[(i + 1) * width + j + 1] + 1
            : Math.max(shared[(i + 1) * width + j], shared[i * width + j + 1])
      }
    }
    let [i, j] = [0, 0]
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        push('same', x[i++])
        j++
      } else if (i < n && (j === m || shared[(i + 1) * width + j] >= shared[i * width + j + 1])) push('removed', x[i++])
      else push('added', y[j++])
    }
  }

  push('same', a.slice(a.length - end).join(''))
  return parts
}

// The words two texts share and the words added and removed, keeping the spaces and line breaks between them
export const diffWords = (before: string, after: string) => {
  const words = (text: string) => text.split(/(\s+)/).filter(Boolean)
  return diff(words(before), words(after))
}

// The lines two texts share and the lines added and removed, each ending in its line break
export const diffLines = (before: string, after: string) => {
  const lines = (text: string) => (text ? `${text}\n`.split(/(?<=\n)/).filter(Boolean) : [])
  return diff(lines(before), lines(after))
}

// Values as JSON, two spaces deep, with every object's keys in order, so the order Postgres keeps them in never shows
// as a change. No values, as before a first version, are no JSON at all.
export const toJson = (values: unknown) =>
  values === undefined
    ? ''
    : JSON.stringify(
        values,
        (_, value) =>
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((name) => [name, value[name]]),
              )
            : value,
        2,
      )

// A change a proposal makes to a content type (PLAN.md section 21): one of its settings, or a field or layout added,
// removed or changed, named by its labels from the top, such as Blocks › Quote, with what changed about it
export interface TypeChange {
  labels: Array<string>
  kind: Kind
  details: Array<string>
  // Whether it changes what the site's API returns: a field's or layout's key, place or type, or the type's name
  api: boolean
}

interface TypeNode {
  kind: 'field' | 'layout'
  schema: { name: string; label?: string; [key: string]: any }
  // The field or layout it sits in, by id, or '' at the top
  parent: string
  labels: Array<string>
}

// Every field and layout in a type's fields by id, as make:migration matches them
function nodesOf(fields: Array<FieldSchema>) {
  const nodes = new Map<string, TypeNode>()
  const add = (list: unknown, kind: TypeNode['kind'], parent: string, labels: Array<string>) => {
    for (const schema of Array.isArray(list) ? list : []) {
      const named = [...labels, label(schema)]
      nodes.set(schema.id, { kind, schema, parent, labels: named })
      if (kind === 'layout') add(schema.fields, 'field', schema.id, named)
      else {
        add(schema.options?.fields, 'field', schema.id, named)
        add(schema.options?.layouts, 'layout', schema.id, named)
      }
    }
  }
  add(fields, 'field', '', [])
  return nodes
}

const settingNames: Record<string, string> = {
  label: 'Label',
  name: 'Name',
  singular: 'Singular label',
  structure: 'Structure',
  drafts: 'Drafts',
  icon: 'Icon',
  titleField: 'Title field',
  slugField: 'Slug field',
  listColumns: 'List columns',
}

const shown = (value: unknown): string =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
    ? 'none'
    : Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)
      ? value.join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

const operators: Record<string, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  greaterThan: 'is more than',
  lessThan: 'is less than',
  empty: 'is empty',
  notEmpty: 'is not empty',
}

// A field's conditions as words, such as format is online, or venue is empty, read in any shape core takes them
const conditionsText = (schema: FieldSchema) => {
  const groups = normaliseConditions(schema)
  const rule = ({ field, operator, value }: { field: string; operator: string; value?: unknown }) =>
    [field, operators[operator] ?? operator, ...(/mpty$/.test(operator) ? [] : [shown(value)])].join(' ')
  return groups.length ? groups.map((group) => group.map(rule).join(' and ')).join(', or ') : 'none'
}

// Choices by their labels, with the value each stores where it differs, since the label is what people see
const choicesText = (list: Array<any>) =>
  list
    .map((choice) =>
      choice?.label && choice.label !== choice.value ? `${choice.label} (${choice.value})` : String(choice?.value),
    )
    .join(', ')

// What a field's settings say that people see, which the model wrote if it proposed them: its instructions and choices
const wording = (schema: Record<string, any>) => [
  ...(schema.instructions ? [`Instructions: ${schema.instructions}`] : []),
  ...(Array.isArray(schema.options?.choices) && schema.options.choices.length
    ? [`Choices: ${choicesText(schema.options.choices)}`]
    : []),
]

// What changed between two versions of a type's file, by id: its settings first, then its fields and layouts in the
// new order, and those removed last. A field added or removed counts once, with what's inside it. typeName names a
// field type, such as Long text for textarea.
export function compareTypes(
  before: Record<string, any>,
  after: Record<string, any>,
  typeName: (type: string) => string = (type) => type,
): Array<TypeChange> {
  const changes: Array<TypeChange> = []
  for (const key of Object.keys(settingNames)) {
    const drafts = (type: Record<string, any>) => (type.drafts === false ? 'off' : 'on')
    const [was, now] = key === 'drafts' ? [drafts(before), drafts(after)] : [before[key], after[key]]
    if (!same(was ?? null, now ?? null)) {
      const details = [`${shown(was)} → ${shown(now)}`]
      changes.push({ labels: [settingNames[key]], kind: 'changed', details, api: key === 'name' })
    }
  }

  const old = nodesOf(before.fields ?? [])
  const now = nodesOf(after.fields ?? [])
  const place = (nodes: Map<string, TypeNode>, parent: string) =>
    parent ? nodes.get(parent)!.labels.join(' › ') : 'the top'
  for (const [id, node] of now) {
    const was = old.get(id)
    if (!was) {
      // Inside a container that's new too, it's part of that container's addition
      if (!node.parent || old.has(node.parent)) {
        const what = node.kind === 'layout' ? 'A layout' : typeName(node.schema.type)
        changes.push({
          labels: node.labels,
          kind: 'added',
          details: [node.schema.required ? `${what}, required` : what, ...wording(node.schema)],
          api: false,
        })
      }
      continue
    }
    const details: Array<string> = []
    if (was.schema.name !== node.schema.name) details.push(`Renamed from ${was.schema.name} to ${node.schema.name}`)
    if (was.parent !== node.parent) details.push(`Moved from ${place(old, was.parent)} to ${place(now, node.parent)}`)
    if (was.schema.type !== node.schema.type) {
      details.push(`${typeName(was.schema.type)} → ${typeName(node.schema.type)}`)
    }
    if (label(was.schema) !== label(node.schema)) details.push(`Label ${label(was.schema)} → ${label(node.schema)}`)
    if (!was.schema.required !== !node.schema.required) {
      details.push(node.schema.required ? 'Now required' : 'No longer required')
    }
    for (const key of ['instructions', 'width', 'defaultValue', 'conditions', 'readonly', 'disabled']) {
      if (same(was.schema[key] ?? null, node.schema[key] ?? null)) continue
      details.push(
        `New ${key}: ${key === 'conditions' ? conditionsText(node.schema as FieldSchema) : shown(node.schema[key])}`,
      )
    }
    const options = new Set([...Object.keys(was.schema.options ?? {}), ...Object.keys(node.schema.options ?? {})])
    for (const key of options) {
      if (key === 'fields' || key === 'layouts') continue
      const [a, b] = [was.schema.options?.[key], node.schema.options?.[key]]
      if (same(a ?? null, b ?? null)) continue
      if (key === 'choices') {
        const list = (choices: unknown): Array<any> => (Array.isArray(choices) ? choices : [])
        const find = (choices: unknown, choice: any) => list(choices).find((other) => other?.value === choice?.value)
        const lost = list(a).filter((choice) => !find(b, choice))
        const gained = list(b).filter((choice) => !find(a, choice))
        const relabelled = list(b).filter((choice) => find(a, choice) && find(a, choice).label !== choice.label)
        if (lost.length) details.push(`Lost the choice${lost.length > 1 ? 's' : ''} ${choicesText(lost)}`)
        if (gained.length) details.push(`New choice${gained.length > 1 ? 's' : ''} ${choicesText(gained)}`)
        for (const choice of relabelled) {
          details.push(`Relabelled ${choice.value} from ${shown(find(a, choice).label)} to ${shown(choice.label)}`)
        }
        if (!lost.length && !gained.length && !relabelled.length)
          details.push(`Choices reordered: ${choicesText(list(b))}`)
      } else details.push(`${key}: ${shown(a)} → ${shown(b)}`)
    }
    const api =
      was.schema.name !== node.schema.name || was.parent !== node.parent || was.schema.type !== node.schema.type
    if (details.length) changes.push({ labels: node.labels, kind: 'changed', details, api })
  }
  for (const [id, node] of old) {
    if (!now.has(id) && (!node.parent || now.has(node.parent))) {
      changes.push({ labels: node.labels, kind: 'removed', details: [], api: true })
    }
  }
  return changes
}
