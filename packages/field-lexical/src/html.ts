import { type Node, type Tree, safeUrl } from './tree'

// A rich text tree as HTML, written on the server with no Lexical or DOM: plain elements with no classes or styles,
// every text and attribute escaped. Links to entries and files take what found has of them, and one that's gone, or
// that isn't live, leaves its text unlinked or its file out.

export interface LinkedFile {
  id: string
  name: string
  mime: string
  url: string
  width?: number | null
  height?: number | null
  alt?: string | null
  caption?: string | null
}

// An entry as the delivery API returns it
export interface LinkedEntry {
  id: string
  type: string
  slug: string | null
  uri: string | null
  values: Record<string, unknown>
  [key: string]: unknown
}

export interface Found {
  entries: Map<string, LinkedEntry>
  media: Map<string, LinkedFile>
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

// Attributes, leaving out those with no value. Empty text stays, as an image's empty alt says it's decorative.
const attributes = (values: Record<string, unknown>) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => ` ${name}="${escape(String(value))}"`)
    .join('')

// Lexical's text formats, its bits in order, innermost first
const formats: Array<[number, string]> = [
  [16, 'code'],
  [1, 'strong'],
  [2, 'em'],
  [8, 'u'],
  [4, 's'],
  [32, 'sub'],
  [64, 'sup'],
  [128, 'mark'],
]

export function toHtml(tree: Tree, found: Found, href: (entry: LinkedEntry) => string | null | undefined) {
  const inside = (node: Node): string => (node.children ?? []).map(write).join('')

  function write(node: Node): string {
    switch (node.type) {
      case 'text':
      case 'code-highlight': {
        const format = typeof node.format === 'number' ? node.format : 0
        return formats.reduce(
          (html, [bit, tag]) => (format & bit ? `<${tag}>${html}</${tag}>` : html),
          escape(node.text as string),
        )
      }
      case 'linebreak':
        return '<br>'
      case 'tab':
        return '\t'
      // An empty paragraph is left out, as the one the editor keeps after a file or block at the end
      case 'paragraph':
        return node.children?.length ? `<p>${inside(node)}</p>` : ''
      case 'heading':
        return `<${node.tag}>${inside(node)}</${node.tag}>`
      case 'quote':
        return `<blockquote>${inside(node)}</blockquote>`
      case 'list': {
        const tag = node.listType === 'number' ? 'ol' : 'ul'
        const start = tag === 'ol' && typeof node.start === 'number' && node.start !== 1 ? node.start : undefined
        return `<${tag}${attributes({ start })}>${inside(node)}</${tag}>`
      }
      case 'listitem':
        return `<li>${inside(node)}</li>`
      case 'code': {
        const language = typeof node.language === 'string' ? node.language.replace(/[^\w-]/g, '') : ''
        const text = (node.children ?? []).map((child) => (child.type === 'linebreak' ? '\n' : write(child))).join('')
        return `<pre><code${attributes({ class: language ? `language-${language}` : undefined })}>${text}</code></pre>`
      }
      case 'link': {
        if (!safeUrl(node.url)) return inside(node)
        const opens = node.target === '_blank'
        const rel = typeof node.rel === 'string' && node.rel ? node.rel : opens ? 'noopener noreferrer' : undefined
        return `<a${attributes({ href: node.url, rel, target: opens ? '_blank' : undefined, title: node.title || undefined })}>${inside(node)}</a>`
      }
      case 'entrylink': {
        const entry = found.entries.get(node.entry as string)
        const address = entry && href(entry)
        if (!entry || !address || !safeUrl(address)) return inside(node)
        return `<a${attributes({ href: address, 'data-entry': entry.id })}>${inside(node)}</a>`
      }
      case 'media': {
        const file = found.media.get(node.media as string)
        if (!file) return ''
        return media(file)
      }
      default:
        return inside(node)
    }
  }

  return inside(tree.root)
}

// A file as the element that shows it: an image, with its caption in a figure, a player for video and audio, and a
// link for others
function media(file: LinkedFile) {
  const kind = file.mime.split('/')[0]
  const element =
    kind === 'image'
      ? `<img${attributes({ src: file.url, alt: file.alt ?? '', width: file.width, height: file.height })}>`
      : kind === 'video' || kind === 'audio'
        ? `<${kind}${attributes({ src: file.url, controls: 'controls', width: file.width, height: file.height })}></${kind}>`
        : `<p><a${attributes({ href: file.url })}>${escape(file.name)}</a></p>`
  if (!file.caption || (kind !== 'image' && kind !== 'video')) return element
  return `<figure>${element}<figcaption>${escape(file.caption)}</figcaption></figure>`
}
