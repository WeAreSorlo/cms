import { tokenSchema, tokenScopes, tokenScopesField } from '../src/schemas'
import { api, errorMessage, shortDate } from './api'
import { NewToken } from './keys'
import { Badge, EmptyState, Loading, Notice, PageHeader, Panel, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FormHandle } from 'iight'
import { CircleAlert, Copy, Plug, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

// A personal token as the admin API returns it. Only the reply that makes it holds the token, since only its hash is
// kept.
interface Token {
  id: string
  name: string
  // drafts lets it save drafts, and publish, which comes with drafts, lets it publish too. Without either it only reads.
  scopes: Array<string>
  createdAt: string
  lastUsedAt: string | null
  token?: string
}

const lastUsed = (token: Token) => (token.lastUsedAt ? shortDate(token.lastUsedAt) : 'Never')

// Where clients connect, as this browser reaches the CMS
const mcpUrl = () => `${location.origin}/mcp`

// A token's permissions that count on this site, since Publish changes counts only where the site allows it
const counted = (scopes: Array<string> = [], publish: boolean) =>
  scopes.filter((scope) => publish || scope !== 'publish')

// What a token can do with its permissions (PLAN.md section 21)
const access = (scopes: Array<string> = []) => (
  <section>
    <h2>Access</h2>
    <p>
      {scopes.includes('publish')
        ? "Reads the site's content as you, saves drafts as you, and publishes as you: it makes entries' drafts live, " +
          'changes entries of types without drafts, which go live at once, and opens forms made through AI. It never ' +
          'unpublishes, archives or deletes anything, and never changes media files or forms that take submissions.'
        : scopes.includes('drafts')
          ? "Reads the site's content as you, and saves drafts as you: changes to entries, and new forms that take no " +
            'submissions until someone opens them. It never publishes, archives or deletes anything.'
          : "Reads the site's content as you, and can't change anything."}
    </p>
  </section>
)

// Under the permissions whenever Publish changes is ticked, since what it lets through goes live with no one in iight
// reviewing it
const publishWarning = (
  <Notice tone='warning'>
    With Publish changes, what your AI client writes can go live on the site without anyone reviewing it in iight,
    including what a web page, a file or an email it read steered it to write. Your client's approval prompt is the only
    check, so keep it asking before it publishes.
  </Notice>
)

// The token just made, which the page its making opens shows once
let made: Token | undefined

// The signed-in person's tokens for AI clients, each opening on its page. No one else's are listed or reachable.
export function TokenList({ publish }: { publish: boolean }) {
  const [tokens, setTokens] = useState<Array<Token>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', '/tokens')
      .then(({ body }) => setTokens(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  const newToken = (
    <a className='iight-button iight-button--primary' href='#/tokens/new'>
      <Plus /> New token
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='MCP tokens' />
      <Panel label='MCP tokens' actions={newToken} />
      <p>
        AI clients such as Claude Code, Cursor and VS Code connect to <code>{mcpUrl()}</code> with a token of yours,
        which reads the site's content as you until you revoke it, and saves drafts{publish && ' or publishes'} as you
        if you let it.
      </p>
      {error && <Notice tone='danger'>{error}</Notice>}
      {!tokens && !error && <Loading />}
      {tokens?.length === 0 && (
        <EmptyState icon={<Plug />} action={newToken}>
          No tokens yet.
        </EmptyState>
      )}
      {!!tokens?.length && (
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
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <a href={`#/tokens/${token.id}`}>{token.name}</a>
                  </td>
                  <td>
                    {counted(token.scopes, publish).length ? (
                      <span className='cms-badges'>
                        {tokenScopes
                          .filter(({ value }) => counted(token.scopes, publish).includes(value))
                          .map(({ value, label }) => (
                            <Badge key={value} tone={value === 'publish' ? 'warning' : 'neutral'}>
                              {label}
                            </Badge>
                          ))}
                      </span>
                    ) : (
                      'Reads only'
                    )}
                  </td>
                  <td>{shortDate(token.createdAt)}</td>
                  <td>{lastUsed(token)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Make a token, which opens its page to show it this once
export function TokenForm({ publish }: { publish: boolean }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the field that stops it
  const area = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  const showInvalid = () => focusInvalid(area.current, 'created').then(setProblem)

  // The button stays enabled while it works, so it keeps focus, and a second click is ignored here instead
  const create = async () => {
    if (busy) return
    setProblem('')
    if (!form.current?.validate().isValid) return showInvalid()
    setBusy(true)
    try {
      const { status, body } = await api('POST', '/tokens', values)
      if (status === 422) {
        form.current.applyReport(body)
        return showInvalid()
      }
      made = body.data
      location.hash = `#/tokens/${body.data.id}`
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader back={{ href: '#/tokens', label: 'MCP tokens' }} title='New token' />
      <div ref={area}>
        <Form ref={form} schema={tokenSchema(publish)} onValuesChange={setValues} />
      </div>
      {values.scopes?.includes('publish') && publishWarning}
      <Panel
        label='About this token'
        problem={problem}
        actions={
          <button type='button' className='iight-button iight-button--primary' aria-busy={busy} onClick={create}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        }
      >
        {access(values.scopes)}
      </Panel>
    </div>
  )
}

// A token's page, where its maker changes its permissions or revokes it, with the token and how to connect a client
// when it was just made
export function TokenPage({ id, publish }: { id: string; publish: boolean }) {
  const confirm = useConfirm()
  const toast = useToast()
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the field that stops a save
  const area = useRef<HTMLDivElement>(null)
  const [token, setToken] = useState<Token>()
  // What the form starts with, and what it holds now
  const [shown, setShown] = useState<Record<string, any>>()
  const [values, setValues] = useState<Record<string, any>>({})
  const [error, setError] = useState('')
  const [problem, setProblem] = useState('')
  // The action under way, save or revoke
  const [busy, setBusy] = useState<string>()
  // Taken once, so going back to the page doesn't show it again
  const [secret] = useState(() => (made?.id === id ? made.token : undefined))
  useEffect(() => void (made = undefined), [])

  // The token as it's saved, with its boxes as it has them. Publish changes isn't a choice where the site doesn't allow
  // it, and the server saves it with Save drafts. The form reports only changes, so what it holds starts as what it
  // shows.
  const show = useCallback(
    (saved: Token) => {
      setToken(saved)
      const shown = { scopes: counted(saved.scopes, publish) }
      setShown(shown)
      setValues(shown)
    },
    [publish],
  )

  // The admin API lists tokens, rather than replying one
  useEffect(() => {
    api('GET', '/tokens')
      .then(({ body }) => {
        const found: Token | undefined = body.data.find((token: Token) => token.id === id)
        if (found) show(found)
        else setError("This token doesn't exist, or it was revoked.")
      })
      .catch((error) => setError(errorMessage(error)))
  }, [id, show])

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
      if (!token || !form.current) return
      const { status, body } = await api('PUT', `/tokens/${token.id}`, { scopes: values.scopes ?? [] })
      if (status === 422) {
        form.current.applyReport(body)
        return focusInvalid(area.current).then(setProblem)
      }
      show(body.data)
      toast('Saved')
    })

  // It asks before the action starts, so the question's dialog hands focus back to Revoke
  const revoke = async () => {
    if (!token) return
    const sure = await confirm({
      title: `Revoke ${token.name}?`,
      body: 'Any client using this token loses its access at once, and gets a 401 from then on.',
      action: 'Revoke',
      danger: true,
    })
    if (!sure) return
    act('revoke', async () => {
      await api('DELETE', `/tokens/${token.id}`)
      toast(`Revoked ${token.name}`)
      location.hash = '#/tokens'
    })
  }

  if (error) return <Notice tone='danger'>{error}</Notice>
  if (!token || !shown) return <Loading />

  return (
    <div>
      <PageHeader back={{ href: '#/tokens', label: 'MCP tokens' }} title={token.name} />
      {secret && (
        <>
          <NewToken name={token.name} token={secret} noun='token' />
          <Connect token={secret} />
        </>
      )}

      {!publish && token.scopes.includes('publish') && (
        <Notice>This site doesn't let tokens publish now, so this token saves drafts but doesn't publish.</Notice>
      )}
      <div ref={area}>
        <Form ref={form} schema={[tokenScopesField(publish)]} values={shown} onValuesChange={setValues} />
      </div>
      {values.scopes?.includes('publish') && publishWarning}
      <p>A connected client gets new tools when it next connects, and loses tools at once.</p>
      {counted(token.scopes, publish).includes('publish') && <KeepAsking />}

      <Panel
        label='About this token'
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
          <button
            type='button'
            className='iight-button iight-button--danger'
            aria-busy={busy === 'revoke'}
            onClick={revoke}
          >
            <Trash2 /> Revoke
          </button>
        }
      >
        <section>
          <h2>Created</h2>
          <p>{shortDate(token.createdAt)}</p>
        </section>
        <section>
          <h2>Last used</h2>
          <p>{lastUsed(token)}</p>
        </section>
        {access(counted(token.scopes, publish))}
      </Panel>
    </div>
  )
}

// How to keep a client asking before each publish, for a token with Publish changes. The rules hold no token, so they
// show whenever the token can publish, not just when it's made.
function KeepAsking() {
  const rules = { permissions: { ask: ['mcp__iight__publish_entries', 'mcp__iight__open_form'] } }

  return (
    <section className='cms-section'>
      <h2>Keep your client asking</h2>
      <p>
        Clients ask before each tool call until they're told not to. Keep yours asking before{' '}
        <code>publish_entries</code> and <code>open_form</code>, which put changes live.
      </p>
      <h3>Claude Code</h3>
      <p>
        To have Claude Code ask before every publish, even once you've let it use iight's other tools without asking,
        add these to <code>permissions.ask</code> in <code>~/.claude/settings.json</code>. They name the server added as{' '}
        <code>iight</code>, as the command when the token was made does.
      </p>
      <CopyCode label='Claude Code rules' text={JSON.stringify(rules, null, 2)} />
      <h3>Cursor and VS Code</h3>
      <p>
        Keep <code>publish_entries</code> and <code>open_form</code> off the tools they run without asking.
      </p>
    </section>
  )
}

// Each client's setup, ready to paste, with the token where the client keeps it
function Connect({ token }: { token: string }) {
  const url = mcpUrl()
  const authorization = `Bearer ${token}`
  const cursor = { mcpServers: { iight: { url, headers: { Authorization: authorization } } } }
  const vsCode = {
    inputs: [{ type: 'promptString', id: 'iight-token', description: 'iight MCP token', password: true }],
    servers: { iight: { type: 'http', url, headers: { Authorization: 'Bearer ${input:iight-token}' } } },
  }

  return (
    <section className='cms-section'>
      <h2>Connect a client</h2>
      <p>
        Clients connect to <code>{url}</code>, sending the token in an Authorization header.
      </p>
      <h3>Claude Code</h3>
      <p>Run this in a terminal. Claude Code keeps the token in its own settings.</p>
      <CopyCode
        label='Claude Code command'
        rows={3}
        text={`claude mcp add --transport http iight ${url} --header "Authorization: ${authorization}"`}
      />
      <h3>Cursor</h3>
      <p>
        Add this to <code>~/.cursor/mcp.json</code> in your home folder, rather than a project's, so the token stays out
        of the project's repository.
      </p>
      <CopyCode label='Cursor settings' text={JSON.stringify(cursor, null, 2)} />
      <h3>VS Code</h3>
      <p>
        Add this to <code>.vscode/mcp.json</code>. VS Code asks for the token the first time it connects, so the file
        never holds it.
      </p>
      <CopyCode label='VS Code settings' text={JSON.stringify(vsCode, null, 2)} />
    </section>
  )
}

// Text to copy, with a Copy button that says beside it when the browser won't allow it
function CopyCode({ label, text, rows }: { label: string; text: string; rows?: number }) {
  const toast = useToast()
  const [problem, setProblem] = useState('')

  const copy = () => {
    setProblem('')
    navigator.clipboard.writeText(text).then(
      () => toast(`Copied the ${label}`),
      () => setProblem(`Couldn't copy the ${label}. Select it and copy it instead.`),
    )
  }

  return (
    <>
      <textarea
        className='embed embed--whole'
        aria-label={label}
        readOnly
        rows={rows ?? text.split('\n').length}
        value={text}
      />
      <div className='actions'>
        <button type='button' className='iight-button' aria-label={`Copy the ${label}`} onClick={copy}>
          <Copy /> Copy
        </button>
        {problem && (
          <p className='cms-problem' role='alert'>
            <CircleAlert /> {problem}
          </p>
        )}
      </div>
    </>
  )
}
