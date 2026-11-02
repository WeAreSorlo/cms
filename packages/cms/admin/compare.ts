import { idsOf } from '../src/fields'
import { FieldSchema, isEmptyValue } from 'iight'

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
