import Editor from './Editor'
import * as logic from './logic'
import type { Input } from '@sorlo/forms'

// The Markdown field as a Sorlo Forms input, for a form's inputs, such as <Form inputs={{ markdown }} />
export const markdown: Input = { ...logic, default: Editor }
