import { form, holdsOne, idsOf, media, relationship, relationshipOptions, shared, sharedOptions } from '../src/fields'
import { ContentType, Entry, GroupsContext, TypesContext, api, errorMessage, titleOf } from './api'
import { Media, MediaLibrary, Thumbnail } from './media'
import { Badge, Dialog, EmptyState, IconButton, Loading, Notice, TypeIcon } from './ui'
import Form, { FieldSchema, Input, inputs, useFieldContext } from 'iight'
import { CircleAlert, Search, X } from 'lucide-react'
import { Suspense, lazy, useContext, useEffect, useMemo, useRef, useState } from 'react'

// After a pick or a removal, focus goes back to the picker's Choose button, or once the field is full and Choose has
// gone, to its last remove button. It would drop to the page otherwise, since a pick unmounts the dialog that had it
// and a removal the button.
function useRefocus(id: string) {
  const area = useRef<HTMLDivElement>(null)
  const pending = useRef(false)
  useEffect(() => {
    if (!pending.current) return
    pending.current = false
    const removes = [...(area.current?.querySelectorAll<HTMLElement>('.cms-picked button') ?? [])]
    const target = document.getElementById(id) ?? removes.pop()
    target?.focus()
  })
  return { area, refocus: () => (pending.current = true) }
}

// What a picker shows of a field's value, and how it changes it, with the input's own checks
function useLinks<T>(load: (ids: Array<string>) => Promise<Record<string, T | null>>) {
  const { id: fieldId, schema, options, value, readonly, disabled, handleValidation } = useFieldContext()
  const { area, refocus } = useRefocus(fieldId)
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
    area,
    ids,
    records,
    one,
    locked: readonly || disabled,
    // A field that takes one item swaps it, and others take more until they're full
    canAdd: one || typeof options?.maximum !== 'number' || ids.length < options.maximum,
    remove: (id: string) => {
      refocus()
      change(ids.filter((other) => other !== id))
    },
    // Whether the field is now full, which closes its dialog
    add: (id: string, record: T) => {
      setRecords((all) => ({ ...all, [id]: record }))
      change(one ? [id] : [...ids, id])
      const full = one || (typeof options?.maximum === 'number' && ids.length + 1 >= options.maximum)
      if (full) refocus()
      return full
    },
  }
}

// The titles of linked entries, the names of linked files and the labels of linked forms, loaded as they're asked for,
// with null for any that have gone
export function useLinkNames(entries: Array<string>, files: Array<string>, forms: Array<string> = []) {
  const types = useContext(TypesContext)
  const [names, setNames] = useState<Record<string, string | null>>({})
  const requested = useRef(new Set<string>())
  const fresh = (ids: Array<string>) => [...new Set(ids)].filter((id) => !requested.current.has(id))
  const [newEntries, newFiles, newForms] = [fresh(entries), fresh(files), fresh(forms)]

  useEffect(() => {
    if (!newEntries.length && !newFiles.length && !newForms.length) return
    for (const id of [...newEntries, ...newFiles, ...newForms]) requested.current.add(id)
    const name = (found: Array<[string, string | null]>) =>
      setNames((all) => ({ ...all, ...Object.fromEntries(found) }))

    // shortcut: a request for each linked entry, as the relationship picker makes, add a route for many when pages
    // link to hundreds of different entries
    Promise.all(
      newEntries.map(async (id): Promise<[string, string | null]> => {
        const entry: Entry | undefined = await api('GET', `/entries/${id}`).then(
          ({ body }) => body.data,
          () => undefined,
        )
        const type = entry && types.get(entry.type)
        return [id, type ? `${titleOf(type, entry)}${entry.archivedAt ? ' (archived)' : ''}` : null]
      }),
    ).then(name)

    for (let start = 0; start < newFiles.length; start += 100) {
      const ids = newFiles.slice(start, start + 100)
      const where = encodeURIComponent(JSON.stringify([[{ field: 'id', op: 'in', value: ids }]]))
      api('GET', `/media?perPage=100&where=${where}`)
        .then(({ body }) => name(ids.map((id) => [id, body.data.find((file: Media) => file.id === id)?.name ?? null])))
        .catch(() => name(ids.map((id) => [id, null])))
    }

    if (newForms.length) {
      api('GET', '/forms')
        .then(({ body }) =>
          name(newForms.map((id) => [id, body.data.find((form: { id: string }) => form.id === id)?.label ?? null])),
        )
        .catch(() => name(newForms.map((id) => [id, null])))
    }
  }, [newEntries.join(), newFiles.join(), newForms.join()])

  return names
}

// A relationship field: the entries it links to, and a dialog that searches the types it takes for more
function RelationshipPicker() {
  const { id, labelId, aria, label, options } = useFieldContext()
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
    <div ref={links.area} className='iight-input__relationship cms-picker'>
      {links.ids.length > 0 && (
        <ul className='cms-picked'>
          {links.ids.map((linked) => (
            <li key={linked}>
              <span>{title(linked)}</span>
              {!links.locked && (
                <IconButton label={`Remove ${title(linked)}`} onClick={() => links.remove(linked)}>
                  <X />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {!links.locked && links.canAdd && (
        <button
          id={id}
          {...aria}
          // Named by its text and the field's label, such as Change Author, since the label alone hides what it does
          aria-labelledby={`${id} ${labelId}`}
          type='button'
          className='iight-button'
          onClick={() => setOpen(true)}
        >
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

  if (!type) return <Notice>There are no content types this field can link to.</Notice>
  return (
    <>
      <Form schema={schema} values={shown} onValuesChange={setQuery} />
      {error && <Notice tone='danger'>{error}</Notice>}
      {!found && !error && <Loading />}
      {found?.length === 0 && (
        <EmptyState icon={<Search />}>{query.search ? 'Nothing matches.' : 'Nothing here yet.'}</EmptyState>
      )}
      {!!found?.length && (
        <ul className='cms-pick-list'>
          {found.map((entry) => (
            <li key={entry.id}>
              {/* Chosen ones stay focusable, so focus stays on the one just picked while the dialog takes more */}
              <button
                type='button'
                aria-disabled={chosen.includes(entry.id) || undefined}
                onClick={() => !chosen.includes(entry.id) && onPick(entry)}
              >
                {titleOf(type, entry)}
                {chosen.includes(entry.id) && <Badge tone='accent'>Chosen</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// A media field: the files it links to, and the media library to choose more from or upload them to
function MediaPicker() {
  const { id, labelId, aria, label, options } = useFieldContext()
  const [open, setOpen] = useState(false)
  const links = useLinks<Media>(async (ids) => {
    const where = JSON.stringify([[{ field: 'id', op: 'in', value: ids }]])
    const { body } = await api('GET', `/media?perPage=100&where=${encodeURIComponent(where)}`)
    return Object.fromEntries(ids.map((id) => [id, body.data.find((file: Media) => file.id === id) ?? null]))
  })

  return (
    <div ref={links.area} className='iight-input__media cms-picker'>
      {links.ids.length > 0 && (
        <ul className='cms-picked'>
          {links.ids.map((linked) => {
            const file = links.records[linked]
            return (
              <li key={linked}>
                {file && <Thumbnail media={file} />}
                <span>{file === undefined ? 'Loading…' : (file?.name ?? 'A deleted file')}</span>
                {!links.locked && (
                  <IconButton label={`Remove ${file?.name ?? 'the file'}`} onClick={() => links.remove(linked)}>
                    <X />
                  </IconButton>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!links.locked && links.canAdd && (
        <button
          id={id}
          {...aria}
          aria-labelledby={`${id} ${labelId}`}
          type='button'
          className='iight-button'
          onClick={() => setOpen(true)}
        >
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

// It holds the name of every icon, a large list, so it loads with the dialog
const IconSearch = lazy(() => import('./iconSearch'))

// The type editor's Icon setting: the icon it names, and a dialog that searches Lucide's icons for another
function IconPicker() {
  const { id, labelId, aria, label, schema, value, readonly, disabled, handleValidation } = useFieldContext()
  const { area, refocus } = useRefocus(id)
  const [open, setOpen] = useState(false)
  const change = (name: string) => {
    refocus()
    handleValidation(inputs.text.validateValue(name, schema))
  }

  return (
    <div ref={area} className='iight-input__icon cms-picker'>
      {value && (
        <ul className='cms-picked'>
          <li>
            <TypeIcon name={value} />
            <span>{value}</span>
            {!readonly && !disabled && (
              <IconButton label={`Remove ${value}`} onClick={() => change('')}>
                <X />
              </IconButton>
            )}
          </li>
        </ul>
      )}
      {!readonly && !disabled && (
        <button
          id={id}
          {...aria}
          aria-labelledby={`${id} ${labelId}`}
          type='button'
          className='iight-button'
          onClick={() => setOpen(true)}
        >
          {value ? 'Change' : 'Choose'}
        </button>
      )}
      {open && (
        <Dialog title={`Choose ${label ? label.toLowerCase() : 'an icon'}`} onClose={() => setOpen(false)}>
          <Suspense fallback={<Loading />}>
            <IconSearch
              chosen={value}
              onPick={(name) => {
                change(name)
                setOpen(false)
              }}
            />
          </Suspense>
        </Dialog>
      )}
    </div>
  )
}

// A form field: one of the forms made in the admin, by its label, with those taking no submissions marked closed
function FormPicker() {
  const { id, aria, schema, required, value, readonly, disabled, handleValidation } = useFieldContext()
  const [forms, setForms] = useState<Array<{ id: string; label: string; open: boolean }>>()
  const [problem, setProblem] = useState('')
  useEffect(() => {
    api('GET', '/forms').then(
      ({ body }) => setForms(body.data),
      (error) => setProblem(errorMessage(error)),
    )
  }, [])
  const known = !value || forms?.some((each) => each.id === value)
  // Until the forms load, or when they can't, the one it holds is named as that
  const unknown = forms ? 'A form that no longer exists' : problem ? "A form that couldn't be loaded" : 'Loading…'

  return (
    <>
      <div className='iight-input__select'>
        <select
          className='iight-input'
          id={id}
          {...aria}
          value={value ?? ''}
          required={required}
          disabled={disabled || readonly}
          onChange={(event) => handleValidation(form.validateValue(event.target.value || null, schema))}
        >
          <option value=''>None</option>
          {!known && <option value={value}>{unknown}</option>}
          {forms?.map((each) => (
            <option key={each.id} value={each.id}>
              {each.open ? each.label : `${each.label} (closed)`}
            </option>
          ))}
        </select>
      </div>
      {problem && (
        <p className='cms-problem' role='alert'>
          <CircleAlert /> Couldn't load the forms. {problem}
        </p>
      )}
    </>
  )
}

// The type editor's Icon setting, whose value is text: the name of one of Lucide's icons
export const iconInput: Input = { ...inputs.text, default: IconPicker }

// The CMS's inputs with their pickers, for the forms that edit entries, content types and shared groups. The schema
// builder offers a Shared group field while there's a shared group to use, other than the one it's building.
export function useInputs(building?: string) {
  const types = useContext(TypesContext)
  const groups = useContext(GroupsContext)
  return useMemo<Record<string, Input>>(() => {
    const usable = [...groups.values()].filter((group) => group.id !== building)
    return {
      relationship: {
        ...relationship,
        optionFields: () => relationshipOptions(types.values()),
        default: RelationshipPicker,
      },
      media: { ...media, default: MediaPicker },
      form: { ...form, default: FormPicker },
      // Types expand their uses into groups, so no form ever renders one
      ...(usable.length
        ? { shared: { ...shared, optionFields: () => sharedOptions(usable), default: () => null } }
        : {}),
    }
  }, [types, groups, building])
}
