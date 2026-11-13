# @sorlo/field-lexical

A rich text field for [Sorlo Forms](https://github.com/WeAreSorlo/forms), on [Lexical](https://lexical.dev), of type `lexical`. It holds formatted text, and when it's delivered as JSON, blocks between its paragraphs, each with fields of its own. Its value is Lexical's own JSON, which the package checks without Lexical. The [Sorlo CMS](https://github.com/WeAreSorlo/cms) includes it and delivers it as HTML or JSON, so a CMS site needs nothing from this page. Its docs are in [Content types](https://github.com/WeAreSorlo/cms/blob/main/docs/content-types.md#rich-text-fields).

## With Sorlo Forms

```bash
npm install @sorlo/forms @sorlo/field-lexical
```

Give the form the input under the type its fields use, and load its styles beside Sorlo Forms':

```tsx
import { lexical } from '@sorlo/field-lexical'
import '@sorlo/field-lexical/styles.css'
import Form from '@sorlo/forms'

const schema = [
  { type: 'lexical', name: 'body', label: 'Body', required: true },
  {
    type: 'lexical',
    name: 'content',
    label: 'Content',
    options: {
      output: 'json',
      layouts: [{ name: 'callout', label: 'Callout', fields: [{ type: 'text', name: 'title', label: 'Title' }] }],
    },
  },
]

export const Editor = () => <Form schema={schema} inputs={{ lexical }} />
```

A server checks values with the entry that has no component, so it loads neither Lexical nor React:

```ts
import { lexical } from '@sorlo/field-lexical/validation'
import { inputs, validateServerValues } from '@sorlo/forms'

const report = await validateServerValues(schema, values, { ...inputs, lexical: { ...lexical, default: () => null } })
```

## The value

Lexical's serialized editor state, `{ root: { type: 'root', children: [...] } }`, or `null` once the editor is emptied. Besides Lexical's own nodes for paragraphs, headings, quotes, lists, code, links and text, it has three of its own, which hold IDs:

- `{ type: 'entrylink', entry, children }`, a link to an entry, around its text
- `{ type: 'media', media }`, a file, on a line of its own
- `{ type: 'block', block }`, a block, whose `block` is a flexible field's block: its layout's values and `_layout`

`validateValue` takes only those nodes, each where it can be, links only to `https:`, `http:`, `mailto:`, `tel:` and paths, and blocks only of the field's layouts. `validateChildren` checks each block's fields, reported by its place among the blocks, such as `content.0.title`, and `pickValue` picks them, leaving out blocks whose layout has gone. `schemaToTypeScript` types the tree, with each block typed by its layout.

## Options

| Option    | What it holds                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output`  | `html` or `json`, how the Sorlo CMS delivers it, which its settings call Delivered as. `html` if not given                                                     |
| `layouts` | For `json` only, the kinds of blocks it takes, as a flexible field's `layouts`: each a `name`, a `label` and its `fields`. Optional, unlike a flexible field's |

An `html` field takes no blocks, since HTML has no way to write them yet, and leaves out any it's given.

## The editor

- **One toolbar:** Heading, Subheading, Bold, Italic, Strikethrough, Code, Link, Bulleted list, Numbered list, Quote, Code block, an Add button for each of a JSON field's layouts, Undo and Redo, a single stop for Tab, which the arrow keys, Home and End move through. Ctrl+B, Ctrl+I and Ctrl+U, or Cmd on a Mac, work in the text. Link asks for an address, and refuses one it doesn't take, saying why.
- **Files and entries:** give the editor `PickersContext`, with `media` and `entry` functions that let someone choose a file or an entry and give back the one chosen, and `files`, which gives the files a value shows by ID. With them, the toolbar has Insert a file and Link to an entry. The Sorlo CMS gives its media library and entry search.
- **Files and blocks** sit on lines of their own, with Move up, Move down and Remove buttons, and a block's fields are a form inside it.
- **Lexical loads with the first editor,** in a chunk of its own, so forms without one don't load it.
- **Strings** are in `src/translations/en.ts`, on an i18next instance of the field's own.

The styles use Sorlo Forms' theme variables, such as `--sorlo-button-background`, so a theme reaches the field too.

## In the Sorlo CMS

`/plugin` makes the field the CMS's plugin, `lexical()`, which the CMS includes. A site lists it in its `plugins` only for its `entryLinks`, where links to each type's entries go in HTML fields. Lexical is pinned, since it's still on 0.x, and a change to a node's shape between its versions comes with a content migration.
