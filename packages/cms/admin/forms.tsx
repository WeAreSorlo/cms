import { formSchema } from '../src/schemas'
import { api, date, errorMessage } from './api'
import Form, { FieldSchema, FormHandle } from 'iight'
import { useCallback, useEffect, useRef, useState } from 'react'

// A form as the admin API returns it
interface FormRecord {
  id: string
  name: string
  label: string
  version: number
  fields: Array<FieldSchema>
  // HTML for pasting the form into a page, as it was last saved
  embed: string
}

interface Submission {
  id: string
  version: number
  values: Record<string, any>
  spam: boolean
  ip: string | null
  userAgent: string | null
  referer: string | null
  createdAt: string
  archivedAt: string | null
}

// The builder is a form of its own, as in the type editor, offering every one of core's inputs
const fieldsSchema: Array<FieldSchema> = [{ name: 'fields', label: 'Fields', type: 'schemabuilder' }]

const views = { inbox: 'Inbox', spam: 'Spam', archive: 'Archive' }
export type View = keyof typeof views
export const isView = (action: string): action is View => Object.hasOwn(views, action)

// Every form, each opening in the form editor, with a link to its inbox
export function FormList() {
  const [forms, setForms] = useState<Array<FormRecord>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', '/forms')
      .then(({ body }) => setForms(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  return (
    <>
      <header>
        <h1>Forms</h1>
        <a href='#/forms/new'>New form</a>
      </header>
      {error && <p role='alert'>{error}</p>}
      {forms?.length === 0 && <p>No forms yet.</p>}
      {!!forms?.length && (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Name</th>
              <th>Version</th>
              <th>Submissions</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((form) => (
              <tr key={form.id}>
                <td>
                  <a href={`#/forms/${form.id}`}>{form.label}</a>
                </td>
                <td>{form.name}</td>
                <td>{form.version}</td>
                <td>
                  <a href={`#/forms/${form.id}/inbox`}>Inbox</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// Create or change a form: its settings, and its fields in core's schema builder. Changing the fields saves a new
// version, which submissions from then on are checked against. A saved form shows the HTML that embeds it.
export function FormEditor({ form: loaded }: { form?: FormRecord }) {
  const settingsForm = useRef<FormHandle>(null)
  const fieldsForm = useRef<FormHandle>(null)
  const [form, setForm] = useState(loaded)
  const [settings, setSettings] = useState<Record<string, any>>({ label: loaded?.label, name: loaded?.name })
  const [shown] = useState(settings)
  const [fields, setFields] = useState<Array<FieldSchema>>(loaded?.fields ?? [])
  const [shownFields] = useState({ fields })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy || !settingsForm.current?.validate().isValid) return
    setBusy(true)
    setMessage('')
    try {
      const body = { ...settings, fields }
      const { status, body: reply } = form
        ? await api('PUT', `/forms/${form.id}`, body)
        : await api('POST', '/forms', body)

      if (status === 422) {
        settingsForm.current.applyReport(reply)
        fieldsForm.current?.applyReport(reply)
        return setMessage('The form has problems, shown with its settings and fields.')
      }
      if (!form) return void (location.hash = `#/forms/${reply.data.id}`)

      const { version } = reply.data
      setMessage(
        version > form.version ? `Saved as version ${version}, which new submissions are checked against.` : 'Saved.',
      )
      setForm(reply.data)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const copy = () =>
    navigator.clipboard.writeText(form!.embed).then(
      () => setMessage('Copied the HTML.'),
      () => setMessage("Couldn't copy the HTML. Select it and copy it instead."),
    )

  return (
    <>
      <header>
        <a href='#/forms'>Forms</a>
        <h1>{form ? form.label : 'New form'}</h1>
        {form && <a href={`#/forms/${form.id}/inbox`}>Inbox</a>}
      </header>

      {form && <p>Version {form.version}</p>}
      <Form ref={settingsForm} schema={formSchema} values={shown} onValuesChange={setSettings} />
      <Form
        ref={fieldsForm}
        schema={fieldsSchema}
        values={shownFields}
        onValuesChange={(next) => setFields(next.fields ?? [])}
      />

      {message && <p role='status'>{message}</p>}
      <div className='actions'>
        <button type='button' className='iight-button' disabled={busy} onClick={save}>
          Save
        </button>
      </div>

      {form && (
        <section>
          <h2>Embed</h2>
          <p>
            Paste this HTML into any page. It posts to the form without JavaScript, takes the page's own styles, and
            shows the form as it was last saved. In code, the SDK sends the form values with{' '}
            <code>cms.form('{form.name}').submit(values)</code>.
          </p>
          <textarea className='embed' aria-label='HTML to embed' readOnly rows={12} value={form.embed} />
          <div className='actions'>
            <button type='button' className='iight-button' onClick={copy}>
              Copy
            </button>
          </div>
        </section>
      )}
    </>
  )
}

// Open a form by its ID
export function FormPage({ id }: { id: string }) {
  const [form, setForm] = useState<FormRecord>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/forms/${id}`)
      .then(({ body }) => setForm(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  if (error) return <p role='alert'>{error}</p>
  return form ? <FormEditor form={form} /> : null
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

// A submitted value as text: the labels of the choices it holds, yes or no, or JSON for a group or list of rows
function show(field: FieldSchema, value: unknown) {
  if (isEmpty(value)) return '–'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const choices: Array<{ value: string; label?: string }> | undefined = field.options?.choices
  if (choices)
    return [value]
      .flat()
      .map((item) => choices.find((choice) => choice.value === item)?.label ?? item)
      .join(', ')
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

// What the inbox calls a submission: its first email address or text, as legacy's did
function summary(fields: Array<FieldSchema>, values: Record<string, any>) {
  const first = (type: string) => fields.find((field) => field.type === type && !isEmpty(values[field.name]))
  const field = first('email') ?? first('text')
  return field ? String(values[field.name]) : 'Submission'
}

// A form's inbox, spam or archive, newest first. A submission opens with the fields of the version it was checked
// against.
export function Inbox({ id, view }: { id: string; view: View }) {
  const [form, setForm] = useState<FormRecord>()
  const [list, setList] = useState<{ data: Array<Submission>; pagination: { lastPage: number } }>()
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Submission>()
  // Each version's fields by its number, loaded as submissions open
  const [versions, setVersions] = useState<Record<number, Array<FieldSchema>>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api('GET', `/forms/${id}`)
      .then(({ body }) => setForm(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  const load = useCallback(async () => {
    const params = new URLSearchParams({ order: '{"createdAt":"desc"}', page: String(page) })
    if (view === 'spam') params.set('spam', 'true')
    if (view === 'archive') params.set('archived', 'true')
    setList((await api('GET', `/forms/${id}/submissions?${params}`)).body)
  }, [id, view, page])

  useEffect(() => {
    load().catch((error) => setError(errorMessage(error)))
  }, [load])

  const openSubmission = async (submission: Submission) => {
    setOpen(submission)
    if (versions[submission.version]) return
    const { body } = await api('GET', `/forms/${id}/versions/${submission.version}`).catch((error) => {
      setError(errorMessage(error))
      return { body: undefined }
    })
    if (body) setVersions((all) => ({ ...all, [submission.version]: body.data.fields }))
  }

  // Archive, restore or move out of spam, which takes the submission out of this view
  const act = async (action: 'archive' | 'restore' | 'not-spam') => {
    if (busy || !open) return
    setBusy(true)
    try {
      await api('POST', `/submissions/${open.id}/${action}`)
      setOpen(undefined)
      await load()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const fields = open && versions[open.version]

  return (
    <>
      <header>
        <a href='#/forms'>Forms</a>
        <h1>{form ? `${form.label}: ${views[view].toLowerCase()}` : views[view]}</h1>
        {form && <a href={`#/forms/${id}`}>Edit the form</a>}
      </header>
      <nav className='actions' aria-label='Submissions'>
        {Object.entries(views).map(([key, label]) =>
          key === view ? (
            <strong key={key} aria-current='page'>
              {label}
            </strong>
          ) : (
            <a key={key} href={`#/forms/${id}/${key}`}>
              {label}
            </a>
          ),
        )}
      </nav>

      {error && <p role='alert'>{error}</p>}
      {list?.data.length === 0 && <p>Nothing here.</p>}
      {!!list?.data.length && (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((submission) => (
              <tr key={submission.id}>
                <td>
                  <button
                    type='button'
                    className='link'
                    aria-current={submission.id === open?.id}
                    onClick={() => openSubmission(submission)}
                  >
                    {summary(form?.fields ?? [], submission.values)}
                  </button>
                </td>
                <td>{date(submission.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

      {open && (
        <section aria-label='Submission'>
          <h2>{summary(fields ?? form?.fields ?? [], open.values)}</h2>
          <p>
            Received {date(open.createdAt)}, checked against version {open.version}
            {open.archivedAt ? `, archived ${date(open.archivedAt)}` : ''}.
          </p>
          {fields ? (
            <dl className='submission'>
              {fields
                .filter((field) => field.type !== 'content')
                .map((field) => (
                  <div key={field.id ?? field.name}>
                    <dt>{field.label ?? field.name}</dt>
                    <dd>{show(field, open.values[field.name])}</dd>
                  </div>
                ))}
            </dl>
          ) : (
            <p>Loading…</p>
          )}
          <dl className='submission'>
            <div>
              <dt>IP address</dt>
              <dd>{open.ip ?? '–'}</dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>{open.userAgent ?? '–'}</dd>
            </div>
            <div>
              <dt>Sent from</dt>
              <dd>{open.referer ?? '–'}</dd>
            </div>
          </dl>
          <div className='actions'>
            {view === 'spam' && (
              <button type='button' className='iight-button' disabled={busy} onClick={() => act('not-spam')}>
                Not spam
              </button>
            )}
            {view === 'inbox' && (
              <button type='button' className='iight-button' disabled={busy} onClick={() => act('archive')}>
                Archive
              </button>
            )}
            {view === 'archive' && (
              <button type='button' className='iight-button' disabled={busy} onClick={() => act('restore')}>
                Restore
              </button>
            )}
          </div>
        </section>
      )}
    </>
  )
}
