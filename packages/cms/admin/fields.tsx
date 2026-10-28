import { holdsOne, idsOf, media, relationship, relationshipOptions } from '../src/fields'
import { ContentType, Entry, TypesContext, api, errorMessage, titleOf } from './api'
import { Media, MediaLibrary, Thumbnail } from './media'
import Form, { FieldSchema, Input, Modal, useFieldContext } from 'iight'
import { ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

// A dialog outside the form it's opened from, since it holds a form of its own, in the admin's theme
const Dialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) =>
  createPortal(
    <div className='iight-theme-default'>
      <Modal open header={<h2>{title}</h2>} closeButton onClose={onClose}>
        {children}
      </Modal>
    </div>,
    document.body,
  )

// What a picker shows of a field's value, and how it changes it, with the input's own checks
function useLinks<T>(load: (ids: Array<string>) => Promise<Record<string, T | null>>) {
  const { schema, options, value, readonly, disabled, handleValidation } = useFieldContext()
  const ids = idsOf(value)
  // Each linked record by ID, or null once it's been deleted
  const [records, setRecords] = useState<Record<string, T | null>>({})

  useEffect(() => {
    const missing = ids.filter((id) => !(id in records))
    if (missing.length) load(missing).then((found) => setRecords((all) => ({ ...all, ...found })))
  }, [ids.join()])

  const change = (next: Array<string>) =>
    handleValidation(relationship.validateValue(holdsOne(schema) ? next[0] : next, schema))
  const one = holdsOne(schema)

  return {
    ids,
    records,
    one,
    locked: readonly || disabled,
    // A field that takes one item swaps it, and others take more until they're full
    canAdd: one || typeof options?.maximum !== 'number' || ids.length < options.maximum,
    remove: (id: string) => change(ids.filter((other) => other !== id)),
    add: (id: string, record: T) => {
      setRecords((all) => ({ ...all, [id]: record }))
      change(one ? [id] : [...ids, id])
      return one || (typeof options?.maximum === 'number' && ids.length + 1 >= options.maximum)
    },
  }
}

// A relationship field: the entries it links to, and a dialog that searches the types it takes for more
function RelationshipPicker() {
  const { id, aria, label, options } = useFieldContext()
  const types = useContext(TypesContext)
  const allowed = useMemo(
    () => [...types.values()].filter((type) => !options?.types?.length || options.types.includes(type.id)),
    [types, options?.types],
  )
  const [open, setOpen] = useState(false)
  const links = useLinks<Entry>(async (ids) => {
    const found = await Promise.all(ids.map((id) => api('GET', `/entries/${id}`).catch(() => null)))
    return Object.fromEntries(ids.map((id, index) => [id, found[index]?.body.data ?? null]))
  })

  const title = (id: string) => {
    const entry = links.records[id]
    const type = entry && types.get(entry.type)
    if (entry === undefined) return 'Loading…'
    return type ? `${titleOf(type, entry)}${entry.archivedAt ? ' (archived)' : ''}` : 'A deleted entry'
  }

  return (
    <div className='iight-input__relationship'>
      {links.ids.length > 0 && (
        <ul className='links'>
          {links.ids.map((linked) => (
            <li key={linked}>
              <span>{title(linked)}</span>
              {!links.locked && (
                <button
                  type='button'
                  className='iight-button'
                  aria-label={`Remove ${title(linked)}`}
                  onClick={() => links.remove(linked)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!links.locked && links.canAdd && (
        <button id={id} {...aria} type='button' className='iight-button' onClick={() => setOpen(true)}>
          {links.one && links.ids.length ? 'Change' : 'Choose'}
        </button>
      )}
      {open && (
        <Dialog title={`Choose ${label ? label.toLowerCase() : 'an entry'}`} onClose={() => setOpen(false)}>
          <EntrySearch
            types={allowed}
            chosen={links.ids}
            onPick={(entry) => links.add(entry.id, entry) && setOpen(false)}
          />
        </Dialog>
      )}
    </div>
  )
}

// Entries of some types, newest first, searched by their titles
function EntrySearch({
  types,
  chosen,
  onPick,
}: {
  types: Array<ContentType>
  chosen: Array<string>
  onPick: (entry: Entry) => void
}) {
  const [query, setQuery] = useState<Record<string, any>>({})
  // What the form starts from, kept the same object, since the form takes up a new one and drops what was typed
  const [shown] = useState({ type: types[0]?.name })
  const [found, setFound] = useState<Array<Entry>>()
  const [error, setError] = useState('')
  const type = types.find((type) => type.name === query.type) ?? types[0]

  const schema = useMemo<Array<FieldSchema>>(() => {
    const choices = types.map((type) => ({ value: type.name, label: type.label }))
    const search: FieldSchema = { name: 'search', label: 'Search', type: 'text', options: { placeholder: 'Title' } }
    if (types.length < 2) return [search]
    return [
      { name: 'type', label: 'Type', type: 'select', width: 50, options: { choices } },
      { ...search, width: 50 },
    ]
  }, [types])

  useEffect(() => {
    if (!type) return
    const field = type.titleField ? `values.${type.titleField}` : type.slugField && 'slug'
    const params = new URLSearchParams({ order: '{"createdAt":"desc"}', perPage: '20' })
    if (query.search && field) params.set('where', JSON.stringify([[{ field, op: 'like', value: query.search }]]))

    // A slow reply to an earlier search mustn't replace a newer one
    let current = true
    api('GET', `/types/${type.name}/entries?${params}`)
      .then(({ body }) => current && setFound(body.data))
      .catch((error) => current && setError(errorMessage(error)))
    return () => {
      current = false
    }
  }, [type, query.search])

  if (!type) return <p>There are no content types this field can link to.</p>
  return (
    <>
      <Form schema={schema} values={shown} onValuesChange={setQuery} />
      {error && <p role='alert'>{error}</p>}
      {found?.length === 0 && <p>{query.search ? 'Nothing matches.' : 'Nothing here yet.'}</p>}
      <ul className='links'>
        {found?.map((entry) => (
          <li key={entry.id}>
            <button
              type='button'
              className='iight-button'
              disabled={chosen.includes(entry.id)}
              onClick={() => onPick(entry)}
            >
              {titleOf(type, entry)}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// A media field: the files it links to, and the media library to choose more from or upload them to
function MediaPicker() {
  const { id, aria, label, options } = useFieldContext()
  const [open, setOpen] = useState(false)
  const links = useLinks<Media>(async (ids) => {
    const where = JSON.stringify([[{ field: 'id', op: 'in', value: ids }]])
    const { body } = await api('GET', `/media?perPage=100&where=${encodeURIComponent(where)}`)
    return Object.fromEntries(ids.map((id) => [id, body.data.find((file: Media) => file.id === id) ?? null]))
  })

  return (
    <div className='iight-input__media'>
      {links.ids.length > 0 && (
        <ul className='links'>
          {links.ids.map((linked) => {
            const file = links.records[linked]
            return (
              <li key={linked}>
                {file && <Thumbnail media={file} />}
                <span>{file === undefined ? 'Loading…' : (file?.name ?? 'A deleted file')}</span>
                {!links.locked && (
                  <button
                    type='button'
                    className='iight-button'
                    aria-label={`Remove ${file?.name ?? 'the file'}`}
                    onClick={() => links.remove(linked)}
                  >
                    Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!links.locked && links.canAdd && (
        <button id={id} {...aria} type='button' className='iight-button' onClick={() => setOpen(true)}>
          {links.one && links.ids.length ? 'Change' : 'Choose'}
        </button>
      )}
      {open && (
        <Dialog title={`Choose ${label ? label.toLowerCase() : 'a file'}`} onClose={() => setOpen(false)}>
          <MediaLibrary
            pick={{
              types: options?.types,
              chosen: links.ids,
              onPick: (file) => links.add(file.id, file) && setOpen(false),
            }}
          />
        </Dialog>
      )}
    </div>
  )
}

// The CMS's inputs with their pickers, for the forms that edit entries and content types
export function useInputs() {
  const types = useContext(TypesContext)
  return useMemo<Record<string, Input>>(
    () => ({
      relationship: {
        ...relationship,
        optionFields: () => relationshipOptions(types.values()),
        default: RelationshipPicker,
      },
      media: { ...media, default: MediaPicker },
    }),
    [types],
  )
}
