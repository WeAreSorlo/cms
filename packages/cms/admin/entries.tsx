import { ContentType, Entry, allEntries, api, date, formatField, titleOf, tree } from './api'
import Form, { FieldSchema, FormHandle } from 'iight'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A type's entries in its list columns: pages for a collection, the whole tree for a hierarchical, or the archive
export function EntryList({ type, archived = false }: { type: ContentType; archived?: boolean }) {
  const [rows, setRows] = useState<ReturnType<typeof tree>>()
  const [page, setPage] = useState(1)
  const [lastPage, setLastPage] = useState(1)
  const [error, setError] = useState('')
  const ordered = type.structure === 'hierarchical' && !archived
  const columns = type.listColumns ?? [type.titleField ?? type.fields[0]?.name]

  const load = useCallback(async () => {
    try {
      if (ordered) return setRows(tree(await allEntries(type)))

      const order = encodeURIComponent('{"createdAt":"desc"}')
      const { body } = await api('GET', `/types/${type.name}/entries?archived=${archived}&order=${order}&page=${page}`)
      setRows(body.data.map((entry: Entry) => ({ entry, depth: 0, index: 0, siblings: 1 })))
      setLastPage(body.pagination.lastPage)
    } catch (error) {
      setError(errorMessage(error))
    }
  }, [type, archived, ordered, page])

  useEffect(() => {
    load()
  }, [load])

  const move = async (entry: Entry, position: number) => {
    await api('PUT', `/entries/${entry.id}/position`, { position }).catch((error) => setError(errorMessage(error)))
    load()
  }

  return (
    <>
      <header>
        <h1>{archived ? `${type.label}: archive` : type.label}</h1>
        {!archived && <a href={`#/types/${type.name}/new`}>New {type.singular ?? type.label}</a>}
        <a href={archived ? `#/types/${type.name}` : `#/types/${type.name}/archive`}>
          {archived ? 'Back to the list' : 'Archive'}
        </a>
      </header>

      {error && <p role='alert'>{error}</p>}
      {rows?.length === 0 && <p>{archived ? 'Nothing is archived.' : 'Nothing here yet.'}</p>}
      {!!rows?.length && (
        <table>
          <thead>
            <tr>
              {columns.map((name) => (
                <th key={name}>{type.fields.find((field) => field.name === name)?.label ?? name}</th>
              ))}
              {ordered && <th>Order</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, depth, index, siblings }) => (
              <tr key={entry.id}>
                {columns.map((name, column) => (
                  <td key={name}>
                    {column === 0 ? (
                      <a href={`#/entries/${entry.id}`} style={{ paddingLeft: `${depth * 1.5}rem` }}>
                        {formatField(type, name, entry) || 'Untitled'}
                      </a>
                    ) : (
                      formatField(type, name, entry)
                    )}
                  </td>
                ))}
                {ordered && (
                  <td>
                    <button
                      type='button'
                      className='iight-button'
                      aria-label='Move up'
                      disabled={index === 0}
                      onClick={() => move(entry, index - 1)}
                    >
                      ↑
                    </button>{' '}
                    <button
                      type='button'
                      className='iight-button'
                      aria-label='Move down'
                      disabled={index === siblings - 1}
                      onClick={() => move(entry, index + 1)}
                    >
                      ↓
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!ordered && lastPage > 1 && (
        <nav className='actions' aria-label='Pages'>
          <button type='button' className='iight-button' disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {lastPage}
          </span>
          <button type='button' className='iight-button' disabled={page === lastPage} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </nav>
      )}
    </>
  )
}

interface Version {
  number: number
  createdAt: string
}

// Create or edit an entry with its type's fields, and see and restore its versions
export function EntryEditor({ type, entry: loaded }: { type: ContentType; entry?: Entry }) {
  const form = useRef<FormHandle>(null)
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
  const [restoring, setRestoring] = useState<Version>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const hierarchical = type.structure === 'hierarchical'

  const loadVersions = useCallback(async () => {
    if (entry) setVersions((await api('GET', `/entries/${entry.id}/versions`)).body.data)
  }, [entry?.id])

  useEffect(() => {
    loadVersions().catch((error) => setMessage(errorMessage(error)))
  }, [loadVersions])

  // A page can't sit under itself or its own descendants
  useEffect(() => {
    if (!hierarchical) return
    allEntries(type)
      .then((entries) => setParents(tree(entries, entry?.id)))
      .catch((error) => setMessage(errorMessage(error)))
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

  // Run an action, showing what went wrong if it fails
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    act(async () => {
      if (!form.current?.validate().isValid) return
      const body = { values, parentId }
      const { status, body: reply } = entry
        ? await api('PUT', `/entries/${entry.id}`, body)
        : await api('POST', `/types/${type.name}/entries`, body)

      if (status === 422) return form.current.applyReport(reply)
      if (!entry) return void (location.hash = `#/entries/${reply.data.id}`)

      setEntry(reply.data)
      setRestoring(undefined)
      setMessage('Saved.')
      await loadVersions()
    })

  // Put an old version's values in the form, for saving as the newest version
  const restore = (version: Version) =>
    act(async () => {
      show((await api('GET', `/entries/${entry!.id}/versions/${version.number}`)).body.data.values)
      setRestoring(version)
    })

  const discard = () => {
    show(entry!.values)
    setRestoring(undefined)
  }

  const archive = (action: 'archive' | 'restore') =>
    act(async () => setEntry((await api('POST', `/entries/${entry!.id}/${action}`)).body.data))

  const remove = () =>
    act(async () => {
      if (!confirm(`Delete ${titleOf(type, entry!)} for good? Its versions go too, and pages under it.`)) return
      await api('DELETE', `/entries/${entry!.id}`)
      location.hash = `#/types/${type.name}/archive`
    })

  const archived = !!entry?.archivedAt

  return (
    <>
      <header>
        {type.structure !== 'singleton' && <a href={`#/types/${type.name}`}>{type.label}</a>}
        <h1>{entry ? titleOf(type, entry) : `New ${type.singular ?? type.label}`}</h1>
      </header>

      {archived && <p role='status'>Archived on {date(entry.archivedAt!)}. Restore it to edit it.</p>}
      {restoring && (
        <p role='status'>
          Version {restoring.number} is in the form. Save to restore it.{' '}
          <button type='button' className='iight-button' onClick={discard}>
            Discard
          </button>
        </p>
      )}

      {hierarchical && (
        <Form
          schema={parentSchema}
          values={shownParent}
          onValuesChange={(next) => setParentId(next.parentId || null)}
        />
      )}
      <Form ref={form} schema={type.fields} values={shown} onValuesChange={setValues} />

      {message && <p role='status'>{message}</p>}
      <div className='actions'>
        {!archived && (
          <button type='button' className='iight-button' disabled={busy} onClick={save}>
            Save
          </button>
        )}
        {entry && !archived && (
          <button type='button' className='iight-button' disabled={busy} onClick={() => archive('archive')}>
            Archive
          </button>
        )}
        {archived && (
          <>
            <button type='button' className='iight-button' disabled={busy} onClick={() => archive('restore')}>
              Restore
            </button>
            <button type='button' className='iight-button' disabled={busy} onClick={remove}>
              Delete for good
            </button>
          </>
        )}
      </div>

      {versions.length > 0 && (
        <section>
          <h2>Versions</h2>
          <ol reversed>
            {versions.map((version, index) => (
              <li key={version.number}>
                Version {version.number}, {date(version.createdAt)}
                {index === 0 ? ' (current)' : ''}{' '}
                {index > 0 && !archived && (
                  <button type='button' className='iight-button' disabled={busy} onClick={() => restore(version)}>
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
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

  const type = entry && types.get(entry.type)
  if (error) return <p role='alert'>{error}</p>
  return type ? <EntryEditor type={type} entry={entry} /> : null
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

  if (error) return <p role='alert'>{error}</p>
  return entry ? <EntryEditor type={type} entry={entry} /> : null
}
