// The format buttons' changes to a textarea's text, as pure functions of its text and selection, so they can be tested
// without a browser. Each one gives the part of the text it replaces, what replaces it, and the selection after.

export interface Selection {
  text: string
  start: number
  end: number
}

export interface Edit {
  // The replaced part of the text, from and to, as offsets in the text before the edit
  from: number
  to: number
  insert: string
  // The selection after the edit, as offsets in the text after it
  select: [number, number]
}

// Wraps the selection in a marker, such as ** for bold, or takes it off when the selection already has it, outside or
// just inside
export function wrap(marker: string) {
  return ({ text, start, end }: Selection): Edit => {
    const size = marker.length
    const selected = text.slice(start, end)
    if (text.slice(start - size, start) === marker && text.slice(end, end + size) === marker) {
      return { from: start - size, to: end + size, insert: selected, select: [start - size, end - size] }
    }
    if (selected.length >= size * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
      return { from: start, to: end, insert: selected.slice(size, -size), select: [start, end - size * 2] }
    }
    return { from: start, to: end, insert: marker + selected + marker, select: [start + size, end + size] }
  }
}

// The start of the line an offset is on, and the end of the line another is on
const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1
const lineEnd = (text: string, offset: number) => {
  const next = text.indexOf('\n', offset)
  return next === -1 ? text.length : next
}

// Gives each line the selection touches a prefix, such as > for a quote, or takes it off when every line already has
// it. Blank lines between them are left alone. In place of a fixed prefix, numbered lists number their lines.
function prefixLines(prefix: (index: number) => string, has: RegExp, replaces?: RegExp) {
  return ({ text, start, end }: Selection): Edit => {
    const from = lineStart(text, start)
    const to = lineEnd(text, end)
    const lines = text.slice(from, to).split('\n')
    const filled = lines.filter((line) => line.trim() !== '')
    const off = filled.length > 0 && filled.every((line) => has.test(line))
    let count = 0
    const changed = lines.map((line) => {
      if (lines.length > 1 && line.trim() === '') return line
      if (off) return line.replace(has, '')
      return prefix(count++) + (replaces ? line.replace(replaces, '') : line)
    })
    const insert = changed.join('\n')
    // With nothing selected, typing carries on at the end of the line
    const after = from + insert.length
    return { from, to, insert, select: start === end ? [after, after] : [from, after] }
  }
}

// Lists switch from one kind to the other, rather than nesting a marker in a marker
const listMarker = /^([-*+]|\d+[.)]) /

export const heading = prefixLines(() => '## ', /^## /, /^#{1,6} /)
export const bulletList = prefixLines(() => '- ', /^[-*+] /, listMarker)
export const numberedList = prefixLines((index) => `${index + 1}. `, /^\d+[.)] /, listMarker)
export const quote = prefixLines(() => '> ', /^> ?/)

// Code in a line is wrapped in backticks, and code over several lines in a fenced block of whole lines
export function code(selection: Selection): Edit {
  const { text, start, end } = selection
  if (!text.slice(start, end).includes('\n')) return wrap('`')(selection)
  const from = lineStart(text, start)
  const to = lineEnd(text, end)
  const block = text.slice(from, to)
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(block)
  const insert = fenced ? fenced[1] : '```\n' + block + '\n```'
  return { from, to, insert, select: [from, from + insert.length] }
}

// A link around the selection, with url selected to type over. With nothing selected, the text goes between the
// brackets.
export function link({ text, start, end }: Selection): Edit {
  const selected = text.slice(start, end)
  const insert = `[${selected}](url)`
  const at = selected ? start + selected.length + 3 : start + 1
  return { from: start, to: end, insert, select: selected ? [at, at + 3] : [at, at] }
}

// An edit's text, made without the browser, as the editor falls back to where insertText isn't supported
export const applied = (text: string, edit: Edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
