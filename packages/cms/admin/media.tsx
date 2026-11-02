import { mediaSchema } from '../src/schemas'
import { ContentType, Entry, TypesContext, api, date, errorMessage, titleOf } from './api'
import { fieldChoicesOf, filterOf, whereOf } from './lists'
import {
  Badge,
  DialogClose,
  EmptyState,
  ListFilters,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Pagination,
  Panel,
  focusHeading,
  useConfirm,
  useListQuery,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle, Modal } from 'iight'
import {
  CircleAlert,
  FileAudio,
  File as FileIcon,
  FileText,
  FileVideo,
  Images,
  SearchX,
  Trash2,
  Upload,
} from 'lucide-react'
import { DragEvent, MouseEvent, useContext, useEffect, useRef, useState } from 'react'

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

// A search on names, and each type a condition on the file's mime
const searchSchema: Array<FieldSchema> = [
  { name: 'search', label: 'Search', type: 'text', width: 50, options: { placeholder: 'Name' } },
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
]

// What a filter's rules can test of a file, by the names the list API gives them
const mediaFields = new Map(
  (
    [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'alt', label: 'Alt text', type: 'text' },
      { name: 'caption', label: 'Caption', type: 'text' },
      { name: 'mime', label: 'MIME type', type: 'text' },
      { name: 'width', label: 'Width', type: 'number' },
      { name: 'height', label: 'Height', type: 'number' },
      { name: 'createdAt', label: 'Uploaded', type: 'date' },
    ] satisfies Array<FieldSchema>
  ).map((field) => [field.name, field]),
)
const mediaChoices = fieldChoicesOf(mediaFields)
// A picker for a field that takes some types has nothing to filter by type
const nameSchema = searchSchema.filter((field) => field.name !== 'type')

const isImage = (media: Media) => media.mime.startsWith('image/')
const extension = (media: Media) => media.name.split('.').pop()!.toUpperCase()

// A file's picture, on squares that show where it's transparent, or the kind of file for the rest and for images the
// browser can't show, such as HEIC outside Safari
export function Thumbnail({ media }: { media: Media }) {
  const [shows, setShows] = useState(isImage(media))
  const Icon = media.mime.startsWith('video/')
    ? FileVideo
    : media.mime.startsWith('audio/')
      ? FileAudio
      : media.mime === 'application/pdf'
        ? FileText
        : FileIcon
  return (
    <span className='cms-thumbnail'>
      {shows ? (
        <img src={media.url} alt='' loading='lazy' onError={() => setShows(false)} />
      ) : (
        <>
          <Icon />
          {extension(media)}
        </>
      )}
    </span>
  )
}

// Such as 515 bytes, 482 kB or 1.5 MB
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`
  const [size, unit] = bytes < 1024 ** 2 ? [bytes / 1024, 'kilobyte'] : [bytes / 1024 ** 2, 'megabyte']
  return new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: 1 }).format(size)
}

// Such as PNG · 106 kB · 1266×700
const detailsOf = (media: Media) =>
  [extension(media), formatSize(media.size), media.width && `${media.width}×${media.height}`]
    .filter(Boolean)
    .join(' · ')

// A file in the grid. In a picker, the files the field already holds can't be chosen again, though they stay
// focusable, so focus stays on the one just picked while the dialog takes more.
export function MediaCard({ media, chosen, onClick }: { media: Media; chosen?: boolean; onClick: () => void }) {
  return (
    <button
      type='button'
      className='cms-media-card'
      aria-disabled={chosen || undefined}
      onClick={chosen ? undefined : onClick}
    >
      <Thumbnail media={media} />
      <span className='cms-media-card__name' title={media.name}>
        {media.name}
      </span>
      <span className='cms-media-card__details'>{detailsOf(media)}</span>
      {(chosen || !media.alt) && (
        <span className='cms-media-card__badges'>
          {chosen && <Badge tone='accent'>Chosen</Badge>}
          {!media.alt && <Badge tone='warning'>No alt text</Badge>}
        </span>
      )}
    </button>
  )
}

// Choosing files for a media field: the MIME types it takes, the files it holds, and what happens to the one chosen
interface Pick {
  types?: Array<string>
  chosen: Array<string>
  onPick: (media: Media) => void
}

// The media library: every file in a grid, newest first, with a search on names, a type filter and a filter on its
// details, in the URL's query. Files dropped on the grid upload, as chosen ones do. Given a field to pick for, it
// shows only the types the field takes, keeps its filters to itself, and a click picks the file rather than editing it.
export function MediaLibrary({ pick, query }: { pick?: Pick; query?: string }) {
  const filters = useListQuery(pick ? undefined : query)
  const { page, setPage } = filters
  const [list, setList] = useState<{ data: Array<Media>; pagination: Pagination }>()
  const [reloads, setReloads] = useState(0)
  const [editing, setEditing] = useState<Media>()
  const [error, setError] = useState('')
  // The files an upload turned away
  const [problems, setProblems] = useState<Array<string>>([])
  // Such as Uploading 2 of 3…, while files go up
  const [progress, setProgress] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const toast = useToast()

  const type = filters.params.get('type')
  const search = filters.params.get('search')?.trim()
  const { where, left } = whereOf(
    mediaFields,
    filterOf(filters.params),
    [type && { field: 'mime', op: 'like', value: type }, search && { field: 'name', op: 'like', value: search }].filter(
      (condition) => !!condition,
    ),
  )
  // Any of the types, each with the filters, since groups join with OR
  const groups = pick?.types?.length
    ? pick.types.flatMap((type) =>
        (where.length ? where : [[]]).map((group) => [
          { field: 'mime', op: 'like', value: type.replace(/\*$/, '') },
          ...group,
        ]),
      )
    : where
  const groupsKey = JSON.stringify(groups)

  useEffect(() => {
    const params = new URLSearchParams({ order: '{"createdAt":"desc"}', page: String(page), perPage: '24' })
    if (groups.length) params.set('where', groupsKey)

    // A slow reply to an earlier search mustn't replace a newer one
    let current = true
    api('GET', `/media?${params}`)
      .then(({ body }) => {
        if (!current) return
        setList(body)
        setError('')
      })
      .catch((error) => current && setError(errorMessage(error)))
    return () => {
      current = false
    }
  }, [groupsKey, page, reloads])

  // A picker takes only its field's types, which the file chooser enforces with accept, and dropped files skip
  const takes = (file: File) =>
    !pick?.types?.length ||
    pick.types.some((type) => (type.endsWith('*') ? file.type.startsWith(type.slice(0, -1)) : file.type === type))

  // Each file goes up on its own, so one that's turned away doesn't stop the others
  const upload = async (files: Array<File>) => {
    if (progress || !files.length) return
    const failed = files.filter((file) => !takes(file)).map((file) => `${file.name} isn't a type this field takes.`)
    const taken = files.filter(takes)
    for (const [index, file] of taken.entries()) {
      setProgress(`Uploading ${index + 1} of ${taken.length}…`)
      const body = new FormData()
      body.append('file', file)
      try {
        const { status, body: reply } = await api('POST', '/media', body)
        if (status === 422) failed.push(`${file.name}: ${reply.fields.file.messages.join(' ')}`)
      } catch (error) {
        failed.push(`${file.name}: ${errorMessage(error)}`)
      }
    }
    setProgress('')
    setProblems(failed)
    const uploaded = files.length - failed.length
    if (uploaded) toast(uploaded === 1 ? 'Uploaded a file' : `Uploaded ${uploaded} files`)
    setPage(1)
    setReloads((count) => count + 1)
  }

  const reload = () => {
    setEditing(undefined)
    setReloads((count) => count + 1)
  }

  // Its button goes, so focus moves to a picker's search, or to the page's heading
  const clearFilters = (event: MouseEvent<HTMLButtonElement>) => {
    const search = event.currentTarget.closest('dialog')?.querySelector<HTMLElement>('.cms-filters input')
    filters.clear()
    if (search) search.focus()
    else focusHeading()
  }

  // Dragging over a child of the zone leaves the zone itself, so only leaving for somewhere outside it counts
  const drop = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setDragging(false)
      upload([...event.dataTransfer.files])
    },
  }

  // A button opens the hidden file input, which keyboards can't reach. It stays enabled while files go up, so it
  // keeps focus, and upload ignores a second go until the first is done.
  const uploadButton = (
    <button
      type='button'
      className={pick ? 'iight-button' : 'iight-button iight-button--primary'}
      aria-busy={!!progress}
      onClick={() => !progress && picker.current?.click()}
    >
      <Upload /> {progress || 'Upload files'}
    </button>
  )

  const filterForms = (
    <ListFilters
      list={filters}
      schema={pick?.types?.length ? nameSchema : searchSchema}
      fieldChoices={mediaChoices}
      count={list?.pagination.total}
      noun={['file', 'files']}
      left={left}
    />
  )

  return (
    <div className={pick ? undefined : 'cms-page'}>
      {pick ? (
        <>
          <div className='cms-toolbar'>{uploadButton}</div>
          {filterForms}
        </>
      ) : (
        <>
          <PageHeader title='Media' />
          <Panel label='Media' actions={uploadButton} sheet='Filters'>
            {filterForms}
          </Panel>
        </>
      )}
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

      {error && <Notice tone='danger'>{error}</Notice>}
      {problems.length > 0 && (
        <Notice tone='danger'>
          {problems.length === 1 ? (
            problems[0]
          ) : (
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <div className='cms-dropzone' data-dragging={dragging || undefined} {...drop}>
        {!list && !error && <Loading />}
        {list?.data.length === 0 &&
          (where.length ? (
            <EmptyState
              icon={<SearchX />}
              action={
                <button type='button' className='iight-button' onClick={clearFilters}>
                  Clear filters
                </button>
              }
            >
              No files match.
            </EmptyState>
          ) : (
            <EmptyState icon={<Images />} action={uploadButton}>
              Nothing uploaded yet. Drop files here, or upload them.
            </EmptyState>
          ))}
        {!!list?.data.length && (
          <ul className='cms-media-grid'>
            {list.data.map((media) => (
              <li key={media.id}>
                <MediaCard
                  media={media}
                  chosen={pick?.chosen.includes(media.id)}
                  onClick={() => (pick ? pick.onPick(media) : setEditing(media))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {!!list?.pagination.total && <Pages pagination={list.pagination} onPage={setPage} />}

      {editing && <MediaEditor key={editing.id} media={editing} onClose={reload} />}
    </div>
  )
}

// The form's values for a file
const valuesOf = (media: Media) => ({ name: media.name, alt: media.alt ?? '', caption: media.caption ?? '' })

// A file's details in a dialog, where its name, alt text and caption change, or it's deleted
function MediaEditor({ media: loaded, onClose }: { media: Media; onClose: () => void }) {
  const form = useRef<FormHandle>(null)
  const [media, setMedia] = useState(loaded)
  // What the form starts from, replaced after a save with the name as the server cleaned it
  const [shown, setShown] = useState(() => valuesOf(loaded))
  const [values, setValues] = useState<Record<string, any>>(shown)
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()
  const [usedBy, setUsedBy] = useState<Array<Entry>>([])
  const types = useContext(TypesContext)
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    api('GET', `/media/${loaded.id}/used-by`)
      .then(({ body }) => setUsedBy(body.data))
      .catch((error) => setProblem(errorMessage(error)))
  }, [loaded.id])

  // Run an action, showing what went wrong if it fails. The buttons stay enabled, so the focused one keeps focus, and
  // a second click is ignored here instead.
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

  const save = () =>
    act('save', async () => {
      if (!form.current?.validate().isValid) return
      const { status, body } = await api('PUT', `/media/${media.id}`, values)
      if (status === 422) return form.current.applyReport(body)
      setMedia(body.data)
      setShown(valuesOf(body.data))
      toast('Saved')
    })

  // It asks before the action starts, so the question's dialog hands focus back to Delete
  const remove = async (dialog: HTMLDialogElement | null) => {
    const sure = await confirm({
      title: `Delete ${media.name} for good?`,
      body: 'Pages that show it will lose it.',
      action: 'Delete for good',
      danger: true,
    })
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/media/${media.id}`)
      toast('Deleted')
      dialog?.close()
    })
  }

  return (
    <Modal
      open
      header={<h2>{media.name}</h2>}
      closeButton={<DialogClose />}
      onClose={onClose}
      footer={
        <div className='cms-dialog-actions'>
          <button
            type='button'
            className='iight-button iight-button--danger cms-dialog-actions__start'
            onClick={(event) => remove(event.currentTarget.closest('dialog'))}
          >
            <Trash2 /> Delete
          </button>
          {problem && (
            <p className='cms-problem' role='alert'>
              <CircleAlert /> {problem}
            </p>
          )}
          <button
            type='button'
            className='iight-button iight-button--primary'
            aria-busy={busy === 'save'}
            onClick={save}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className='cms-media-details'>
        <Thumbnail media={media} />
        <p>
          {detailsOf(media)} · uploaded {date(media.createdAt)} ·{' '}
          <a href={media.url} target='_blank' rel='noreferrer'>
            Open the file
          </a>
        </p>
      </div>
      <Form ref={form} schema={mediaSchema} values={shown} onValuesChange={setValues} />
      <UsedBy entries={usedBy} types={types} />
    </Modal>
  )
}

// The entries that link to a file or an entry, each opening in its editor
export function UsedBy({ entries, types }: { entries: Array<Entry>; types: Map<string, ContentType> }) {
  if (!entries.length) return null
  return (
    <section className='cms-used-by'>
      <h2>Used by</h2>
      <ul>
        {entries.map((entry) => {
          const type = types.get(entry.type)
          return (
            <li key={entry.id}>
              <a href={`#/entries/${entry.id}`}>{type ? titleOf(type, entry) : entry.type}</a>
              {type && <span className='cms-muted'>{type.singular ?? type.label}</span>}
              {entry.archivedAt && <Badge tone='warning'>Archived</Badge>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
