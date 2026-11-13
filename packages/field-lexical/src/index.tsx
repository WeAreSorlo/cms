import * as logic from './logic'
import type { Input } from '@sorlo/forms'
import { Suspense, lazy } from 'react'

// Lexical is most of the field's size, so it loads with the first editor rather than with every form
const Editor = lazy(() => import('./Editor'))

function RichText() {
  return (
    <Suspense fallback={<div className='sorlo-input__richtext' />}>
      <Editor />
    </Suspense>
  )
}

// The field as a Sorlo Forms input, for a form's inputs, such as <Form inputs={{ lexical }} />
export const lexical: Input = { ...logic.lexical, default: RichText }

export { PickersContext } from './pickers'
export type { PickedEntry, PickedFile, Pickers } from './pickers'
export { isJson } from './logic'
export { isTree, linksOf, plainText } from './tree'
export type { Block, Node, Tree } from './tree'
