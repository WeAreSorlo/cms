import type { VersionOptions } from '.'
import type { ContentMigrationFile } from './content'
import { flattenValidationReport, inputs, pickValues, validateServerValues } from './core'
import { Database, uuidv7 } from './db'
import { entrySaver } from './entries'
import { FormRow, FormValues, checkForm, opening, saveForm } from './forms'
import { findMedia, saveMediaDetails } from './media'
import { EntryRow, toAdminEntry, withStatus } from './query'
import { formsOf } from './relations'
import { mediaSchema } from './schemas'
import type { ContentType } from './types'
import { HTTPException } from 'hono/http-exception'
import type { ValidationReport } from 'iight'
import { Insertable, Kysely, Selectable, sql } from 'kysely'
import { isDeepStrictEqual } from 'node:util'

// The changes the assistant proposes in a chat, which the person applies, saving drafts as themselves, or applies and
// publishes, or skips (PLAN.md section 21). They live in a table of their own, since a chat's messages are only ever
// added to, and what became of them reaches the model with the person's next message.

export type ProposalRow = Selectable<Database['proposals']>

// What an entry proposal sets: a new entry's values and parent, or only the top-level fields a change sets, with a
// page's parent when it moves it
export interface EntryChange {
  values: Record<string, any>
  parentId?: string | null
}

// What the chat shows beside a proposal: what it changes is called, an entry's title as it stands, a form's label or a
// file's name, and for an entry that exists, its status, since publishing makes all of its draft live, and for an
// image, where it's served
interface Shown {
  title?: string | null
  entryStatus?: 'draft' | 'published' | 'changed'
  image?: string | null
}

// A proposal as the chat shows it, with the proposed forms an entry names, which applying it makes first
export const toProposal = (row: ProposalRow, needs: Array<string> = [], shown: Shown = {}) => ({
  id: row.id,
  kind: row.kind,
  targetId: row.target_id,
  isNew: row.is_new,
  type: row.type,
  before: row.before,
  after: row.after,
  status: row.status,
  version: row.version,
  published: row.published,
  needs,
  ...shown,
})
export type Proposal = ReturnType<typeof toProposal>

// When what a proposal changes has changed since it was proposed, so applying it would overwrite a newer edit
export class Stale extends Error {}
const staleMessage =
  'Not applied: what it changes has been changed since it was proposed. Ask the assistant for a fresh proposal.'
const goneMessage = 'Not applied: what it changes has been deleted since it was proposed.'

// Whether an entry's current values and parent still hold what a change found, for every field it sets and a page's
// parent when it moves it, so applying it can't overwrite an edit made since
export const unchanged = (current: EntryRow, before: EntryChange, after: EntryChange) =>
  Object.keys(after.values).every((name) => isDeepStrictEqual(current.values[name], before.values[name])) &&
  (!Object.hasOwn(after, 'parentId') || current.parent_id === before.parentId)

// What an entry change saves: a new entry as proposed, or the fields it sets on the entry as it is now
export const changedEntry = (after: EntryChange, current?: EntryRow) =>
  current
    ? {
        values: { ...current.values, ...after.values },
        parentId: Object.hasOwn(after, 'parentId') ? after.parentId! : current.parent_id,
      }
    : { values: after.values, parentId: after.parentId ?? null }

export const sameForm = (form: FormRow, values: FormValues) =>
  isDeepStrictEqual({ name: form.name, label: form.label, fields: form.fields }, values)

// A file's name, alt text or caption that a proposal changes, as none when empty
export type MediaChange = Partial<Record<'name' | 'alt' | 'caption', string | null>>

// Whether a file still holds what a change found, for every detail it sets
export const sameMedia = (current: Record<string, unknown>, before: MediaChange, after: MediaChange) =>
  Object.keys(after).every((name) => (current[name] ?? null) === (before[name as keyof MediaChange] ?? null))

// How applying lands: as a draft, or published, for which a form opens, and the CMS's address, for the event a change
// to a file writes
export interface ApplyOptions {
  publish?: boolean
  origin: string
}

// The pending form proposals each entry proposal names in its form fields, by proposal
function needsOf(rows: Array<ProposalRow>, types: Map<string, ContentType>) {
  const forms = rows.filter((row) => row.kind === 'form' && row.is_new && row.status === 'pending')
  return (row: ProposalRow) => {
    const type = row.kind === 'entry' && row.status === 'pending' && forms.length && types.get(row.type!)
    if (!type) return []
    const named = formsOf(type, row.after.values ?? {})
    return forms.filter((form) => named.includes(form.target_id)).map((form) => form.id)
  }
}

// A core report's messages a line each, by path, such as values.slug: Another entry here already uses this slug.
export const messagesOf = (report: ValidationReport, prefix = '') =>
  Object.entries(flattenValidationReport(report).messages)
    .flatMap(([path, messages]) => messages.map((message) => `${prefix}${path}: ${message}`))
    .join('\n')

// A chat's proposals, and applying and skipping them, as its person
export function proposals(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  migrations: () => Promise<Record<string, ContentMigrationFile>>,
  versions?: VersionOptions,
) {
  const saver = entrySaver(db, types, migrations, versions)
  const rowsOf = (chat: string) =>
    db.selectFrom('proposals').selectAll().where('chat_id', '=', chat).orderBy('created_at').orderBy('id').execute()

  // Records a proposal the assistant made with a tool call
  const propose = async (
    chat: string,
    call: string,
    proposal: Omit<Insertable<Database['proposals']>, 'id' | 'chat_id' | 'tool_use_id'>,
  ) => {
    const id = uuidv7()
    await db
      .insertInto('proposals')
      .values({ ...proposal, id, chat_id: chat, tool_use_id: call })
      .execute()
    return id
  }

  // The ids of the forms proposed in the chat and not made yet, which an entry proposed there can name
  const pendingForms = async (chat: string) =>
    (
      await db
        .selectFrom('proposals')
        .select('target_id')
        .where('chat_id', '=', chat)
        .where('kind', '=', 'form')
        .where('is_new', '=', true)
        .where('status', '=', 'pending')
        .execute()
    ).map((row) => row.target_id)

  // A chat's proposals as it shows them, by the tool call that made each
  const byCall = async (chat: string) => {
    const rows = await rowsOf(chat)
    const needs = needsOf(rows, types)
    const targets = (kind: ProposalRow['kind']) =>
      rows.filter((row) => row.kind === kind && !row.is_new).map((row) => row.target_id)
    const [changed, files] = [targets('entry'), targets('media')]
    const entries = changed.length ? await withStatus(db).selectAll().where('id', 'in', changed).execute() : []
    const media = files.length
      ? await db.selectFrom('media').select(['id', 'name', 'mime']).where('id', 'in', files).execute()
      : []
    const shownOf = (row: ProposalRow): Shown => {
      if (row.kind === 'form') return { title: row.after.label as string }
      if (row.kind === 'media') {
        const file = media.find((file) => file.id === row.target_id)
        const image = file?.mime.startsWith('image/') ? `/media/${file.id}/${encodeURIComponent(file.name)}` : null
        return { title: file?.name ?? null, image }
      }
      const type = types.get(row.type ?? '')
      const entry = entries.find((entry) => entry.id === row.target_id)
      const values = row.is_new ? row.after.values : entry?.values
      const title = type?.titleField && values?.[type.titleField]
      return {
        title: type?.structure === 'singleton' ? type.label : typeof title === 'string' && title.trim() ? title : null,
        ...(entry && { entryStatus: toAdminEntry(entry).status as Shown['entryStatus'] }),
      }
    }
    const calls = new Map<string, Array<Proposal>>()
    for (const row of rows) {
      calls.set(row.tool_use_id, [...(calls.get(row.tool_use_id) ?? []), toProposal(row, needs(row), shownOf(row))])
    }
    return calls
  }

  // A chat's proposals as it shows them, by id
  const byId = async (chat: string) =>
    new Map([...(await byCall(chat)).values()].flat().map((proposal) => [proposal.id, proposal]))

  // Marks a proposal decided in the transaction that applied it, unless another request got there first
  const claim =
    (id: string, user: string, published: boolean) => async (trx: Kysely<Database>, version: number | null) => {
      const { numUpdatedRows } = await trx
        .updateTable('proposals')
        .set({ status: 'applied', version, published, decided_by: user, decided_at: sql`now()` })
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .executeTakeFirst()
      if (!numUpdatedRows) throw new HTTPException(409, { message: 'It was already applied or skipped.' })
    }

  // Opens the forms a page names that Apply made in the chat and that have never been open, in the transaction that
  // makes the page live, since a live page with a closed form refuses sign-ups
  const openMade = async (trx: Kysely<Database>, chat: string, named: Array<string>) => {
    if (!named.length) return
    const made = trx
      .selectFrom('proposals')
      .select('target_id')
      .where('chat_id', '=', chat)
      .where('kind', '=', 'form')
      .where('is_new', '=', true)
      .where('status', '=', 'applied')
    const opened = await trx
      .updateTable('forms')
      .set(opening)
      .where('id', 'in', named)
      .where('id', 'in', made)
      .where('first_opened_at', 'is', null)
      .returning('id')
      .execute()
    if (!opened.length) return
    await trx
      .updateTable('proposals')
      .set({ published: true })
      .where('chat_id', '=', chat)
      .where('kind', '=', 'form')
      .where(
        'target_id',
        'in',
        opened.map((form) => form.id),
      )
      .execute()
  }

  const markStale = (id: string, user: string) =>
    db
      .updateTable('proposals')
      .set({ status: 'stale', decided_by: user, decided_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute()

  // Saves an entry proposal's draft as the person, through the editor's own save, linked to the chat, and with publish
  // makes it live with every check a publish runs, as the editor's Publish does. A type without drafts publishes every
  // save. Going live opens the forms the page shows that Apply made closed.
  const applyEntry = async (row: ProposalRow, user: string, publish: boolean) => {
    const type = types.get(row.type!)
    if (!type) throw new HTTPException(409, { message: 'Its content type has been removed.' })
    const applied = await saver.migrated()
    // Values proposed before a content migration ran have the fields as they were
    if ((applied.at(-1) ?? null) !== row.migration) throw new Stale()
    const after = row.after as EntryChange
    const live = publish || type.drafts === false
    let values: Record<string, any> = {}
    const saved = await saver.saveEntry(
      type,
      user,
      applied,
      live,
      (current) => {
        if (current && !unchanged(current, row.before as EntryChange, after)) throw new Stale()
        const changed = changedEntry(after, current)
        values = changed.values
        return changed
      },
      row.is_new ? undefined : row.target_id,
      {
        via: { chat: row.chat_id },
        newId: row.is_new ? row.target_id : undefined,
        during: async (trx, version) => {
          await claim(row.id, user, live)(trx, version)
          if (live) await openMade(trx, row.chat_id, formsOf(type, values))
        },
      },
    )
    return saved.report
  }

  // Makes or changes a form as the person: closed, as every form through AI is until a person opens it, or open with
  // publish, which is the person opening it
  const applyForm = async (row: ProposalRow, user: string, publish: boolean) => {
    const checked = await checkForm(db, row.after, row.is_new ? undefined : { id: row.target_id })
    if (checked.report) return checked.report
    const saved = await saveForm(db, user, checked.form, row.is_new ? undefined : row.target_id, {
      id: row.is_new ? row.target_id : undefined,
      open: publish || (row.is_new ? false : undefined),
      guard: (current) => {
        if (current.open) {
          throw new HTTPException(409, { message: "It's taking submissions now, so only a person can change it." })
        }
        if (!sameForm(current, row.before as FormValues)) throw new Stale()
      },
      during: (trx, form) => claim(row.id, user, publish)(trx, form.version),
    })
    return saved.report
  }

  // Changes a file's details as the person, through the media library's own save. Files have no drafts, so it shows on
  // the site at once.
  const applyMedia = async (row: ProposalRow, user: string, origin: string) => {
    const after = row.after as MediaChange
    const file = await findMedia(db, row.target_id)
    const values = pickValues(mediaSchema, { name: file.name, alt: file.alt, caption: file.caption, ...after }, inputs)
    const report = await validateServerValues(mediaSchema, values, inputs)
    if (!report.isValid) return report
    // The name as it's checked, only when it changes, since the file may have been renamed meanwhile
    const changes = { ...after, ...(Object.hasOwn(after, 'name') && { name: values.name }) }
    await saveMediaDetails(db, row.target_id, changes, origin, {
      guard: (current) => {
        if (!sameMedia(current, row.before as MediaChange, after)) throw new Stale()
      },
      during: (trx) => claim(row.id, user, true)(trx, null),
    })
  }

  // Each proposal's result, with the proposal as it ends up, which a failure leaves pending or makes stale
  type Result = { id: string; status: number; data?: Proposal; message?: string; report?: ValidationReport }

  // What stopped a proposal applying, or nothing once it's applied
  const tryApply = async (
    row: ProposalRow,
    user: string,
    { publish = false, origin }: ApplyOptions,
  ): Promise<Omit<Result, 'id'> | undefined> => {
    try {
      const report =
        row.kind === 'form'
          ? await applyForm(row, user, publish)
          : row.kind === 'media'
            ? await applyMedia(row, user, origin)
            : await applyEntry(row, user, publish)
      if (report)
        return {
          status: 422,
          message: `Not applied, since it doesn't pass its checks now:\n${messagesOf(report)}`,
          report,
        }
    } catch (error) {
      if (error instanceof Stale) {
        await markStale(row.id, user)
        return { status: 409, message: staleMessage }
      }
      // Two requests made the same new entry or form at once, and the first won
      const constraint = (error as { constraint?: string }).constraint
      if (constraint === 'entries_pkey' || constraint === 'forms_pkey')
        return { status: 409, message: 'It was already applied.' }
      if (!(error instanceof HTTPException)) throw error
      if (error.status === 404) {
        await markStale(row.id, user)
        return { status: 409, message: goneMessage }
      }
      return { status: error.status, message: error.message }
    }
  }

  // Applies one of the chat's pending proposals, after the proposed forms it names, replying a result for each. A
  // failed check leaves it pending, and what it changes having changed since makes it stale.
  const applyOne = async (chat: string, id: string, user: string, options: ApplyOptions): Promise<Array<Result>> => {
    const rows = await rowsOf(chat)
    const row = rows.find((row) => row.id === id)
    if (!row) return [{ id, status: 404, message: "There's no proposal with this id in this chat." }]
    const results: Array<Result> = []
    const needs = needsOf(rows, types)(row)
    const failure =
      row.status !== 'pending'
        ? { status: 409, message: 'It was already applied or skipped.' }
        : await (async () => {
            // Made closed, and opened only once the page goes live, since the page may fail its own checks
            for (const need of needs) {
              const [made] = await applyOne(chat, need, user, { ...options, publish: false })
              results.push(made)
              if (made.status !== 200)
                return { status: 409, message: `Not applied, since its form wasn't made: ${made.message}` }
            }
            return tryApply(row, user, options)
          })()
    return [...results, { id, status: 200, ...failure }]
  }

  const apply = async (chat: string, ids: Array<string>, user: string, options: ApplyOptions) => {
    const rows = await rowsOf(chat)
    const needs = needsOf(rows, types)
    // A form that a page in the batch shows is made closed, and opens only once the page goes live
    const shown = new Set(rows.filter((row) => ids.includes(row.id)).flatMap(needs))
    const results: Array<Result> = []
    for (const id of ids) {
      const own = shown.has(id) ? { ...options, publish: false } : options
      // A form that an entry before it named was applied with it
      if (!results.some((done) => done.id === id)) results.push(...(await applyOne(chat, id, user, own)))
    }
    // Each with the proposal as the chat shows it now, its warnings and image included
    const now = await byId(chat)
    return results.map((result) => ({ ...result, data: now.get(result.id) }))
  }

  // Skips pending proposals, and with a proposed form, the entries proposed to name it
  const skip = async (chat: string, ids: Array<string>, user: string) => {
    const rows = await rowsOf(chat)
    const needs = needsOf(rows, types)
    const skipping = new Set(
      rows.filter((row) => ids.includes(row.id) && row.status === 'pending').map((row) => row.id),
    )
    for (const row of rows) if (needs(row).some((need) => skipping.has(need))) skipping.add(row.id)
    if (!skipping.size) return []
    const skipped = await db
      .updateTable('proposals')
      .set({ status: 'skipped', decided_by: user, decided_at: sql`now()` })
      .where('id', 'in', [...skipping])
      .where('status', '=', 'pending')
      .returningAll()
      .execute()
    const now = await byId(chat)
    return skipped.map((row) => now.get(row.id) ?? toProposal(row))
  }

  // Skips the proposals a round made that was never stored, such as when another tab wrote first, since no step shows
  // them and the model never saw them. No one decided them, so the model never hears of them.
  const drop = async (chat: string, calls: Array<string>) => {
    if (!calls.length) return
    await db
      .updateTable('proposals')
      .set({ status: 'skipped' })
      .where('chat_id', '=', chat)
      .where('tool_use_id', 'in', calls)
      .where('status', '=', 'pending')
      .execute()
  }

  // What became of the chat's proposals since a time, for the system message after the person's next message. Only
  // ids and fixed words, since a system message carries the weight of instructions.
  const outcomes = async (chat: string, since?: Date) => {
    const rows = await rowsOf(chat)
    const decided = (status: ProposalRow['status']) =>
      rows
        .filter((row) => row.status === status && row.decided_at && (!since || row.decided_at > since))
        .map((row) => row.id)
    const [applied, skipped, stale] = [decided('applied'), decided('skipped'), decided('stale')]
    const published = applied.filter((id) => rows.find((row) => row.id === id)!.published)
    const drafts = applied.filter((id) => !published.includes(id))
    const pending = rows.filter((row) => row.status === 'pending').map((row) => row.id)
    const list = (ids: Array<string>) =>
      ids.length > 20 ? `${ids.slice(0, 20).join(', ')} and ${ids.length - 20} more` : ids.join(', ')
    const of = (count: number) => (count === 1 ? '1 of your proposals' : `${count} of your proposals`)
    const done = [
      drafts.length && `applied ${of(drafts.length)} as drafts: ${list(drafts)}`,
      published.length && `applied and published ${of(published.length)}: ${list(published)}`,
      skipped.length && `skipped ${of(skipped.length)}: ${list(skipped)}`,
    ].filter(Boolean)
    return [
      done.length && `Since your last reply, the person ${done.join('; ')}.`,
      stale.length &&
        `${of(stale.length)} couldn't be applied, since what they change was changed after you proposed them: ${list(stale)}.`,
      pending.length && `${of(pending.length)} still wait for them: ${list(pending)}.`,
    ]
      .filter(Boolean)
      .join(' ')
  }

  return { propose, pendingForms, byCall, apply, skip, drop, outcomes, saver }
}
