import type { Status } from './api'
import Form, { FieldSchema, Modal, ValidationReport, flattenValidationReport } from 'iight'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  LucideProvider,
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
  useState,
} from 'react'

// Light, dark, or the OS's setting, remembered in this browser. index.html applies the choice before each first paint.
export function ThemeSwitch() {
  const [schema] = useState<Array<FieldSchema>>(() => [
    {
      type: 'radio',
      name: 'theme',
      label: 'Theme',
      defaultValue: document.documentElement.dataset.theme ?? 'system',
      options: {
        choices: [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
      },
    },
  ])

  const choose = ({ theme }: Record<string, any>) => {
    const root = document.documentElement
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
    else delete root.dataset.theme

    // Without storage, the choice lasts until the page reloads
    try {
      if (root.dataset.theme) localStorage.setItem('iight-theme', root.dataset.theme)
      else localStorage.removeItem('iight-theme')
    } catch {}
  }

  return <Form schema={schema} onValuesChange={choose} />
}

// Lucide's list of every icon is large, so the type icons load after the rest of the page
const LazyTypeIcon = lazy(() => import('./typeIcon'))
export const TypeIcon = ({ name }: { name?: string }) => (
  <Suspense fallback={<span className='cms-icon' />}>
    <LazyTypeIcon name={name} />
  </Suspense>
)

// A page's title, with a link back above it, details below it, and its actions on the right
export function PageHeader({
  back,
  title,
  meta,
  actions,
}: {
  back?: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className='cms-header'>
      <div>
        {back && (
          <a className='cms-header__back' href={back.href}>
            <ChevronLeft />
            {back.label}
          </a>
        )}
        <h1>{title}</h1>
        {meta && <div className='cms-header__meta'>{meta}</div>}
      </div>
      {actions && <div className='cms-header__actions'>{actions}</div>}
    </header>
  )
}

const noticeIcons = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }

// Something that stays true of the page, such as an entry being archived. Problems are announced straight away.
export function Notice({ tone = 'info', children }: { tone?: keyof typeof noticeIcons; children: ReactNode }) {
  const Icon = noticeIcons[tone]
  return (
    <div className={`cms-notice cms-notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
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
        {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
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

// The one live region for toasts. Each lasts 5 seconds, paused while the pointer or focus is on it.
export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([])
  const toast = useCallback((message: string) => setToasts((shown) => [...shown, { id: Math.random(), message }]), [])
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
      onKeyDown={(event) => event.key === 'Escape' && onDismiss(id)}
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
        <p>{asking?.body}</p>
      </Modal>
    </ConfirmContext.Provider>
  )
}
