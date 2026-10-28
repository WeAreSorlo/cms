// A typed client for the iight CMS's delivery API (PLAN.md section 8). It must never import server code.

// An entry as the delivery API returns it. The file `npx iight types pull` writes narrows it for each content type.
export interface Entry {
  id: string
  type: string
  slug: string | null
  uri: string | null
  parentId: string | null
  position: number | null
  values: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

// A file in the media library, as the delivery API returns it and with() resolves a media field
export interface Media {
  id: string
  name: string
  mime: string
  size: number
  width: number | null
  height: number | null
  alt: string | null
  caption: string | null
  url: string
  createdAt: string
  updatedAt: string
}

// Each content type's entry, by type name, filled in by the pulled file through module augmentation
export interface EntryTypes {}

// Each content type's fields that with() can name, typed as it returns them with links resolved Depth levels deep.
// The pulled file fills it in.
export interface ResolvedTypes<Depth extends number> {}

// The CMS's settings that types depend on, such as the depth with() resolves to when a query doesn't say. The pulled
// file fills it in.
export interface DeliverySettings {}

// Without pulled types, any type name works and values are unknown
type Registered = [keyof EntryTypes] extends [never] ? Record<string, Entry> : EntryTypes

type DefaultDepth = DeliverySettings extends { depth: infer D extends number } ? D : 2

// The depths a query can ask for, and each one's level less
// shortcut: typed to 10 levels, lengthen both when sites resolve deeper
export type Depth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
type Less = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

// The fields of an entry's values that with() resolves, Depth levels deep
type ResolvedOf<E extends Entry, D extends number> = E['type'] extends keyof ResolvedTypes<D>
  ? ResolvedTypes<D>[E['type']]
  : {}

// An entry with some of its values typed as R has them, or the entry itself when R has none
type Merge<E extends Entry, R> = [keyof R] extends [never]
  ? E
  : { [P in keyof E]: P extends 'values' ? { [F in keyof E[P]]: F extends keyof R ? R[F] : E[P][F] } : E[P] }

// An entry that a link resolved D levels deep holds, with every link of its own resolved a level less
export type Linked<E extends Entry, D extends number> = E extends Entry
  ? Less[D] extends 0
    ? E
    : Merge<E, ResolvedOf<E, Less[D]>>
  : never

// An entry with the fields K resolved, as with() returns them, D levels deep
export type With<E extends Entry, K extends PropertyKey, D extends number = DefaultDepth> = [K] extends [never]
  ? E
  : Merge<E, Pick<ResolvedOf<E, D>, K & keyof ResolvedOf<E, D>>>

// The fields with() can name: those that hold links, or any without pulled types
type Linkable<E extends Entry> = [keyof ResolvedTypes<1>] extends [never] ? string : keyof ResolvedOf<E, 1> & string

export interface Paginated<E> {
  data: Array<E>
  pagination: { page: number; perPage: number; total: number; lastPage: number }
}

type Operator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'like'
  | 'not like'
  | 'in'
  | 'not in'
  | 'between'
  | 'not between'
  | 'exists'
  | 'not exists'

// What a query can filter and sort by, named as the API names them, with the value each holds
type Fields<E extends Entry> = {
  id: string
  slug: string
  uri: string
  parentId: string
  position: number
  // Sent as JSON, so a Date goes as its ISO timestamp
  createdAt: string | Date
  updatedAt: string | Date
} & { [K in keyof E['values'] & string as `values.${K}`]: Exclude<E['values'][K], undefined> }

// The value an operator takes. like matches text, which the other entry properties aren't.
type Value<F, V, O extends Operator> = O extends 'exists' | 'not exists'
  ? []
  : O extends 'in' | 'not in'
    ? [value: Array<V>]
    : O extends 'between' | 'not between'
      ? [value: [V, V]]
      : O extends 'like' | 'not like'
        ? [value: F extends 'slug' | 'uri' | `values.${string}` ? string : never]
        : [value: V]

// A request the CMS refused or couldn't answer, with its HTTP status and the API's { message }
export class IightError extends Error {
  name = 'IightError'
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

interface Condition {
  field: string
  op: Operator
  value?: unknown
}

// A chainable query for one content type's entries, returning them with the fields K resolved, D levels deep
class EntriesQuery<E extends Entry, K extends PropertyKey = never, D extends number = DefaultDepth> {
  #request: (params: URLSearchParams) => Promise<any>
  // Groups joined by OR, each a list of conditions that must all match, as the API takes them
  #where: Array<Array<Condition>> = []
  #order: Record<string, 'asc' | 'desc'> = {}
  #with = new Set<string>()
  #depth?: number

  constructor(request: (params: URLSearchParams) => Promise<any>) {
    this.#request = request
  }

  // A condition the entries must also match
  where<F extends keyof Fields<E> & string, O extends Operator>(
    field: F,
    op: O,
    ...[value]: Value<F, Fields<E>[F], O>
  ) {
    if (!this.#where.length) this.#where.push([])
    this.#where[this.#where.length - 1].push({ field, op, value })
    return this
  }

  // A condition that starts another group, so entries can match it instead of the groups before
  orWhere<F extends keyof Fields<E> & string, O extends Operator>(
    field: F,
    op: O,
    ...[value]: Value<F, Fields<E>[F], O>
  ) {
    this.#where.push([{ field, op, value }])
    return this
  }

  orderBy(field: keyof Fields<E> & string, direction: 'asc' | 'desc' = 'asc') {
    this.#order[field] = direction
    return this
  }

  // Relationship and media fields, or fields that hold them, to come with what they link to rather than IDs. The
  // entries they link to come with their own links too, down to the depth.
  with<F extends Linkable<E> = never>(...fields: Array<F>) {
    for (const field of fields) this.#with.add(field)
    return this as unknown as EntriesQuery<E, K | F, D>
  }

  // How many levels of links with() resolves, the CMS's delivery.depth if not given
  depth<N extends Depth>(depth: N) {
    this.#depth = depth
    return this as unknown as EntriesQuery<E, K, N>
  }

  // One page of entries, with { data, pagination }
  paginate(perPage = 15, page = 1): Promise<Paginated<With<E, K, D>>> {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) })
    if (this.#where.length) params.set('where', JSON.stringify(this.#where))
    if (Object.keys(this.#order).length) params.set('order', JSON.stringify(this.#order))
    if (this.#with.size) params.set('with', JSON.stringify([...this.#with]))
    if (this.#depth !== undefined) params.set('depth', String(this.#depth))
    return this.#request(params)
  }

  // The first matching entry, or null
  async first(): Promise<With<E, K, D> | null> {
    return (await this.paginate(1)).data[0] ?? null
  }

  // Every matching entry, fetching the pages in turn
  async all() {
    const entries: Array<With<E, K, D>> = []
    for (let page = 1, lastPage = 1; page <= lastPage; page++) {
      const { data, pagination } = await this.paginate(100, page)
      entries.push(...data)
      lastPage = pagination.lastPage
    }
    return entries
  }
}

export interface ClientOptions {
  // The CMS's address, such as https://cms.example.com
  url: string
  // A key from `iight make:api-key`
  token: string
  // In place of the global fetch, e.g. to add caching
  fetch?: typeof globalThis.fetch
}

export function createClient({ url, token, fetch = globalThis.fetch }: ClientOptions) {
  // fetch is called on its own, since browsers refuse it as a method of another object
  const get = async (path: string, params: URLSearchParams) => {
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}?${params}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body === undefined) {
      const message =
        body?.message ?? (response.ok ? "The CMS's reply isn't JSON." : `The CMS replied ${response.status}.`)
      throw new IightError(message, response.status, body)
    }
    return body
  }

  return {
    // A query for a content type's entries, such as cms.entries('blog')
    entries: <T extends keyof Registered & string>(type: T) =>
      new EntriesQuery<Extract<Registered[T], Entry>>((params) =>
        get(`/v1/entries/${encodeURIComponent(type)}`, params),
      ),
  }
}
