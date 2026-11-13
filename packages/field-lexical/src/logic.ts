import {
  type Block,
  type Layout,
  type Node,
  type Tree,
  isEmptyTree,
  isTree,
  layoutsOf,
  mapNodes,
  plainText,
} from './tree'
import { inputs, validationError, validationMessage, validationSuccess } from '@sorlo/forms'
import type {
  InputOptionFields,
  InputPickValue,
  InputSchema,
  InputTypeValue,
  InputValidateChildren,
  InputValidateValue,
} from '@sorlo/forms'

// The field's checks and types, without Lexical or React, so a server loads neither. Its output setting says how it's
// delivered: HTML, by default, or JSON, which can hold blocks, taking the flexible field's layouts as their kinds.

// Whether a field is delivered as JSON rather than HTML
export const isJson = (schema: InputSchema) => schema.options?.output === 'json'

// The layouts a field's blocks can have: a JSON field's, and none for HTML, which has no way to write them yet
const layoutsFor = (schema: InputSchema) => (isJson(schema) ? layoutsOf(schema.options) : new Map<string, Layout>())

// Takes blocks of any layout, where the layouts don't matter
export const anyLayout = { has: () => true }

// An emptied editor holds null, so a field that isn't required can hold it
export const orNull = (schema: InputSchema, type: string) => (schema.required ? type : `${type} | null`)

const validateValue: InputValidateValue = (value, schema) => {
  const layouts = layoutsFor(schema)
  const empty = value === undefined || value === null || (isTree(value, layouts) && isEmptyTree(value))
  if (empty) {
    return schema.required ? validationError(value, validationMessage(schema, 'required')) : validationSuccess(value)
  }
  if (!isTree(value, layouts)) return validationError(value, validationMessage(schema, 'invalid'))
  return validationSuccess(value)
}

// The blocks of a tree, in order
const blocksOf = (value: unknown): Array<Node> =>
  isTree(value, anyLayout) ? value.root.children.filter((node) => node.type === 'block') : []

// Each block's fields checked against its layout, reported by the block's place among the blocks, such as body.0.title
const validateChildren: InputValidateChildren = (value, schema, validateFields) => {
  const layouts = layoutsFor(schema)
  return blocksOf(value).map((node) => {
    const block = node.block as Block
    return validateFields(layouts.get(block._layout)?.fields ?? [], block)
  })
}

// The tree with blocks whose layout has gone left out, as an HTML field's all are, and each block's values picked by
// its layout's fields
const pickValue: InputPickValue = (value, schema, pickFields) => {
  if (!isTree(value, anyLayout)) return value
  const layouts = layoutsFor(schema)
  const tree: Tree = {
    ...value,
    root: {
      ...value.root,
      children: value.root.children.filter(
        (node) => node.type !== 'block' || layouts.has((node.block as Block)._layout),
      ),
    },
  }
  return mapNodes(tree, (node) => {
    if (node.type !== 'block') return node
    const block = node.block as Block
    return {
      ...node,
      block: { ...pickFields(layouts.get(block._layout)?.fields ?? [], block), _layout: block._layout },
    }
  })
}

// The type of a tree: text nodes generically, and blocks by their layouts, as the flexible field types them, so
// checking _layout narrows one. Top-level nodes are named, so checking type narrows a block too.
const typeValue: InputTypeValue = (schema, typeFields) => {
  const blocks = [...layoutsFor(schema).values()].map(
    (layout) => `({ _layout: ${JSON.stringify(layout.name)} } & ${typeFields(layout.fields ?? [])})`,
  )
  const others = `{ type: 'paragraph' | 'heading' | 'quote' | 'list' | 'code' | 'media'; [key: string]: unknown }`
  const block = blocks.length ? `{ type: 'block'; version: number; block: ${blocks.join(' | ')} } | ` : ''
  return orNull(schema, `{ root: { type: 'root'; children: Array<${block}${others}>; [key: string]: unknown } }`)
}

// Delivered as, then the flexible field's Layouts setting, with the IDs it gives each layout, for JSON only and
// optional, since without blocks a field is still rich text
const optionFields = ((fields) => [
  {
    name: 'output',
    label: 'Delivered as',
    type: 'radio',
    defaultValue: 'html',
    instructions: 'HTML is ready to show. JSON keeps the structure for the site to render, and can hold blocks.',
    options: {
      choices: [
        { value: 'html', label: 'HTML' },
        { value: 'json', label: 'JSON' },
      ],
    },
  },
  ...inputs.flexible.optionFields(fields).map((field) => {
    const { required: _, options: { minimum: __, ...options } = {}, ...layouts } = field
    return { ...layouts, options, conditions: [{ field: 'output', operator: 'equals', value: 'json' }] }
  }),
]) as InputOptionFields

export const lexical = {
  name: () => 'Rich text',
  description: () => 'Formatted text with headings, lists, links and files, delivered as HTML, or as JSON with blocks.',
  category: () => 'Standard',
  optionFields,
  prepareSchema: inputs.flexible.prepareSchema,
  validateValue,
  validateChildren,
  pickValue,
  typeValue,
  // Its text, a line for each paragraph, for lists and versions
  formatValue: (value: unknown) => (isTree(value, anyLayout) ? plainText(value) : null),
}

// A tree with each text node's text replaced by what change makes of it, for find and replace. A value that isn't a
// tree is left as it is.
export const mapText = (value: unknown, change: (text: string) => string) =>
  isTree(value, anyLayout)
    ? mapNodes(value, (node) => (node.type === 'text' ? { ...node, text: change(node.text as string) } : node))
    : value
