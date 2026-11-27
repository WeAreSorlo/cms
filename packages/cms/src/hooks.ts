import type { Plugin } from '.'
import type { Database } from './db'
import type { AdminSubmission } from './forms'
import type { AdminMedia } from './media'
import type { AdminEntry } from './query'
import type { ValidationReport } from '@sorlo/forms'
import { HTTPException } from 'hono/http-exception'
import type { Kysely } from 'kysely'

// Lifecycle hooks: a site's own code around every write to entries, files and form submissions. Before hooks can
// change what a save writes, or refuse a write, and core checks whatever they return before it's stored, so a hook can
// never write values that stray from the schema. After hooks run once the write has committed.

type Values = Record<string, any>

// Where a write came from
export type HookSource = 'admin' | 'api' | 'mcp' | 'assistant' | 'bulk' | 'import' | 'migration'

export interface HookUser {
  id: string
  email: string
  name: string
}

export interface HookArgs<Item> {
  // create or update for the save hooks, and otherwise the action
  operation: 'create' | 'update' | 'publish' | 'unpublish' | 'archive' | 'restore'
  // The values being written, or for an after hook, those written
  values: Values
  // The values as they were stored before the write, or null on create
  original: Values | null
  // The record as it was stored before the write, or null on create, and for an after hook, as the write left it
  entry: Item | null
  // The person making the change, or null for a public form post, sorlo import or sorlo migrate
  user: HookUser | null
  source: HookSource
  // The server's own content API, acting as the person making the change
  sorlo: Sorlo
  // One object the hooks of a write and the writes they make through sorlo share, so a hook can tell its own apart
  context: Record<string, any>
  // Adds a warning, by dotted path such as pets.0.name, or _entry for the whole record, which comes back beside a
  // successful write
  warn: (path: string, message: string) => void
}

type Hook<Item> = (args: HookArgs<Item>) => void | Promise<void>
// Returns the values to write, or nothing to keep them
type SaveHook<Item> = (args: HookArgs<Item>) => Values | void | Promise<Values | void>

export interface EntryHooks {
  beforeSave?: SaveHook<AdminEntry>
  afterSave?: Hook<AdminEntry>
  beforePublish?: Hook<AdminEntry>
  afterPublish?: Hook<AdminEntry>
  beforeUnpublish?: Hook<AdminEntry>
  afterUnpublish?: Hook<AdminEntry>
  beforeArchive?: Hook<AdminEntry>
  afterArchive?: Hook<AdminEntry>
  beforeRestore?: Hook<AdminEntry>
  afterRestore?: Hook<AdminEntry>
}

// By content type name, with '*' for every type
export type ContentHooks = Record<string, EntryHooks>

// For every file in the media library. Values are its name, alt text and caption.
export interface MediaHooks {
  beforeSave?: SaveHook<AdminMedia>
  afterSave?: Hook<AdminMedia>
}

export interface SubmissionHooks {
  beforeSave?: SaveHook<AdminSubmission>
  afterSave?: Hook<AdminSubmission>
  beforeArchive?: Hook<AdminSubmission>
  afterArchive?: Hook<AdminSubmission>
  beforeRestore?: Hook<AdminSubmission>
  afterRestore?: Hook<AdminSubmission>
}

// By form name, with '*' for every form
export type FormHooks = Record<string, SubmissionHooks>

// Warnings beside a successful write, nested as core's report nests its messages
export interface Warnings {
  fields: Record<string, { messages: Array<string>; children?: WarningChildren }>
}
type WarningChildren = Warnings | Array<WarningChildren>

export interface Written<Item> {
  data: Item
  warnings?: Warnings
}

export interface WriteOptions {
  // Writes without the person's permissions. With no person behind a write, as for a public form post, an import or a
  // migration, sorlo can only read without it.
  skipPermissions?: boolean
}

// What the admin's entry lists take: groups joined by OR, each a list of conditions that must all match
export interface EntryListQuery {
  where?: Array<Array<{ field: string; op: string; value?: unknown }>>
  order?: Record<string, 'asc' | 'desc'>
  page?: number
  perPage?: number
  archived?: boolean
}

export interface EntryChange {
  // Top-level fields to change, merged as bulk editing merges them
  values?: Values
  // A page's new parent, or null for the top
  parentId?: string | null
  publish?: boolean
}

// The server's own content API, as hooks get it. Its writes take the path the admin's do, checks and hooks included,
// with the context of the write that called it. A refused write throws a ValidationError with its report.
export interface Sorlo {
  entries: {
    get(id: string): Promise<AdminEntry | null>
    list(type: string, query?: EntryListQuery): Promise<{ data: Array<AdminEntry>; pagination: unknown }>
    create(type: string, change: EntryChange, options?: WriteOptions): Promise<Written<AdminEntry>>
    update(id: string, change: EntryChange, options?: WriteOptions): Promise<Written<AdminEntry>>
    publish(id: string, options?: WriteOptions): Promise<Written<AdminEntry>>
    unpublish(id: string, options?: WriteOptions): Promise<Written<AdminEntry>>
    archive(id: string, options?: WriteOptions): Promise<Written<AdminEntry>>
    restore(id: string, options?: WriteOptions): Promise<Written<AdminEntry>>
  }
  media: {
    get(id: string): Promise<AdminMedia | null>
    update(
      id: string,
      values: { name?: string; alt?: string | null; caption?: string | null },
      options?: WriteOptions,
    ): Promise<Written<AdminMedia>>
  }
}

const isObject = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Puts a message at a dotted path in a report nested as core nests one: a group's fields under its children, and a
// list's items by index. With invalid, every level it passes is marked invalid, as a refusal is.
function place(report: any, path: Array<string>, message: string, invalid: boolean) {
  const [name, ...rest] = path
  const field = (report.fields[name] ??= invalid ? { isValid: false, messages: [] } : { messages: [] })
  if (invalid) report.isValid = field.isValid = false
  if (rest.length) field.children = descend(field.children, rest, message, invalid)
  else field.messages.push(message)
}

function descend(children: any, path: Array<string>, message: string, invalid: boolean): any {
  const empty = () => (invalid ? { isValid: true, fields: {} } : { fields: {} })
  if (!/^\d+$/.test(path[0])) {
    const report = isObject(children) ? children : empty()
    place(report, path, message, invalid)
    return report
  }
  const list = Array.isArray(children) ? children : []
  const index = Number(path[0])
  // No holes, which JSON would make nulls
  for (let each = list.length; each < index; each++) list[each] = empty()
  list[index] = path.length > 1 ? descend(list[index], path.slice(1), message, invalid) : (list[index] ?? empty())
  return list
}

const pathOf = (path: string) => {
  const parts = path.split('.').filter(Boolean)
  // A message on a list item goes on its list, as core has no messages for items
  while (parts.length > 1 && /^\d+$/.test(parts.at(-1)!)) parts.pop()
  return parts.length ? parts : ['_entry']
}

// Messages by dotted path, merged into a report as a refusal, or into a fresh one
export function refusedReport(messages: Record<string, Array<string>>, report?: ValidationReport): ValidationReport {
  const merged: any = report ? structuredClone(report) : { isValid: true, fields: {} }
  for (const [path, list] of Object.entries(messages))
    for (const message of list) place(merged, pathOf(path), message, true)
  return merged
}

export function warningsOf(warned: Array<[string, string]>): Warnings {
  const warnings: any = { fields: {} }
  for (const [path, message] of warned) place(warnings, pathOf(path), message, false)
  return warnings
}

// A report's messages by dotted path, as core's flattenValidationReport gives them, without loading core here
function messagesOf(report: { fields: Record<string, any> }, prefix = '', flat: Record<string, Array<string>> = {}) {
  const walk = (children: any, at: string): unknown =>
    Array.isArray(children)
      ? children.forEach((child, index) => walk(child, `${at}${index}.`))
      : isObject(children) && messagesOf(children as any, at, flat)
  for (const [name, field] of Object.entries(report.fields ?? {})) {
    if (field?.messages?.length) flat[`${prefix}${name}`] = field.messages
    walk(field?.children, `${prefix}${name}.`)
  }
  return flat
}

// A report's messages a line each, by dotted path, such as title: This field is required.
export const linesOf = (report: { fields: Record<string, any> }) =>
  Object.entries(messagesOf(report)).flatMap(([path, messages]) => messages.map((message) => `${path}: ${message}`))

// Known as a ValidationError even from another copy of this module, such as a site's sorlo.config.ts loading
// @sorlo/cms apart from the CLI
const brand = Symbol.for('sorlo.ValidationError')

// What a before hook throws to refuse a write, with messages by dotted path, such as { 'pets.0.name': '…' } or
// { _entry: '…' } for the whole record, which merge into core's report, so the write replies 422 as any failed check
// does. What sorlo throws for a refused write, with that write's report.
export class ValidationError extends Error {
  readonly messages: Record<string, Array<string>>
  readonly report: ValidationReport
  constructor(messages: Record<string, string | Array<string>>) {
    const list = Object.fromEntries(Object.entries(messages ?? {}).map(([path, each]) => [path, [each].flat()]))
    const report = refusedReport(list)
    super(linesOf(report).join('\n') || 'The write was refused.')
    this.name = 'ValidationError'
    this.messages = list
    this.report = report
    Object.defineProperty(this, brand, { value: true })
  }
}

const isValidationError = (error: unknown): error is ValidationError =>
  error instanceof ValidationError || (isObject(error) && (error as any)[brand] === true)

// A refused write that isn't a save, such as an archive, replying 422 with the hooks' report, as a refused save does
export class Refusal extends HTTPException {
  constructor(readonly report: ValidationReport) {
    super(422, { message: linesOf(report).join('\n') })
  }
}

// Refusals that sorlo passes on from a write a hook made, which refuse that write, never the one whose hook made it
const passedOn = new WeakSet<object>()
export function refusalOf(report: ValidationReport) {
  const error = new ValidationError(messagesOf(report))
  Object.defineProperty(error, 'report', { value: report })
  passedOn.add(error)
  return error
}

type Kind = 'content' | 'media' | 'forms'

const hookNames = {
  content: [
    'beforeSave',
    'afterSave',
    'beforePublish',
    'afterPublish',
    'beforeUnpublish',
    'afterUnpublish',
    'beforeArchive',
    'afterArchive',
    'beforeRestore',
    'afterRestore',
  ],
  media: ['beforeSave', 'afterSave'],
  forms: ['beforeSave', 'afterSave', 'beforeArchive', 'afterArchive', 'beforeRestore', 'afterRestore'],
}
const settingOf = { content: 'contentHooks', media: 'mediaHooks', forms: 'formHooks' } as const
type HookName = (typeof hookNames.content)[number]

export interface HookSettings {
  contentHooks?: ContentHooks
  mediaHooks?: MediaHooks
  formHooks?: FormHooks
  plugins?: Array<Plugin>
}

export interface SiteHooks {
  // The hooks a write runs, in order: each plugin's, then the site's, '*' before the type's or form's own
  chain(kind: Kind, key: string | undefined, name: HookName): Array<{ label: string; run: (args: any) => any }>
  // Whether any type or form has the hook, so a write reads records for its hooks only when one would get them
  has(kind: Kind, name: HookName): boolean
  // The sorlo API for a write's hooks, which the app gives once it's put together
  sorlo?: (run: Run) => Sorlo
}

// The site's hooks from sorlo.config.ts and its plugins, checked as the servers start: each a function under one of the
// hooks' names
export function siteHooks({ plugins = [], ...site }: HookSettings = {}): SiteHooks {
  const sources = [
    ...plugins.map((plugin) => ({ settings: plugin as HookSettings, from: `from the plugin ${plugin.name}` })),
    { settings: site, from: 'in sorlo.config.ts' },
  ]
  const keyed = (key: string) => (/^[a-z]\w*$/i.test(key) ? `.${key}` : `['${key}']`)
  const problems: Array<string> = []
  const check = (kind: Kind, at: string, hooks: unknown, from: string) => {
    if (!isObject(hooks)) return void problems.push(`${at} ${from} needs to be an object of hooks.`)
    for (const [name, hook] of Object.entries(hooks)) {
      if (!hookNames[kind].includes(name)) {
        problems.push(`${at}.${name} ${from} isn't a hook. They're ${hookNames[kind].join(', ')}.`)
      } else if (typeof hook !== 'function') problems.push(`${at}.${name} ${from} needs to be a function.`)
    }
  }
  for (const { settings, from } of sources) {
    for (const kind of ['content', 'forms'] as const) {
      const setting = settings[settingOf[kind]]
      if (setting === undefined) continue
      if (!isObject(setting)) problems.push(`${settingOf[kind]} ${from} needs to be an object.`)
      else
        for (const [key, hooks] of Object.entries(setting)) check(kind, `${settingOf[kind]}${keyed(key)}`, hooks, from)
    }
    if (settings.mediaHooks !== undefined) check('media', 'mediaHooks', settings.mediaHooks, from)
  }
  if (problems.length) throw new Error(problems.join('\n'))

  const named = new Set(
    sources.flatMap(({ settings }) =>
      (['content', 'media', 'forms'] as const).flatMap((kind) => {
        const setting: any = settings[settingOf[kind]]
        const sets = kind === 'media' ? [setting] : Object.values(setting ?? {})
        return sets.flatMap((hooks: any) => Object.keys(hooks ?? {}).map((name) => `${kind} ${name}`))
      }),
    ),
  )
  return {
    has: (kind, name) => named.has(`${kind} ${name}`),
    chain: (kind, key, name) =>
      sources.flatMap(({ settings, from }) => {
        const setting: any = settings[settingOf[kind]]
        const sets: Array<[string, any]> =
          kind === 'media'
            ? [['', setting]]
            : [
                ['*', setting?.['*']],
                ...(key !== undefined && key !== '*' ? [[key, setting?.[key]] as [string, any]] : []),
              ]
        return sets.flatMap(([at, hooks]) =>
          typeof hooks?.[name] === 'function'
            ? [{ label: `${settingOf[kind]}${at && keyed(at)}.${name} ${from}`, run: hooks[name] }]
            : [],
        )
      }),
  }
}

// Who a write acts as, where it came from, and the context its hooks share
export interface Run {
  user: HookUser | null
  source: HookSource
  // The CMS's address as the request saw it, for files' URLs
  origin?: string
  context?: Record<string | symbol, any>
  // For a before hook's sorlo, the transaction of the write whose hook it is, which its reads and writes go through,
  // so they see what that write has done so far and go with it, and that write, whose after hooks its own join
  trx?: Kysely<Database>
  parent?: Write
}

// How deep writes through sorlo can nest, which is likely a loop
export const maxDepth = 5
export const depthKey = Symbol('depth')
// The records whose own before hooks are running, which are locked until their write ends
export const busyKey = Symbol('busy')

type Base = Pick<HookArgs<unknown>, 'operation' | 'values' | 'original' | 'entry'>

// One write's hooks: the before hooks it runs as it goes, the after hooks it queues to run once it commits, and the
// warnings they add
export class Write {
  readonly warned: Array<[string, string]> = []
  readonly context: Record<string | symbol, any>
  private queued: Array<() => Promise<void>> = []

  constructor(
    readonly hooks: SiteHooks | undefined,
    readonly run: Run,
  ) {
    this.context = run.context ?? {}
  }

  // A before hook's, given the write's transaction, and an after hook's, which comes once it has committed
  private args(base: Base, trx?: Kysely<Database>) {
    const inside = trx ? { trx, parent: this } : { trx: undefined, parent: undefined }
    return {
      ...structuredClone(base),
      user: this.run.user,
      source: this.run.source,
      context: this.context,
      sorlo: this.hooks!.sorlo!({ ...this.run, ...inside, context: this.context }),
      warn: (path: string, message: string) => void this.warned.push([String(path), String(message)]),
    }
  }

  // Runs the before hooks named for a record, in order. beforeSave's each get the values the one before returned,
  // which check runs core's checks on again, and a hook whose values fail them, or that throws anything but a
  // ValidationError, fails the write as a server error naming it, since the person writing can't fix it. Gives the
  // values to write, or the refusal's messages. id is the record the write has locked, which its hooks can't write, and
  // trx the write's transaction, which their sorlo goes through.
  async before(
    kind: Kind,
    key: string | undefined,
    name: HookName,
    base: Base,
    {
      check,
      id,
      trx,
    }: {
      check?: (values: Values) => Promise<{ values: Values; report: ValidationReport }>
      id?: string
      trx?: Kysely<Database>
    } = {},
  ): Promise<{ values: Values; refused?: undefined } | { refused: Record<string, Array<string>> }> {
    const chain = this.hooks?.chain(kind, key, name) ?? []
    let values = base.values
    const busy: Set<string> = (this.context[busyKey] ??= new Set())
    const locked = id !== undefined && !busy.has(id)
    if (locked) busy.add(id)
    try {
      for (const { label, run } of chain) {
        let returned: unknown
        try {
          returned = await run(this.args({ ...base, values }, trx))
        } catch (error) {
          if (isValidationError(error) && !passedOn.has(error)) return { refused: error.messages }
          console.error(`${label} failed:`, error)
          throw new HTTPException(500, { message: `${label} failed. The server's log says why.` })
        }
        if (name !== 'beforeSave' || returned === undefined) continue
        const checked = isObject(returned) ? await check!(returned) : undefined
        if (!checked?.report.isValid) {
          const why = checked ? linesOf(checked.report).join('\n  ') : "it didn't return an object of values"
          console.error(`${label} returned values that don't pass their checks:\n  ${why}`)
          throw new HTTPException(500, {
            message: `${label} returned values that don't pass their checks. The server's log says why.`,
          })
        }
        values = checked.values
      }
      return { values }
    } finally {
      if (locked) busy.delete(id)
    }
  }

  // Whether any hooks are named for a record, so a write reads what they'd get only when they'd get it
  wants(kind: Kind, key: string | undefined, name: HookName) {
    return !!this.hooks?.chain(kind, key, name).length
  }

  // Queues the after hooks named for a record, to run once the write commits, with the record as the write left it.
  // Their errors are logged, since the write has happened.
  after(kind: Kind, key: string | undefined, name: HookName, base: Base) {
    const chain = this.hooks?.chain(kind, key, name) ?? []
    if (!chain.length) return
    this.queued.push(async () => {
      for (const { label, run } of chain) {
        try {
          await run(this.args(base))
        } catch (error) {
          console.error(`${label} failed after the write, which stands:`, error)
        }
      }
    })
  }

  // Runs the queued after hooks, once the write has committed. A write a before hook made through sorlo commits with
  // the write whose hook it is, so its after hooks join that write's.
  async flush() {
    const queued = this.queued.splice(0)
    if (this.run.parent) return void this.run.parent.queued.push(...queued)
    for (const run of queued) await run()
  }

  // Forgets the queued after hooks of a write that didn't happen
  drop() {
    this.queued = []
  }

  // What a successful write's reply adds: its hooks' warnings, if any
  get reply(): { warnings?: Warnings } {
    return this.warned.length ? { warnings: warningsOf(this.warned) } : {}
  }
}
