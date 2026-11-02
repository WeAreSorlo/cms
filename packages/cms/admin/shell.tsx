import { ContentType, SectionContext, pathOf, sectionOf } from './api'
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
  SunMoon,
  Workflow,
  X,
} from 'lucide-react'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

// The page around every admin page: the nav with the user's row, a skip link, and the column for the page's panel.
// After each change of page it titles the document after the page's heading and moves focus there, so screen readers
// announce the new page. A list's search and filters change only the query after the page's path, which keeps the page.
export function Shell({
  hash,
  types,
  user,
  onSignOut,
  children,
}: {
  hash: string
  types: Map<string, ContentType>
  user: { name: string }
  onSignOut: () => void
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null)
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

        <main id='main' ref={main} tabIndex={-1}>
          <SectionContext.Provider value={showSection}>
            <PanelSlot.Provider value={panelSlot}>
              <Toaster>
                <Confirmer>{children}</Confirmer>
              </Toaster>
            </PanelSlot.Provider>
          </SectionContext.Provider>
        </main>
        {/* The panel on every page: the page's own at the top, then the assistant's region, which the shell keeps
            across pages so a chat lasts, and which is empty until the assistant comes (PLAN.md section 21) */}
        <div className='cms-side'>
          <div ref={setPanelSlot} className='cms-panel-slot' />
          <div className='cms-side__assistant' />
        </div>
      </div>
    </LucideProvider>
  )
}
