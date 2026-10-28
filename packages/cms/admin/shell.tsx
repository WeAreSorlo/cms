import { ContentType, SectionContext, sectionOf } from './api'
import { Confirmer, ThemeSwitch, Toaster, TypeIcon } from './ui'
import { Blocks, ClipboardList, Images, LogOut, LucideProvider, Menu, Workflow, X } from 'lucide-react'
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

// The page around every admin page: the nav, the user's menu, and a skip link. After each change of page it titles the
// document after the page's heading and moves focus there, so screen readers announce the new page.
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
  const main = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  // A page's own word on its nav item, which lasts until the hash changes
  const [shown, setShown] = useState<{ hash: string; section: string }>()
  const showSection = useCallback((section: string) => setShown({ hash: location.hash, section }), [])
  const section = shown?.hash === hash ? shown.section : sectionOf(hash)

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
  const shownHash = useRef(hash)
  useEffect(() => {
    if (hash !== shownHash.current) {
      shownHash.current = hash
      setMenuOpen(false)
      pending.current = true
    }
    update()
  }, [hash])

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
    [{ section: 'schema', label: 'Content types', icon: <Blocks /> }],
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
            if (!menuOpen || event.key !== 'Escape') return
            setMenuOpen(false)
            menuButton.current?.focus()
          }}
        >
          <strong className='cms-nav__mark'>iight</strong>
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
          <div className='cms-nav__user'>
            <p>Signed in as {user.name}.</p>
            <ThemeSwitch />
            <button type='button' className='iight-button' onClick={onSignOut}>
              <LogOut /> Sign out
            </button>
          </div>
        </nav>

        <main id='main' ref={main} tabIndex={-1}>
          <SectionContext.Provider value={showSection}>
            <Toaster>
              <Confirmer>{children}</Confirmer>
            </Toaster>
          </SectionContext.Provider>
        </main>
      </div>
    </LucideProvider>
  )
}
