import { actionLayouts, automationSchema, events } from '../src/schemas'
import { api, date, errorMessage } from './api'
import Form, { FormHandle, baseInputSchemaFields } from 'iight'
import { useCallback, useEffect, useRef, useState } from 'react'

// An automation as the admin API returns it
interface Automation {
  id: string
  name: string
  triggers: Array<string>
  conditions: Array<{ rules: Array<{ field: string; operator: string; value?: string }> }>
  // Flexible blocks, each with _layout naming its action
  actions: Array<Record<string, any>>
}

// A try of one of an automation's actions
interface Run {
  id: string
  event: { id: string; name: string; createdAt: string }
  action: number
  attempt: number
  status: 'pending' | 'succeeded' | 'failed'
  runAt: string
  finishedAt: string | null
  response: string | null
  error: string | null
}

const schema = automationSchema(baseInputSchemaFields())

const settingsOf = ({ name, triggers, conditions, actions }: Automation) => ({ name, triggers, conditions, actions })

const eventLabel = (name: string) => events.find((event) => event.value === name)?.label ?? name

const actionLabel = (automation: Automation, index: number) =>
  actionLayouts.find((layout) => layout.name === automation.actions[index]?._layout)?.label ?? 'A removed action'

// Automations, with what triggers them and what they do, each opening in the automation editor
function AutomationTable({ automations }: { automations: Array<Automation> }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>When</th>
          <th>Then</th>
          <th>Runs</th>
        </tr>
      </thead>
      <tbody>
        {automations.map((automation) => (
          <tr key={automation.id}>
            <td>
              <a href={`#/automations/${automation.id}`}>{automation.name}</a>
            </td>
            <td>{automation.triggers.map(eventLabel).join(', ')}</td>
            <td>{automation.actions.map((_, index) => actionLabel(automation, index)).join(', ')}</td>
            <td>
              <a href={`#/automations/${automation.id}/runs`}>Runs</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function AutomationList() {
  const [automations, setAutomations] = useState<Array<Automation>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', '/automations')
      .then(({ body }) => setAutomations(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  return (
    <>
      <header>
        <h1>Automations</h1>
        <a href='#/automations/new'>New automation</a>
      </header>
      {error && <p role='alert'>{error}</p>}
      {automations?.length === 0 && <p>No automations yet.</p>}
      {!!automations?.length && <AutomationTable automations={automations} />}
    </>
  )
}

// The automations a form's submissions can run, on the form's page, with a way to start one that emails them
export function FormAutomations({ formId }: { formId: string }) {
  const [automations, setAutomations] = useState<Array<Automation>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/automations?form=${formId}`)
      .then(({ body }) => setAutomations(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [formId])

  return (
    <section>
      <h2>Automations</h2>
      <p>Each submission runs the automations whose conditions it meets.</p>
      {error && <p role='alert'>{error}</p>}
      {automations?.length === 0 && <p>None yet.</p>}
      {!!automations?.length && <AutomationTable automations={automations} />}
      <div className='actions'>
        <a href={`#/automations/new/${formId}`}>Email new submissions</a>
      </div>
    </section>
  )
}

// Create or change an automation in a core form: the events that trigger it, conditions on their data, and the
// actions it runs in order
function AutomationEditor({ automation: loaded, initial }: { automation?: Automation; initial?: object }) {
  const form = useRef<FormHandle>(null)
  const [automation, setAutomation] = useState(loaded)
  const [shown, setShown] = useState<Record<string, any>>(loaded ? settingsOf(loaded) : (initial ?? {}))
  const [values, setValues] = useState(shown)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy || !form.current?.validate().isValid) return
    setBusy(true)
    setMessage('')
    try {
      const { status, body } = automation
        ? await api('PUT', `/automations/${automation.id}`, values)
        : await api('POST', '/automations', values)

      if (status === 422) {
        form.current.applyReport(body)
        return setMessage('The automation has problems, shown with its settings.')
      }
      if (!automation) return void (location.hash = `#/automations/${body.data.id}`)

      // Saving makes a new webhook's secret, so show the settings as they were saved
      setAutomation(body.data)
      setShown(settingsOf(body.data))
      setValues(settingsOf(body.data))
      setMessage('Saved.')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || !automation || !confirm(`Delete ${automation.name}? Its runs go too, and any still to come.`)) return
    setBusy(true)
    try {
      await api('DELETE', `/automations/${automation.id}`)
      location.hash = '#/automations'
    } catch (error) {
      setMessage(errorMessage(error))
      setBusy(false)
    }
  }

  return (
    <>
      <header>
        <a href='#/automations'>Automations</a>
        <h1>{automation ? automation.name : 'New automation'}</h1>
        {automation && <a href={`#/automations/${automation.id}/runs`}>Runs</a>}
      </header>

      <Form ref={form} schema={schema} values={shown} onValuesChange={setValues} />

      {message && <p role='status'>{message}</p>}
      <div className='actions'>
        <button type='button' className='iight-button' disabled={busy} onClick={save}>
          Save
        </button>
        {automation && (
          <button type='button' className='iight-button' disabled={busy} onClick={remove}>
            Delete
          </button>
        )}
      </div>
    </>
  )
}

// Open an automation by its ID
export function AutomationPage({ id }: { id: string }) {
  const [automation, setAutomation] = useState<Automation>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/automations/${id}`)
      .then(({ body }) => setAutomation(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  if (error) return <p role='alert'>{error}</p>
  return automation ? <AutomationEditor automation={automation} /> : null
}

// A new automation, or with a form's ID, one that emails the form's submissions, leaving out spam
export function NewAutomation({ formId }: { formId?: string }) {
  const [initial, setInitial] = useState<object | undefined>(formId ? undefined : {})
  const [error, setError] = useState('')

  useEffect(() => {
    if (!formId) return
    api('GET', `/forms/${formId}`)
      .then(({ body: { data: form } }) =>
        setInitial({
          name: `${form.label} notifications`,
          triggers: ['submission.created'],
          conditions: [
            {
              rules: [
                { field: 'form.id', operator: 'equals', value: form.id },
                { field: 'submission.spam', operator: 'equals', value: 'false' },
              ],
            },
          ],
          actions: [{ _layout: 'email' }],
        }),
      )
      .catch((error) => setError(errorMessage(error)))
  }, [formId])

  if (error) return <p role='alert'>{error}</p>
  return initial ? <AutomationEditor initial={initial} /> : null
}

// When a pending try is due, or when a try finished
const when = (run: Run) =>
  run.status === 'pending'
    ? `Due ${date(run.runAt)}`
    : `${run.status === 'succeeded' ? 'Succeeded' : 'Failed'} ${date(run.finishedAt!)}`

// An automation's runs, newest first: each try of each of its actions, with what came back or why it failed
export function Runs({ id }: { id: string }) {
  const [automation, setAutomation] = useState<Automation>()
  const [list, setList] = useState<{ data: Array<Run>; pagination: { lastPage: number } }>()
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', `/automations/${id}`)
      .then(({ body }) => setAutomation(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  const load = useCallback(async () => {
    const params = new URLSearchParams({ order: '{"id":"desc"}', page: String(page) })
    setList((await api('GET', `/automations/${id}/runs?${params}`)).body)
  }, [id, page])

  const refresh = useCallback(() => load().catch((error) => setError(errorMessage(error))), [load])
  useEffect(() => void refresh(), [refresh])

  return (
    <>
      <header>
        <a href='#/automations'>Automations</a>
        <h1>{automation ? `${automation.name}: runs` : 'Runs'}</h1>
        {automation && <a href={`#/automations/${id}`}>Edit the automation</a>}
        <button type='button' className='iight-button' onClick={refresh}>
          Refresh
        </button>
      </header>

      {error && <p role='alert'>{error}</p>}
      {list?.data.length === 0 && <p>No runs yet. Each try of each action shows here.</p>}
      {!!list?.data.length && (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Action</th>
              <th>Try</th>
              <th>Status</th>
              <th>What came back</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((run) => (
              <tr key={run.id}>
                <td>
                  {eventLabel(run.event.name)}
                  <br />
                  <small>{date(run.event.createdAt)}</small>
                </td>
                <td>{automation ? `${run.action + 1}. ${actionLabel(automation, run.action)}` : run.action + 1}</td>
                <td>{run.attempt}</td>
                <td>{when(run)}</td>
                <td>
                  {run.error && <p>{run.error}</p>}
                  {run.response && <pre className='response'>{run.response}</pre>}
                </td>
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
    </>
  )
}
