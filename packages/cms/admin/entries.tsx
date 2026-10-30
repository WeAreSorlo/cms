import {
  ContentType,
  Entry,
  SectionContext,
  TypesContext,
  allEntries,
  api,
  date,
  errorMessage,
  formatField,
  formatValue,
  titleOf,
  tree,
} from './api'
import { useInputs } from './fields'
import { UsedBy } from './media'
import {
  Badge,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Pagination,
  StatusBadge,
  TypeIcon,
  focusInvalid,
  useConfirm,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle, ValidationReport } from 'iight'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  CircleAlert,
  Plus,
  Sheet,
  Trash2,
} from 'lucide-react'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

// Fields whose stored values sort the way they read
const sortable = new Set([
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

// A type's entries in its list columns: pages for a collection, the whole tree for a hierarchical, or the archive
export function EntryList({ type, archived = false }: { type: ContentType; archived?: boolean }) {
  const [rows, setRows] = useState<ReturnType<typeof tree>>()
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<Pagination>()
  const [sort, setSort] = useState<{ name: string; direction: 'asc' | 'desc' }>()
  const [error, setError] = useState('')
  // The entries ticked for bulk editing, in the order they were ticked, kept as pages and sorts change
  const [ticked, setTicked] = useState<Array<string>>([])
  const ordered = type.structure === 'hierarchical' && !archived
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

  const load = useCallback(async () => {
    try {
      if (ordered) return setRows(tree(await allEntries(type)))

      const order = encodeURIComponent(
        JSON.stringify(sort ? { [`values.${sort.name}`]: sort.direction } : { createdAt: 'desc' }),
      )
      const { body } = await api('GET', `/types/${type.name}/entries?archived=${archived}&order=${order}&page=${page}`)
      setRows(body.data.map((entry: Entry) => ({ entry, depth: 0, index: 0, siblings: 1 })))
      setPagination(body.pagination)
    } catch (error) {
      setError(errorMessage(error))
    }
  }, [type, archived, ordered, page, sort])

  useEffect(() => {
    load()
  }, [load])

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

  const tick = (ids: Array<string>, on: boolean) =>
    setTicked((all) =>
      on ? [...all, ...ids.filter((id) => !all.includes(id))] : all.filter((id) => !ids.includes(id)),
    )
  const shownIds = rows?.map(({ entry }) => entry.id) ?? []
  const pageTicked = shownIds.length > 0 && shownIds.every((id) => ticked.includes(id))

  const newEntry = (
    <a className='iight-button iight-button--primary' href={`#/types/${type.name}/new`}>
      <Plus /> New {singular}
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader
        back={archived ? { href: `#/types/${type.name}`, label: type.label } : undefined}
        title={archived ? `${type.label}: archive` : type.label}
        actions={
          !archived && (
            <>
              {ticked.length > 0 && (
                <>
                  <span className='cms-muted'>{ticked.length} selected</span>
                  <a className='iight-button' href={`#/types/${type.name}/bulk/${ticked.join(',')}`}>
                    <Sheet /> Bulk edit
                  </a>
                </>
              )}
              <a className='iight-button' href={`#/types/${type.name}/archive`}>
                <Archive /> Archive
              </a>
              {newEntry}
            </>
          )
        }
      />

      {error && <Notice tone='danger'>{error}</Notice>}
      {!rows && !error && <Loading />}
      {rows?.length === 0 &&
        (archived ? (
          <EmptyState icon={<Archive />}>Nothing is archived.</EmptyState>
        ) : (
          <EmptyState icon={<TypeIcon name={type.icon} />} action={newEntry}>
            Nothing here yet.
          </EmptyState>
        ))}

      {!!rows?.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                {!archived && (
                  <th className='cms-table__tick'>
                    <label>
                      <input
                        type='checkbox'
                        aria-label='Select every entry on this page'
                        checked={pageTicked}
                        ref={(box) => {
                          if (box) box.indeterminate = !pageTicked && shownIds.some((id) => ticked.includes(id))
                        }}
                        onChange={(event) => tick(shownIds, event.target.checked)}
                      />
                    </label>
                  </th>
                )}
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
                <tr key={entry.id} className={ticked.includes(entry.id) ? 'cms-table__selected' : undefined}>
                  {!archived && (
                    <td className='cms-table__tick'>
                      <label>
                        <input
                          type='checkbox'
                          aria-label={`Select ${titleOf(type, entry)}`}
                          checked={ticked.includes(entry.id)}
                          onChange={(event) => tick([entry.id], event.target.checked)}
                        />
                      </label>
                    </td>
                  )}
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

interface Version {
  number: number
  createdAt: string
}

// Create, edit and publish an entry with its type's fields, see the entries that link to it, and see and restore its
// versions
export function EntryEditor({ type, entry: loaded }: { type: ContentType; entry?: Entry }) {
  const form = useRef<FormHandle>(null)
  // Where focus goes once Unpublish, which only a live entry has, goes
  const publishButton = useRef<HTMLButtonElement>(null)
  // Around the forms, for finding the fields that stop a save
  const fields = useRef<HTMLDivElement>(null)
  const inputs = useInputs()
  const types = useContext(TypesContext)
  const confirm = useConfirm()
  const toast = useToast()
  const [entry, setEntry] = useState(loaded)
  // A new entry starts from its fields' defaults, as core's new flexible blocks do, so conditions can see them
  const [values, setValues] = useState<Record<string, any>>(
    () => loaded?.values ?? Object.fromEntries(type.fields.map((field) => [field.name, field.defaultValue])),
  )
  // What the form starts from, replaced only to load a version. Passing every change back would let the form
  // adopt a stale copy while an input is still updating, such as a slug generated from the title.
  const [shown, setShown] = useState(values)
  const [parentId, setParentId] = useState(loaded?.parentId ?? null)
  const [shownParent] = useState({ parentId: parentId ?? '' })
  const [parents, setParents] = useState<ReturnType<typeof tree>>([])
  const [versions, setVersions] = useState<Array<Version>>([])
  const [usedBy, setUsedBy] = useState<Array<Entry>>([])
  const [restoring, setRestoring] = useState<Version>()
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()
  const hierarchical = type.structure === 'hierarchical'
  // Without drafts, Save publishes, so it runs every check, and an entry has no status to show
  const drafts = type.drafts !== false

  const loadVersions = useCallback(async () => {
    if (entry) setVersions((await api('GET', `/entries/${entry.id}/versions`)).body.data)
  }, [entry?.id])

  useEffect(() => {
    loadVersions().catch((error) => setProblem(errorMessage(error)))
  }, [loadVersions])

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
      const { status, body: reply } = entry
        ? await api('PUT', `/entries/${entry.id}`, body)
        : await api('POST', `/types/${type.name}/entries`, body)

      if (status === 422) {
        form.current!.applyReport(reply)
        return showInvalid(publish, reply)
      }
      toast(publish ? 'Published' : 'Saved')
      if (!entry) return void (location.hash = `#/entries/${reply.data.id}`)

      setEntry(reply.data)
      setRestoring(undefined)
      await loadVersions()
    })

  const unpublish = () =>
    act('unpublish', async () => {
      setEntry((await api('POST', `/entries/${entry!.id}/unpublish`)).body.data)
      toast('Unpublished')
      publishButton.current?.focus()
    })

  // Put an old version's values in the form, for saving as the newest version
  const restore = (version: Version) =>
    act('restore', async () => {
      show((await api('GET', `/entries/${entry!.id}/versions/${version.number}`)).body.data.values)
      setRestoring(version)
    })

  const discard = () => {
    show(entry!.values)
    setRestoring(undefined)
  }

  // Each asks first where it needs to, before the action starts, so the dialog hands focus back to its button
  const archive = async (action: 'archive' | 'restore') => {
    const count = usedBy.length
    const cancelled =
      action === 'archive' &&
      count > 0 &&
      !(await confirm({
        title: `Archive ${titleOf(type, entry!)}?`,
        body: `${count === 1 ? 'An entry links' : `${count} entries link`} to it. Their links leave it out until it's restored, and it can't be deleted while they're there.`,
        action: 'Archive',
      }))
    if (cancelled) return
    act(action, async () => setEntry((await api('POST', `/entries/${entry!.id}/${action}`)).body.data))
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
    <div className='cms-page cms-editor'>
      <PageHeader
        back={type.structure !== 'singleton' ? { href: `#/types/${type.name}`, label: type.label } : undefined}
        title={entry ? titleOf(type, entry) : `New ${type.singular ?? type.label}`}
        meta={
          archived ? <Badge tone='warning'>Archived</Badge> : drafts && entry && <StatusBadge status={entry.status} />
        }
      />

      <div className='cms-editor__body'>
        <div ref={fields} className='cms-editor__form'>
          {archived && <Notice tone='warning'>Archived on {date(entry.archivedAt!)}. Restore it to edit it.</Notice>}
          {restoring && (
            <Notice>
              Version {restoring.number} is in the form. Save to restore it.{' '}
              <button type='button' className='iight-button' onClick={discard}>
                Discard
              </button>
            </Notice>
          )}

          {hierarchical && (
            <Form
              schema={parentSchema}
              values={shownParent}
              onValuesChange={(next) => setParentId(next.parentId || null)}
            />
          )}
          <Form ref={form} schema={type.fields} inputs={inputs} values={shown} onValuesChange={setValues} />
        </div>

        {entry && (usedBy.length > 0 || versions.length > 0) && (
          <aside className='cms-editor__aside' aria-label='About this entry'>
            <UsedBy entries={usedBy} types={types} />
            {versions.length > 0 && (
              <section>
                <h2>Versions</h2>
                <ol className='cms-versions'>
                  {versions.map((version, index) => (
                    <li key={version.number}>
                      Version {version.number}
                      <span className='cms-muted'>{date(version.createdAt)}</span>
                      {index === 0 && <Badge tone='accent'>Current</Badge>}
                      {drafts && version.number === entry.publishedVersion && <StatusBadge status='published' />}
                      {index > 0 && !archived && (
                        <button type='button' className='iight-button' onClick={() => restore(version)}>
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </aside>
        )}
      </div>

      <div className='cms-action-bar'>
        {!archived && (
          <>
            {drafts && (
              <button
                ref={publishButton}
                type='button'
                className='iight-button iight-button--primary'
                aria-busy={busy === 'publish'}
                onClick={() => save(true)}
              >
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </button>
            )}
            <button
              type='button'
              className={drafts ? 'iight-button' : 'iight-button iight-button--primary'}
              aria-busy={busy === 'save'}
              onClick={() => save(false)}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            {drafts && entry && entry.status !== 'draft' && (
              <button type='button' className='iight-button' aria-busy={busy === 'unpublish'} onClick={unpublish}>
                {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
              </button>
            )}
          </>
        )}
        {/* One button for both, so it keeps focus when an entry is archived or restored */}
        {entry && (
          <button
            type='button'
            className={archived ? 'iight-button iight-button--primary' : 'iight-button'}
            onClick={() => archive(archived ? 'restore' : 'archive')}
          >
            {archived ? <ArchiveRestore /> : <Archive />} {archived ? 'Restore' : 'Archive'}
          </button>
        )}
        {problem && (
          <p className='cms-problem' role='alert'>
            <CircleAlert /> {problem}
          </p>
        )}
        {archived && (
          <button type='button' className='iight-button iight-button--danger cms-action-bar__end' onClick={remove}>
            <Trash2 /> Delete for good
          </button>
        )}
      </div>
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
  if (error) return <Notice tone='danger'>{error}</Notice>
  return type ? <EntryEditor type={type} entry={entry} /> : <Loading />
}

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
