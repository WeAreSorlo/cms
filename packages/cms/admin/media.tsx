import { mediaSchema } from '../src/schemas'
import { ContentType, Entry, TypesContext, api, date, errorMessage, titleOf } from './api'
import Form, { FieldSchema, FormHandle, Modal } from 'iight'
import { useContext, useEffect, useRef, useState } from 'react'

// A media file as the admin API returns it
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
}

// Each type is a condition on the file's mime
const filterSchema: Array<FieldSchema> = [
  {
    name: 'type',
    label: 'Type',
    type: 'select',
    width: 50,
    options: {
      placeholder: 'All types',
      choices: [
        { value: 'image/', label: 'Images' },
        { value: 'video/', label: 'Video' },
        { value: 'audio/', label: 'Audio' },
        { value: 'application/', label: 'Documents' },
      ],
    },
  },
  { name: 'search', label: 'Search', type: 'text', width: 50, options: { placeholder: 'Name' } },
]

const isImage = (media: Media) => media.mime.startsWith('image/')
const extension = (media: Media) => media.name.split('.').pop()!.toUpperCase()

// A file's picture, or its type for other files and for images the browser can't show, such as HEIC outside Safari
export function Thumbnail({ media }: { media: Media }) {
  const [shows, setShows] = useState(isImage(media))
  return shows ? (
    <img src={media.url} alt='' loading='lazy' onError={() => setShows(false)} />
  ) : (
    <span className='media-type'>{extension(media)}</span>
  )
}

// Such as 515 bytes, 482 kB or 1.5 MB
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`
  const [size, unit] = bytes < 1024 ** 2 ? [bytes / 1024, 'kilobyte'] : [bytes / 1024 ** 2, 'megabyte']
  return new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 1 }).format(size)
}

// Choosing files for a media field: the MIME types it takes, the files it holds, and what happens to the one chosen
interface Pick {
  types?: Array<string>
  chosen: Array<string>
  onPick: (media: Media) => void
}

// The media library: every file in a grid, newest first, with a type filter and a search on names. Given a field to
// pick for, it shows only the types the field takes, and a click picks the file rather than editing it.
export function MediaLibrary({ pick }: { pick?: Pick }) {
  const [filters, setFilters] = useState<Record<string, any>>({})
  const [page, setPage] = useState(1)
  const [list, setList] = useState<{ data: Array<Media>; pagination: { lastPage: number } }>()
  const [reloads, setReloads] = useState(0)
  const [editing, setEditing] = useState<Media>()
  const [problems, setProblems] = useState<Array<string>>([])
  const [uploading, setUploading] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const where = [
      filters.type && { field: 'mime', op: 'like', value: filters.type },
      filters.search && { field: 'name', op: 'like', value: filters.search },
    ].filter(Boolean)
    const params = new URLSearchParams({ order: '{"createdAt":"desc"}', page: String(page), perPage: '24' })
    // Any of the types, each with the filters, since groups join with OR
    const groups = pick?.types?.length
      ? pick.types.map((type) => [{ field: 'mime', op: 'like', value: type.replace(/\*$/, '') }, ...where])
      : [where]
    if (groups.some((group) => group.length)) params.set('where', JSON.stringify(groups))

    // A slow reply to an earlier search mustn't replace a newer one
    let current = true
    api('GET', `/media?${params}`)
      .then(({ body }) => current && setList(body))
      .catch((error) => current && setProblems([errorMessage(error)]))
    return () => {
      current = false
    }
  }, [filters, page, reloads, pick?.types?.join()])

  // Each file goes up on its own, so one that's turned away doesn't stop the others
  const upload = async (files: Array<File>) => {
    setUploading(true)
    const failed: Array<string> = []
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      try {
        const { status, body: reply } = await api('POST', '/media', body)
        if (status === 422) failed.push(`${file.name}: ${reply.fields.file.messages.join(' ')}`)
      } catch (error) {
        failed.push(`${file.name}: ${errorMessage(error)}`)
      }
    }
    setProblems(failed)
    setUploading(false)
    setPage(1)
    setReloads((count) => count + 1)
  }

  const reload = () => {
    setEditing(undefined)
    setReloads((count) => count + 1)
  }

  return (
    <>
      <header>
        {!pick && <h1>Media</h1>}
        {/* A button opens the hidden file input, which keyboards can't reach */}
        <button type='button' className='iight-button' disabled={uploading} onClick={() => picker.current?.click()}>
          {uploading ? 'Uploading…' : 'Upload files'}
        </button>
        <input
          ref={picker}
          type='file'
          multiple
          hidden
          accept={pick?.types?.join(',')}
          onChange={(event) => {
            // Copied, since clearing the input empties its list, so choosing the same file again uploads it again
            upload([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
      </header>

      <Form
        // A picker for a field that takes some types has nothing to filter by type
        schema={pick?.types?.length ? filterSchema.slice(1) : filterSchema}
        onValuesChange={(next) => {
          setFilters(next)
          setPage(1)
        }}
      />

      {problems.length > 0 && (
        <ul role='alert'>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {list?.data.length === 0 && <p>{filters.type || filters.search ? 'No files match.' : 'Nothing uploaded yet.'}</p>}
      {!!list?.data.length && (
        <ul className='media-grid'>
          {list.data.map((media) => (
            <li key={media.id}>
              <button
                type='button'
                disabled={pick?.chosen.includes(media.id)}
                onClick={() => (pick ? pick.onPick(media) : setEditing(media))}
              >
                <Thumbnail media={media} />
                <span>{media.name}</span>
                {!media.alt && <small>No alt text</small>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {list && list.pagination.lastPage > 1 && (
        <nav className='actions' aria-label='Pages'>
          <button type='button' className='iight-button' disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {list.pagination.lastPage}
          </span>
          <button
            type='button'
            className='iight-button'
            disabled={page === list.pagination.lastPage}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}

      {editing && <MediaEditor key={editing.id} media={editing} onClose={reload} />}
    </>
  )
}

// The form's values for a file
const detailsOf = (media: Media) => ({ name: media.name, alt: media.alt ?? '', caption: media.caption ?? '' })

// A file's details in a dialog, where its name, alt text and caption change, or it's deleted
function MediaEditor({ media: loaded, onClose }: { media: Media; onClose: () => void }) {
  const form = useRef<FormHandle>(null)
  const [media, setMedia] = useState(loaded)
  // What the form starts from, replaced after a save with the name as the server cleaned it
  const [shown, setShown] = useState(() => detailsOf(loaded))
  const [values, setValues] = useState<Record<string, any>>(shown)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [usedBy, setUsedBy] = useState<Array<Entry>>([])
  const types = useContext(TypesContext)

  useEffect(() => {
    api('GET', `/media/${loaded.id}/used-by`)
      .then(({ body }) => setUsedBy(body.data))
      .catch((error) => setMessage(errorMessage(error)))
  }, [loaded.id])

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
      const { status, body } = await api('PUT', `/media/${media.id}`, values)
      if (status === 422) return form.current.applyReport(body)
      setMedia(body.data)
      setShown(detailsOf(body.data))
      setMessage('Saved.')
    })

  const remove = () =>
    act(async () => {
      if (!confirm(`Delete ${media.name} for good? Pages that show it will lose it.`)) return
      await api('DELETE', `/media/${media.id}`)
      onClose()
    })

  const details = [
    extension(media),
    formatSize(media.size),
    media.width && `${media.width} × ${media.height}`,
    `uploaded ${date(media.createdAt)}`,
  ]

  return (
    <Modal
      open
      header={<h2>{media.name}</h2>}
      closeButton
      onClose={onClose}
      footer={
        <div className='actions'>
          <button type='button' className='iight-button' disabled={busy} onClick={save}>
            Save
          </button>
          <button type='button' className='iight-button' disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      }
    >
      {isImage(media) && (
        <img
          className='media-preview'
          src={media.url}
          alt=''
          onError={(event) => (event.currentTarget.hidden = true)}
        />
      )}
      <p>
        {details.filter(Boolean).join(', ')}.{' '}
        <a href={media.url} target='_blank' rel='noreferrer'>
          Open the file
        </a>
      </p>
      <Form ref={form} schema={mediaSchema} values={shown} onValuesChange={setValues} />
      {message && <p role='status'>{message}</p>}
      <UsedBy entries={usedBy} types={types} />
    </Modal>
  )
}

// The entries that link to a file or an entry, each opening in its editor
export function UsedBy({ entries, types }: { entries: Array<Entry>; types: Map<string, ContentType> }) {
  if (!entries.length) return null
  return (
    <section>
      <h2>Used by</h2>
      <ul>
        {entries.map((entry) => {
          const type = types.get(entry.type)
          return (
            <li key={entry.id}>
              <a href={`#/entries/${entry.id}`}>{type ? titleOf(type, entry) : entry.type}</a>
              {entry.archivedAt ? ' (archived)' : ''}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
