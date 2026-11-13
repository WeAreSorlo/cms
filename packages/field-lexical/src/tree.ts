import type { FieldSchema } from '@sorlo/forms'

// The stored value: Lexical's serialized editor state, as the editor writes it. Its nodes are Lexical's own, and
// Sorlo's three, which hold IDs: entrylink, a link to an entry, media, a file from the media library, and block, a
// modular field's block, whose block is a flexible field's block, keyed on _layout.

export type Node = { type: string; children?: Array<Node>; [key: string]: unknown }
export type Tree = { root: Node & { type: 'root'; children: Array<Node> } }
export type Block = Record<string, unknown> & { _layout: string }
export type Layout = { id?: string; name: string; label?: string; fields?: Array<FieldSchema> }
export type Layouts = { has: (name: string) => boolean }

// What each node can hold. Inline nodes sit in paragraphs, headings, quotes, list items and links, and full-width ones
// at the top: media, and in a modular field, blocks.
const inline = ['text', 'linebreak', 'tab', 'link', 'entrylink']
const text = ['text', 'linebreak', 'tab']
const top = ['paragraph', 'heading', 'quote', 'list', 'code', 'media', 'block']
const holds: Record<string, Array<string>> = {
  tree: ['root'],
  root: top,
  paragraph: inline,
  heading: inline,
  quote: inline,
  list: ['listitem'],
  listitem: [...inline, 'list'],
  code: [...text, 'code-highlight'],
  link: text,
  entrylink: text,
}

// Lists nest a level a node, so this is far past any page and short of a deep tree overflowing the stack
const maxDepth = 64

// Addresses links can have: the web, email, phone numbers, and paths and anchors on the site. Others, such as
// javascript:, would run in the site's pages.
export const safeUrl = (url: unknown) =>
  typeof url === 'string' && (/^(https?:|mailto:|tel:)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()))

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isId = (value: unknown) => typeof value === 'string' && value !== ''

// The field's layouts by name, as the flexible field has them
export function layoutsOf(options?: Record<string, any>): Map<string, Layout> {
  const layouts: Array<Layout> = Array.isArray(options?.layouts) ? options.layouts : []
  return new Map(layouts.filter((layout) => layout?.name).map((layout) => [layout.name, layout] as const))
}

// Whether a value is a tree of known nodes, each in a place it can be and with what it needs, and blocks only where
// layouts are given and of one of them. Other keys Lexical writes, such as format and version, are kept as they are.
export function isTree(value: unknown, layouts?: Layouts): value is Tree {
  const check = (node: unknown, parent: string, depth: number): boolean => {
    if (!isObject(node) || typeof node.type !== 'string' || depth > maxDepth) return false
    if (!(holds[parent] ?? []).includes(node.type)) return false
    const fits =
      node.type === 'text' || node.type === 'code-highlight'
        ? typeof node.text === 'string' && (node.format === undefined || Number.isInteger(node.format))
        : node.type === 'heading'
          ? /^h[1-6]$/.test(node.tag)
          : node.type === 'list'
            ? node.listType === 'bullet' || node.listType === 'number'
            : node.type === 'link'
              ? safeUrl(node.url)
              : node.type === 'entrylink'
                ? isId(node.entry)
                : node.type === 'media'
                  ? isId(node.media)
                  : node.type === 'block'
                    ? !!layouts &&
                      isObject(node.block) &&
                      typeof node.block._layout === 'string' &&
                      layouts.has(node.block._layout)
                    : true
    if (!fits) return false
    if (!(node.type in holds)) return node.children === undefined
    return Array.isArray(node.children) && node.children.every((child) => check(child, node.type, depth + 1))
  }
  return isObject(value) && isObject(value.root) && value.root.type === 'root' && check(value.root, 'tree', 0)
}

// Every node of a tree, parents before their children
export function* nodesOf(tree: Tree): Generator<Node> {
  const walk = function* (node: Node): Generator<Node> {
    yield node
    for (const child of node.children ?? []) yield* walk(child)
  }
  yield* walk(tree.root)
}

// A copy of a tree with each node replaced by what change makes of it, after its children have been
export function mapNodes(tree: Tree, change: (node: Node) => Node): Tree {
  const walk = (node: Node): Node => change(node.children ? { ...node, children: node.children.map(walk) } : node)
  return { ...tree, root: walk(tree.root) as Tree['root'] }
}

// Whether a tree holds nothing: no text, files or blocks, as an editor emptied of everything still holds a paragraph
export const isEmptyTree = (tree: Tree) =>
  ![...nodesOf(tree)].some(
    (node) => (node.type === 'text' && (node.text as string).trim()) || node.type === 'media' || node.type === 'block',
  )

// The entries and files a tree links to, by ID, each once. A value that isn't a tree links to none.
export function linksOf(value: unknown) {
  const entries = new Set<string>()
  const media = new Set<string>()
  for (const node of isObject(value) && isObject(value.root) ? nodesOf(value as Tree) : []) {
    if (node.type === 'entrylink' && isId(node.entry)) entries.add(node.entry as string)
    if (node.type === 'media' && isId(node.media)) media.add(node.media as string)
  }
  return { entries: [...entries], media: [...media] }
}

// A tree's text, a line for each paragraph, heading, quote, list item and code block
export function plainText(tree: Tree) {
  const lines: Array<string> = []
  const line = (node: Node): string =>
    (node.children ?? [])
      .map((child) =>
        child.type === 'linebreak'
          ? '\n'
          : child.type === 'tab'
            ? '\t'
            : typeof child.text === 'string'
              ? child.text
              : line(child),
      )
      .join('')
  const walk = (node: Node) => {
    if (node.type === 'root' || node.type === 'list') node.children?.forEach(walk)
    else if (node.type === 'listitem' && node.children?.some((child) => child.type === 'list'))
      node.children.forEach(walk)
    else if (node.children) lines.push(line(node))
  }
  walk(tree.root)
  return lines.join('\n')
}
