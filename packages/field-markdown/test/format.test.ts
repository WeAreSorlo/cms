import { type Edit, applied, bulletList, code, heading, link, numberedList, quote, wrap } from '../src/format'
import { describe, expect, it } from 'vitest'

// Runs an edit on text with its selection marked by [ and ], and gives the result marked the same way
function run(edit: (selection: { text: string; start: number; end: number }) => Edit, marked: string) {
  const start = marked.indexOf('[')
  const end = marked.indexOf(']') - 1
  const text = marked.replace('[', '').replace(']', '')
  const result = edit({ text, start, end })
  const after = applied(text, result)
  const [from, to] = result.select
  return after.slice(0, from) + '[' + after.slice(from, to) + ']' + after.slice(to)
}

describe('format buttons', () => {
  it('wraps and unwraps the selection', () => {
    expect(run(wrap('**'), 'a [word] b')).toBe('a **[word]** b')
    expect(run(wrap('**'), 'a **[word]** b')).toBe('a [word] b')
    expect(run(wrap('**'), 'a [**word**] b')).toBe('a [word] b')
    expect(run(wrap('_'), 'a []b')).toBe('a _[]_b')
    expect(run(wrap('_'), '**[word]**')).toBe('**_[word]_**')
  })

  it('prefixes every line the selection touches, and takes the prefix off when they all have it', () => {
    expect(run(bulletList, 'o[ne\ntw]o')).toBe('[- one\n- two]')
    expect(run(bulletList, '[- one\n- two]')).toBe('[one\ntwo]')
    expect(run(quote, 'a\n[b\n\nc]')).toBe('a\n[> b\n\n> c]')
    expect(run(quote, '[> b\n\n>c]')).toBe('[b\n\nc]')
  })

  it('puts the caret at the end of the line when nothing was selected', () => {
    expect(run(heading, 'Ti[]tle')).toBe('## Title[]')
    expect(run(heading, '## Ti[]tle')).toBe('Title[]')
  })

  it('switches a heading level or a kind of list rather than nesting', () => {
    expect(run(heading, '### [Title]')).toBe('[## Title]')
    expect(run(numberedList, '[- one\n- two]')).toBe('[1. one\n2. two]')
    expect(run(bulletList, '[1. one\n2. two]')).toBe('[- one\n- two]')
  })

  it('makes inline code in a line and a fenced block over lines', () => {
    expect(run(code, 'a [b] c')).toBe('a `[b]` c')
    expect(run(code, 'x\n[one\ntwo]')).toBe('x\n[```\none\ntwo\n```]')
    expect(run(code, '[```\none\n```]')).toBe('[one]')
  })

  it('makes a link with url selected, or the caret in the brackets', () => {
    expect(run(link, 'see [docs]')).toBe('see [docs]([url])')
    expect(run(link, 'see []')).toBe('see [[]](url)')
  })
})
