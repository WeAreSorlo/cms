import { isEmpty, showValue } from '../src/fields'
import { formSchema } from '../src/schemas'
import { api, date, errorMessage } from './api'
import { FormAutomations } from './automations'
import {
  Badge,
  EmptyState,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Pagination,
  Panel,
  RouteTabs,
  focusInvalid,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle } from 'iight'
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  ClipboardList,
  Copy,
  Inbox as InboxIcon,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
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

  const newForm = (
    <a className='iight-button iight-button--primary' href='#/forms/new'>
      <Plus /> New form
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='Forms' actions={newForm} />
      {error && <Notice tone='danger'>{error}</Notice>}
      {!forms && !error && <Loading />}
      {forms?.length === 0 && (
        <EmptyState icon={<ClipboardList />} action={newForm}>
          No forms yet.
        </EmptyState>
      )}
      {!!forms?.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Label</th>
                <th>Name</th>
                <th className='cms-table__number'>Version</th>
                <th>Submissions</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((form) => (
                <tr key={form.id}>
                  <td>
                    <a href={`#/forms/${form.id}`}>{form.label}</a>
                  </td>
                  <td>
                    <code>{form.name}</code>
                  </td>
                  <td className='cms-table__number'>{form.version}</td>
                  <td>
                    <a href={`#/forms/${form.id}/inbox`}>Inbox</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Create or change a form: its settings, and its fields in core's schema builder. Changing the fields saves a new
// version, which submissions from then on are checked against. A saved form shows the HTML that embeds it.
export function FormEditor({ form: loaded }: { form?: FormRecord }) {
  const settingsForm = useRef<FormHandle>(null)
  const fieldsForm = useRef<FormHandle>(null)
  // Around both forms, for finding the fields that stop a save
  const forms = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const [form, setForm] = useState(loaded)
  const [settings, setSettings] = useState<Record<string, any>>({ label: loaded?.label, name: loaded?.name })
  const [shown] = useState(settings)
  const [fields, setFields] = useState<Array<FieldSchema>>(loaded?.fields ?? [])
  const [shownFields] = useState({ fields })
  const [problem, setProblem] = useState('')
  const [copyProblem, setCopyProblem] = useState('')
  const [busy, setBusy] = useState(false)

  // The button stays enabled while it saves, so it keeps focus, and a second click is ignored here instead
  const save = async () => {
    if (busy) return
    setProblem('')
    if (!settingsForm.current?.validate().isValid) return focusInvalid(forms.current).then(setProblem)
    setBusy(true)
    try {
      const body = { ...settings, fields }
      const { status, body: reply } = form
        ? await api('PUT', `/forms/${form.id}`, body)
        : await api('POST', '/forms', body)

      if (status === 422) {
        settingsForm.current.applyReport(reply)
        fieldsForm.current?.applyReport(reply)
        return focusInvalid(forms.current).then(setProblem)
      }
      if (!form) {
        toast('Saved')
        return void (location.hash = `#/forms/${reply.data.id}`)
      }

      const { version } = reply.data
      toast(version > form.version ? `Saved as version ${version}, which new submissions are checked against` : 'Saved')
      setForm(reply.data)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    setCopyProblem('')
    navigator.clipboard.writeText(form!.embed).then(
      () => toast('Copied the HTML'),
      () => setCopyProblem("Couldn't copy the HTML. Select it and copy it instead."),
    )
  }

  return (
    <div>
      <PageHeader
        back={{ href: '#/forms', label: 'Forms' }}
        title={form ? form.label : 'New form'}
        meta={form && <Badge>Version {form.version}</Badge>}
        actions={
          form && (
            <a className='iight-button' href={`#/forms/${form.id}/inbox`}>
              <InboxIcon /> Inbox
            </a>
          )
        }
      />

      <div ref={forms}>
        <Form ref={settingsForm} schema={formSchema} values={shown} onValuesChange={setSettings} />
        <Form
          ref={fieldsForm}
          schema={fieldsSchema}
          values={shownFields}
          onValuesChange={(next) => setFields(next.fields ?? [])}
        />
      </div>

      <Panel
        label='About this form'
        problem={problem}
        actions={
          <button type='button' className='iight-button iight-button--primary' aria-busy={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        }
      />

      {form && (
        <section className='cms-section'>
          <h2>Embed</h2>
          <p>
            Paste this HTML into any page. It posts to the form without JavaScript, takes the page's own styles, and
            shows the form as it was last saved. In code, the SDK sends the form values with{' '}
            <code>cms.form('{form.name}').submit(values)</code>.
          </p>
          <textarea className='embed' aria-label='HTML to embed' readOnly rows={12} value={form.embed} />
          <div className='actions'>
            <button type='button' className='iight-button' onClick={copy}>
              <Copy /> Copy
            </button>
            {copyProblem && (
              <p className='cms-problem' role='alert'>
                <CircleAlert /> {copyProblem}
              </p>
            )}
          </div>
        </section>
      )}

      {form && (
        <div className='cms-section'>
          <FormAutomations formId={form.id} />
        </div>
      )}
    </div>
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

  if (error) return <Notice tone='danger'>{error}</Notice>
  return form ? <FormEditor form={form} /> : <Loading />
}

// What the inbox calls a submission: its first email address or text, as legacy's did
function summary(fields: Array<FieldSchema>, values: Record<string, any>) {
  const first = (type: string) => fields.find((field) => field.type === type && !isEmpty(values[field.name]))
  const field = first('email') ?? first('text')
  return field ? String(values[field.name]) : 'Submission'
}

const emptyViews = { inbox: 'No submissions yet.', spam: 'No spam.', archive: 'Nothing is archived.' }

// What each action says once it's done, since each takes the submission out of the view
const done = { archive: 'Archived', restore: 'Restored', spam: 'Marked as spam', 'not-spam': 'Moved to the inbox' }

// A form's inbox, spam or archive, newest first, with the submission that's open beside the list when there's room. A
// submission opens with the fields of the version it was checked against.
export function Inbox({ id, view }: { id: string; view: View }) {
  const [form, setForm] = useState<FormRecord>()
  const [list, setList] = useState<{ data: Array<Submission>; pagination: Pagination }>()
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Submission>()
  // Each version's fields by its number, loaded as submissions open
  const [versions, setVersions] = useState<Record<number, Array<FieldSchema>>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const detail = useRef<HTMLHeadingElement>(null)
  const listArea = useRef<HTMLDivElement>(null)
  const toast = useToast()

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

  // Focus follows the submission into its panel, which is under the list on narrow screens
  const openSubmission = async (submission: Submission) => {
    setOpen(submission)
    setTimeout(() => detail.current?.focus())
    if (versions[submission.version]) return
    const { body } = await api('GET', `/forms/${id}/versions/${submission.version}`).catch((error) => {
      setError(errorMessage(error))
      return { body: undefined }
    })
    if (body) setVersions((all) => ({ ...all, [submission.version]: body.data.fields }))
  }

  // Archive, restore, or mark as spam or not, each of which takes the submission out of this view. Focus goes back to
  // the list, since the panel closes.
  const act = async (action: keyof typeof done) => {
    if (busy || !open) return
    setBusy(true)
    try {
      await api('POST', `/submissions/${open.id}/${action}`)
      setOpen(undefined)
      toast(done[action])
      await load()
      listArea.current?.querySelector('button')?.focus()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const fields = open && versions[open.version]

  return (
    <div className='cms-page'>
      <PageHeader
        back={{ href: '#/forms', label: 'Forms' }}
        title={form ? `${form.label}: ${views[view].toLowerCase()}` : views[view]}
        actions={
          form && (
            <a className='iight-button' href={`#/forms/${id}`}>
              <Pencil /> Edit the form
            </a>
          )
        }
      />
      <RouteTabs
        label='Submissions'
        current={view}
        tabs={Object.entries(views).map(([key, label]) => ({ key, href: `#/forms/${id}/${key}`, label }))}
      />

      {error && <Notice tone='danger'>{error}</Notice>}
      {!list && !error && <Loading />}
      {list?.data.length === 0 && <EmptyState icon={<InboxIcon />}>{emptyViews[view]}</EmptyState>}

      {!!list?.data.length && (
        <div className='cms-split'>
          <div ref={listArea} className='cms-split__list'>
            <div className='cms-table-wrap'>
              <table className='cms-table'>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((submission) => (
                    <tr key={submission.id} className={submission.id === open?.id ? 'cms-table__selected' : undefined}>
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
            </div>
            {!!list.pagination.total && <Pages pagination={list.pagination} onPage={setPage} />}
          </div>

          <section className='cms-split__detail' aria-label='Submission'>
            {open ? (
              <>
                <h2 ref={detail} tabIndex={-1}>
                  {summary(fields ?? form?.fields ?? [], open.values)}
                </h2>
                <p className='cms-muted'>
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
                          <dd>{showValue(field, open.values[field.name])}</dd>
                        </div>
                      ))}
                  </dl>
                ) : (
                  <Loading />
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
                  {view === 'inbox' && (
                    <button type='button' className='iight-button' onClick={() => act('archive')}>
                      <Archive /> Archive
                    </button>
                  )}
                  {view === 'archive' && (
                    <button type='button' className='iight-button' onClick={() => act('restore')}>
                      <ArchiveRestore /> Restore
                    </button>
                  )}
                  {open.spam ? (
                    <button type='button' className='iight-button' onClick={() => act('not-spam')}>
                      <ShieldCheck /> Not spam
                    </button>
                  ) : (
                    <button type='button' className='iight-button' onClick={() => act('spam')}>
                      <ShieldAlert /> Mark as spam
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className='cms-muted'>Choose a submission to read it.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
