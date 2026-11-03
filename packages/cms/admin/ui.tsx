import { Status, pathOf } from './api'
import { filterOf } from './lists'
import Form, { FieldSchema, Modal, ValidationReport, flattenValidationReport } from 'iight'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  ListFilter,
  LoaderCircle,
  LucideProvider,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sun,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  MouseEvent,
  ReactNode,
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'

const themes = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
]

// The theme on <html>, so every switch on the page shows the one chosen
const watchTheme = (changed: () => void) => {
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

// Light, dark, or the OS's setting, remembered in this browser, as three icons that switch at once, with their names
// for screen readers. They're native radios, so the arrow keys move between them. index.html applies the choice
// before each first paint.
export function ThemeSwitch() {
  const id = useId()
  const theme = useSyncExternalStore(watchTheme, () => document.documentElement.dataset.theme ?? 'system')

  const choose = (theme: string) => {
    const root = document.documentElement
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
    else delete root.dataset.theme

    // Without storage, the choice lasts until the page reloads
    try {
      if (root.dataset.theme) localStorage.setItem('iight-theme', root.dataset.theme)
      else localStorage.removeItem('iight-theme')
    } catch {}
  }

  return (
    <div className='cms-theme'>
      <span id={id}>Theme</span>
      <div className='cms-theme__choices' role='radiogroup' aria-labelledby={id}>
        {themes.map(({ value, label, icon }) => (
          <label key={value} title={label}>
            <input
              className='cms-visually-hidden'
              type='radio'
              name={id}
              value={value}
              checked={theme === value}
              onChange={() => choose(value)}
            />
            {icon}
            <span className='cms-visually-hidden'>{label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// Lucide's list of every icon is large, so the type icons load after the rest of the page
const LazyTypeIcon = lazy(() => import('./typeIcon'))
export const TypeIcon = ({ name }: { name?: string }) => (
  <Suspense fallback={<span className='cms-icon' />}>
    <LazyTypeIcon name={name} />
  </Suspense>
)

// A page's title on one line after a link to the list it's in, with details such as a badge beside it. The h1 holds
// only the title, since the shell titles the document after it. The page's actions are in its panel.
export function PageHeader({
  back,
  title,
  meta,
}: {
  back?: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
}) {
  return (
    <header className='cms-header'>
      <div className='cms-header__title'>
        {back && (
          <>
            <a href={back.href}>{back.label}</a>
            <span aria-hidden>/</span>
          </>
        )}
        <h1>{title}</h1>
        {meta && <span className='cms-header__meta'>{meta}</span>}
      </div>
    </header>
  )
}

// Where pages' panels go: the top of the shell's column at the window's right, or nowhere, as on the reference page,
// which shows its panels in place
export const PanelSlot = createContext<HTMLElement | null>(null)

// A page's panel: its actions at the top with what stops them, details in the middle, and the actions that take the
// page away, such as Delete, at the bottom. From 64rem it fills the shell's column beside the page, as tall as the
// window, and only its middle scrolls. Below that, its actions are a bar fixed to the bottom of the window, and the
// rest follows the page, or with sheet, opens from a button of that name in the bar, as a list's filters do.
export function Panel({
  actions,
  problem,
  label,
  footer,
  sheet,
  children,
}: {
  actions?: ReactNode
  problem?: string
  // The panel's name, such as About this entry
  label?: string
  footer?: ReactNode
  sheet?: string
  children?: ReactNode
}) {
  const slot = useContext(PanelSlot)
  const bar = useRef<HTMLDivElement>(null)
  const sheetButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  const hasBar = !!(actions || problem || sheet)

  // The page makes room for the bar, as tall as its buttons and problem make it
  useLayoutEffect(() => {
    const element = bar.current
    if (!slot || !element) return
    const root = document.documentElement
    const observer = new ResizeObserver(() => root.style.setProperty('--cms-bar', `${element.offsetHeight}px`))
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--cms-bar')
    }
  }, [slot, hasBar])

  // A panel with nothing in it leaves the shell's column empty, rather than holding an empty landmark
  if (!hasBar && !children && !footer) return null

  // The whole panel is the landmark, since the shell's column sits outside main and the actions need one too
  const panel = (
    <aside className='cms-panel' aria-label={label} data-sheet={sheet && ''}>
      {hasBar && (
        <div ref={bar} className='cms-panel__actions'>
          <div className='cms-panel__buttons'>
            {actions}
            {sheet && (
              <button
                ref={sheetButton}
                type='button'
                className='iight-button cms-panel__sheet'
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen(!open)}
              >
                <SlidersHorizontal /> {sheet}
              </button>
            )}
          </div>
          {problem && (
            <p className='cms-problem' role='alert'>
              <CircleAlert /> {problem}
            </p>
          )}
        </div>
      )}
      {children && (
        <div
          id={id}
          className='cms-panel__body'
          data-open={open || undefined}
          onKeyDown={(event) => {
            if (!open || event.key !== 'Escape') return
            setOpen(false)
            sheetButton.current?.focus()
          }}
        >
          {children}
        </div>
      )}
      {footer && <div className='cms-panel__footer'>{footer}</div>}
    </aside>
  )
  return slot ? createPortal(panel, slot) : panel
}

// Moves focus to the page's heading, as the shell does on a change of page, such as when the focused button goes
export function focusHeading() {
  const heading = document.querySelector<HTMLElement>('main h1')
  if (!heading) return
  heading.tabIndex = -1
  heading.focus()
}

// A list's search and filter, kept in the URL's query after the page's path, so they survive a reload and can be
// shared, or without a query, as in a picker, kept here from start. Its forms start from what's shown, which follows
// the query when it changes from elsewhere, such as the nav's link to the bare list, and after clear. Its page starts
// again at the first whenever the query changes.
export function useListQuery(query?: string, start = '') {
  const [kept, setKept] = useState(start)
  const params = useMemo(() => new URLSearchParams(query ?? kept), [query, kept])
  const current = params.toString()
  const written = useRef(current)
  const [shown, setShown] = useState(params)
  useEffect(() => {
    if (current === written.current) return
    written.current = current
    setShown(params)
  }, [current])

  const [paging, setPaging] = useState({ query: current, page: 1 })
  const page = paging.query === current ? paging.page : 1
  const setPage = (page: number) => setPaging({ query: current, page })

  // Empty values leave the query. Replacing the URL keeps history to one entry for the page.
  const write = (next: URLSearchParams) => {
    for (const key of [...next.keys()]) if (!next.get(key)) next.delete(key)
    written.current = next.toString()
    if (query === undefined) setKept(written.current)
    else location.replace(`${pathOf(location.hash)}${written.current && `?${written.current}`}`)
  }

  const clear = () => {
    write(new URLSearchParams())
    setShown(new URLSearchParams())
  }

  return { params, shown, write, clear, page, setPage, filtered: current !== '' }
}

// A list's search box and Filter, which shows and hides core's conditions input over the fields it lists, then Clear
// filters once anything's set, and how many the list holds, announced as that changes
export function ListFilters({
  list,
  schema,
  fieldChoices,
  count,
  noun,
  left,
}: {
  list: ReturnType<typeof useListQuery>
  // The search's fields, named as the query's keys, such as search. The same array from render to render, since a new
  // one starts the form again from what's shown, losing what's being typed.
  schema: Array<FieldSchema>
  fieldChoices: Array<object>
  // How many the list holds, once it's loaded
  count?: number
  noun: [one: string, many: string]
  // How many rules the list leaves out, since it can't filter with them
  left: number
}) {
  const id = useId()
  const area = useRef<HTMLDivElement>(null)
  const { params, shown, write } = list
  // Open whenever the rules shown come from elsewhere, such as a shared link, so they can be seen
  const filterValues = useMemo(() => ({ filter: filterOf(shown) }), [shown])
  const [open, setOpen] = useState(filterValues.filter.length > 0)
  useEffect(() => {
    if (filterValues.filter.length) setOpen(true)
  }, [filterValues])
  const searchValues = useMemo(
    () => Object.fromEntries(schema.map((field) => [field.name, shown.get(field.name) ?? ''])),
    [shown, schema],
  )
  const filterSchema = useMemo<Array<FieldSchema>>(
    () => [
      {
        name: 'filter',
        label: 'Rules',
        type: 'conditions',
        instructions: `Shows the ${noun[1]} that match every rule of any group.`,
        options: { fieldChoices },
      },
    ],
    [fieldChoices, noun[1]],
  )

  const change = (values: Record<string, any>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) {
      next.set(key, typeof value === 'string' ? value : value?.length ? JSON.stringify(value) : '')
    }
    write(next)
  }

  // Its button goes, so focus moves to the search
  const clear = () => {
    list.clear()
    area.current?.querySelector<HTMLElement>('input, select')?.focus()
  }

  return (
    <div ref={area} className='cms-filters'>
      <Form schema={schema} values={searchValues} onValuesChange={change} />
      <button
        type='button'
        className='iight-button'
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ListFilter /> Filter
      </button>
      <div id={id} hidden={!open}>
        <Form schema={filterSchema} values={filterValues} onValuesChange={change} />
        {left > 0 && (
          <Notice tone='warning'>
            {left === 1
              ? "A rule can't filter this list, so it's left out."
              : `${left} rules can't filter this list, so they're left out.`}{' '}
            Lists can filter with every operator but starts with.
          </Notice>
        )}
      </div>
      {list.filtered && (
        <button type='button' className='iight-button' onClick={clear}>
          <X /> Clear filters
        </button>
      )}
      <p className='cms-muted' role='status'>
        {count !== undefined &&
          (count === 0 ? `No ${noun[1]}` : `${count.toLocaleString()} ${count === 1 ? noun[0] : noun[1]}`)}
      </p>
    </div>
  )
}

const noticeIcons = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }

// Something that stays true of the page, such as an entry being archived. Problems are announced straight away, unless
// it's quiet, as in a chat's replies, which a status of their own reads out.
export function Notice({
  tone = 'info',
  quiet,
  children,
}: {
  tone?: keyof typeof noticeIcons
  quiet?: boolean
  children: ReactNode
}) {
  const Icon = noticeIcons[tone]
  return (
    <div className={`cms-notice cms-notice--${tone}`} role={quiet ? undefined : tone === 'danger' ? 'alert' : 'status'}>
      <Icon />
      <div>{children}</div>
    </div>
  )
}

export const Badge = ({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  children: ReactNode
}) => <span className={`cms-badge cms-badge--${tone}`}>{children}</span>

const statuses = {
  draft: { tone: 'neutral', label: 'Draft' },
  published: { tone: 'success', label: 'Published' },
  changed: { tone: 'warning', label: 'Changed' },
} as const

// What's live of an entry: nothing yet, its draft as it stands, or an older version than its draft
export const StatusBadge = ({ status }: { status: Status }) => (
  <Badge tone={statuses[status].tone}>{statuses[status].label}</Badge>
)

// What a page shows when it has nothing to list, with the action that fills it
export const EmptyState = ({
  icon,
  action,
  children,
}: {
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
}) => (
  <div className='cms-empty'>
    <LucideProvider size={24}>{icon}</LucideProvider>
    <p>{children}</p>
    {action}
  </div>
)

// It only appears once loading has taken a moment, so quick pages don't flash it
export const Loading = () => (
  <p className='cms-loading' role='status'>
    <LoaderCircle className='cms-spin' /> Loading…
  </p>
)

export interface Pagination {
  page: number
  perPage: number
  total: number
  lastPage: number
}

// Which rows a page of a list holds, and buttons for the pages either side
export function Pages({ pagination, onPage }: { pagination: Pagination; onPage: (page: number) => void }) {
  const { page, perPage, total, lastPage } = pagination
  return (
    <nav className='cms-pages' aria-label='Pages'>
      <span>
        {((page - 1) * perPage + 1).toLocaleString()}–{Math.min(page * perPage, total).toLocaleString()} of{' '}
        {total.toLocaleString()}
      </span>
      {lastPage > 1 && (
        <>
          <IconButton label='Previous page' disabled={page === 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label='Next page' disabled={page === lastPage} onClick={() => onPage(page + 1)}>
            <ChevronRight />
          </IconButton>
        </>
      )}
    </nav>
  )
}

// A quiet, square button with just an icon. Its label names it for screen readers and shows on hover.
export const IconButton = ({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) => (
  <button
    type='button'
    className='cms-icon-button'
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
)

// A dialog's close button, for core's Modal. Closing the dialog itself, rather than unmounting it, hands focus back
// to whatever opened it.
export const DialogClose = () => (
  <IconButton label='Close' onClick={(event) => event.currentTarget.closest('dialog')?.close()}>
    <X />
  </IconButton>
)

// A dialog outside whatever opens it, since it may hold a form of its own inside another. The theme on <html> still
// reaches it.
export const Dialog = ({
  title,
  footer,
  onClose,
  children,
}: {
  title: string
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
}) =>
  createPortal(
    <Modal open header={<h2>{title}</h2>} footer={footer} closeButton={<DialogClose />} onClose={onClose}>
      {children}
    </Modal>,
    document.body,
  )

// Links between the views of one page, such as an inbox and its spam
export const RouteTabs = ({
  label,
  tabs,
  current,
}: {
  label: string
  tabs: Array<{ key: string; href: string; label: string }>
  current: string
}) => (
  <nav className='cms-tabs' aria-label={label}>
    {tabs.map((tab) => (
      <a key={tab.key} href={tab.href} aria-current={tab.key === current ? 'page' : undefined}>
        {tab.label}
      </a>
    ))}
  </nav>
)

// After a form fails its checks: moves focus to the first field that failed, and says how many need fixing before it
// can be saved, or published. A form marks its fields a render or two after it's checked, so this waits up to half a
// second for them. The innermost fields count, so a group with a bad field counts once. Given the report of a check
// with allowIncomplete, which still shows every field's messages, only the fields showing the report's messages count.
export async function focusInvalid(area: HTMLElement | null, action = 'saved', report?: ValidationReport) {
  const reported = report && new Set(Object.values(flattenValidationReport(report).messages).flat())
  const fails = (field: Element) =>
    !reported ||
    [...field.querySelectorAll(':scope > .iight-messages > li')].some((item) => reported.has(item.textContent!))

  let invalid: Array<Element> = []
  for (let tries = 0; tries < 30 && !invalid.length; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 16))
    const failed = [...(area?.querySelectorAll('.iight-invalid') ?? [])].filter(fails)
    invalid = failed.filter((field) => !failed.some((other) => other !== field && field.contains(other)))
  }
  invalid[0]?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
  return invalid.length > 1
    ? `${invalid.length} fields need fixing before this can be ${action}.`
    : `A field needs fixing before this can be ${action}.`
}

const ToastContext = createContext((message: string) => {})

// Shows a passing message, for results that leave the page as it was, such as Saved
export const useToast = () => useContext(ToastContext)

// A live region for toasts: the shell's, and one in a dialog that toasts while it stays open. Each lasts 5 seconds,
// paused while the pointer or focus is on it. A toast fired once a dialog's has gone, such as for a message that was
// still waiting to send when the dialog closed, shows in the toaster around it instead.
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([])
  const outer = useContext(ToastContext)
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => void (shown.current = false)
  }, [])
  const toast = useCallback(
    (message: string) =>
      shown.current ? setToasts((all) => [...all, { id: Math.random(), message }]) : outer(message),
    [outer],
  )
  const dismiss = useCallback((id: number) => setToasts((shown) => shown.filter((toast) => toast.id !== id)), [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className='cms-toasts' role='status'>
        {toasts.map(({ id, message }) => (
          <Toast key={id} id={id} message={message} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function Toast({ id, message, onDismiss }: { id: number; message: string; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => onDismiss(id), 5000)
    return () => clearTimeout(timer)
  }, [paused, id, onDismiss])

  return (
    <div
      className='cms-toast'
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Only the toast, not the dialog it may be in
        event.preventDefault()
        onDismiss(id)
      }}
    >
      <CircleCheck />
      {message}
      <IconButton label='Dismiss' onClick={() => onDismiss(id)}>
        <X />
      </IconButton>
    </div>
  )
}

interface Question {
  title: string
  body: ReactNode
  // The button that goes ahead, named for what it does
  action: string
  danger?: boolean
}

const ConfirmContext = createContext(async (question: Question) => false)

// Asks before an action, resolving true if the person goes ahead
export const useConfirm = () => useContext(ConfirmContext)

// The dialog behind useConfirm. Cancel comes first, so it has focus when the dialog opens, and Escape cancels too.
export function Confirmer({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState<Question & { answer: (yes: boolean) => void }>()
  const confirm = useCallback(
    (question: Question) => new Promise<boolean>((answer) => setAsking({ ...question, answer })),
    [],
  )
  // The dialog closes itself after either button, and then reports a cancel, which the promise ignores
  const answer = (yes: boolean) => {
    asking?.answer(yes)
    setAsking(undefined)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!asking}
        header={<h2>{asking?.title}</h2>}
        onClose={() => answer(false)}
        footer={
          <div className='cms-dialog-actions'>
            <button type='button' className='iight-button' onClick={() => answer(false)}>
              Cancel
            </button>
            <button
              type='button'
              className={`iight-button iight-button--${asking?.danger ? 'danger' : 'primary'}`}
              onClick={() => answer(true)}
            >
              {asking?.action}
            </button>
          </div>
        }
      >
        {/* A body of its own, such as a list, comes as it is */}
        {typeof asking?.body === 'string' ? <p>{asking.body}</p> : asking?.body}
      </Modal>
    </ConfirmContext.Provider>
  )
}
