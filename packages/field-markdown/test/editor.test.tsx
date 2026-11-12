// @vitest-environment jsdom
import { Preview } from '../src/Preview'
import { markdown } from '../src/index'
import Form from '@sorlo/forms'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

// A form with a Markdown field holding some text, and the values it last reported
function renderField(text = '', settings: Record<string, unknown> = {}) {
  const seen: { values: Record<string, any> } = { values: {} }
  render(
    <Form
      schema={[{ type: 'markdown', name: 'body', label: 'Body', ...settings }]}
      inputs={{ markdown }}
      values={{ body: text }}
      onValuesChange={(values) => (seen.values = values)}
    />,
  )
  return { box: screen.getByLabelText('Body') as HTMLTextAreaElement, seen }
}

describe('the Markdown editor', () => {
  it('formats the selection with a button and with its shortcut', () => {
    const { box, seen } = renderField('a word here')
    box.setSelectionRange(2, 6)
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(seen.values.body).toBe('a **word** here')
    expect([box.selectionStart, box.selectionEnd]).toEqual([4, 8])

    fireEvent.keyDown(box, { key: 'i', ctrlKey: true })
    expect(seen.values.body).toBe('a **_word_** here')
  })

  it('names each button and moves through the toolbar with the arrow keys, as one stop for Tab', () => {
    renderField()
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    const names = [...toolbar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Heading', 'Bold', 'Italic', 'Link', 'Bulleted list', 'Numbered list', 'Quote', 'Code'])
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-keyshortcuts')).toBe('Control+B')

    const heading = screen.getByRole('button', { name: 'Heading' })
    expect([...toolbar.querySelectorAll('button')].filter((button) => button.tabIndex === 0)).toEqual([heading])
    heading.focus()
    fireEvent.keyDown(heading, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Bold' }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Code' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(heading)
  })

  it('shows a preview with its state announced, and hides the text and buttons meanwhile', async () => {
    const { box } = renderField('## Hello\n\nSome **bold** text')
    const toggle = screen.getByRole('button', { name: 'Preview' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(box.hidden).toBe(true)
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Bold' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(toggle)
    expect(box.hidden).toBe(false)
    expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull()
  })

  it('has no format buttons when it is read-only, but still previews', () => {
    renderField('Text', { readonly: true })
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy()
  })
})

describe('the preview', () => {
  it("shows HTML as text, so it never runs, and drops unsafe links' addresses", () => {
    const { container } = render(
      <Preview
        text={[
          '<script>window.ran = true</script>',
          '<img src="x" onerror="window.ran = true">',
          '[click](javascript:window.ran=true) and ![x](javascript:alert(1))',
          '<a href="https://example.com" onclick="window.ran = true">raw</a>',
        ].join('\n\n')}
      />,
    )
    expect(container.querySelector('script, [onerror], [onclick]')).toBeNull()
    expect(container.textContent).toContain('<script>window.ran = true</script>')
    for (const element of container.querySelectorAll('[href], [src]')) {
      expect(element.getAttribute('href') ?? element.getAttribute('src')).not.toMatch(/javascript/i)
    }
    expect((globalThis as any).ran).toBeUndefined()
  })

  it('opens links in a new tab, so following one keeps what is being written', () => {
    render(<Preview text='[Docs](https://example.com/docs)' />)
    const docs = screen.getByRole('link', { name: 'Docs' })
    expect(docs.getAttribute('href')).toBe('https://example.com/docs')
    expect(docs.getAttribute('target')).toBe('_blank')
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('says when there is nothing to preview', () => {
    render(<Preview text='  ' />)
    expect(screen.getByText('Nothing to preview.')).toBeTruthy()
  })
})
