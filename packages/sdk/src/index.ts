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

// Each content type's entry, by type name, filled in by the pulled file through module augmentation
export interface EntryTypes {}

// Without pulled types, any type name works and values are unknown
type Registered = [keyof EntryTypes] extends [never] ? Record<string, Entry> : EntryTypes

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

// A chainable query for one content type's entries
class EntriesQuery<E extends Entry> {
  #request: (params: URLSearchParams) => Promise<Paginated<E>>
  // Groups joined by OR, each a list of conditions that must all match, as the API takes them
  #where: Array<Array<Condition>> = []
  #order: Record<string, 'asc' | 'desc'> = {}

  constructor(request: (params: URLSearchParams) => Promise<Paginated<E>>) {
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

  // One page of entries, with { data, pagination }
  paginate(perPage = 15, page = 1) {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) })
    if (this.#where.length) params.set('where', JSON.stringify(this.#where))
    if (Object.keys(this.#order).length) params.set('order', JSON.stringify(this.#order))
    return this.#request(params)
  }

  // The first matching entry, or null
  async first(): Promise<E | null> {
    return (await this.paginate(1)).data[0] ?? null
  }

  // Every matching entry, fetching the pages in turn
  async all() {
    const entries: Array<E> = []
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
