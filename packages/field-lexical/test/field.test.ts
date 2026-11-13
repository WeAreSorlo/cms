import { lexical, mapText } from '../src/validation'
import { block, layouts, paragraph, text, tree } from './fixtures'
import {
  flattenValidationReport,
  inputs,
  pickValues,
  schemaToTypeScript,
  validateInputSchemaFields,
  validateServerValues,
} from '@sorlo/forms'
import { describe, expect, it } from 'vitest'

const body = { name: 'body', type: 'lexical' }
const modular = { name: 'body', type: 'lexical', options: { output: 'json', layouts } }
const all = { ...inputs, lexical: { ...lexical, default: () => null } }

describe('the rich text field without its component, delivered as HTML', () => {
  it('takes trees of the nodes it knows, each where it can be', () => {
    const valid = tree(
      { type: 'heading', tag: 'h2', version: 1, children: [text('Hello')] },
      paragraph(text('See '), { type: 'link', url: 'https://example.com', children: [text('this')] }),
      paragraph({ type: 'entrylink', entry: '0192', children: [text('a post')] }, { type: 'linebreak' }),
      { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [text('One')] }] },
      { type: 'media', media: '0193' },
      { type: 'code', children: [text('let a = 1'), { type: 'linebreak' }] },
    )
    expect(lexical.validateValue(valid, body)).toEqual({ isValid: true, messages: [], value: valid })

    for (const invalid of [
      'Hello',
      { root: { type: 'paragraph', children: [] } },
      tree({ type: 'script', children: [] }),
      tree(text('loose text at the top')),
      tree(paragraph({ type: 'media', media: '0193' })),
      tree(paragraph({ type: 'link', url: 'javascript:alert(1)', children: [text('x')] })),
      tree({ type: 'heading', tag: 'h7', children: [] }),
      tree(paragraph({ type: 'entrylink', entry: '', children: [] })),
      tree(block({ _layout: 'callout', title: 'No blocks in rich text' })),
    ]) {
      expect(lexical.validateValue(invalid, body).messages).toEqual(['Invalid value.'])
    }
  })

  it('counts a tree with no text, files or blocks as empty', () => {
    const emptied = tree(paragraph())
    expect(lexical.validateValue(null, { ...body, required: true }).messages).toEqual(['This field is required.'])
    expect(lexical.validateValue(emptied, { ...body, required: true }).messages).toEqual(['This field is required.'])
    expect(lexical.validateValue(emptied, body).isValid).toBe(true)
    expect(lexical.validateValue(tree({ type: 'media', media: '0193' }), { ...body, required: true }).isValid).toBe(
      true,
    )
  })

  it('refuses a tree too deep for its walk', () => {
    let list: object = { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [text('x')] }] }
    for (let level = 0; level < 40; level++) {
      list = { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [list] }] }
    }
    expect(lexical.validateValue(tree(list), body).isValid).toBe(false)
  })

  it('formats its value as its text, a line for each paragraph', () => {
    const value = tree(paragraph(text('One '), text('two', 1)), {
      type: 'list',
      listType: 'number',
      children: [{ type: 'listitem', children: [text('Three')] }],
    })
    expect(lexical.formatValue(value)).toBe('One two\nThree')
    expect(lexical.formatValue('nope')).toBeNull()
  })

  it('types its value as the tree, or null when it can be emptied', () => {
    const types = schemaToTypeScript(
      [
        { ...body, required: true },
        { ...body, name: 'aside' },
      ],
      all,
      { name: 'post' },
    )
    expect(types).toContain("body: { root: { type: 'root'; children: Array<{ type: 'paragraph' | 'heading'")
    expect(types).toMatch(/aside\?: \{ root: .* \} \| null/)
  })

  it('replaces the text of every text node, and nothing else', () => {
    const value = tree(paragraph(text('Acme rocks'), { type: 'link', url: '/acme', children: [text('Acme')] }))
    expect(mapText(value, (each) => each.replaceAll('Acme', 'Sorlo'))).toEqual(
      tree(paragraph(text('Sorlo rocks'), { type: 'link', url: '/acme', children: [text('Sorlo')] })),
    )
    expect(mapText('Acme', () => 'x')).toBe('Acme')
  })
})

describe('the rich text field without its component, delivered as JSON', () => {
  it('takes blocks of its layouts at the top', () => {
    const value = tree(paragraph(text('Hi')), block({ _layout: 'callout', title: 'Note' }))
    expect(lexical.validateValue(value, modular).isValid).toBe(true)
    expect(lexical.validateValue(tree(block({ _layout: 'gone' })), modular).isValid).toBe(false)
    expect(lexical.validateValue(tree(paragraph(block({ _layout: 'callout' }))), modular).isValid).toBe(false)
  })

  it('takes Delivered as, HTML if not given, and for JSON only, the flexible field’s Layouts, which it needs none of', async () => {
    const [output, layouts] = lexical.optionFields([])
    expect(output).toMatchObject({ name: 'output', type: 'radio', defaultValue: 'html' })
    expect(layouts).toMatchObject({
      name: 'layouts',
      conditions: [{ field: 'output', operator: 'equals', value: 'json' }],
    })
    expect(layouts.required).toBeUndefined()
    expect(layouts.options?.minimum).toBeUndefined()
    expect(lexical.prepareSchema(modular).options?.layouts[0].id).toMatch(/^lay_/)

    // As the schema builder's field editor checks a field's settings
    const settings = validateInputSchemaFields(all.lexical)
    const bare = { name: 'body', label: 'Body', type: 'lexical', options: { output: 'json' } }
    expect((await validateServerValues(settings, bare, inputs)).isValid).toBe(true)
    expect((await validateServerValues(settings, { ...body, label: 'Body' }, inputs)).isValid).toBe(true)
    expect(lexical.validateValue(tree(paragraph(text('Hi'))), bare).isValid).toBe(true)
    expect(lexical.validateValue(tree(block({ _layout: 'callout' })), bare).isValid).toBe(false)
  })

  it('takes no blocks once delivered as HTML, whatever layouts it lists, so a save leaves them out', () => {
    const html = { ...modular, options: { layouts } }
    const value = tree(paragraph(text('Kept')), block({ _layout: 'callout', title: 'Hi' }))
    expect(lexical.validateValue(value, html).isValid).toBe(false)
    expect(pickValues([html], { body: value }, all).body).toEqual(tree(paragraph(text('Kept'))))
    expect(schemaToTypeScript([html], all, { name: 'post' })).not.toContain("type: 'block'")
  })

  it('checks each block’s fields on a server, reported by its place among the blocks', async () => {
    const value = tree(
      block({ _layout: 'callout', title: 'Fine' }),
      paragraph(text('Between')),
      block({ _layout: 'callout', title: '' }),
    )
    const report = await validateServerValues([modular], { body: value }, all)
    expect(report.isValid).toBe(false)
    expect(flattenValidationReport(report).messages['body.1.title']).toEqual(['This field is required.'])
  })

  it('picks each block’s values by its layout, leaving out blocks whose layout has gone', () => {
    const value = tree(block({ _layout: 'callout', title: 'Hi', stray: 1 }), block({ _layout: 'gone', title: 'x' }))
    expect(pickValues([modular], { body: value }, all).body).toEqual(
      tree(block({ title: 'Hi', tone: 'info', _layout: 'callout' })),
    )
  })

  it('types its blocks by their layouts, keyed on _layout', () => {
    const types = schemaToTypeScript([{ ...modular, required: true }], all, { name: 'page' })
    expect(types).toContain(`{ type: 'block'; version: number; block: ({ _layout: "callout" } & {`)
    expect(types).toContain('title: string')
  })
})
