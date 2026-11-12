import i18n from './i18n'
import type { ComponentProps } from 'react'
import Markdown, { type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Links open in a new tab, so following one can't lose what's being written
const NewTab = ({ node: _, ...props }: ComponentProps<'a'> & ExtraProps) => (
  <a {...props} target='_blank' rel='noopener noreferrer' />
)

// Markdown as React elements, with GitHub's tables, strikethrough and task lists. HTML in it shows as text and never
// runs, and react-markdown's default urlTransform empties links and images with schemes such as javascript:.
export function Preview({ text }: { text: string }) {
  if (!text.trim()) return <p className='sorlo-markdown__empty'>{i18n.t('nothingToPreview')}</p>
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: NewTab }}>
      {text}
    </Markdown>
  )
}
