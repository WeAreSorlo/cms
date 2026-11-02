import { form, media, relationship } from '../src/fields'
import { maxNamed } from '../src/schemas'
import type { ContentType, SharedGroup } from '../src/types'
import { FieldSchema, Input, inputs } from 'iight'
import { createContext, useContext, useEffect } from 'react'

export type { ContentType, SharedGroup }

// The site's content types, for the pickers and the pages that show entries' titles
export const TypesContext = createContext(new Map<string, ContentType>())

// The site's shared groups by name, as their files have them, for the type editor
export const GroupsContext = createContext(new Map<string, SharedGroup>())

// A page's place in the URL's hash, without the query after it, which holds a list's search and filters
export const pathOf = (hash: string) => hash.split('?')[0]

// The nav item a page belongs to, from its URL's hash, such as types/blog for #/types/blog/archive. An entry's URL
// doesn't name its type, so its page tells the shell through SectionContext once the entry loads.
export function sectionOf(hash: string) {
  const [section, name] = pathOf(hash).replace(/^#\/?/, '').split('/')
  if (section === 'types' && name) return `types/${name}`
  return ['chat', 'media', 'forms', 'automations', 'schema', 'groups', 'migrations', 'keys', 'tokens'].includes(section)
    ? section
    : undefined
}

// What the assistant beside a page takes "this" and "these" to mean: the page its next message sends, which the server
// checks before the model sees any of it, as ids and type names, and the line above its box, which names the same
// thing with what the page shows (PLAN.md section 21)
export interface PageView {
  page: Record<string, unknown>
  label: string
}

// Set by a page just before it moves itself to another address, such as the type editor once its type is renamed through
// the assistant, so the shell leaves focus where it is rather than moving it to the new page's heading
export const navigation = { keepFocus: false }

// Each page tells the shell what it shows, for the shell's assistant to send with each message
export const PageViewContext = createContext((view: PageView | null) => {})

// Tells the assistant what the page shows, from when it mounts or changes until it goes
export function usePageView(view: PageView | null | undefined) {
  const show = useContext(PageViewContext)
  const key = JSON.stringify(view)
  useEffect(() => {
    // Undefined leaves the page's view be, for a part of a page, such as a picker
    if (view === undefined) return
    show(view)
    return () => show(null)
  }, [key, show])
}

// What a list's search and filter find, as its lines say, such as 37 matching your filter
export const matchingOf = (searched: boolean, filtered: boolean) =>
  `matching ${searched && filtered ? 'your search and filter' : searched ? 'your search' : 'your filter'}`

// A list's view: its ticked entries, in the order they were ticked, or else those its search and filter match, in its
// order, which the server finds with the list's own query, or else the type alone
export function listView(
  type: ContentType,
  list: {
    ticked: Array<string>
    where: Array<unknown>
    order: unknown
    // How many the search and filter match, once the list knows
    total?: number
    searched: boolean
    filtered: boolean
    archived: boolean
  },
): PageView {
  const { ticked, where, order, total, searched, filtered, archived } = list
  const name = archived ? `${type.label} archive` : type.label
  if (ticked.length) {
    const many = ticked.length > maxNamed ? `, too many to send, so tick ${maxNamed} or fewer` : ''
    return {
      page: { type: type.name, ticked, ...(archived && { archived }) },
      label: `${name}: ${ticked.length} ticked${many}`,
    }
  }
  if (where.length && total !== undefined) {
    const many = total > maxNamed ? `, too many to send, so narrow it to ${maxNamed} or fewer` : ''
    return {
      page: { type: type.name, where, order, ...(archived && { archived }) },
      label: `${name}: ${total} ${matchingOf(searched, filtered)}${many}`,
    }
  }
  return { page: { type: type.name, ...(archived && { archived }) }, label: name }
}

export const SectionContext = createContext((section: string) => {})

// An entry as the admin API returns it. It's a draft until it's published, then published, or changed once a newer
// version is saved, and publishedVersion is the number of the version that's live.
export interface Entry {
  id: string
  type: string
  slug: string | null
  uri: string | null
  parentId: string | null
  position: number | null
  values: Record<string, any>
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  archivedAt: string | null
  createdBy: string | null
  updatedBy: string | null
  status: Status
  publishedVersion: number | null
}

export type Status = 'draft' | 'published' | 'changed'

// Such as 1 entry or 1,240 entries
export const count = (length: number, one: string, many: string) =>
  `${length.toLocaleString()} ${length === 1 ? one : many}`

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Call the admin API with JSON, or with FormData for an upload. A validation report comes back with its 422, and any
// other failure throws its message.
export async function api(method: string, path: string, body?: unknown) {
  const sendsJson = body !== undefined && !(body instanceof FormData)
  const response = await fetch(`/api${path}`, {
    method,
    headers: sendsJson ? { 'content-type': 'application/json' } : {},
    body: sendsJson ? JSON.stringify(body) : (body as FormData | undefined),
  })

  const json = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok && response.status !== 422) throw new Error(json?.message ?? response.statusText)
  return { status: response.status, body: json }
}

// Every live entry of a type, through all the pages, siblings in order
export async function allEntries(type: ContentType) {
  const entries: Array<Entry> = []
  const order = encodeURIComponent('{"position":"asc"}')
  for (let page = 1, lastPage = 1; page <= lastPage; page++) {
    const { body } = await api('GET', `/types/${type.name}/entries?order=${order}&perPage=100&page=${page}`)
    entries.push(...body.data)
    lastPage = body.pagination.lastPage
  }
  return entries
}

// A value as text, formatted by its field's input
export function formatValue(field: FieldSchema | undefined, value: any) {
  const format =
    field && ({ ...inputs, relationship, media, form } as Record<string, Partial<Input>>)[field.type]?.formatValue
  // Core formats an invalid value as null, which shows here as it is, so a cell can show what its message is about
  const text = (format && format(value, field)) ?? (typeof value === 'object' ? null : value?.toString())
  // Core formats a choice field as the values it holds, which show here as their choices' labels
  const choices: Array<{ value: unknown; label?: string }> | undefined = field?.options?.choices
  if (!choices) return text ?? ''
  return [text ?? []]
    .flat()
    .map((item) => choices.find((choice) => choice.value === item)?.label ?? item)
    .join(', ')
}

// A field's value as text, formatted by its input
export const formatField = (type: ContentType, name: string | undefined, entry: Entry) =>
  formatValue(
    type.fields.find((field) => field.name === name),
    entry.values[name ?? ''],
  )

export const titleOf = (type: ContentType, entry: Entry) =>
  type.structure === 'singleton' ? type.label : formatField(type, type.titleField, entry) || 'Untitled'

// Entries in tree order, each with its depth and place among its siblings, leaving out one entry and its descendants
export function tree(entries: Array<Entry>, without?: string) {
  const children = new Map<string | null, Array<Entry>>()
  for (const entry of entries) children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry])

  const rows: Array<{ entry: Entry; depth: number; index: number; siblings: number }> = []
  const walk = (parentId: string | null, depth: number) =>
    (children.get(parentId) ?? []).forEach((entry, index, siblings) => {
      if (entry.id === without) return
      rows.push({ entry, depth, index, siblings: siblings.length })
      walk(entry.id, depth + 1)
    })

  walk(null, 0)
  return rows
}

export const date = (iso: string) => new Date(iso).toLocaleString()

// Such as 30 Oct, 14:02, or 30 Oct without the time, with the year once it isn't this one
export function shortDate(iso: string, time = true) {
  const when = new Date(iso)
  const year = when.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  const clock = time ? ({ hour: 'numeric', minute: '2-digit' } as const) : {}
  return when.toLocaleString(undefined, { day: 'numeric', month: 'short', year, ...clock })
}
