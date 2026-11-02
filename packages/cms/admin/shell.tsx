import { ContentType, PageView, PageViewContext, SectionContext, pathOf, sectionOf } from './api'
import { AssistantContext, useAssistantState } from './chat'
import { Confirmer, IconButton, PanelSlot, ThemeSwitch, Toaster, TypeIcon } from './ui'
import {
  Blocks,
  ClipboardList,
  Component,
  Images,
  KeyRound,
  LogOut,
  LucideProvider,
  Menu,
  MessagesSquare,
  Plug,
  SunMoon,
  Workflow,
  X,
} from 'lucide-react'
import { ReactNode, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'

// The assistant under the page's panel, in a chunk of its own with its Markdown renderer
const PanelAssistant = lazy(() => import('./assistant').then((module) => ({ default: module.PanelAssistant })))

// The page around every admin page: the nav with the user's row, a skip link, and the column for the page's panel and,
// with the assistant on, the assistant under it, whose chat lasts from page to page.
// After each change of page it titles the document after the page's heading and moves focus there, so screen readers
// announce the new page. A list's search and filters change only the query after the page's path, which keeps the page.
export function Shell({
  hash,
  types,
  user,
  mcp,
  ai,
  onSignOut,
  children,
}: {
  hash: string
  types: Map<string, ContentType>
  user: { id: string; name: string }
  // Whether /mcp is on, so the user's row links to their MCP tokens
  mcp: boolean
  // Whether the assistant is on, with Chat at the top of the nav
  ai: boolean
  onSignOut: () => void
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null)
  const assistant = useAssistantState(ai, user.id)
  // What the page shows, which the assistant beside it takes "this" and "these" to mean
  const [view, setView] = useState<PageView | null>(null)
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

  // Set when the page changes, until the new page's heading has taken focus
  const pending = useRef(false)
  const update = () => {
    const heading = main.current?.querySelector('h1')
    document.title = heading?.textContent ? `${heading.textContent} · iight` : 'iight'
    if (pending.current && heading) {
      pending.current = false
      focusHeading()
    }
  }

  // Pages that load before showing their heading take focus when it arrives
  useEffect(() => {
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
      pending.current = true
    }
    update()
  }, [path])

  const groups = [
    ...(ai ? [[{ section: 'chat', label: 'Chat', icon: <MessagesSquare /> }]] : []),
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
      { section: 'keys', label: 'API keys', icon: <KeyRound /> },
    ],
  ]

  return (
    <LucideProvider size={16}>
      <div className='admin'>
        <button type='button' className='iight-button cms-skip' onClick={focusHeading}>
          Skip to content
        </button>

        <div className='cms-bar'>
          <strong>iight</strong>
          <button
            ref={menuButton}
            type='button'
            className='iight-button'
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
            <p>Signed in as {user.name}</p>
            {mcp && (
              <a
                className='cms-icon-button'
                href='#/tokens'
                aria-label='MCP tokens'
                title='MCP tokens'
                aria-current={section === 'tokens' ? 'page' : undefined}
              >
                <Plug />
              </a>
            )}
            <button
              type='button'
              className='cms-icon-button cms-nav__theme'
              aria-label='Theme'
              title='Theme'
              popoverTarget='cms-theme'
            >
              <SunMoon />
            </button>
            {/* After its button, so Tab goes into it */}
            <div id='cms-theme' className='cms-popover' popover='auto'>
              <ThemeSwitch />
            </div>
            <IconButton label='Sign out' onClick={onSignOut}>
              <LogOut />
            </IconButton>
          </div>
        </nav>

        <AssistantContext.Provider value={assistant}>
          <main id='main' ref={main} tabIndex={-1}>
            <SectionContext.Provider value={showSection}>
              <PageViewContext.Provider value={setView}>
                <PanelSlot.Provider value={panelSlot}>
                  <Toaster>
                    <Confirmer>{children}</Confirmer>
                  </Toaster>
                </PanelSlot.Provider>
              </PageViewContext.Provider>
            </SectionContext.Provider>
          </main>
          {/* The panel on every page: the page's own at the top, then the assistant, which the shell keeps across
              pages so a chat lasts, other than on the Chat page, which is the assistant (PLAN.md section 21) */}
          <div className='cms-side'>
            <div ref={setPanelSlot} className='cms-panel-slot' />
            {ai && section !== 'chat' && (
              <aside className='cms-side__assistant' aria-label='Assistant'>
                <Suspense>
                  <PanelAssistant view={view} />
                </Suspense>
              </aside>
            )}
          </div>
        </AssistantContext.Provider>
      </div>
    </LucideProvider>
  )
}
