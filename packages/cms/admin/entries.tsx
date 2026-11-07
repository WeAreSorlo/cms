import { maxTicked } from '../src/schemas'
import {
  ContentType,
  Entry,
  SectionContext,
  TypesContext,
  allEntries,
  api,
  count,
  date,
  errorMessage,
  formatField,
  formatValue,
  listView,
  matchingOf,
  shortDate,
  titleOf,
  tree,
  usePageView,
} from './api'
import { AssistantContext, useBeside } from './chat'
import { useInputs } from './fields'
import {
  Ticks,
  changeTicks,
  entryFields,
  fieldChoicesOf,
  filterOf,
  sortable,
  ticksOf,
  watchTicks,
  whereOf,
} from './lists'
import { UsedBy } from './media'
import {
  Badge,
  EmptyState,
  IconButton,
  ListFilters,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Pagination,
  Panel,
  StatusBadge,
  TypeIcon,
  focusHeading,
  focusInvalid,
  useConfirm,
  useListQuery,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle, ValidationReport } from '@sorlo/core'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  CircleAlert,
  Plus,
  SearchX,
  Sheet,
  Trash2,
} from 'lucide-react'
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// A cell's text, or a dash when there's nothing
export function CellText({ text }: { text: string }) {
  if (text) return text
  return (
    <>
      <span className='cms-muted' aria-hidden>
        –
      </span>
      <span className='cms-visually-hidden'>None</span>
    </>
  )
}

// A list cell: the value as its input formats it, Yes for a ticked box, and a dash when there's nothing
export const FieldValue = ({ field, value }: { field?: FieldSchema; value: unknown }) => (
  <CellText text={field?.type === 'boolean' ? (value ? 'Yes' : '') : formatValue(field, value)} />
)

// The line above a list's table while its ticks can reach past the page, or do: how many are ticked, Select all for
// every entry the list holds once the whole page is ticked, and Untick all. Select all becomes Untick all in place, so
// focus stays on it. Its words are a status, so ticking the page reads them out.
export function TickedLine({
  ticked,
  onPage,
  shown,
  total,
  every,
  matching,
  selecting = false,
  problem,
  onSelectAll,
  onUntickAll,
}: {
  // How many are ticked, how many of them are on this page, and how many rows the page shows
  ticked: number
  onPage: number
  shown: number
  // How many entries the list holds, and whether the last Select all ticked every one of them, which are still ticked
  total?: number
  every: boolean
  // What its search and filter find, such as matching your filter, when it has either
  matching?: string
  selecting?: boolean
  problem?: string
  onSelectAll: () => void
  onUntickAll: () => void
}) {
  const these =
    total === undefined ? '' : matching ? `${total.toLocaleString()} ${matching}` : count(total, 'entry', 'entries')
  const canSelect = shown > 0 && onPage === shown && total !== undefined && total > shown && !every
  // Every entry the list holds, past this page
  const everyShown = every && total !== undefined && total > shown
  const elsewhere = ticked - onPage
  const line = everyShown || canSelect || elsewhere > 0
  const text = !line
    ? ''
    : everyShown
      ? `All ${these} are ticked${ticked > total ? `, ${ticked.toLocaleString()} in all` : ''}.`
      : elsewhere > 0
        ? `${ticked.toLocaleString()} ticked, ${onPage.toLocaleString()} on this page.`
        : `All ${count(shown, 'entry', 'entries')} on this page are ticked.`
  const tooMany = canSelect && total > maxTicked
  const buttons = [
    canSelect && !tooMany && { label: selecting ? 'Selecting…' : `Select all ${these}`, onClick: onSelectAll },
    (everyShown || elsewhere > 0) && { label: 'Untick all', onClick: onUntickAll },
  ].filter((button) => !!button)

  return (
    <div className='cms-ticked' data-shown={line || !!problem || undefined}>
      <p role='status'>
        {text}
        {tooMany && ` Narrow the search or filter to ${maxTicked.toLocaleString()} or fewer to select them all.`}
      </p>
      {buttons.map((button, at) => (
        <button
          // By place, so Select all stays the same button once it becomes Untick all
          key={at}
          type='button'
          className='link'
          aria-busy={(at === 0 && canSelect && selecting) || undefined}
          onClick={button.onClick}
        >
          {button.label}
        </button>
      ))}
      {problem && (
        <p className='cms-problem' role='alert'>
          <CircleAlert /> {problem}
        </p>
      )}
    </div>
  )
}

// A list's ticks and its run, as the admin keeps them, which change while a run goes on whatever page is open
const useTicks = (list: string) => useSyncExternalStore(watchTicks, () => ticksOf(list))

// The names of the automations that any of some events trigger, each of which can run once for every entry an action
// changes
async function automationsOn(events: Array<string>) {
  const automations: Array<{ name: string; triggers: Array<string> }> = (await api('GET', '/automations')).body.data
  return automations
    .filter((automation) => automation.triggers.some((event) => events.includes(event)))
    .map((automation) => automation.name)
}

// Such as Notify editors runs when entries are archived, so it can run once for every entry
const runsOnEach = (names: Array<string>, when: string) =>
  `${new Intl.ListFormat('en').format(names)} ${names.length === 1 ? 'runs' : 'run'} when entries are ${when}, so ${
    names.length === 1 ? 'it' : 'each'
  } can run once for every entry.`

// How many of some entries, counting the pages under them, other entries link to
// shortcut: past 10,000 ticked it asks 10,000 at a time, so links between two batches count too, ask once if that matters
async function linkedOf(type: ContentType, ids: Array<string>) {
  let linked = 0
  for (let at = 0; at < ids.length; at += maxTicked) {
    const { body } = await api('POST', `/types/${type.name}/entries/used-by`, { ids: ids.slice(at, at + maxTicked) })
    linked += body.data.count
  }
  return linked
}

// Such as 12 of them are linked from other entries, whose links to them will stop working on the site
function linkedText(linked: number, of: number, pages: boolean) {
  const one = linked === 1
  const which = of === 1 ? 'It' : `${linked.toLocaleString()} of them`
  const under = pages ? (one ? ', or a page under it,' : ', or pages under them,') : ''
  const is = !one ? ' are' : which === 'It' && !under ? "'s" : ' is'
  return `${which}${under}${is} linked from other entries, whose links to ${one ? 'it' : 'them'} will stop working on the site.`
}

// What the archive and restore routes reply for each entry they were sent
interface Result {
  id: string
  status: number
  message?: string
}

// A type's entries in its list columns: pages for a collection, the whole tree for a hierarchical, or the archive,
// with a search over the title field and a filter over the other fields, in the URL's query. Entries ticked here, as
// many as the list holds, can be bulk edited a hundred at a time, archived, or in the archive, restored.
export function EntryList({ type, archived = false, query }: { type: ContentType; archived?: boolean; query: string }) {
  const [rows, setRows] = useState<ReturnType<typeof tree>>()
  const [pagination, setPagination] = useState<Pagination>()
  const [sort, setSort] = useState<{ name: string; direction: 'asc' | 'desc' }>()
  const [error, setError] = useState('')
  // The entries ticked, in the order they were ticked, kept as pages, sorts and filters change, and until the tab
  // reloads, with the archive or restore under way and what the last one couldn't do
  const ticksKey = archived ? `${type.name}/archive` : type.name
  const { ticked, selected, run, ended, problem } = useTicks(ticksKey)
  const setTicks = (change: (now: Ticks) => Ticks) => changeTicks(ticksKey, change)
  const tickedIds = useMemo(() => [...ticked], [ticked])
  // The archive, search and filter the total was counted for, so the assistant's line never shows another's count
  const [counted, setCounted] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [lineProblem, setLineProblem] = useState('')
  // Bumped to load the list again as it is now, such as once Select all has ticked what it holds
  const [reloads, setReloads] = useState(0)
  const headerBox = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const list = useListQuery(query)
  const { page, setPage } = list
  const fields = useMemo(() => entryFields(type.fields), [type])
  const titleField = type.fields.find((field) => field.name === type.titleField)
  const search = list.params.get('search')?.trim()
  const { where, left } = whereOf(
    fields,
    filterOf(list.params),
    titleField && search ? [{ field: `values.${titleField.name}`, op: 'like', value: search }] : [],
  )
  // A search or filter lists the pages that match on pages of their own, rather than the whole tree
  const ordered = type.structure === 'hierarchical' && !archived && !where.length
  // Archived entries are never live, and without drafts, saved ones always are
  const statuses = !archived && type.drafts !== false
  const singular = type.singular ?? type.label

  const columns = (type.listColumns ?? [type.titleField ?? type.fields[0]?.name]).map((name) => {
    const field = type.fields.find((field) => field.name === name)
    return {
      name,
      field,
      label: field?.label ?? name,
      number: field?.type === 'number' || field?.type === 'range',
      sortable: !ordered && !!field && sortable.has(field.type),
    }
  })

  // A slow reply to an earlier search mustn't replace a newer one
  const loads = useRef(0)
  const filter = JSON.stringify(where)
  // The archive, search and filter the list shows, which its count and its last Select all were for
  const listing = `${archived}${filter}`
  const order = sort ? { [`values.${sort.name}`]: sort.direction } : { createdAt: 'desc' }
  const load = useCallback(async () => {
    const mine = ++loads.current
    try {
      if (ordered) {
        const entries = await allEntries(type)
        if (mine !== loads.current) return
        setRows(tree(entries))
        return setError('')
      }

      const params = new URLSearchParams({
        archived: String(archived),
        order: JSON.stringify(order),
        page: String(page),
      })
      if (where.length) params.set('where', filter)
      const { body } = await api('GET', `/types/${type.name}/entries?${params}`)
      if (mine !== loads.current) return
      // A page that isn't there now, as once its entries are archived, gives way to the last one that is
      if (page > body.pagination.lastPage) return setPage(body.pagination.lastPage)
      setRows(body.data.map((entry: Entry) => ({ entry, depth: 0, index: 0, siblings: 1 })))
      setPagination(body.pagination)
      setCounted(listing)
      setError('')
    } catch (error) {
      if (mine === loads.current) setError(errorMessage(error))
    }
  }, [type, archived, ordered, page, sort, filter])

  // A run that ends, on this page or after it was left, loads the list again
  useEffect(() => {
    load()
  }, [load, reloads, ended])

  // Once a run ends, focus that went with its button, which goes with the last of the ticks, moves to the page's
  // heading, as long as the list is still showing. Focus anywhere else stays put.
  const endedBefore = useRef(ended)
  useEffect(() => {
    if (ended === endedBefore.current) return
    endedBefore.current = ended
    if (document.activeElement === document.body) focusHeading()
  }, [ended])

  const move = async (entry: Entry, position: number) => {
    await api('PUT', `/entries/${entry.id}/position`, { position }).catch((error) => setError(errorMessage(error)))
    load()
  }

  // Each click sorts by the column, then the other way, then back to newest first
  const sortBy = (name: string) => {
    setPage(1)
    if (sort?.name !== name) setSort({ name, direction: 'asc' })
    else setSort(sort.direction === 'asc' ? { name, direction: 'desc' } : undefined)
  }

  // The assistant beside the list takes "these" to be the ticked entries, or those the search and filter match
  const total = ordered ? rows?.length : counted === listing ? pagination?.total : undefined
  const searched = !!search
  const filtered = filterOf(list.params).length > 0
  usePageView(
    listView(type, {
      ticked: tickedIds,
      where,
      order,
      total: ordered ? undefined : total,
      searched,
      filtered,
      archived,
    }),
  )

  const tick = (ids: Array<string>, on: boolean) =>
    setTicks((now) => {
      const ticked = new Set(now.ticked)
      for (const id of ids) {
        if (on) ticked.add(id)
        else ticked.delete(id)
      }
      return { ...now, ticked }
    })
  const shownIds = rows?.map(({ entry }) => entry.id) ?? []
  const onPage = shownIds.filter((id) => ticked.has(id)).length
  const pageTicked = shownIds.length > 0 && onPage === shownIds.length
  // The last Select all was for this list as it stands, it holds as many entries as were found, and all are ticked
  const every =
    selected?.listing === listing && selected.ids.length === total && selected.ids.every((id) => ticked.has(id))

  // Ticks every entry the list holds, after those already ticked, in the list's order
  const selectAll = async () => {
    if (selecting) return
    setSelecting(true)
    setLineProblem('')
    try {
      const params = new URLSearchParams({ archived: String(archived), order: JSON.stringify(order) })
      if (where.length) params.set('where', filter)
      const found: Array<string> = (await api('GET', `/types/${type.name}/entries/ids?${params}`)).body.data
      setTicks((now) => ({ ...now, ticked: new Set([...now.ticked, ...found]), selected: { listing, ids: found } }))
      // So the line counts what the list holds now
      setReloads((count) => count + 1)
    } catch (error) {
      setLineProblem(errorMessage(error))
    } finally {
      setSelecting(false)
    }
  }

  // The line goes, so focus moves to the box that ticks the page
  const untickAll = () => {
    setTicks((now) => ({ ...now, ticked: new Set(), selected: undefined, problem: undefined }))
    setLineProblem('')
    headerBox.current?.focus()
  }

  // Archives or restores the ticked entries a hundred at a time, unticking each hundred as it finishes. A page whose
  // parent comes back in a later hundred is tried again once the rest are done, until a round brings none back. What
  // a failure leaves is still ticked, for going on with. The run keeps to what's kept with the ticks, rather than this
  // page, so it goes on, and shows, if the list is left and comes back, and a second can't start, from the first click.
  const actOnTicked = async (action: 'archive' | 'restore') => {
    if (ticksOf(ticksKey).run) return
    const ids = [...ticksOf(ticksKey).ticked]
    const total = ids.length
    setTicks((now) => ({ ...now, run: { action, done: 0, total, asking: true }, problem: undefined }))
    const verb = action === 'archive' ? 'Archive' : 'Restore'
    const done = { count: 0, changed: 0 }
    let started = false
    let stopped: string | undefined
    try {
      const [listening, linked] = await Promise.all([
        automationsOn(action === 'archive' ? ['entry.archived', 'entry.unpublished'] : ['entry.restored']),
        action === 'archive' ? linkedOf(type, ids) : 0,
      ])
      const warning = listening.length > 0 && (
        <Notice tone='warning'>
          {runsOnEach(listening, action === 'archive' ? 'archived or unpublished' : 'restored')}
        </Notice>
      )
      const pages = type.structure === 'hierarchical'
      // Restoring asks first only when automations would run for each one
      const sure =
        (action === 'restore' && !warning) ||
        (await confirm({
          title: `${verb} ${count(total, 'entry', 'entries')}?`,
          body: (
            <>
              <p>
                {action === 'archive'
                  ? `Archived entries leave the live site${pages ? ', with the pages under them' : ''}. You can restore them from the archive.`
                  : 'Restored entries come back as drafts, to publish again.'}
              </p>
              {linked > 0 && <Notice tone='warning'>{linkedText(linked, total, pages)}</Notice>}
              {warning}
            </>
          ),
          action: verb,
          danger: action === 'archive',
        }))
      if (!sure) return

      started = true
      setTicks((now) => ({ ...now, run: { action, done: 0, total } }))
      let left = ids
      let refused: Array<Result> = []
      while (left.length) {
        refused = []
        for (let at = 0; at < left.length; at += 100) {
          const { body } = await api('POST', `/types/${type.name}/entries/${action}`, {
            ids: left.slice(at, at + 100),
          })
          const results: Array<Result> = body.data
          // Those archived or deleted since untick too, and leave the last Select all, since they've left the list
          const finished = results.filter((result) => result.status !== 409)
          refused.push(...results.filter((result) => result.status === 409))
          const gone = new Set(finished.map((result) => result.id))
          done.count += finished.length
          done.changed += finished.filter((result) => result.status === 200).length
          setTicks((now) => ({
            ...now,
            ticked: new Set([...now.ticked].filter((id) => !gone.has(id))),
            selected: now.selected && { ...now.selected, ids: now.selected.ids.filter((id) => !gone.has(id)) },
            run: { action, done: done.count, total },
          }))
        }
        if (refused.length === left.length) break
        left = refused.map((result) => result.id)
      }

      if (done.changed) toast(`${verb}d ${count(done.changed, 'entry', 'entries')}`)
      if (refused.length === 1) stopped = "A page wasn't restored, since its parent is archived. It's still ticked."
      else if (refused.length) {
        const pages = refused.length.toLocaleString()
        stopped = `${pages} pages weren't restored, since their parents are archived. They're still ticked.`
      }
    } catch (error) {
      const message = errorMessage(error).replace(/\.$/, '')
      const so = `${verb}d ${done.count.toLocaleString()} of ${count(total, 'entry', 'entries')}, then stopped`
      stopped = done.count
        ? `${so}: ${message}. The rest are still ticked, so ${verb} goes on with them.`
        : errorMessage(error)
    } finally {
      setTicks((now) => ({ ...now, run: undefined, problem: stopped, ended: now.ended + (started ? 1 : 0) }))
    }
  }

  // Past a hundred it says how far it's got, as Apply all does. While it asks first, it says nothing yet.
  const working = run && !run.asking
  const progress =
    working &&
    `${run.action === 'archive' ? 'Archiving' : 'Restoring'}${
      run.total > 100 ? ` ${run.done.toLocaleString()} of ${run.total.toLocaleString()}` : ''
    }…`

  const newEntry = (
    <a className='sorlo-button sorlo-button--primary' href={`#/types/${type.name}/new`}>
      <Plus /> New {singular}
    </a>
  )

  const searchSchema = useMemo<Array<FieldSchema>>(
    () =>
      titleField
        ? [
            {
              name: 'search',
              label: 'Search',
              type: 'text',
              options: { placeholder: titleField.label ?? titleField.name },
            },
          ]
        : [],
    [titleField],
  )
  const fieldChoices = useMemo(() => fieldChoicesOf(fields), [fields])
  const title = archived ? `${type.label}: archive` : type.label

  // Its button goes, so focus moves to the page's heading
  const clearFilters = () => {
    list.clear()
    focusHeading()
  }

  return (
    <div className='cms-page'>
      <PageHeader back={archived ? { href: `#/types/${type.name}`, label: type.label } : undefined} title={title} />
      <Panel
        label={title}
        sheet='Filters'
        problem={problem}
        actions={
          archived ? (
            ticked.size > 0 && (
              <button
                type='button'
                className='sorlo-button sorlo-button--primary'
                aria-busy={!!working}
                onClick={() => actOnTicked('restore')}
              >
                <ArchiveRestore /> {working ? progress : `Restore ${count(ticked.size, 'entry', 'entries')}`}
              </button>
            )
          ) : (
            <>
              {newEntry}
              {/* The grid opens the first hundred, and goes through the rest a hundred at a time */}
              {ticked.size > 0 && (
                <a className='sorlo-button' href={`#/types/${type.name}/bulk/${tickedIds.slice(0, 100).join(',')}`}>
                  <Sheet /> Bulk edit {count(ticked.size, 'entry', 'entries')}
                </a>
              )}
            </>
          )
        }
        footer={
          !archived && (
            <>
              {ticked.size > 0 && (
                <button
                  type='button'
                  className='sorlo-button sorlo-button--danger'
                  aria-busy={!!working}
                  onClick={() => actOnTicked('archive')}
                >
                  <Archive /> {working ? progress : `Archive ${count(ticked.size, 'entry', 'entries')}`}
                </button>
              )}
              <a className='sorlo-button' href={`#/types/${type.name}/archive`}>
                Open the archive
              </a>
            </>
          )
        }
      >
        <ListFilters
          list={list}
          schema={searchSchema}
          fieldChoices={fieldChoices}
          count={rows && (ordered ? rows.length : pagination?.total)}
          noun={['entry', 'entries']}
          left={left}
        />
      </Panel>
      <p className='cms-visually-hidden' role='status'>
        {progress || ''}
      </p>

      {error && <Notice tone='danger'>{error}</Notice>}
      {!rows && !error && <Loading />}
      {rows?.length === 0 &&
        (where.length ? (
          <EmptyState
            icon={<SearchX />}
            action={
              <button type='button' className='sorlo-button' onClick={clearFilters}>
                Clear filters
              </button>
            }
          >
            Nothing matches.
          </EmptyState>
        ) : archived ? (
          <EmptyState icon={<Archive />}>Nothing is archived.</EmptyState>
        ) : (
          <EmptyState icon={<TypeIcon name={type.icon} />} action={newEntry}>
            Nothing here yet.
          </EmptyState>
        ))}

      {!!rows?.length && (
        <TickedLine
          ticked={ticked.size}
          onPage={onPage}
          shown={shownIds.length}
          total={total}
          every={every}
          matching={where.length ? matchingOf(searched, filtered) : undefined}
          selecting={selecting}
          problem={lineProblem}
          onSelectAll={selectAll}
          onUntickAll={untickAll}
        />
      )}
      {!!rows?.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th className='cms-table__tick'>
                  <label>
                    <input
                      ref={(box) => {
                        headerBox.current = box
                        if (box) box.indeterminate = !pageTicked && onPage > 0
                      }}
                      type='checkbox'
                      aria-label='Select every entry on this page'
                      checked={pageTicked}
                      onChange={(event) => tick(shownIds, event.target.checked)}
                    />
                  </label>
                </th>
                {columns.map((column) => {
                  const direction = sort?.name === column.name ? sort.direction : undefined
                  return (
                    <th
                      key={column.name}
                      className={column.number ? 'cms-table__number' : undefined}
                      aria-sort={direction && (direction === 'asc' ? 'ascending' : 'descending')}
                    >
                      {column.sortable ? (
                        <button type='button' className='cms-table__sort' onClick={() => sortBy(column.name)}>
                          {column.label}
                          {direction === 'asc' ? (
                            <ArrowUp />
                          ) : direction === 'desc' ? (
                            <ArrowDown />
                          ) : (
                            <ChevronsUpDown className='cms-muted' />
                          )}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  )
                })}
                {statuses && <th>Status</th>}
                {ordered && <th>Order</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, depth, index, siblings }) => (
                <tr key={entry.id} className={ticked.has(entry.id) ? 'cms-table__selected' : undefined}>
                  <td className='cms-table__tick'>
                    <label>
                      <input
                        type='checkbox'
                        aria-label={`Select ${titleOf(type, entry)}`}
                        checked={ticked.has(entry.id)}
                        onChange={(event) => tick([entry.id], event.target.checked)}
                      />
                    </label>
                  </td>
                  {columns.map((column, position) => (
                    <td key={column.name} className={column.number ? 'cms-table__number' : undefined}>
                      {position === 0 ? (
                        <a href={`#/entries/${entry.id}`} style={{ paddingLeft: `${depth * 1.5}rem` }}>
                          {formatField(type, column.name, entry) || 'Untitled'}
                        </a>
                      ) : (
                        <FieldValue field={column.field} value={entry.values[column.name]} />
                      )}
                    </td>
                  ))}
                  {statuses && (
                    <td>
                      <StatusBadge status={entry.status} />
                    </td>
                  )}
                  {ordered && (
                    <td>
                      <IconButton label='Move up' disabled={index === 0} onClick={() => move(entry, index - 1)}>
                        <ArrowUp />
                      </IconButton>
                      <IconButton
                        label='Move down'
                        disabled={index === siblings - 1}
                        onClick={() => move(entry, index + 1)}
                      >
                        <ArrowDown />
                      </IconButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!ordered && !!pagination?.total && <Pages pagination={pagination} onPage={setPage} />}
    </div>
  )
}

export interface Version {
  number: number
  // What people call it, such as Before the rebrand
  name: string | null
  // Null once the user who saved it is deleted
  createdBy: { id: string; name: string } | null
  createdAt: string
  // The last time it went live, and who published it then, null once they're deleted
  publishedAt: string | null
  publishedBy: { id: string; name: string } | null
  // The assistant's chat or the MCP token it was saved through, with the chat's title, null once it's deleted, or the
  // token's name
  via: { kind: 'chat' | 'token'; id: string; name: string | null } | null
  // The one its last publish came through, or null for a publish in the editor
  publishedVia: Version['via']
}

// How a version was saved besides who saved it, such as through Claude Desktop, or with the assistant
export const viaText = (via: Version['via']) =>
  !via ? '' : via.kind === 'token' ? `, through ${via.name ?? 'an MCP token'}` : ', with the assistant'

// A version's page, which compares it with the one before
export const versionHref = (entry: Entry, version: Version) => `#/entries/${entry.id}/versions/${version.number}`

// An entry's versions, newest first: the current one, and the live one when that's older, until all of them are asked
// for. Each links to its page, and every version but the current one can be restored, unless the entry is archived.
export function Versions({
  versions,
  entry,
  drafts,
  defaultOpen = false,
  onRestore,
}: {
  versions: Array<Version>
  entry: Entry
  drafts: boolean
  defaultOpen?: boolean
  onRestore: (version: Version) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const current = versions[0]
  const few = versions.filter((version) => version === current || version.number === entry.publishedVersion)

  return (
    <section>
      <h2>Versions</h2>
      <ol id={id} className='cms-versions'>
        {(open ? versions : few).map((version) => (
          <li key={version.number}>
            <div>
              <div className='cms-versions__title'>
                <a href={versionHref(entry, version)}>{version.name ?? `Version ${version.number}`}</a>
                {version === current && <Badge tone='accent'>Current</Badge>}
                {drafts && version.number === entry.publishedVersion && <StatusBadge status='published' />}
              </div>
              {version.name && <div className='cms-versions__by'>Version {version.number}</div>}
              <div className='cms-versions__by'>
                {version.createdBy?.name ?? 'Deleted user'}
                {viaText(version.via)} · {shortDate(version.createdAt)}
              </div>
              {drafts && version.publishedAt && (
                <div className='cms-versions__by'>
                  Published by {version.publishedBy?.name ?? 'Deleted user'}
                  {viaText(version.publishedVia)} · {shortDate(version.publishedAt, false)}
                </div>
              )}
            </div>
            {version !== current && !entry.archivedAt && (
              <button
                type='button'
                className='sorlo-button'
                aria-label={`Restore version ${version.number}`}
                onClick={() => onRestore(version)}
              >
                Restore
              </button>
            )}
          </li>
        ))}
      </ol>
      {versions.length > few.length && (
        <button type='button' className='link' aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show all ${versions.length} versions`}
        </button>
      )}
    </section>
  )
}

// A version to put in the form when its entry's editor opens next, from Restore on the version's page
let restoreNext: { entryId: string; version: Version } | undefined
export const restoreOnOpen = (entryId: string, version: Version) => (restoreNext = { entryId, version })

// Create, edit and publish an entry with its type's fields, see the entries that link to it, and see and restore its
// versions
export function EntryEditor({ type, entry: loaded }: { type: ContentType; entry?: Entry }) {
  const form = useRef<FormHandle>(null)
  // The primary button at the top of the panel, Publish, Save or Restore, where focus goes once the button it
  // replaces goes, such as Unpublish, which only a live entry has
  const primaryButton = useRef<HTMLButtonElement>(null)
  // Around the forms, for finding the fields that stop a save
  const fields = useRef<HTMLDivElement>(null)
  const inputs = useInputs()
  const types = useContext(TypesContext)
  const confirm = useConfirm()
  const toast = useToast()
  const [entry, setEntry] = useState(loaded)
  // The assistant beside the editor takes "this" to be the entry, once it's saved
  usePageView(entry ? { page: { entry: entry.id }, label: titleOf(type, entry) } : null)
  // A new entry starts from its fields' defaults, as core's new flexible blocks do, so conditions can see them
  const [values, setValues] = useState<Record<string, any>>(
    () => loaded?.values ?? Object.fromEntries(type.fields.map((field) => [field.name, field.defaultValue])),
  )
  // What the form starts from, replaced only to load a version. Passing every change back would let the form
  // adopt a stale copy while an input is still updating, such as a slug generated from the title.
  const [shown, setShown] = useState(values)
  const [parentId, setParentId] = useState(loaded?.parentId ?? null)
  // What the parent picker starts from, replaced only to load a version, as the form's values are
  const [shownParent, setShownParent] = useState({ parentId: parentId ?? '' })
  const [parents, setParents] = useState<ReturnType<typeof tree>>([])
  const [versions, setVersions] = useState<Array<Version>>([])
  const [usedBy, setUsedBy] = useState<Array<Entry>>([])
  // The version in the form, and whether the page kept its own parent, since the version's can't take it back
  const [restoring, setRestoring] = useState<{ number: number; parentKept: boolean }>()
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()
  const hierarchical = type.structure === 'hierarchical'
  // Without drafts, Save publishes, so it runs every check, and an entry has no status to show
  const drafts = type.drafts !== false
  // Whether the form holds changes the person made since it last loaded or saved, which the assistant beside it asks
  // to have saved before it applies a proposal to the entry. Values change as the form loads too, so only a change
  // after a key or a pointer in the form counts.
  const touched = useRef(false)
  const interacted = useRef(false)
  // Counts the person's changes, so a save that ends doesn't clear one made while it was saving
  const edits = useRef(0)
  const changed = () => void (interacted.current && ((touched.current = true), edits.current++))
  const assistant = useContext(AssistantContext)

  const loadVersions = useCallback(async () => {
    if (entry) setVersions((await api('GET', `/entries/${entry.id}/versions`)).body.data)
  }, [entry?.id])

  useEffect(() => {
    loadVersions().catch((error) => setProblem(errorMessage(error)))
  }, [loadVersions])

  // Once a proposal for the entry is applied, the editor loads the draft it saved
  useBeside({
    // A change to the type's fields changes the form too
    shows: (proposal) =>
      (proposal.kind === 'entry' && proposal.targetId === entry?.id) ||
      (proposal.kind === 'type' && proposal.targetId === type.id),
    touched: () => touched.current,
    reload: async () => {
      if (!entry) return
      const { body } = await api('GET', `/entries/${entry.id}`)
      setEntry(body.data)
      show(body.data.values)
      if (hierarchical) showParent(body.data.parentId)
      setRestoring(undefined)
      touched.current = interacted.current = false
      await loadVersions()
    },
  })

  useEffect(() => {
    if (!entry) return
    api('GET', `/entries/${entry.id}/used-by`)
      .then(({ body }) => setUsedBy(body.data))
      .catch((error) => setProblem(errorMessage(error)))
  }, [entry?.id])

  // A page can't sit under itself or its own descendants
  useEffect(() => {
    if (!hierarchical) return
    allEntries(type)
      .then((entries) => setParents(tree(entries, entry?.id)))
      .catch((error) => setProblem(errorMessage(error)))
  }, [type, entry?.id])

  const parentSchema = useMemo<Array<FieldSchema>>(() => {
    const choices = parents.map(({ entry: page, depth }) => ({
      value: page.id,
      label: `${'– '.repeat(depth)}${titleOf(type, page)}`,
    }))
    return [
      { name: 'parentId', label: 'Parent', type: 'select', options: { placeholder: 'None, at the top', choices } },
    ]
  }, [parents])

  const show = (next: Record<string, any>) => {
    setShown(next)
    setValues(next)
  }

  const showParent = (next: string | null) => {
    setShownParent({ parentId: next ?? '' })
    setParentId(next)
  }

  // Run an action, showing what went wrong if it fails. The buttons stay enabled while one runs, since disabling the
  // focused one would drop keyboard focus, so a second click is ignored here instead.
  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(name)
    setProblem('')
    try {
      await action()
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(undefined)
    }
  }

  // Once the form has shown its messages. A draft's report leaves out what only a publish needs.
  const showInvalid = (publish: boolean, report: ValidationReport) =>
    focusInvalid(fields.current, publish ? 'published' : 'saved', publish ? undefined : report).then(setProblem)

  // Save the form as the draft, and with publish, make it the live copy too. A draft can be unfinished, and its fields
  // still show what a publish needs, while a publish runs every check.
  const save = (publish: boolean) =>
    act(publish ? 'publish' : 'save', async () => {
      const checked = form.current!.validate({ allowIncomplete: drafts && !publish })
      if (!checked.isValid) return showInvalid(publish, checked)
      const body = { values, parentId, publish }
      const at = edits.current
      const { status, body: reply } = entry
        ? await api('PUT', `/entries/${entry.id}`, body)
        : await api('POST', `/types/${type.name}/entries`, body)

      if (status === 422) {
        form.current!.applyReport(reply)
        return showInvalid(publish, reply)
      }
      // A save that changes nothing leaves the entry as it was, and a publish of what's live publishes nothing
      const changed = !entry || reply.data.updatedAt !== entry.updatedAt || reply.data.publishedAt !== entry.publishedAt
      toast(!changed ? 'No changes' : publish ? 'Published' : 'Saved')
      if (!entry) return void (location.hash = `#/entries/${reply.data.id}`)

      setEntry(reply.data)
      setRestoring(undefined)
      if (edits.current === at) touched.current = interacted.current = false
      // The assistant's proposals for the entry show its status as it is now
      void assistant?.refresh()
      await loadVersions()
    })

  const unpublish = () =>
    act('unpublish', async () => {
      setEntry((await api('POST', `/entries/${entry!.id}/unpublish`)).body.data)
      toast('Unpublished')
      primaryButton.current?.focus()
    })

  // Put an old version's values in the form, and a page's parent in its picker, for saving as the newest version. A
  // parent archived, deleted or moved under the page since can't take it back, so then the page keeps its own.
  const restoreVersion = (version: Version) =>
    act('version', async () => {
      const { values, parentId: was } = (await api('GET', `/entries/${entry!.id}/versions/${version.number}`)).body.data
      show(values)
      const kept =
        hierarchical && was !== null && !tree(await allEntries(type), entry!.id).some((row) => row.entry.id === was)
      if (hierarchical) showParent(kept ? entry!.parentId : was)
      setRestoring({ number: version.number, parentKept: kept })
      touched.current = true
    })

  const discard = () => {
    show(entry!.values)
    if (hierarchical) showParent(entry!.parentId)
    setRestoring(undefined)
    touched.current = interacted.current = false
  }

  // Taken once, so going back to the editor doesn't restore it again
  useEffect(() => {
    const next = restoreNext
    restoreNext = undefined
    if (entry && next?.entryId === entry.id) restoreVersion(next.version)
  }, [])

  // Archiving swaps the panel's buttons for Restore and Delete for good, and restoring swaps them back, so once the page
  // shows the result, focus moves to the primary button: Restore, or Publish, or Save for a type without drafts
  const archiveOrRestore = (action: 'archive' | 'restore') =>
    act(action, async () => {
      const { body } = await api('POST', `/entries/${entry!.id}/${action}`)
      flushSync(() => setEntry(body.data))
      primaryButton.current?.focus()
    })

  // Each asks first where it needs to, before the action starts, so the dialog hands focus back to its button
  const archive = async () => {
    const count = usedBy.length
    const sure =
      count === 0 ||
      (await confirm({
        title: `Archive ${titleOf(type, entry!)}?`,
        body: `${count === 1 ? 'An entry links' : `${count} entries link`} to it. Their links leave it out until it's restored, and it can't be deleted while they're there.`,
        action: 'Archive',
      }))
    if (sure) archiveOrRestore('archive')
  }

  const remove = async () => {
    const sure = await confirm({
      title: `Delete ${titleOf(type, entry!)} for good?`,
      body: hierarchical ? 'Its versions go too, and so do the pages under it.' : 'Its versions go too.',
      action: 'Delete for good',
      danger: true,
    })
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/entries/${entry!.id}`)
      toast('Deleted')
      location.hash = `#/types/${type.name}/archive`
    })
  }

  const archived = !!entry?.archivedAt

  return (
    <div>
      <PageHeader
        back={type.structure !== 'singleton' ? { href: `#/types/${type.name}`, label: type.label } : undefined}
        title={entry ? titleOf(type, entry) : `New ${type.singular ?? type.label}`}
        meta={
          archived ? <Badge tone='warning'>Archived</Badge> : drafts && entry && <StatusBadge status={entry.status} />
        }
      />

      <div ref={fields} onKeyDown={() => (interacted.current = true)} onPointerDown={() => (interacted.current = true)}>
        {archived && <Notice tone='warning'>Archived on {date(entry.archivedAt!)}. Restore it to edit it.</Notice>}
        {restoring && (
          <Notice>
            Version {restoring.number} is in the form. Save to restore it.
            {restoring.parentKept &&
              ' Its parent has been archived, deleted or moved under this page since, so the page stays where it is.'}{' '}
            <button type='button' className='sorlo-button' onClick={discard}>
              Discard
            </button>
          </Notice>
        )}

        {hierarchical && (
          <Form
            schema={parentSchema}
            values={shownParent}
            onValuesChange={(next) => {
              setParentId(next.parentId || null)
              changed()
            }}
          />
        )}
        <Form
          ref={form}
          schema={type.fields}
          inputs={inputs}
          values={shown}
          onValuesChange={(next) => {
            setValues(next)
            changed()
          }}
        />
      </div>

      <Panel
        label='About this entry'
        problem={problem}
        actions={
          archived ? (
            <button
              ref={primaryButton}
              type='button'
              className='sorlo-button sorlo-button--primary'
              aria-busy={busy === 'restore'}
              onClick={() => archiveOrRestore('restore')}
            >
              <ArchiveRestore /> {busy === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
          ) : drafts ? (
            <>
              <button type='button' className='sorlo-button' aria-busy={busy === 'save'} onClick={() => save(false)}>
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </button>
              <button
                ref={primaryButton}
                type='button'
                className='sorlo-button sorlo-button--primary'
                aria-busy={busy === 'publish'}
                onClick={() => save(true)}
              >
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </button>
            </>
          ) : (
            <button
              ref={primaryButton}
              type='button'
              className='sorlo-button sorlo-button--primary'
              aria-busy={busy === 'save'}
              onClick={() => save(false)}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          )
        }
        footer={
          entry &&
          (archived ? (
            <button
              type='button'
              className='sorlo-button sorlo-button--danger'
              aria-busy={busy === 'delete'}
              onClick={remove}
            >
              <Trash2 /> {busy === 'delete' ? 'Deleting…' : 'Delete for good'}
            </button>
          ) : (
            <>
              {drafts && entry.status !== 'draft' && (
                <button type='button' className='sorlo-button' aria-busy={busy === 'unpublish'} onClick={unpublish}>
                  {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
                </button>
              )}
              <button type='button' className='sorlo-button' aria-busy={busy === 'archive'} onClick={archive}>
                <Archive /> {busy === 'archive' ? 'Archiving…' : 'Archive'}
              </button>
            </>
          ))
        }
      >
        {entry && (versions.length > 0 || usedBy.length > 0) && (
          <>
            {versions.length > 0 && (
              <Versions versions={versions} entry={entry} drafts={drafts} onRestore={restoreVersion} />
            )}
            <UsedBy entries={usedBy} types={types} />
          </>
        )}
      </Panel>
    </div>
  )
}

// Open an entry by its ID, with its type
export function EntryPage({ id, types }: { id: string; types: Map<string, ContentType> }) {
  const [entry, setEntry] = useState<Entry>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/entries/${id}`)
      .then(({ body }) => setEntry(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  const showSection = useContext(SectionContext)
  useEffect(() => {
    if (entry) showSection(`types/${entry.type}`)
  }, [entry, showSection])

  const type = entry && types.get(entry.type)
  // The server finds no entry whose type it doesn't have, such as one renamed that sorlo migrate hasn't moved it to yet
  if (error === 'Not Found') {
    return (
      <Notice tone='danger'>
        There's no entry with this id among the site's content types now. If its type was renamed, sorlo migrate moves
        its entries to the new name, and they open from there.
      </Notice>
    )
  }
  if (error) return <Notice tone='danger'>{error}</Notice>
  if (entry && !type) return <TypeGone name={entry.type} />
  return type ? <EntryEditor type={type} entry={entry} /> : <Loading />
}

// A page of a content type that isn't one of the site's now, such as one renamed since, whose entries keep its old name
// until sorlo migrate moves them
export const TypeGone = ({ name }: { name: string }) => (
  <div className='cms-page'>
    <PageHeader title={name} />
    <Notice>
      There's no content type named {name} now. If it was renamed, sorlo migrate moves its entries to the new name, and
      they open from there.
    </Notice>
  </div>
)

// A singleton opens straight into its one entry
export function SingletonPage({ type }: { type: ContentType }) {
  const [entry, setEntry] = useState<Entry>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/types/${type.name}/singleton`)
      .then(({ body }) => setEntry(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [type])

  if (error) return <Notice tone='danger'>{error}</Notice>
  return entry ? <EntryEditor type={type} entry={entry} /> : <Loading />
}
