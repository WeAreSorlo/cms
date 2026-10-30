import { actionLayouts, automationSchema, events } from '../src/schemas'
import { api, date, errorMessage } from './api'
import {
  Badge,
  EmptyState,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Pagination,
  Panel,
  focusInvalid,
  useConfirm,
  useToast,
} from './ui'
import Form, { FormHandle, baseInputSchemaFields } from 'iight'
import { History, Mail, Pencil, Plus, RefreshCw, Trash2, Workflow } from 'lucide-react'
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
    <div className='cms-table-wrap'>
      <table className='cms-table'>
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
    </div>
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

  const newAutomation = (
    <a className='iight-button iight-button--primary' href='#/automations/new'>
      <Plus /> New automation
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='Automations' actions={newAutomation} />
      {error && <Notice tone='danger'>{error}</Notice>}
      {!automations && !error && <Loading />}
      {automations?.length === 0 && (
        <EmptyState icon={<Workflow />} action={newAutomation}>
          No automations yet.
        </EmptyState>
      )}
      {!!automations?.length && <AutomationTable automations={automations} />}
    </div>
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
      {error && <Notice tone='danger'>{error}</Notice>}
      {!automations && !error && <Loading />}
      {automations?.length === 0 && <p className='cms-muted'>None yet.</p>}
      {!!automations?.length && <AutomationTable automations={automations} />}
      <div className='actions'>
        <a className='iight-button' href={`#/automations/new/${formId}`}>
          <Mail /> Email new submissions
        </a>
      </div>
    </section>
  )
}

// Create or change an automation in a core form: the events that trigger it, conditions on their data, and the
// actions it runs in order
function AutomationEditor({ automation: loaded, initial }: { automation?: Automation; initial?: object }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the fields that stop a save
  const area = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const [automation, setAutomation] = useState(loaded)
  const [shown, setShown] = useState<Record<string, any>>(loaded ? settingsOf(loaded) : (initial ?? {}))
  const [values, setValues] = useState(shown)
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()

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

  // Once the form has shown its messages
  const showInvalid = () => focusInvalid(area.current).then(setProblem)

  const save = () =>
    act('save', async () => {
      if (!form.current?.validate().isValid) return showInvalid()
      const { status, body } = automation
        ? await api('PUT', `/automations/${automation.id}`, values)
        : await api('POST', '/automations', values)

      if (status === 422) {
        form.current.applyReport(body)
        return showInvalid()
      }
      toast('Saved')
      if (!automation) return void (location.hash = `#/automations/${body.data.id}`)

      // Saving makes a new webhook's secret, so show the settings as they were saved
      setAutomation(body.data)
      setShown(settingsOf(body.data))
      setValues(settingsOf(body.data))
    })

  // It asks before the action starts, so the question's dialog hands focus back to Delete
  const remove = async () => {
    if (!automation) return
    const sure = await confirm({
      title: `Delete ${automation.name}?`,
      body: 'Its runs go too, and any still to come.',
      action: 'Delete',
      danger: true,
    })
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/automations/${automation.id}`)
      toast('Deleted')
      location.hash = '#/automations'
    })
  }

  return (
    <div>
      <PageHeader
        back={{ href: '#/automations', label: 'Automations' }}
        title={automation ? automation.name : 'New automation'}
        actions={
          automation && (
            <a className='iight-button' href={`#/automations/${automation.id}/runs`}>
              <History /> Runs
            </a>
          )
        }
      />

      <div ref={area}>
        <Form ref={form} schema={schema} values={shown} onValuesChange={setValues} />
      </div>

      <Panel
        label='About this automation'
        problem={problem}
        actions={
          <button
            type='button'
            className='iight-button iight-button--primary'
            aria-busy={busy === 'save'}
            onClick={save}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        }
        footer={
          automation && (
            <button type='button' className='iight-button iight-button--danger' onClick={remove}>
              <Trash2 /> Delete
            </button>
          )
        }
      />
    </div>
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

  if (error) return <Notice tone='danger'>{error}</Notice>
  return automation ? <AutomationEditor automation={automation} /> : <Loading />
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

  if (error) return <Notice tone='danger'>{error}</Notice>
  return initial ? <AutomationEditor initial={initial} /> : <Loading />
}

// A try's status as a badge, with when a pending try is due or when a finished one ended
function Status({ run }: { run: Run }) {
  if (run.status === 'pending') {
    return (
      <span className='cms-status'>
        <Badge>Due</Badge>
        <span className='cms-muted'>{date(run.runAt)}</span>
      </span>
    )
  }
  return (
    <span className='cms-status'>
      {run.status === 'succeeded' ? <Badge tone='success'>Succeeded</Badge> : <Badge tone='danger'>Failed</Badge>}
      <span className='cms-muted'>{date(run.finishedAt!)}</span>
    </span>
  )
}

// An automation's runs, newest first: each try of each of its actions, with what came back or why it failed
export function Runs({ id }: { id: string }) {
  const [automation, setAutomation] = useState<Automation>()
  const [list, setList] = useState<{ data: Array<Run>; pagination: Pagination }>()
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
    <div className='cms-page'>
      <PageHeader
        back={{ href: '#/automations', label: 'Automations' }}
        title={automation ? `${automation.name}: runs` : 'Runs'}
        actions={
          <>
            {automation && (
              <a className='iight-button' href={`#/automations/${id}`}>
                <Pencil /> Edit the automation
              </a>
            )}
            <button type='button' className='iight-button' onClick={refresh}>
              <RefreshCw /> Refresh
            </button>
          </>
        }
      />

      {error && <Notice tone='danger'>{error}</Notice>}
      {!list && !error && <Loading />}
      {list?.data.length === 0 && (
        <EmptyState icon={<History />}>No runs yet. Each try of each action shows here.</EmptyState>
      )}
      {!!list?.data.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Event</th>
                <th>Action</th>
                <th className='cms-table__number'>Try</th>
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
                    <small className='cms-muted'>{date(run.event.createdAt)}</small>
                  </td>
                  <td>{automation ? `${run.action + 1}. ${actionLabel(automation, run.action)}` : run.action + 1}</td>
                  <td className='cms-table__number'>{run.attempt}</td>
                  <td>
                    <Status run={run} />
                  </td>
                  <td>
                    {run.error && <p className='cms-run-error'>{run.error}</p>}
                    {run.response && <pre className='response'>{run.response}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!!list?.pagination.total && <Pages pagination={list.pagination} onPage={setPage} />}
    </div>
  )
}
