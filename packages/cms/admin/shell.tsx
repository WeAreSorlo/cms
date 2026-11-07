import {
  ContentType,
  PageView,
  PageViewContext,
  SectionContext,
  initialsOf,
  navigation,
  pathOf,
  sectionOf,
} from './api'
import { AssistantContext, useAssistantState } from './chat'
import { MigrationsContext, ShellMigrationsNotice, useMigrations } from './migrations'
import { Confirmer, PanelSlot, ThemeSwitch, Toaster, TypeIcon } from './ui'
import {
  Blocks,
  ChevronsUpDown,
  CircleUserRound,
  ClipboardList,
  Component,
  DatabaseZap,
  Images,
  KeyRound,
  LogOut,
  LucideProvider,
  Menu,
  Plug,
  Sparkles,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { ReactNode, Suspense, lazy, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

// The assistant under the page's panel, in a chunk of its own with its Markdown renderer
const PanelAssistant = lazy(() => import('./assistant').then((module) => ({ default: module.PanelAssistant })))

type Size = { now: number; min: number; max: number }

// The panel's width, which its CSS keeps from its least to its most
function panelWidth(side: HTMLElement): Size {
  const style = getComputedStyle(side)
  return { now: side.offsetWidth, min: parseFloat(style.minWidth), max: parseFloat(style.maxWidth) }
}

// The assistant's height, from its CSS's least to as tall as leaves the page's panel above it room for its actions and
// footer, since the CSS gives the panel's middle no height of its own there, only its padding
function assistantHeight(assistant: HTMLElement, handle: HTMLElement): Size {
  const side = assistant.parentElement!
  const panel = side.querySelector<HTMLElement>('.cms-panel')
  let least = panel ? panel.offsetHeight - panel.clientHeight : 0
  for (const part of panel?.children ?? []) {
    const style = getComputedStyle(part)
    least += part.classList.contains('cms-panel__body')
      ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      : (part as HTMLElement).offsetHeight
  }
  const min = parseFloat(getComputedStyle(assistant).minHeight)
  // A window too short for both keeps the assistant at its least
  return { now: assistant.offsetHeight, min, max: Math.max(min, side.clientHeight - handle.offsetHeight - least) }
}

// A handle that resizes what it controls, by pointer or by arrow keys, Home and End, as WAI-ARIA's window splitter
// does. It sits on the left of or above what it resizes, so left and up make it bigger. The size goes in a custom
// property on <html>, which the CSS keeps within its limits, and this browser remembers it.
function Splitter({
  name,
  label,
  controls,
  vertical,
  measure,
}: {
  // The custom property, --cms-<name>, and what this browser remembers it as, sorlo-<name>
  name: string
  label: string
  // The id of what it resizes
  controls: string
  // A vertical line, which resizes widths
  vertical?: boolean
  measure: (pane: HTMLElement, handle: HTMLElement) => Size
}) {
  const handle = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>()
  const property = `--cms-${name}`
  const key = `sorlo-${name}`
  const sized = () => measure(document.getElementById(controls)!, handle.current!)

  const resize = (to: number) => {
    const { min, max } = sized()
    const next = Math.round(Math.max(min, Math.min(max, to)))
    document.documentElement.style.setProperty(property, `${next}px`)
    return next
  }
  const save = (value: number) => {
    // Without storage, the size lasts until the page reloads
    try {
      localStorage.setItem(key, String(value))
    } catch {}
  }

  useLayoutEffect(() => {
    const root = document.documentElement
    try {
      const saved = Number(localStorage.getItem(key))
      if (saved > 0) root.style.setProperty(property, `${saved}px`)
    } catch {}
    // Below 64rem the handle is hidden, with nothing to measure
    const observer = new ResizeObserver(() => handle.current?.offsetParent && setSize(sized()))
    observer.observe(document.getElementById(controls)!)
    return () => {
      observer.disconnect()
      root.style.removeProperty(property)
    }
  }, [])

  const steps: Record<string, number> = vertical ? { ArrowLeft: 16, ArrowRight: -16 } : { ArrowUp: 16, ArrowDown: -16 }

  return (
    <div
      ref={handle}
      role='separator'
      tabIndex={0}
      className='cms-splitter'
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={size?.now}
      aria-valuemin={size?.min}
      aria-valuemax={size?.max}
      // Its most can change with the page beside it, such as a panel with more actions
      onFocus={() => setSize(sized())}
      onKeyDown={(event) => {
        const { now, min, max } = sized()
        const step = steps[event.key]
        const to = event.key === 'Home' ? min : event.key === 'End' ? max : step && now + step
        if (to === undefined) return
        event.preventDefault()
        save(resize(to))
      }}
      onPointerDown={(event) => {
        if (event.button) return
        // Leaves focus where it was, such as in the box to write in, and selects no text on the way
        event.preventDefault()
        const element = event.currentTarget
        const from = sized().now
        const start = vertical ? event.clientX : event.clientY
        let last: number | undefined
        const move = (moved: PointerEvent) => (last = resize(from + start - (vertical ? moved.clientX : moved.clientY)))
        element.setPointerCapture(event.pointerId)
        element.dataset.dragging = ''
        element.addEventListener('pointermove', move)
        element.addEventListener(
          'lostpointercapture',
          () => {
            element.removeEventListener('pointermove', move)
            delete element.dataset.dragging
            if (last !== undefined) save(last)
          },
          { once: true },
        )
      }}
    />
  )
}

// The person's initials and name, cut short when it's too long, which opens their menu. Its name for screen readers
// starts with the name it shows.
export function AccountButton({ name, menu, open }: { name: string; menu?: string; open?: boolean }) {
  return (
    <button type='button' className='cms-account' popoverTarget={menu} aria-expanded={open}>
      <span className='cms-account__initials' aria-hidden>
        {initialsOf(name)}
      </span>
      <span className='cms-account__name'>{name}</span>
      <span className='cms-visually-hidden'>, account menu</span>
      <ChevronsUpDown />
    </button>
  )
}

// The person's menu: who they are, their own pages, the one open marked, the theme, and Sign out. onPick closes it as
// a link is followed.
export function AccountMenu({
  user,
  mcp,
  section,
  onPick,
  onSignOut,
}: {
  user: { name: string; email: string }
  mcp: boolean
  section?: string
  onPick?: () => void
  onSignOut: () => void
}) {
  const current = (page: string) => (page === section ? ('page' as const) : undefined)
  return (
    <>
      <p className='cms-account-menu__who'>
        <strong>{user.name}</strong>
        <span className='cms-muted'>{user.email}</span>
      </p>
      <ul>
        <li>
          <a href='#/account' aria-current={current('account')} onClick={onPick}>
            <CircleUserRound /> Your account
          </a>
        </li>
        {mcp && (
          <li>
            <a href='#/account/tokens' aria-current={current('account/tokens')} onClick={onPick}>
              <Plug /> MCP tokens
            </a>
          </li>
        )}
      </ul>
      <ThemeSwitch />
      <button type='button' className='cms-account-menu__sign-out' onClick={onSignOut}>
        <LogOut /> Sign out
      </button>
    </>
  )
}

// The page around every admin page: the nav with the user's row, a skip link, and the column for the page's panel and,
// with the assistant on, the assistant under it, whose chat lasts from page to page.
// After each change of page it titles the document after the page's heading and moves focus there, so screen readers
// announce the new page. A list's search and filters change only the query after the page's path, which keeps the page.
export function Shell({
  hash,
  types,
  user,
  editable,
  mcp,
  ai,
  onSignOut,
  onTypes,
  arriving = false,
  children,
}: {
  hash: string
  types: Map<string, ContentType>
  user: { id: string; name: string; email: string }
  // Whether the type editor is on, as in sorlo dev, where migrations run from the admin
  editable: boolean
  // Whether /mcp is on, so the person's menu links to their MCP tokens
  mcp: boolean
  // Whether the assistant is on, with Assistant at the top of the nav
  ai: boolean
  onSignOut: () => void
  // Loads the types again, once the assistant's Apply has changed one
  onTypes?: () => Promise<unknown>
  // Whether someone has just signed in, joined or reset their password, whose page went with the focus it had
  arriving?: boolean
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const accountMenu = useId()
  const [accountOpen, setAccountOpen] = useState(false)
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null)
  const assistant = useAssistantState(ai, user.id, onTypes)
  // What migrations wait, for the notice above every page and the Migrations page, loaded again with the types
  const migrations = useMigrations(types)
  // What the page shows, which the assistant beside it takes "this" and "these" to mean
  const [view, setView] = useState<PageView | null>(null)
  // Whether the person has hidden the assistant's chat beside pages, which this browser remembers
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return !!localStorage.getItem('sorlo-assistant-collapsed')
    } catch {
      return false
    }
  })
  const collapse = (next: boolean) => {
    setCollapsed(next)
    // Without storage, it lasts until the page reloads
    try {
      if (next) localStorage.setItem('sorlo-assistant-collapsed', 'true')
      else localStorage.removeItem('sorlo-assistant-collapsed')
    } catch {}
  }
  const main = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  const path = pathOf(hash)

  // A page's own word on its nav item, which lasts until the page changes
  const [shown, setShown] = useState<{ path: string; section: string }>()
  const showSection = useCallback((section: string) => setShown({ path: pathOf(location.hash), section }), [])
  const section = shown?.path === path ? shown.section : sectionOf(hash)

  const focusHeading = () => {
    const heading = main.current?.querySelector('h1')
    if (!heading) return main.current?.focus()
    heading.tabIndex = -1
    heading.focus()
  }

  // Set when the page changes, or as someone arrives, until the new page's heading has taken focus
  const pending = useRef(arriving)
  const update = () => {
    const heading = main.current?.querySelector('h1')
    document.title = heading?.textContent ? `${heading.textContent} · Sorlo` : 'Sorlo'
    if (pending.current && heading) {
      pending.current = false
      focusHeading()
    }
  }

  // Pages that load before showing their heading take focus when it arrives. Someone arriving starts on the page, until
  // then, or for good on a page with no heading.
  useEffect(() => {
    if (arriving) main.current?.focus()
    const observer = new MutationObserver(update)
    observer.observe(main.current!, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  // This runs once the new page is in the document, so it never focuses the old page's heading
  const shownPath = useRef(path)
  useEffect(() => {
    if (path !== shownPath.current) {
      shownPath.current = path
      setMenuOpen(false)
      pending.current = !navigation.keepFocus
      navigation.keepFocus = false
    }
    update()
  }, [path])

  const groups = [
    ...(ai ? [[{ section: 'chat', label: 'Assistant', icon: <Sparkles /> }]] : []),
    [...types.values()].map((type) => ({
      section: `types/${type.name}`,
      label: type.label,
      icon: <TypeIcon name={type.icon} />,
    })),
    [
      { section: 'media', label: 'Media', icon: <Images /> },
      { section: 'forms', label: 'Forms', icon: <ClipboardList /> },
      { section: 'automations', label: 'Automations', icon: <Workflow /> },
    ],
    [
      { section: 'schema', label: 'Content types', icon: <Blocks /> },
      { section: 'groups', label: 'Shared groups', icon: <Component /> },
      { section: 'migrations', label: 'Migrations', icon: <DatabaseZap /> },
      { section: 'keys', label: 'API keys', icon: <KeyRound /> },
      { section: 'users', label: 'Users', icon: <Users /> },
    ],
  ]

  return (
    <LucideProvider size={16}>
      <div className='admin'>
        <button type='button' className='sorlo-button cms-skip' onClick={focusHeading}>
          Skip to content
        </button>

        <div className='cms-bar'>
          <strong>Sorlo</strong>
          <button
            ref={menuButton}
            type='button'
            className='sorlo-button'
            aria-expanded={menuOpen}
            aria-controls='nav'
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X /> : <Menu />} Menu
          </button>
        </div>

        <nav
          id='nav'
          className='cms-nav'
          aria-label='Main'
          data-open={menuOpen || undefined}
          onKeyDown={(event) => {
            // Escape closes an open popover first, as the browser does
            if (!menuOpen || event.key !== 'Escape' || event.currentTarget.querySelector(':popover-open')) return
            setMenuOpen(false)
            menuButton.current?.focus()
          }}
        >
          <div className='cms-nav__list'>
            {groups.map((items, index) => (
              <ul key={index}>
                {items.map((item) => (
                  <li key={item.section}>
                    <a href={`#/${item.section}`} aria-current={item.section === section ? 'page' : undefined}>
                      {item.icon}
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          </div>
          <div className='cms-nav__user'>
            <AccountButton name={user.name} menu={accountMenu} open={accountOpen} />
            {/* After its button, so Tab goes into it. Hiding it returns focus to the button, which a new page's
                heading then takes. */}
            <div
              id={accountMenu}
              className='cms-popover cms-account-menu'
              popover='auto'
              onToggle={(event) => setAccountOpen(event.newState === 'open')}
            >
              <AccountMenu
                user={user}
                mcp={mcp}
                section={section}
                onPick={() => document.getElementById(accountMenu)?.hidePopover()}
                onSignOut={onSignOut}
              />
            </div>
          </div>
        </nav>

        <AssistantContext.Provider value={assistant}>
          <MigrationsContext.Provider value={migrations}>
            {/* Around the panel as well as the page, for the assistant in it */}
            <Toaster>
              <Confirmer>
                <main id='main' ref={main} tabIndex={-1}>
                  {/* Waiting migrations stop saves, or the pages whose tables are behind, so every page says so */}
                  {section !== 'migrations' && <ShellMigrationsNotice editable={editable} />}
                  <SectionContext.Provider value={showSection}>
                    <PageViewContext.Provider value={setView}>
                      <PanelSlot.Provider value={panelSlot}>{children}</PanelSlot.Provider>
                    </PageViewContext.Provider>
                  </SectionContext.Provider>
                </main>
                {/* The panel on every page: the page's own card at the top, then the assistant's, which the shell keeps
                    across pages so a chat lasts, other than on the Chat page, which is the assistant (PLAN.md section
                    21). Handles on its left edge and between the cards resize the panel and the assistant, whose
                    title hides its chat. */}
                <div id='cms-side' className='cms-side'>
                  <Splitter
                    name='panel-width'
                    label='Resize the panel'
                    controls='cms-side'
                    vertical
                    measure={panelWidth}
                  />
                  <div ref={setPanelSlot} className='cms-panel-slot' />
                  {ai && section !== 'chat' && (
                    <>
                      <Splitter
                        name='assistant-height'
                        label='Resize the assistant'
                        controls='cms-assistant'
                        measure={assistantHeight}
                      />
                      <aside
                        id='cms-assistant'
                        className='cms-side__assistant'
                        aria-label='Assistant'
                        data-collapsed={collapsed || undefined}
                      >
                        <Suspense>
                          <PanelAssistant view={view} collapsed={collapsed} onCollapse={collapse} />
                        </Suspense>
                      </aside>
                    </>
                  )}
                </div>
              </Confirmer>
            </Toaster>
          </MigrationsContext.Provider>
        </AssistantContext.Provider>
      </div>
    </LucideProvider>
  )
}
