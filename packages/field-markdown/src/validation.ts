import * as logic from './logic'

// The Markdown field without its component, so a server checks and types values without React's editor or a Markdown
// parser. Give it a component to render, such as () => null.
export const markdown = { ...logic }
