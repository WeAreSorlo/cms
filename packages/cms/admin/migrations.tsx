import { ContentType, TypesContext, api, errorMessage, shortDate } from './api'
import { Badge, EmptyState, Notice, PageHeader, Panel, focusHeading, useConfirm, useToast } from './ui'
import { CircleCheck } from 'lucide-react'
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

// The admin's Migrations page and the notice above every other page while migrations wait (PLAN.md section 6). Anyone
// signed in sees what waits, and in iight dev, where the type editor is, Run runs it as iight migrate does.

// A migration as GET /api/migrations lists it, in the order iight migrate runs them
export interface Migration {
  name: string
  kind: 'cms' | 'content'
  status: 'waiting' | 'ran'
  batch: number | null
  ranAt: string | null
  // A waiting content migration's helper calls, its flags and TODOs, or why it doesn't load
  steps?: Array<Step>
  notes?: Array<{ kind: 'flag' | 'todo'; line: number; text: string }>
  problem?: string | null
}

// A helper call, with its arguments by name
interface Step {
  helper: string
  type?: string
  path?: string
  from?: string
  to?: string
  value?: unknown
}

// A run, which the server keeps in memory until it restarts
export interface Run {
  status: 'running' | 'done' | 'failed'
  migrations: Array<string>
  ran: Array<string>
  step: { kind: 'migration' | 'links'; name: string | null; done: number | null; total: number | null } | null
  failed: { name: string | null; message: string } | null
  startedBy: { id: string; name: string }
  startedAt: string
  finishedAt: string | null
}

export interface Listing {
  data: Array<Migration>
  // A hash of what waits, which Run sends back, so it runs only what the page showed
  waiting: string | null
  run: Run | null
}

// What iight migrate --check lists, up to 100 of them, and how many entries don't pass in all
export interface Check {
  entries: number
  failures: Array<{
    entry: { id: string; type: string; title: string | null; archived: boolean }
    copy: 'draft' | 'live'
    messages: Record<string, Array<string>>
  }>
}

// The list the shell keeps for its notice and the Migrations page: loaded when the admin opens and whenever the types
// load again, which is when migrations are written, and every second while a run goes, so every page follows it
export function useMigrations(types: unknown) {
  const [listing, setListing] = useState<Listing>()
  const [problem, setProblem] = useState('')
  const reload = useCallback(async (): Promise<Listing | undefined> => {
    try {
      const { body } = await api('GET', '/migrations')
      setListing(body)
      setProblem('')
      return body
    } catch (error) {
      setProblem(errorMessage(error))
    }
  }, [])
  useEffect(() => void reload(), [types, reload])

  const running = listing?.run?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(reload, 1000)
    return () => clearInterval(timer)
  }, [running, reload])

  // A run that ends asks once more, so what its last migration changed reaches every page's notice
  const was = useRef(running)
  useEffect(() => {
    if (was.current && !running) void reload()
    was.current = running
  }, [running, reload])

  return { listing, problem, reload, setListing }
}

export const MigrationsContext = createContext<ReturnType<typeof useMigrations>>({
  listing: undefined,
  problem: '',
  reload: async () => undefined,
  setListing: () => {},
})

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`

// A migration's name without the time it was made, such as resources
const shortName = (name: string) => name.replace(/^\d{4}_\d\d_\d\d_\d{6}_/, '')

// What the notice above every page says while migrations wait. Waiting content migrations stop entries saving, and
// waiting CMS migrations stop the pages whose tables are behind.
export function MigrationsNotice({
  waiting,
  run,
  editable,
}: {
  waiting: Array<Migration>
  run?: Run | null
  editable: boolean
}) {
  if (run?.status === 'running') return <Notice>Migrations are running. Entries can be saved once they're done.</Notice>
  if (!waiting.length) return null

  const content = waiting.some((migration) => migration.kind === 'content')
  const cms = waiting.length - waiting.filter((migration) => migration.kind === 'content').length
  const one = waiting.length === 1
  const until = editable ? (
    one ? (
      'it runs'
    ) : (
      'they run'
    )
  ) : (
    <>
      a developer runs <code>npx iight migrate</code>
    </>
  )
  const said = !content ? (
    <>
      The CMS has {cms === 1 ? 'a migration' : `${cms} migrations`} waiting, so some pages may not work until {until}.
    </>
  ) : cms ? (
    <>
      {plural(waiting.length, 'migration')} {one ? 'is' : 'are'} waiting, so entries can't be saved, and some pages may
      not work, until {until}.
    </>
  ) : (
    <>
      {plural(waiting.length, 'migration')} {one ? 'is' : 'are'} waiting, so entries can't be saved until {until}.
    </>
  )
  return (
    <Notice tone='warning'>
      {said} <a href='#/migrations'>{editable ? (one ? 'Review and run it' : 'Review and run them') : 'See which'}</a>
    </Notice>
  )
}

// The shell's notice, and a toast for a run that ends while the person is on another page
export function ShellMigrationsNotice({ editable }: { editable: boolean }) {
  const { listing } = useContext(MigrationsContext)
  const toast = useToast()
  const status = listing?.run?.status
  const was = useRef(status)
  useEffect(() => {
    if (was.current === 'running' && listing?.run && status !== 'running') toast(outcomeWords(listing.run))
    was.current = status
  }, [status])

  return (
    <MigrationsNotice
      waiting={listing?.data.filter((migration) => migration.status === 'waiting') ?? []}
      run={listing?.run}
      editable={editable}
    />
  )
}

// A helper call in words, such as Blog posts: renames title to headline, and whether it deletes values
export function stepWords(step: Step, types: Map<string, ContentType>): { text: string; deletes?: boolean } {
  const type = types.get(step.type ?? '')?.label ?? step.type
  const last = (path = '') => path.split('.').at(-1)
  const field = (path = '') => path.split('.').slice(0, -1).join('.')
  switch (step.helper) {
    case 'renameField':
      return {
        text:
          field(step.from) === field(step.to)
            ? `${type}: renames ${step.from} to ${last(step.to)}`
            : `${type}: moves ${step.from} to ${step.to}`,
      }
    case 'removeField':
      return { text: `${type}: deletes the values of ${step.path}`, deletes: true }
    case 'addField':
      return { text: `${type}: fills in ${step.path} where it's empty, with ${JSON.stringify(step.value)}` }
    case 'mapField':
      return { text: `${type}: changes ${step.path}, with code of its own` }
    case 'renameLayout':
      return { text: `${type}: renames the ${last(step.from)} blocks in ${field(step.from)} to ${last(step.to)}` }
    case 'removeLayout':
      return { text: `${type}: deletes every ${last(step.path)} block in ${field(step.path)}`, deletes: true }
    case 'renameType':
      return { text: `Renames the type ${step.from} to ${step.to}` }
    case 'update':
      return { text: `${type}: changes its entries' values, with code of its own` }
    default:
      return { text: step.helper }
  }
}

// What the waiting migrations delete, for the question Run asks first, such as Blog posts: the values of summary
export function deletionsOf(waiting: Array<Migration>, types: Map<string, ContentType>) {
  return waiting.flatMap((migration) =>
    (migration.steps ?? []).flatMap((step) => {
      const type = types.get(step.type ?? '')?.label ?? step.type
      if (step.helper === 'removeField') return [`${type}: the values of ${step.path}`]
      if (step.helper === 'removeLayout') {
        const path = step.path ?? ''
        return [`${type}: every ${path.split('.').at(-1)} block in ${path.split('.').slice(0, -1).join('.')}`]
      }
      return []
    }),
  )
}

// The question's body, naming each deletion
export const deletionsQuestion = (deletions: Array<string>) => (
  <>
    <p>These delete values that their down can't bring back. Each entry's old versions keep them.</p>
    <ul>
      {deletions.map((deletion) => (
        <li key={deletion}>{deletion}</li>
      ))}
    </ul>
  </>
)

// Where a run has got, such as Running 2 of 3: resources, 1,500 of 12,000 rows
export function progressOf(run: Run) {
  const { step } = run
  if (!step) return run.status === 'running' ? 'Starting…' : ''
  const rows = step.total === null ? '' : `, ${step.done!.toLocaleString('en')} of ${step.total.toLocaleString('en')}`
  if (step.kind === 'links') return `Rebuilding links between entries${rows}`
  const index = run.migrations.indexOf(step.name!) + 1
  return `Running ${index} of ${run.migrations.length}: ${shortName(step.name!)}${rows && `${rows} rows`}`
}

// How a run ended, in a few words, for the toast
export function outcomeWords(run: Run) {
  if (run.status === 'done') return `Ran ${plural(run.ran.length, 'migration')}`
  return run.failed?.name ? `${shortName(run.failed.name)} failed, and changed nothing` : 'The migrations stopped'
}

// How the last run ended, with what ran, what failed and why, and what still waits
export function RunOutcome({ run, waiting = 0 }: { run: Run; waiting?: number }) {
  const by = `${run.startedBy.name} · ${shortDate(run.finishedAt ?? run.startedAt)}`
  if (run.status === 'running') return null
  if (run.status === 'done') {
    return (
      <Notice tone='success'>
        Ran {plural(run.ran.length, 'migration')}
        {/* Such as one the type editor wrote while it ran */}
        {waiting ? '.' : ', so entries can be saved again.'} <span className='cms-muted'>{by}</span>
      </Notice>
    )
  }
  const left = run.migrations.filter((name) => !run.ran.includes(name) && name !== run.failed?.name)
  // A migration's own message may not end its sentence
  const message = `${run.failed?.message}${/[.!?]$/.test(run.failed?.message ?? '') ? '' : '.'}`
  // Every migration ran and the links failed, which the next run, or start of iight dev, rebuilds
  if (!run.failed?.name && !left.length) {
    return (
      <Notice tone='danger'>
        {message} The {plural(run.ran.length, 'migration')} ran, so entries can be saved, and the links between entries
        are rebuilt at the next run, or when the server starts again. <span className='cms-muted'>{by}</span>
      </Notice>
    )
  }
  // It stopped outside any migration, such as with the database down, before the next one started
  if (!run.failed?.name) {
    return (
      <Notice tone='danger'>
        The run stopped before <code>{left[0]}</code>, which changed nothing: {message}
        {run.ran.length > 0 && ` ${plural(run.ran.length, 'migration')} ran before it.`}
        {left.length > 1 && ` ${plural(left.length - 1, 'other')} still ${left.length === 2 ? 'waits' : 'wait'}.`} Once
        that's fixed, run them again. <span className='cms-muted'>{by}</span>
      </Notice>
    )
  }
  return (
    <Notice tone='danger'>
      <code>{run.failed.name}</code> failed and changed nothing: {message}
      {run.ran.length > 0 && ` ${plural(run.ran.length, 'migration')} ran before it.`}
      {left.length > 0 && ` ${plural(left.length, 'other')} still ${left.length === 1 ? 'waits' : 'wait'}.`} Fix it,
      then run them again. <span className='cms-muted'>{by}</span>
    </Notice>
  )
}

// The waiting migrations, in the order they run, each with what it does, its flags and TODOs, or why it doesn't load,
// and during a run, where each one has got
export function WaitingList({ waiting, run }: { waiting: Array<Migration>; run?: Run | null }) {
  if (!waiting.length) {
    return <EmptyState icon={<CircleCheck />}>Nothing is waiting, so entries can be saved.</EmptyState>
  }

  const stateOf = (name: string) =>
    run?.status === 'running' && run.step?.name === name
      ? ['accent', 'Running']
      : run?.ran.includes(name)
        ? ['success', 'Ran']
        : run?.failed?.name === name
          ? ['danger', 'Failed']
          : undefined

  return (
    <ol className='cms-migrations'>
      {waiting.map((migration) => {
        const state = stateOf(migration.name)
        const flags = migration.notes?.filter((note) => note.kind === 'flag') ?? []
        const todos = migration.notes?.filter((note) => note.kind === 'todo') ?? []
        return (
          <li key={`${migration.kind}/${migration.name}`}>
            <div className='cms-change__head'>
              <code className='cms-migrations__name'>{migration.name}</code>
              <Badge>{migration.kind === 'cms' ? 'CMS' : 'Content'}</Badge>
              {state && <Badge tone={state[0] as 'accent'}>{state[1]}</Badge>}
            </div>
            {migration.kind === 'cms' && <p className='cms-muted'>Changes the CMS's own tables.</p>}
            {migration.kind === 'content' && !migration.problem && <Steps steps={migration.steps ?? []} />}
            {flags.length > 0 && (
              <Notice tone='warning' quiet>
                Flagged:
                <ul>
                  {flags.map((note) => (
                    <li key={note.line}>{note.text}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {todos.length > 0 && (
              <Notice tone='danger' quiet>
                {todos.length === 1
                  ? "This can't run until its TODO is done:"
                  : "This can't run until its TODOs are done:"}
                <ul>
                  {todos.map((note) => (
                    <li key={note.line}>
                      {note.text}. Finish it in its file, at line {note.line}, then delete the TODO comment.
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            {migration.problem && (
              <Notice tone='danger' quiet>
                It doesn't load: {migration.problem}
              </Notice>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Steps({ steps }: { steps: Array<Step> }) {
  const types = useContext(TypesContext)
  if (!steps.length) return <p className='cms-muted'>It changes no values.</p>
  return (
    <ul className='cms-migrations__steps'>
      {steps.map((step, index) => {
        const { text, deletes } = stepWords(step, types)
        return (
          <li key={index}>
            {text}
            {deletes && <Badge tone='danger'>Deletes</Badge>}
          </li>
        )
      })}
    </ul>
  )
}

// The migrations that ran, the site's newest first, and the CMS's own in a fold under them
export function RanList({ ran }: { ran: Array<Migration> }) {
  const newest = (list: Array<Migration>) =>
    [...list].sort((a, b) => (b.ranAt ?? '').localeCompare(a.ranAt ?? '') || b.name.localeCompare(a.name))
  const content = newest(ran.filter((migration) => migration.kind === 'content'))
  const cms = newest(ran.filter((migration) => migration.kind === 'cms'))
  const table = (list: Array<Migration>, label: string) => (
    <div className='cms-table-wrap'>
      <table className='cms-table'>
        <caption className='cms-visually-hidden'>{label}</caption>
        <thead>
          <tr>
            <th>Name</th>
            <th className='cms-table__number'>Batch</th>
            <th>Ran</th>
          </tr>
        </thead>
        <tbody>
          {list.map((migration) => (
            <tr key={migration.name}>
              <td>
                <code>{migration.name}</code>
              </td>
              <td className='cms-table__number'>{migration.batch}</td>
              <td>{migration.ranAt && shortDate(migration.ranAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <>
      {content.length ? table(content, 'Content migrations that ran') : <p>No content migration has run yet.</p>}
      {cms.length > 0 && (
        <details className='cms-migrations__fold'>
          <summary>The CMS's own, {cms.length}</summary>
          {table(cms, "The CMS's own migrations that ran")}
        </details>
      )}
    </>
  )
}

// How many entries don't pass, such as 2 entries don't pass
const checkWords = (check: Check) =>
  check.entries === 0
    ? 'Every entry passes.'
    : `${plural(check.entries, "entry doesn't", "entries don't")} pass${check.entries > check.failures.length ? `, and here are the first ${check.failures.length}` : ''}.`

// The entries that don't pass, each linking to its editor, with each message by its path
export function CheckList({ check }: { check: Check }) {
  const types = useContext(TypesContext)
  return (
    <>
      <p>{checkWords(check)}</p>
      {check.failures.length > 0 && (
        <ul className='cms-migrations__checks'>
          {check.failures.map(({ entry, copy, messages }) => (
            <li key={`${entry.id}/${copy}`}>
              <div className='cms-change__head'>
                <a href={`#/entries/${entry.id}`}>
                  {types.get(entry.type)?.label ?? entry.type}: {entry.title ?? 'Untitled'}
                </a>
                {copy === 'live' && <Badge>Live copy</Badge>}
                {entry.archived && <Badge>Archived</Badge>}
              </div>
              <ul>
                {Object.entries(messages).map(([path, list]) => (
                  <li key={path}>
                    <code>{path}</code>: {list.join(' ')}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// The panel's buttons: Run while anything waits, then Check entries once nothing does, with where a run has got
export function MigrationActions({
  waiting,
  run,
  busy,
  onRun,
  onCheck,
}: {
  waiting: number
  run?: Run | null
  busy?: string
  onRun: () => void
  onCheck: () => void
}) {
  const running = run?.status === 'running'
  return (
    <>
      {(waiting > 0 || running) && (
        <button
          type='button'
          className='iight-button iight-button--primary'
          aria-busy={running || busy === 'run'}
          onClick={onRun}
        >
          {running ? 'Running…' : busy === 'run' ? 'Starting…' : `Run ${plural(waiting, 'migration')}`}
        </button>
      )}
      {!waiting && !running && (
        <button type='button' className='iight-button' aria-busy={busy === 'check'} onClick={onCheck}>
          {busy === 'check' ? 'Checking entries…' : 'Check entries'}
        </button>
      )}
      {running && <p className='cms-panel__note'>{progressOf(run)}</p>}
    </>
  )
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className='cms-section'>
    <h2>{title}</h2>
    {children}
  </section>
)

// The page: what waits and what ran, in iight dev with Run and Check entries in its panel. Run asks first when what
// waits deletes values, naming each, and sends back what the page showed, so it runs that and nothing else.
export function MigrationsPage({ editable }: { editable: boolean }) {
  const { listing, problem: failed, reload, setListing } = useContext(MigrationsContext)
  const types = useContext(TypesContext)
  const confirm = useConfirm()
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState<string>()
  const [check, setCheck] = useState<Check>()
  const outcome = useRef<HTMLDivElement>(null)
  // A polite status, which says a run started, while the line of progress under it changes without being read out
  const [said, setSaid] = useState('')

  // Opening the page, or coming back to it from the editor, such as after finishing a TODO, shows the files as they are
  // now
  useEffect(() => {
    void reload()
    addEventListener('focus', reload)
    return () => removeEventListener('focus', reload)
  }, [reload])

  const waiting = listing?.data.filter((migration) => migration.status === 'waiting') ?? []
  const ran = listing?.data.filter((migration) => migration.status === 'ran') ?? []
  const run = listing?.run
  const running = run?.status === 'running'

  // Once a run this page started or followed ends, focus moves to what became of it, as Run's button may have gone, and
  // a problem from before, such as that it was already running, goes
  const was = useRef(run?.status)
  useEffect(() => {
    if (was.current === 'running' && run?.status !== 'running') {
      setSaid('')
      setProblem('')
      outcome.current?.focus()
    }
    was.current = run?.status
  }, [run?.status])

  const start = async () => {
    if (busy || running || !listing) return
    // A TODO or a file that doesn't load stops the run, which the server says, so there's nothing to ask about yet
    const stopped = waiting.some(
      (migration) => migration.problem || migration.notes?.some(({ kind }) => kind === 'todo'),
    )
    const deletions = deletionsOf(waiting, types)
    if (deletions.length && !stopped) {
      const sure = await confirm({
        title: `Run ${plural(waiting.length, 'migration')}, deleting values?`,
        body: deletionsQuestion(deletions),
        action: 'Run and delete',
        danger: true,
      })
      if (!sure) return
    }
    setBusy('run')
    setProblem('')
    try {
      const { body } = await api('POST', '/migrations/run', { waiting: listing.waiting })
      setSaid(`Running ${plural(body.data.migrations.length, 'migration')}…`)
      setListing({ ...listing, run: body.data })
    } catch (error) {
      setProblem(errorMessage(error))
      // What waits may have changed, so the page shows it as it is now. Run goes once nothing waits, so focus moves
      // to the page's heading rather than being lost with it.
      const shown = await reload()
      if (shown && !shown.data.some((migration) => migration.status === 'waiting')) setTimeout(focusHeading)
    } finally {
      setBusy(undefined)
    }
  }

  const checkEntries = async () => {
    if (busy) return
    setBusy('check')
    setProblem('')
    try {
      const { data } = (await api('GET', '/migrations/check')).body
      setCheck(data)
      setSaid(checkWords(data))
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className='cms-page'>
      <PageHeader title='Migrations' />
      <Panel
        label='Migrations'
        problem={problem}
        actions={
          editable && (
            <MigrationActions waiting={waiting.length} run={run} busy={busy} onRun={start} onCheck={checkEntries} />
          )
        }
      />
      <p className='cms-visually-hidden' role='status'>
        {said}
      </p>
      <p>
        Content migrations change entries' values when a content type changes, and the CMS's own change its tables.{' '}
        {editable ? (
          <>
            Run is <code>npx iight migrate</code>: it runs every waiting migration, the CMS's first, each in its own
            transaction.
          </>
        ) : (
          <>
            They run with <code>npx iight migrate</code>, as part of each deploy.
          </>
        )}
      </p>
      {failed && <Notice tone='danger'>{failed}</Notice>}
      <div ref={outcome} tabIndex={-1} className='cms-migrations__outcome'>
        {run && <RunOutcome run={run} waiting={waiting.length} />}
      </div>

      {listing && (
        <>
          <Section title='Waiting'>
            <WaitingList waiting={waiting} run={run} />
          </Section>
          {check && (
            <Section title="Entries that don't pass">
              <CheckList check={check} />
            </Section>
          )}
          <Section title='Ran'>
            <RanList ran={ran} />
            <p className='cms-muted'>
              To undo the last batch, run <code>npx iight migrate:rollback</code>, then put back the type's file, the
              snapshot and the migration with git.
            </p>
          </Section>
        </>
      )}
    </div>
  )
}
