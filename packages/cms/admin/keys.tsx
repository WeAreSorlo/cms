import { apiKeySchema } from '../src/schemas'
import { api, errorMessage, shortDate } from './api'
import { CellText } from './entries'
import { Badge, EmptyState, Loading, Notice, PageHeader, Panel, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FormHandle } from 'iight'
import { CircleAlert, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

// A key as the admin API returns it. Only the reply that makes it holds its token, since only its hash is kept.
interface ApiKey {
  id: string
  name: string
  scopes: Array<string>
  createdAt: string
  // Null for keys from iight make:api-key
  createdBy: { id: string; name: string } | null
  lastUsedAt: string | null
  token?: string
}

// Who made a key and when
// shortcut: a key whose user was deleted says the CLI too, since neither has a user; tell them apart once users can
// be deleted outside SQL
const madeBy = (key: ApiKey) => `${key.createdBy?.name ?? 'The CLI'} · ${shortDate(key.createdAt)}`

const lastUsed = (key: ApiKey) => (key.lastUsedAt ? shortDate(key.lastUsedAt) : 'Never')

// The key just made, which the page its making opens shows once
let made: ApiKey | undefined

// Every key for the delivery API, with what it can do, who made it and when it was last used, each opening on its
// page. Anyone signed in can manage keys, under iight start too, since they're data rather than files.
export function KeyList() {
  const [keys, setKeys] = useState<Array<ApiKey>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', '/keys')
      .then(({ body }) => setKeys(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  const newKey = (
    <a className='iight-button iight-button--primary' href='#/keys/new'>
      <Plus /> New key
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='API keys' actions={newKey} />
      <p>Every key reads published content and media through the delivery API, and its permissions let it do more.</p>
      {error && <Notice tone='danger'>{error}</Notice>}
      {!keys && !error && <Loading />}
      {keys?.length === 0 && (
        <EmptyState icon={<KeyRound />} action={newKey}>
          No keys yet.
        </EmptyState>
      )}
      {!!keys?.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Name</th>
                <th>Permissions</th>
                <th>Created</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <a href={`#/keys/${key.id}`}>{key.name}</a>
                  </td>
                  <td>
                    {key.scopes.length ? (
                      <span className='cms-badges'>
                        {key.scopes.map((scope) => (
                          <Badge key={scope}>{scope}</Badge>
                        ))}
                      </span>
                    ) : (
                      <CellText text='' />
                    )}
                  </td>
                  <td>{madeBy(key)}</td>
                  <td>{lastUsed(key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Make a key, or change one's name and permissions, which keeps the key itself. Making one opens its page, which shows
// the key this once.
export function KeyEditor({ apiKey: loaded, token }: { apiKey?: ApiKey; token?: string }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the fields that stop a save
  const area = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const [apiKey, setApiKey] = useState(loaded)
  const [shown] = useState(() => ({ name: loaded?.name, scopes: loaded?.scopes ?? [] }))
  const [values, setValues] = useState<Record<string, any>>(shown)
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
      const { status, body } = apiKey
        ? await api('PUT', `/keys/${apiKey.id}`, values)
        : await api('POST', '/keys', values)

      if (status === 422) {
        form.current.applyReport(body)
        return showInvalid()
      }
      if (!apiKey) {
        made = body.data
        return void (location.hash = `#/keys/${body.data.id}`)
      }
      toast('Saved')
      setApiKey(body.data)
    })

  // It asks before the action starts, so the question's dialog hands focus back to Revoke
  const revoke = async () => {
    if (!apiKey) return
    const sure = await confirm({
      title: `Revoke ${apiKey.name}?`,
      body: 'Anything using this key stops working at once, and gets a 401 from then on.',
      action: 'Revoke',
      danger: true,
    })
    if (!sure) return
    act('revoke', async () => {
      await api('DELETE', `/keys/${apiKey.id}`)
      toast(`Revoked ${apiKey.name}`)
      location.hash = '#/keys'
    })
  }

  return (
    <div>
      <PageHeader back={{ href: '#/keys', label: 'API keys' }} title={apiKey ? apiKey.name : 'New key'} />
      {apiKey && token && <NewToken name={apiKey.name} token={token} />}

      <div ref={area}>
        <Form ref={form} schema={apiKeySchema} values={shown} onValuesChange={setValues} />
      </div>

      <Panel
        label='About this key'
        problem={problem}
        actions={
          <button
            type='button'
            className='iight-button iight-button--primary'
            aria-busy={busy === 'save'}
            onClick={save}
          >
            {apiKey ? (busy === 'save' ? 'Saving…' : 'Save') : busy === 'save' ? 'Creating…' : 'Create key'}
          </button>
        }
        footer={
          apiKey && (
            <button type='button' className='iight-button iight-button--danger' onClick={revoke}>
              <Trash2 /> Revoke
            </button>
          )
        }
      >
        {apiKey && (
          <>
            <section>
              <h2>Created</h2>
              <p>{madeBy(apiKey)}</p>
            </section>
            <section>
              <h2>Last used</h2>
              <p>{lastUsed(apiKey)}</p>
            </section>
          </>
        )}
      </Panel>
    </div>
  )
}

// Open a key by its ID, with the key itself if it was just made
export function KeyPage({ id }: { id: string }) {
  const [apiKey, setApiKey] = useState<ApiKey>()
  const [error, setError] = useState('')
  // Taken once, so going back to the page doesn't show it again
  const [token] = useState(() => (made?.id === id ? made.token : undefined))
  useEffect(() => void (made = undefined), [])

  // The admin API lists keys, rather than replying one
  useEffect(() => {
    api('GET', '/keys')
      .then(({ body }) => {
        const found = body.data.find((key: ApiKey) => key.id === id)
        if (found) setApiKey(found)
        else setError("This key doesn't exist, or it was revoked.")
      })
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  if (error) return <Notice tone='danger'>{error}</Notice>
  return apiKey ? <KeyEditor apiKey={apiKey} token={token} /> : <Loading />
}

// A new key, which the server keeps only the hash of, so it's shown just this once
function NewToken({ name, token }: { name: string; token: string }) {
  const field = useRef<HTMLInputElement>(null)
  const note = useId()
  const [problem, setProblem] = useState('')
  const toast = useToast()

  // Focus goes to the key, after the shell has moved it to the page's heading, as it does on every new page
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus())
    return () => clearTimeout(timer)
  }, [])

  const copy = () => {
    setProblem('')
    navigator.clipboard.writeText(token).then(
      () => toast('Copied the key'),
      () => setProblem("Couldn't copy the key. Select it and copy it instead."),
    )
  }

  return (
    <div>
      <Notice tone='warning'>
        <span id={note}>Copy the key for {name} now, since it can't be shown again.</span>
      </Notice>
      <input
        ref={field}
        className='embed'
        aria-label={`Key for ${name}`}
        aria-describedby={note}
        readOnly
        value={token}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className='actions'>
        <button type='button' className='iight-button' onClick={copy}>
          <Copy /> Copy
        </button>
        {problem && (
          <p className='cms-problem' role='alert'>
            <CircleAlert /> {problem}
          </p>
        )}
      </div>
    </div>
  )
}
