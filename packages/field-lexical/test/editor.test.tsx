// @vitest-environment jsdom
import { PickersContext, lexical } from '../src/index'
import { layouts, paragraph, text, tree } from './fixtures'
import Form from '@sorlo/forms'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const file = { id: '0193', name: 'cat.jpg', mime: 'image/jpeg', url: '/cat.jpg', alt: 'A cat' }

// A form with a rich text field delivered as HTML, or as JSON with blocks, and the values it last reported
async function renderField(value: unknown, modular = false, pickers = {}) {
  const seen: { values: Record<string, any> } = { values: {} }
  render(
    <PickersContext.Provider value={pickers}>
      <Form
        schema={[
          { type: 'lexical', name: 'body', label: 'Body', options: { output: modular ? 'json' : 'html', layouts } },
        ]}
        inputs={{ lexical }}
        values={{ body: value }}
        onValuesChange={(values) => (seen.values = values)}
      />
    </PickersContext.Provider>,
  )
  // The editor loads in a chunk of its own
  await screen.findByRole('toolbar', { name: 'Formatting' })
  return seen
}

const names = () =>
  [...screen.getByRole('toolbar', { name: 'Formatting' }).querySelectorAll('button')].map((button) =>
    button.getAttribute('aria-label'),
  )

describe('the rich text editor', () => {
  it('shows the stored text, named by its label, with one toolbar that takes one stop for Tab', async () => {
    await renderField(tree(paragraph(text('Hello there'))))
    const box = screen.getByRole('textbox', { name: 'Body' })
    expect(box.textContent).toBe('Hello there')
    expect(names()).toEqual([
      'Heading',
      'Subheading',
      'Bold',
      'Italic',
      'Strikethrough',
      'Code',
      'Link',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Code block',
      'Undo',
      'Redo',
    ])
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect([...toolbar.querySelectorAll('button')].filter((button) => button.tabIndex === 0)).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Heading' }), { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Redo' }))
  })

  it('offers the host’s pickers, and inserts the file chosen', async () => {
    const seen = await renderField(tree(paragraph(text('Hi'))), false, {
      media: async () => file,
      entry: async () => ({ id: '0192', title: 'A post' }),
    })
    expect(names()).toContain('Link to an entry')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Insert a file' })))
    expect(seen.values.body.root.children.map((node: any) => node.type)).toContain('media')
    expect(screen.getByRole('img', { name: 'A cat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeTruthy()
  })

  it('refuses an unsafe link address, saying why', async () => {
    await renderField(tree(paragraph(text('Hi'))))
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    const address = screen.getByLabelText('Link address')
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    fireEvent.keyDown(address, { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('https://')
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(screen.queryByLabelText('Link address')).toBeNull()
  })
})

describe('the rich text editor delivered as JSON', () => {
  it('adds a block of a layout, edited with its fields, and keeps their values in the tree', async () => {
    const seen = await renderField(null, true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add Callout' })))
    const blockOf = () => seen.values.body.root.children.find((node: any) => node.type === 'block')
    expect(blockOf()).toMatchObject({ block: { _layout: 'callout', tone: 'info' } })

    const title = screen.getByRole('textbox', { name: 'Title' })
    await act(async () => fireEvent.change(title, { target: { value: 'Note' } }))
    expect(blockOf().block).toEqual({ _layout: 'callout', title: 'Note', tone: 'info' })
  })

  it('removes a block with its button, keeping the text around it', async () => {
    const seen = await renderField(tree(paragraph(text('Hi'))), true)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add Callout' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove Callout' })))
    expect(screen.getByRole('textbox', { name: 'Body' }).textContent).toBe('Hi')
    expect(seen.values.body.root.children.map((node: any) => node.type)).not.toContain('block')
  })
})
