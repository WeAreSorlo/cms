import { ruleKind } from '../src/schemas'
import type { FieldSchema } from '@sorlo/core'

// What a list asks the list API for besides its page: its sort, its search and its filter, which is core's conditions
// input's value. The URL's query keeps the search and the filter, after the page's path, such as
// #/types/blog?search=lamp&filter=[…], so they survive a reload and can be shared.

// Fields whose stored values sort the way they read
export const sortable = new Set([
  'text',
  'textarea',
  'identifier',
  'email',
  'url',
  'tel',
  'number',
  'range',
  'date',
  'datetime',
  'time',
  'boolean',
  'select',
  'radio',
  'color',
])

// The fields rules can compare: those that sort, and a checkbox's choices. Groups and lists hold no one value, and links
// hold IDs.
const filterable = new Set([...sortable, 'checkbox'])

// A condition of the list API's where, which takes groups of them joined by OR, each group's all having to match
export interface Condition {
  field: string
  op: string
  value?: unknown
}

// A type's top-level fields that rules can compare, by the names the list API gives them, such as values.title
export const entryFields = (fields: Array<FieldSchema>) =>
  new Map(fields.filter((field) => filterable.has(field.type)).map((field) => [`values.${field.name}`, field]))

// What core's conditions input lists for them
export const fieldChoicesOf = (fields: Map<string, FieldSchema>) =>
  [...fields].map(([value, field]) => ({ value, label: field.label ?? field.name, ...ruleKind([field]) }))

// The filter in a list's query, or none when it isn't a list
export function filterOf(params: URLSearchParams): Array<unknown> {
  try {
    const filter = JSON.parse(params.get('filter') ?? '[]')
    return Array.isArray(filter) ? filter : []
  } catch {
    return []
  }
}

// Core's conditions input keeps a rule's value as the text its control gives
const asText = (value: unknown) =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

// A rule's value as its field stores it, or undefined until there is one
function valueOf(field: FieldSchema, text: string) {
  if (text.trim() === '') return undefined
  if (field.type === 'number' || field.type === 'range') return Number.isFinite(Number(text)) ? Number(text) : undefined
  if (field.type === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined
  return ruleKind([field]).choices?.find((choice) => String(choice?.value) === text)?.value ?? text
}

// Each of core's operators as conditions of the list API, any of which may match. Those a missing value passes, such as
// does not equal, also match an empty field, as core's do and SQL's comparisons don't. Starts with has none, since like
// matches anywhere in the text.
function waysOf(field: string, schema: FieldSchema, operator: unknown, value: unknown): Array<Condition> | undefined {
  const empty = { field, op: 'not exists' }
  // A checkbox holds a list, whose JSON text holds each choice quoted, so contains finds one there
  // shortcut: like ignores case, so choices that differ only by case match each other, add a list operator to the API
  // if a site has some
  const text = schema.type === 'checkbox' ? JSON.stringify(value) : String(value)
  if (operator === 'equals') return [{ field, op: '=', value }]
  if (operator === 'notEquals') return [{ field, op: '!=', value }, empty]
  if (operator === 'contains') return [{ field, op: 'like', value: text }]
  if (operator === 'notContains') return [{ field, op: 'not like', value: text }, empty]
  if (operator === 'greaterThan') return [{ field, op: '>', value }]
  if (operator === 'lessThan') return [{ field, op: '<', value }]
  if (operator === 'empty') return [empty]
  if (operator === 'notEmpty') return [{ field, op: 'exists' }]
}

// The list API's where for a filter over fields named as the API names them, with conditions every group must also
// meet, such as a search. It leaves out the rules that aren't finished, and the rules the API can't express, which it
// counts. A rule that matches in two ways makes a group for each.
// shortcut: each such rule doubles its group's groups, cap them if people put many in one group
export function whereOf(fields: Map<string, FieldSchema>, filter: Array<unknown>, also: Array<Condition> = []) {
  let left = 0
  const groups = filter.flatMap((group: any) => {
    const rules: Array<Array<Condition>> = []
    for (const rule of Array.isArray(group?.rules) ? group.rules : []) {
      const schema = fields.get(rule?.field)
      const value = schema && valueOf(schema, asText(rule.value))
      const needsValue = rule?.operator !== 'empty' && rule?.operator !== 'notEmpty'
      // Not finished: no field or operator yet, or no value its field can hold, which its control says
      if (!rule?.field || !rule.operator || (schema && needsValue && value === undefined)) continue
      const ways = schema && waysOf(rule.field, schema, rule.operator, value)
      if (ways) rules.push(ways)
      else left++
    }
    if (!rules.length) return []
    return rules.reduce<Array<Array<Condition>>>(
      (made, ways) => made.flatMap((group) => ways.map((way) => [...group, way])),
      [[]],
    )
  })

  const where = groups.length ? groups.map((group) => [...also, ...group]) : also.length ? [also] : []
  return { where, left }
}

// The entries ticked in a list, such as blog or its archive, blog/archive, in the order they were ticked, with what the
// last Select all found and the archive or restore under way. The admin keeps them until the tab reloads, so they
// outlast a visit to the grid, an entry or the archive, and a list that shows again shows its run as it stands
// (PLAN.md section 18).
export interface Ticks {
  ticked: Set<string>
  // The archive, search and filter it was for, and the ids it found, so the list knows while every entry it holds is
  // ticked
  selected?: { listing: string; ids: Array<string> }
  // Archiving or restoring them a hundred at a time, and how far it's got, or asking first, before it starts
  run?: { action: 'archive' | 'restore'; done: number; total: number; asking?: boolean }
  // How many runs have ended, so a list showing loads again as one does, and what the last one couldn't do
  ended: number
  problem?: string
}

const none: Ticks = { ticked: new Set(), ended: 0 }
const kept = new Map<string, Ticks>()
const watchers = new Set<() => void>()

export const ticksOf = (list: string) => kept.get(list) ?? none

// Changes a list's ticks, and tells the lists showing them
export function changeTicks(list: string, change: (now: Ticks) => Ticks) {
  kept.set(list, change(ticksOf(list)))
  for (const watcher of watchers) watcher()
}

export function watchTicks(watcher: () => void) {
  watchers.add(watcher)
  return () => void watchers.delete(watcher)
}

// The hundred of a list's ticks that bulk editing shows, which the grid's address names, as a page of them. There's
// none for a hundred or fewer, or for ids that aren't one of the hundreds, as after a reload.
export function hundredOf(ticked: Array<string>, ids: Array<string>) {
  const start = ticked.indexOf(ids[0])
  const hundred = start % 100 === 0 ? ticked.slice(start, start + 100) : []
  if (ticked.length <= 100 || hundred.length !== ids.length || hundred.some((id, at) => id !== ids[at])) return
  return { page: start / 100 + 1, perPage: 100, total: ticked.length, lastPage: Math.ceil(ticked.length / 100) }
}
