import { accountSchema, inviteSchema, joinSchema, resetSchema, signInSchema } from '../src/schemas'
import { api, count, errorMessage, shortDate } from './api'
import { CellText } from './entries'
import { NewToken } from './keys'
import {
  Badge,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PageHeader,
  Panel,
  focusHeading,
  focusInvalid,
  useConfirm,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle, ValidationReport } from 'iight'
import { KeyRound, LogOut, Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

// People, how they sign in, and each person's own account (PLAN.md section 5)

// Who's signed in, as sign-in replies them
export interface SignedIn {
  id: string
  email: string
  name: string
}

// A person as the admin API returns them
export interface Person {
  id: string
  name: string
  email: string
  createdAt: string
  lastActiveAt: string | null
  invitedBy: { id: string; name: string } | null
  removedAt: string | null
  removedBy: { id: string; name: string } | null
}

// An invite as the admin API returns it. Only the reply that makes it holds its link, since only its hash is kept.
export interface Invite {
  id: string
  email: string
  invitedBy: { id: string; name: string } | null
  createdAt: string
  expiresAt: string
  // The person removed whom accepting brings back
  restores: { id: string; name: string; removedAt: string } | null
  link?: string
  emailed?: boolean
}

export interface Account {
  id: string
  name: string
  email: string
  createdAt: string
  otherSessions: number
}

// Such as 3 Nov, 14:02, or Never
const when = (iso: string | null) => (iso ? shortDate(iso) : 'Never')

// Set by a reset link's page as it signs someone in, for their account page to say what changed
let resetDone = false

// What a page before signing in makes of its form's reply: nothing more to do, a report for the form, or a problem
type Outcome = void | { report: ValidationReport } | { problem: string }

// Posts a page's form before signing in, giving the reply's status and body
async function post(path: string, values: unknown) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// A page before signing in, as sign-in looks: the name, then a card with a core form and its one button, which Enter
// in a field presses, since core's form has no submit button. Once there's nothing left to send, its form goes and
// focus moves to its heading.
function AccessPage({
  title,
  intro,
  schema,
  action,
  working,
  failure,
  notice,
  after,
  onSend,
}: {
  title: string
  intro?: ReactNode
  schema?: Array<FieldSchema>
  action: string
  working: string
  // What it says when the server can't be reached, or fails
  failure: string
  notice?: ReactNode
  after?: ReactNode
  onSend: (values: Record<string, any>) => Promise<Outcome>
}) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the fields that stop it
  const area = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [values, setValues] = useState({})
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    document.title = `${title} · iight`
  }, [title])

  // Focus starts on the heading, since the page that had it has gone, and goes back there once the form and its button
  // go
  const done = !schema
  useEffect(() => heading.current?.focus(), [done])

  // Moves focus to the first field to fix, once the form has shown its messages
  const showInvalid = () => focusInvalid(area.current)

  // The button stays enabled while it works, so it keeps focus, and a second press is ignored here instead
  const submit = async () => {
    if (sending || !schema) return
    if (!form.current?.validate().isValid) return showInvalid()
    setSending(true)
    setProblem('')
    try {
      const outcome = await onSend(values)
      if (outcome && 'report' in outcome) {
        form.current?.applyReport(outcome.report)
        showInvalid()
      } else if (outcome) setProblem(outcome.problem)
    } catch {
      setProblem(failure)
    } finally {
      setSending(false)
    }
  }

  return (
    <main
      className='cms-sign-in'
      onKeyDown={(event) => event.key === 'Enter' && event.target instanceof HTMLInputElement && submit()}
    >
      <p className='cms-sign-in__mark'>iight</p>
      <div className='cms-sign-in__card' ref={area}>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {intro}
        {problem && <Notice tone='danger'>{problem}</Notice>}
        {notice}
        {schema && <Form ref={form} schema={schema} onValuesChange={setValues} />}
        {schema && (
          <button type='button' className='iight-button iight-button--primary' aria-busy={sending} onClick={submit}>
            {sending ? working : action}
          </button>
        )}
        {after}
      </div>
    </main>
  )
}

// A link under a card's button
const CardLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <p className='cms-sign-in__links'>
    <a href={href}>{children}</a>
  </p>
)

// Sign in, with Forgot your password? under it
export function SignIn({ onSignIn }: { onSignIn: (user: SignedIn) => void }) {
  return (
    <AccessPage
      title='Sign in'
      schema={signInSchema}
      action='Sign in'
      working='Signing in…'
      failure="Couldn't sign in. Try again in a moment."
      after={<CardLink href='#/forgot'>Forgot your password?</CardLink>}
      onSend={async (values) => {
        const { status, body } = await post('/session', values)
        if (status === 200) return onSignIn(body.data)
        if (status === 422) return { report: body }
        if (status === 429) return { problem: body.message }
        throw new Error(body?.message)
      }}
    />
  )
}

// Join with an invite's link, choosing a name and a password, then signed in
export function JoinPage({ token, onSignIn }: { token: string; onSignIn: (user: SignedIn) => void }) {
  return (
    <AccessPage
      title='Choose your name and password'
      intro={<p>You've been invited to edit this site's content. You'll sign in with the email you were invited at.</p>}
      schema={joinSchema}
      action='Join'
      working='Joining…'
      failure="Couldn't join. Try again in a moment."
      onSend={async (values) => {
        const { status, body } = await post('/session/invite', { ...values, token })
        if (status === 200) return onSignIn(body.data)
        if (status === 422) return { report: body }
        if (status === 404 || status === 409) return { problem: body.message }
        throw new Error(body?.message)
      }}
    />
  )
}

// Ask for a reset link by email, which says the same whatever the address
export function ForgotPage() {
  const [sent, setSent] = useState<ReactNode>()
  return (
    <AccessPage
      title='Reset your password'
      intro={!sent && <p>We'll email you a link to choose a new password.</p>}
      schema={sent ? undefined : inviteSchema}
      action='Send a link'
      working='Sending…'
      failure="Couldn't send a link. Try again in a moment."
      notice={sent}
      after={<CardLink href='#/'>Back to sign in</CardLink>}
      onSend={async (values) => {
        const { status, body } = await post('/session/forgot', values)
        if (status === 202) return setSent(<Notice tone='success'>{body.message}</Notice>)
        if (status === 404) {
          return setSent(
            <Notice tone='warning'>
              This site doesn't send email, so ask someone who can sign in to make you a reset link on their Users page.
            </Notice>,
          )
        }
        if (status === 422) return { report: body }
        if (status === 429) return { problem: body.message }
        throw new Error(body?.message)
      }}
    />
  )
}

// Choose a new password with a reset link, which signs you out everywhere and in here
export function ResetPage({ token, onSignIn }: { token: string; onSignIn: (user: SignedIn) => void }) {
  return (
    <AccessPage
      title='Choose a new password'
      schema={resetSchema}
      action='Save password'
      working='Saving…'
      failure="Couldn't save your password. Try again in a moment."
      after={<CardLink href='#/forgot'>Ask for a new link</CardLink>}
      onSend={async (values) => {
        const { status, body } = await post('/session/reset', { ...values, token })
        if (status === 200) {
          resetDone = true
          return onSignIn(body.data)
        }
        if (status === 422) return { report: body }
        if (status === 404) return { problem: body.message }
        throw new Error(body?.message)
      }}
    />
  )
}

// Everyone who can sign in, each opening on their page, then the invites waiting
export function UserList({ me }: { me: string }) {
  const [people, setPeople] = useState<Array<Person>>()
  const [invites, setInvites] = useState<Array<Invite>>()
  const [error, setError] = useState('')
  const toast = useToast()

  const load = useCallback(
    () =>
      Promise.all([api('GET', '/users'), api('GET', '/invites')])
        .then(([users, invites]) => {
          setPeople(users.body.data)
          setInvites(invites.body.data)
        })
        .catch((error) => setError(errorMessage(error))),
    [],
  )
  useEffect(() => void load(), [load])

  // Its row goes, so focus goes to the page's heading
  const deleteInvite = async (invite: Invite) => {
    try {
      await api('DELETE', `/invites/${invite.id}`)
      toast(`Deleted the invite for ${invite.email}`)
      focusHeading()
      await load()
    } catch (error) {
      setError(errorMessage(error))
    }
  }

  const invite = (
    <a className='iight-button iight-button--primary' href='#/users/invite'>
      <UserPlus /> Invite someone
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='Users' />
      <Panel
        label='Users'
        actions={invite}
        footer={
          <a className='iight-button' href='#/users/removed'>
            Removed users
          </a>
        }
      />
      <p>Everyone here can sign in to the admin and change anything in it, since there are no roles yet.</p>
      {error && <Notice tone='danger'>{error}</Notice>}
      {!people && !error && <Loading />}
      {people && <PeopleTable people={people} me={me} />}
      {!!invites?.length && (
        <>
          <h2>Invites</h2>
          <InvitesTable invites={invites} onDelete={deleteInvite} />
        </>
      )}
    </div>
  )
}

// Everyone who can sign in, with you marked, each opening on their page, or yours on your account
export function PeopleTable({ people, me }: { people: Array<Person>; me: string }) {
  return (
    <div className='cms-table-wrap'>
      <table className='cms-table'>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Last active</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.id}>
              <td>
                {person.id === me ? (
                  <span className='cms-badges'>
                    <a href='#/account'>{person.name}</a>
                    <Badge tone='accent'>You</Badge>
                  </span>
                ) : (
                  <a href={`#/users/${person.id}`}>{person.name}</a>
                )}
              </td>
              <td>{person.email}</td>
              <td>{when(person.lastActiveAt)}</td>
              <td>{shortDate(person.createdAt, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The invites waiting, each with New link, which makes another on the invite page and stops this one, and Delete
export function InvitesTable({ invites, onDelete }: { invites: Array<Invite>; onDelete: (invite: Invite) => void }) {
  return (
    <div className='cms-table-wrap'>
      <table className='cms-table'>
        <thead>
          <tr>
            <th>Email</th>
            <th>Invited by</th>
            <th>Expires</th>
            <th>
              <span className='cms-visually-hidden'>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            <tr key={invite.id}>
              <td>
                {invite.email}
                {invite.restores && <div className='cms-muted'>Brings back {invite.restores.name}</div>}
              </td>
              <td>
                <CellText text={invite.invitedBy?.name ?? ''} />
              </td>
              <td>
                {new Date(invite.expiresAt) <= new Date() ? (
                  <Badge tone='warning'>Expired</Badge>
                ) : (
                  shortDate(invite.expiresAt)
                )}
              </td>
              <td>
                <span className='cms-row-actions'>
                  <a
                    href={`#/users/invite?email=${encodeURIComponent(invite.email)}`}
                    aria-label={`New link for ${invite.email}`}
                  >
                    New link
                  </a>
                  <IconButton label={`Delete the invite for ${invite.email}`} onClick={() => onDelete(invite)}>
                    <Trash2 />
                  </IconButton>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Those removed, latest first, who can't sign in and whom an invite brings back
export function RemovedUsers() {
  const [people, setPeople] = useState<Array<Person>>()
  const [error, setError] = useState('')

  useEffect(() => {
    api('GET', '/users?removed=true')
      .then(({ body }) => setPeople(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  return (
    <div className='cms-page'>
      <PageHeader back={{ href: '#/users', label: 'Users' }} title='Removed users' />
      <p>
        They can't sign in, and what they made and saved keeps their name. Inviting someone's address again brings their
        account back.
      </p>
      {error && <Notice tone='danger'>{error}</Notice>}
      {!people && !error && <Loading />}
      {people?.length === 0 && <EmptyState icon={<Users />}>Nobody has been removed.</EmptyState>}
      {!!people?.length && (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Removed</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.id}>
                  <td>
                    <a href={`#/users/${person.id}`}>{person.name}</a>
                  </td>
                  <td>{person.email}</td>
                  <td>{removedText(person)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Such as 3 Nov, 14:02 by Sam
const removedText = (person: Person) =>
  `${shortDate(person.removedAt!)}${person.removedBy ? ` by ${person.removedBy.name}` : ''}`

// Invite someone by their email: a link to pass on, shown this once, which the site emails them too where it can. An
// address that someone removed had brings them back, which the page says before the invite's made.
export function InvitePage({ query, mail }: { query: string; mail: boolean }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the field that stops it
  const area = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(() => ({ email: new URLSearchParams(query).get('email') ?? '' }))
  const [values, setValues] = useState<Record<string, any>>(shown)
  const [removed, setRemoved] = useState<Array<Person>>([])
  const [invite, setInvite] = useState<Invite>()
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  // Starts the form again, for the next invite
  const [round, setRound] = useState(0)

  useEffect(() => {
    api('GET', '/users?removed=true')
      .then(({ body }) => setRemoved(body.data))
      .catch(() => {})
  }, [])
  const restores = removed.find((person) => person.email === String(values.email ?? '').toLowerCase())
  // Whom accepting brings back: the invite's, once it's made, or before that, whoever removed had the address typed
  const bringsBack = invite
    ? invite.restores && { email: invite.email, ...invite.restores }
    : restores && { email: restores.email, name: restores.name, removedAt: restores.removedAt! }

  // The button stays enabled while it works, so it keeps focus, and a second press is ignored here instead
  const send = async () => {
    if (busy) return
    setProblem('')
    if (!form.current?.validate().isValid) return setProblem(await focusInvalid(area.current, 'sent'))
    setBusy(true)
    try {
      const { status, body } = await api('POST', '/invites', values)
      if (status === 422) {
        form.current.applyReport(body)
        return setProblem(await focusInvalid(area.current, 'sent'))
      }
      setInvite(body.data)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const again = () => {
    setInvite(undefined)
    setShown({ email: '' })
    setValues({ email: '' })
    setRound(round + 1)
  }

  const lasts = 'It works once, for 7 days.'
  return (
    <div>
      <PageHeader back={{ href: '#/users', label: 'Users' }} title='Invite someone' />
      {invite ? (
        <>
          <NewToken name={invite.email} token={invite.link!} noun='link' />
          {invite.emailed ? (
            <Notice tone='success'>
              Emailed the link to {invite.email} too. It works once, until {shortDate(invite.expiresAt)}.
            </Notice>
          ) : (
            <Notice tone={mail ? 'warning' : 'info'}>
              {mail ? 'The email may not have gone, so send them the link yourself.' : 'Send them the link yourself.'}{' '}
              It works once, until {shortDate(invite.expiresAt)}.
            </Notice>
          )}
        </>
      ) : (
        <>
          <p>
            {mail
              ? `We'll email them a link to choose their name and password, and show it here to copy too. ${lasts}`
              : `You'll get a link to send them, to choose their name and password. ${lasts}`}
          </p>
          <div ref={area}>
            <Form key={round} ref={form} schema={inviteSchema} values={shown} onValuesChange={setValues} />
          </div>
        </>
      )}
      {bringsBack && (
        <Notice>
          {bringsBack.email} belonged to {bringsBack.name}, removed on {shortDate(bringsBack.removedAt, false)}.
          Accepting brings back that account, with what it made and its chats.
        </Notice>
      )}

      <Panel
        label='About this invite'
        problem={problem}
        actions={
          invite ? (
            <button type='button' className='iight-button' onClick={again}>
              <UserPlus /> Invite someone else
            </button>
          ) : (
            <button type='button' className='iight-button iight-button--primary' aria-busy={busy} onClick={send}>
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          )
        }
      />
    </div>
  )
}

// Someone's page: their details, a reset link to pass on and Remove, or once they're removed, Invite again
export function UserPage({ id, me, mcp }: { id: string; me: string; mcp: boolean }) {
  const [person, setPerson] = useState<Person>()
  const [error, setError] = useState('')
  const [reset, setReset] = useState<{ link: string; expiresAt: string }>()
  const [problem, setProblem] = useState('')
  // The action under way, such as remove
  const [busy, setBusy] = useState<string>()
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    api('GET', `/users/${id}`)
      .then(({ body }) => setPerson(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [id])

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

  const makeLink = () =>
    act('reset', async () => {
      const { body } = await api('POST', `/users/${id}/reset`)
      setReset(body.data)
    })

  // It asks before anything starts, saying what a removal does, with the keys they made and the invites they sent from
  // the lists the admin already reads
  const remove = async () => {
    if (!person) return
    let keys: Array<{ name: string }> = []
    let invites: Array<Invite> = []
    // Without them, the question says less
    try {
      const [keyList, inviteList] = await Promise.all([api('GET', '/keys'), api('GET', '/invites')])
      keys = keyList.body.data.filter((key: { createdBy: { id: string } | null }) => key.createdBy?.id === person.id)
      invites = inviteList.body.data.filter((invite: Invite) => invite.invitedBy?.id === person.id)
    } catch {}
    const waiting = invites.length
      ? ` ${invites.length === 1 ? "The invite they sent that's still waiting is" : `The ${invites.length} invites they sent that are still waiting are`} deleted.`
      : ''
    const sure = await confirm({
      title: `Remove ${person.name}?`,
      body: (
        <>
          <p>
            They're signed out everywhere, and their password{mcp ? ' and MCP tokens stop' : ' stops'} working.
            {waiting} What they made and saved keeps their name.
          </p>
          {keys.length > 0 && (
            <p>
              {keys.length === 1 ? 'This API key they made keeps' : 'These API keys they made keep'} working, so revoke
              any they shouldn't keep: {keys.map((key) => key.name).join(', ')}.
            </p>
          )}
        </>
      ),
      action: `Remove ${person.name}`,
      danger: true,
    })
    if (!sure) return
    act('remove', async () => {
      await api('POST', `/users/${id}/remove`)
      toast(`Removed ${person.name}`)
      location.hash = '#/users'
    })
  }

  if (error) return <Notice tone='danger'>{error}</Notice>
  if (!person) return <Loading />

  const removed = !!person.removedAt
  return (
    <div>
      <PageHeader
        back={removed ? { href: '#/users/removed', label: 'Removed users' } : { href: '#/users', label: 'Users' }}
        title={person.name}
        meta={removed && <Badge>Removed</Badge>}
      />
      {person.id === me && (
        <Notice>
          This is you. Change your name, email and password on <a href='#/account'>your account page</a>.
        </Notice>
      )}
      {reset && (
        <>
          <NewToken name={person.name} token={reset.link} noun='link' />
          <Notice>
            It works once, until {shortDate(reset.expiresAt)}. Using it signs {person.name} out everywhere, so pass it
            only to them.
          </Notice>
        </>
      )}
      <dl className='cms-pairs'>
        <div>
          <dt>Email</dt>
          <dd>{person.email}</dd>
        </div>
        <div>
          <dt>Joined</dt>
          <dd>
            {shortDate(person.createdAt, false)}
            {person.invitedBy && `, invited by ${person.invitedBy.name}`}
          </dd>
        </div>
        <div>
          <dt>Last active</dt>
          <dd>{when(person.lastActiveAt)}</dd>
        </div>
        {removed && (
          <div>
            <dt>Removed</dt>
            <dd>{removedText(person)}</dd>
          </div>
        )}
      </dl>
      {removed && <p>They can't sign in. Inviting their address again brings their account back.</p>}

      {person.id !== me && (
        <PersonPanel person={person} busy={busy} problem={problem} onReset={makeLink} onRemove={remove} />
      )}
    </div>
  )
}

// Someone else's panel: Make a reset link, and Remove in its footer, or once they're removed, Invite again
export function PersonPanel({
  person,
  busy,
  problem,
  onReset,
  onRemove,
}: {
  person: Person
  busy?: string
  problem?: string
  onReset: () => void
  onRemove: () => void
}) {
  return (
    <Panel
      label={`About ${person.name}`}
      problem={problem}
      actions={
        person.removedAt ? (
          <a className='iight-button' href={`#/users/invite?email=${encodeURIComponent(person.email)}`}>
            <UserPlus /> Invite again
          </a>
        ) : (
          <button type='button' className='iight-button' aria-busy={busy === 'reset'} onClick={onReset}>
            <KeyRound /> {busy === 'reset' ? 'Making a link…' : 'Make a reset link'}
          </button>
        )
      }
      footer={
        !person.removedAt && (
          <button type='button' className='iight-button iight-button--danger' onClick={onRemove}>
            <UserMinus /> Remove
          </button>
        )
      }
    />
  )
}

// Your own name, email and password, and the other browsers you're signed in on
export function AccountPage({ onUser, mcp }: { onUser: (user: SignedIn) => void; mcp: boolean }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the fields that stop a save
  const area = useRef<HTMLDivElement>(null)
  const [account, setAccount] = useState<Account>()
  const [shown, setShown] = useState<Record<string, any>>()
  const [values, setValues] = useState<Record<string, any>>({})
  // Starts the form again after each save, emptying its passwords
  const [round, setRound] = useState(0)
  const [error, setError] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState<string>()
  const toast = useToast()
  // Taken once, so going back to the page doesn't say it again
  const [reset] = useState(() => {
    const was = resetDone
    resetDone = false
    return was
  })

  const show = (loaded: Account) => {
    setAccount(loaded)
    setShown({ name: loaded.name, email: loaded.email })
    setValues({ name: loaded.name, email: loaded.email })
  }
  useEffect(() => {
    api('GET', '/account')
      .then(({ body }) => show(body.data))
      .catch((error) => setError(errorMessage(error)))
  }, [])

  // Your current password shows once the email differs from yours, so the schema follows the email you have
  const schema = useMemo(() => account && accountSchema(account.email), [account?.email])

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
      if (!form.current?.validate().isValid) return setProblem(await focusInvalid(area.current))
      const { status, body } = await api('PUT', '/account', values)
      if (status === 422) {
        form.current.applyReport(body)
        return setProblem(await focusInvalid(area.current))
      }
      show(body.data)
      setRound((round) => round + 1)
      onUser({ id: body.data.id, email: body.data.email, name: body.data.name })
      toast(values.newPassword ? 'Saved, and signed you out everywhere else' : 'Saved')
    })

  const signOutOthers = () =>
    act('others', async () => {
      await api('DELETE', '/account/sessions')
      setAccount((account) => account && { ...account, otherSessions: 0 })
      toast('Signed out everywhere else')
    })

  if (error) return <Notice tone='danger'>{error}</Notice>
  if (!account || !schema) return <Loading />

  return (
    <div>
      <PageHeader title='Your account' />
      {reset && (
        <Notice tone='success'>
          Your password has changed, and every other session has ended.
          {mcp && (
            <>
              {' '}
              Your <a href='#/tokens'>MCP tokens</a> still work, so if someone else may have used your account, revoke
              any you don't recognise.
            </>
          )}
        </Notice>
      )}
      <div ref={area}>
        <Form key={round} ref={form} schema={schema} values={shown} onValuesChange={setValues} />
      </div>
      <AccountPanel account={account} busy={busy} problem={problem} onSave={save} onSignOut={signOutOthers} />
    </div>
  )
}

// Your account's panel: Save, then the other browsers you're signed in on, with Sign out everywhere else
export function AccountPanel({
  account,
  busy,
  problem,
  onSave,
  onSignOut,
}: {
  account: Account
  busy?: string
  problem?: string
  onSave: () => void
  onSignOut: () => void
}) {
  return (
    <Panel
      label='Your account'
      problem={problem}
      actions={
        <button
          type='button'
          className='iight-button iight-button--primary'
          aria-busy={busy === 'save'}
          onClick={onSave}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <section>
        <h2>Sessions</h2>
        <p>
          {account.otherSessions
            ? `You're also signed in on ${count(account.otherSessions, 'other browser', 'other browsers')}.`
            : "You aren't signed in anywhere else."}
        </p>
        <button type='button' className='iight-button' aria-busy={busy === 'others'} onClick={onSignOut}>
          <LogOut /> Sign out everywhere else
        </button>
      </section>
      <section>
        <h2>Joined</h2>
        <p>{shortDate(account.createdAt, false)}</p>
      </section>
    </Panel>
  )
}
