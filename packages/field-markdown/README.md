# @sorlo/field-markdown

A Markdown field for [Sorlo Forms](https://github.com/WeAreSorlo/forms): a textarea with format buttons and a preview rendered in the browser. Its value is the Markdown text, as written. The [Sorlo CMS](https://github.com/WeAreSorlo/cms) includes it as the `markdown` field type, so a CMS site needs nothing from this page. Its docs are in [Content types](https://github.com/WeAreSorlo/cms/blob/main/docs/content-types.md#markdown-fields).

## With Sorlo Forms

```bash
npm install @sorlo/forms @sorlo/field-markdown
```

Give the form the input under the type its fields use, and load its styles beside Sorlo Forms':

```tsx
import { markdown } from '@sorlo/field-markdown'
import '@sorlo/field-markdown/styles.css'
import Form from '@sorlo/forms'

const schema = [{ type: 'markdown', name: 'body', label: 'Body', required: true, options: { rows: 12 } }]

export const Editor = () => <Form schema={schema} inputs={{ markdown }} />
```

A server checks values with the entry that has no component, so it loads no editor or Markdown parser:

```ts
import { markdown } from '@sorlo/field-markdown/validation'
import { inputs, validateServerValues } from '@sorlo/forms'

const report = await validateServerValues(schema, values, { ...inputs, markdown: { ...markdown, default: () => null } })
```

## Options

The textarea's: `placeholder`, `rows` (8 if not given), `minLength` and `maxLength`, checked with the textarea's messages. `schemaToTypeScript` types its value as a `string`.

## The editor

- **Format buttons:** Heading, Bold, Italic, Link, Bulleted list, Numbered list, Quote and Code, each taking its format off text that already has it. They're one toolbar, a single stop for Tab, which the arrow keys, Home and End move through. Ctrl+B, Ctrl+I and Ctrl+K, or Cmd on a Mac, work in the textarea, and Undo takes a button's change back.
- **Preview** is a toggle button whose pressed state screen readers announce. It renders with [react-markdown](https://github.com/remarkjs/react-markdown) and GitHub Flavored Markdown, as React elements rather than HTML. HTML in the text shows as text and never runs, links and images with schemes such as `javascript:` lose their addresses, and links open in a new tab, so following one keeps what's being written. Images load from wherever they point.
- **Strings** are in `src/translations/en.ts`, on an i18next instance of the field's own.

The styles use Sorlo Forms' theme variables, such as `--sorlo-button-background`, so a theme reaches the field too.
