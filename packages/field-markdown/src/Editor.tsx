import {
  type Edit,
  type Selection,
  applied,
  bulletList,
  code,
  heading,
  link,
  numberedList,
  quote,
  wrap,
} from './format'
import i18n from './i18n'
import { validateValue } from './logic'
import { useFieldContext } from '@sorlo/forms'
import { Bold, Code, Eye, Heading2, Italic, Link, List, ListOrdered, Quote } from 'lucide-react'
import { type KeyboardEvent, Suspense, lazy, useLayoutEffect, useRef, useState } from 'react'

// The Markdown parser is most of the field's size, so it loads with the first preview rather than with every form
const Preview = lazy(() => import('./Preview').then((module) => ({ default: module.Preview })))

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)

// Shortcuts take Cmd on a Mac, where Ctrl+B and Ctrl+I already move the caret, and Ctrl elsewhere
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// The format buttons in order, with the letter that does the same in the textarea
const buttons: Array<{ key: string; icon: typeof Bold; edit: (selection: Selection) => Edit; letter?: string }> = [
  { key: 'heading', icon: Heading2, edit: heading },
  { key: 'bold', icon: Bold, edit: wrap('**'), letter: 'b' },
  { key: 'italic', icon: Italic, edit: wrap('_'), letter: 'i' },
  { key: 'link', icon: Link, edit: link, letter: 'k' },
  { key: 'bulletList', icon: List, edit: bulletList },
  { key: 'numberedList', icon: ListOrdered, edit: numberedList },
  { key: 'quote', icon: Quote, edit: quote },
  { key: 'code', icon: Code, edit: code },
]

// A textarea for Markdown, with format buttons and a preview. The buttons are one toolbar, a single stop for Tab that
// the arrow keys, Home and End move through.
export default function Editor() {
  const { id, aria, schema, required, readonly, disabled, options, value, handleValidation } = useFieldContext()
  const text = typeof value === 'string' ? value : ''
  const area = useRef<HTMLTextAreaElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const selected = useRef<[number, number]>(undefined)
  const [previewing, setPreviewing] = useState(false)
  const [active, setActive] = useState(0)
  const locked = readonly || disabled
  const change = (next: string) => handleValidation(validateValue(next, schema))

  // The selection an edit made, put back once React has rendered its text, which moves the caret to the end
  useLayoutEffect(() => {
    if (!selected.current || !area.current) return
    area.current.setSelectionRange(...selected.current)
    selected.current = undefined
  })

  const apply = (edit: (selection: Selection) => Edit) => {
    const box = area.current
    if (!box || locked || previewing) return
    const result = edit({ text: box.value, start: box.selectionStart, end: box.selectionEnd })
    box.focus()
    box.setSelectionRange(result.from, result.to)
    // Through the browser, so Undo takes the edit back. Where that isn't supported, as in jsdom, the value is set.
    const done = document.execCommand?.(result.insert ? 'insertText' : 'delete', false, result.insert)
    if (!done) change(applied(box.value, result))
    box.setSelectionRange(...result.select)
    selected.current = result.select
  }

  const shortcut = (event: KeyboardEvent) => {
    if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return
    const button = buttons.find((each) => each.letter === event.key.toLowerCase())
    if (!button) return
    event.preventDefault()
    apply(button.edit)
  }

  const move = (event: KeyboardEvent) => {
    const steps: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: -1 }
    if (!(event.key in steps)) return
    event.preventDefault()
    const index = (steps[event.key] + buttons.length) % buttons.length
    setActive(index)
    toolbar.current?.querySelectorAll('button')[index]?.focus()
  }

  return (
    <div className='sorlo-input__markdown'>
      <div className='sorlo-markdown__bar'>
        {!locked && (
          <div
            ref={toolbar}
            role='toolbar'
            aria-label={t('toolbar')}
            aria-controls={id}
            className='sorlo-markdown__toolbar'
            onKeyDown={move}
          >
            {buttons.map(({ key, icon: Icon, edit, letter }, index) => (
              <button
                key={key}
                type='button'
                className='sorlo-markdown__button'
                tabIndex={index === active ? 0 : -1}
                aria-label={t(key)}
                aria-keyshortcuts={letter && `${mac ? 'Meta' : 'Control'}+${letter.toUpperCase()}`}
                title={letter ? t('withShortcut', { label: t(key), shortcut: keys(letter) }) : t(key)}
                disabled={previewing}
                onFocus={() => setActive(index)}
                onClick={() => apply(edit)}
              >
                <Icon aria-hidden />
              </button>
            ))}
          </div>
        )}
        <button
          type='button'
          className='sorlo-markdown__button sorlo-markdown__toggle'
          aria-pressed={previewing}
          aria-controls={`${id}-preview`}
          onClick={() => setPreviewing(!previewing)}
        >
          <Eye aria-hidden />
          {t('preview')}
        </button>
      </div>
      <textarea
        ref={area}
        className='sorlo-input'
        id={id}
        {...aria}
        hidden={previewing}
        value={text}
        onChange={(event) => change(event.target.value)}
        onKeyDown={shortcut}
        required={required}
        readOnly={readonly}
        disabled={disabled}
        minLength={options?.minLength}
        maxLength={options?.maxLength}
        placeholder={options?.placeholder}
        rows={options?.rows ?? 8}
      />
      <div id={`${id}-preview`} className='sorlo-markdown__preview' hidden={!previewing}>
        {previewing && (
          <Suspense>
            <Preview text={text} />
          </Suspense>
        )}
      </div>
    </div>
  )
}

// A shortcut as the platform writes it, such as ⌘B or Ctrl+B
const keys = (letter: string) => (mac ? `⌘${letter.toUpperCase()}` : `Ctrl+${letter.toUpperCase()}`)
