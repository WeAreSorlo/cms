import { markdown } from '../src/validation'
import { inputs, schemaToTypeScript, validateServerValues } from '@sorlo/forms'
import { describe, expect, it } from 'vitest'

const body = { name: 'body', type: 'markdown' }

describe('the Markdown field without its component', () => {
  it("checks values as Sorlo Forms' textarea does", () => {
    expect(markdown.validateValue('# Hello', body)).toEqual({ isValid: true, messages: [], value: '# Hello' })
    expect(markdown.validateValue('', { ...body, required: true }).messages).toEqual(['This field is required.'])
    expect(markdown.validateValue(42, body).messages).toEqual(['Invalid value.'])
    expect(markdown.validateValue('ab', { ...body, options: { minLength: 3 } }).isValid).toBe(false)
    expect(markdown.validateValue('abcd', { ...body, options: { maxLength: 3 } }).isValid).toBe(false)
  })

  it('takes the textarea’s settings', () => {
    const names = markdown.optionFields([]).map((field) => field.name)
    expect(names).toEqual(['placeholder', 'rows', 'minLength', 'maxLength'])
  })

  it('checks values on a server, with no component', async () => {
    const all = { ...inputs, markdown: { ...markdown, default: () => null } }
    expect('default' in markdown).toBe(false)
    const report = await validateServerValues([{ ...body, required: true }], { body: '' }, all)
    expect(report.isValid).toBe(false)
  })

  it('types its value as a string', () => {
    const all = { ...inputs, markdown: { ...markdown, default: () => null } }
    expect(schemaToTypeScript([{ ...body, required: true }], all, { name: 'post' })).toContain('body: string')
  })
})
