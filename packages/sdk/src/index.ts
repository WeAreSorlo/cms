// A typed client for the Sorlo CMS's delivery API (PLAN.md section 8). It must never import server code.

// An entry as the delivery API returns it. The file `npx sorlo types pull` writes narrows it for each content type.
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
  // When it was last published
  publishedAt: string
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

// Each form's values, by form name, filled in by the pulled file
export interface FormTypes {}

// Without pulled types, any type name works and values are unknown
type Registered = [keyof EntryTypes] extends [never] ? Record<string, Entry> : EntryTypes

// Without pulled types, any form name works and takes any values
type RegisteredForms = [keyof FormTypes] extends [never] ? Record<string, Record<string, unknown>> : FormTypes

// A submission as the CMS stored it
export interface Submission<V> {
  id: string
  // The version of the form's fields that the values were checked against
  version: number
  values: V
  createdAt: string
}

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

// An entry as a preview reads it: its draft, which may never have been published, and whose fields can be empty at any
// level, since drafts can be saved unfinished. Its links are to drafts too.
export type Draft<E> = {
  [P in keyof E]: P extends 'values' ? Unfinished<E[P]> : P extends 'slug' | 'uri' | 'publishedAt' ? E[P] | null : E[P]
}

// Values that can be missing anywhere, but for the _layout that names a flexible block's layout, with linked entries as
// drafts and media files as they are
type Unfinished<T> = T extends Entry
  ? Draft<T>
  : T extends Media
    ? T
    : T extends Array<infer I>
      ? Array<Unfinished<I>>
      : T extends object
        ? { [K in keyof T as K extends '_layout' ? K : never]: T[K] } & {
            [K in keyof T as K extends '_layout' ? never : K]?: Unfinished<T[K]>
          }
        : T

// What a query finds: entries with the fields K resolved, D levels deep, or for a preview, their drafts
type Result<E extends Entry, K extends PropertyKey, D extends number, P extends boolean> = P extends true
  ? Draft<With<E, K, D>>
  : With<E, K, D>

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
export class SorloError extends Error {
  name = 'SorloError'
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

// A chainable query for one content type's entries, returning them with the fields K resolved, D levels deep, or their
// drafts when P is true
class EntriesQuery<
  E extends Entry,
  K extends PropertyKey = never,
  D extends number = DefaultDepth,
  P extends boolean = false,
> {
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
    return this as unknown as EntriesQuery<E, K | F, D, P>
  }

  // How many levels of links with() resolves, the CMS's delivery.depth if not given
  depth<N extends Depth>(depth: N) {
    this.#depth = depth
    return this as unknown as EntriesQuery<E, K, N, P>
  }

  // One page of entries, with { data, pagination }
  paginate(perPage = 15, page = 1): Promise<Paginated<Result<E, K, D, P>>> {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) })
    if (this.#where.length) params.set('where', JSON.stringify(this.#where))
    if (Object.keys(this.#order).length) params.set('order', JSON.stringify(this.#order))
    if (this.#with.size) params.set('with', JSON.stringify([...this.#with]))
    if (this.#depth !== undefined) params.set('depth', String(this.#depth))
    return this.#request(params)
  }

  // The first matching entry, or null
  async first(): Promise<Result<E, K, D, P> | null> {
    return (await this.paginate(1)).data[0] ?? null
  }

  // Every matching entry, fetching the pages in turn
  async all() {
    const entries: Array<Result<E, K, D, P>> = []
    for (let page = 1, lastPage = 1; page <= lastPage; page++) {
      const { data, pagination } = await this.paginate(100, page)
      entries.push(...data)
      lastPage = pagination.lastPage
    }
    return entries
  }
}

export interface ClientOptions<Preview extends boolean = boolean> {
  // The CMS's address, such as https://cms.example.com
  url: string
  // A key from `sorlo make:api-key`, which entries need. Forms take submissions without one, so browsers can send
  // them, but a site's own server sends one from `sorlo make:api-key --submit`, so it isn't rate limited as one visitor.
  token?: string
  // Reads drafts in place of what's live, for a site's preview, typing their values as unfinished. Every query sends
  // status=draft, which needs a key from `sorlo make:api-key --preview`, so keep the client on a server.
  preview?: Preview
  // In place of the global fetch, e.g. to add caching
  fetch?: typeof globalThis.fetch
}

export function createClient<Preview extends boolean = false>({
  url,
  token,
  preview,
  fetch = globalThis.fetch,
}: ClientOptions<Preview>) {
  // fetch is called on its own, since browsers refuse it as a method of another object
  const request = async (path: string, json?: unknown) => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (json !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok || body === undefined) {
      const failed =
        response.status === 422 ? "The values don't pass the form's checks." : `The CMS replied ${response.status}.`
      const message = body?.message ?? (response.ok ? "The CMS's reply isn't JSON." : failed)
      throw new SorloError(message, response.status, body)
    }
    return body
  }

  return {
    // A query for a content type's entries, such as cms.entries('blog'). Its type is written out so the SDK's built
    // types keep Registered[T], which a site's pulled types fill in, rather than what it was when the SDK was built.
    entries: <T extends keyof Registered & string>(
      type: T,
    ): EntriesQuery<Extract<Registered[T], Entry>, never, DefaultDepth, Preview> =>
      new EntriesQuery((params) => {
        if (preview) params.set('status', 'draft')
        return request(`/v1/entries/${encodeURIComponent(type)}?${params}`)
      }),

    // A form, by its name, such as cms.form('contact')
    form: <F extends keyof RegisteredForms & string>(form: F) => ({
      // Sends the values, resolving the submission as it was stored. Values that don't pass throw a SorloError with
      // status 422, whose body is core's report, for a core form's applyReport.
      submit: async (values: RegisteredForms[F]): Promise<Submission<RegisteredForms[F]>> =>
        (await request(`/v1/forms/${encodeURIComponent(form)}`, values)).data,
    }),
  }
}
