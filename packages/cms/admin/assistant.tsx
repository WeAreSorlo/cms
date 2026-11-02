import { chatMessageSchema, chatTitleSchema } from '../src/schemas'
import { pageOf, shortDate } from './api'
import { Chat, ChatMessage, useAssistant } from './chat'
import { Dialog, EmptyState, Notice, PageHeader, Panel, focusHeading, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FormHandle } from 'iight'
import { ArrowUp, Check, ChevronsUpDown, CircleAlert, MessagesSquare, Square, SquarePen } from 'lucide-react'
import { ComponentProps, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// The admin's assistant: the Chat page, and the assistant under each page's panel, which share one chat through the
// shell (PLAN.md section 21). Loaded only with the assistant on, since its Markdown renderer is the larger part.

const nameOf = (chat: Chat | null) => chat?.title ?? 'New chat'

// Opens a new chat, with focus in the box to write in beside the button that asked
function newChat(assistant: ReturnType<typeof useAssistant>, from: Element) {
  assistant.open(null)
  from.closest('.cms-assistant, .cms-chat-page')?.querySelector('textarea')?.focus()
}

// Only links into the admin, to web pages and to email addresses keep their address. Images never load, since an
// image's address can carry what a reply was told to send to it.
const linkable = (url: string) => (/^(#\/|https?:|mailto:)/i.test(url) ? url : null)

function Link({ href, children }: ComponentProps<'a'>) {
  if (!href) return <>{children}</>
  if (href.startsWith('#/')) return <a href={href}>{children}</a>
  return (
    <a href={href} target='_blank' rel='noreferrer'>
      {children}
    </a>
  )
}

// A reply's text, from Markdown to React elements. HTML in it is dropped rather than rendered.
export const Rendered = ({ text }: { text: string }) => (
  <div className='cms-reply'>
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      disallowedElements={['img']}
      urlTransform={linkable}
      components={{ a: Link }}
    >
      {text}
    </Markdown>
  </div>
)

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <li className='cms-chat__mine'>{message.text}</li>
  return (
    <li className='cms-chat__reply'>
      {message.parts.map((part, index) =>
        part.type === 'text' ? (
          <Rendered key={index} text={part.text} />
        ) : (
          <p key={index} className='cms-chat__step' data-failed={part.failed || undefined}>
            {part.failed ? <CircleAlert /> : <Check />}
            {part.text}
          </p>
        ),
      )}
      {message.notice && (
        <Notice tone={message.notice.tone} quiet>
          {message.notice.text}
        </Notice>
      )}
    </li>
  )
}

// The messages, kept at the end as a reply comes in, until the person scrolls back. Only scrolling up counts, since a
// scroll to the end can land short when the reply has grown again by the time its event comes.
function Messages({ messages }: { messages: Array<ChatMessage> }) {
  const box = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const top = useRef(0)
  // A message just sent brings the chat to its end, wherever it was
  const sent = messages.filter((message) => message.role === 'user').length
  const seen = useRef(sent)
  useLayoutEffect(() => {
    if (sent > seen.current) atEnd.current = true
    seen.current = sent
    if (atEnd.current) box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [messages])

  return (
    <div
      ref={box}
      className='cms-chat__messages'
      role='group'
      aria-label='Messages'
      tabIndex={0}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
        if (scrollHeight - scrollTop - clientHeight < 24) atEnd.current = true
        else if (scrollTop < top.current) atEnd.current = false
        top.current = scrollTop
      }}
    >
      {messages.length ? (
        <ol>
          {messages.map((message, index) => (
            <Message key={index} message={message} />
          ))}
        </ol>
      ) : (
        <EmptyState icon={<MessagesSquare />}>
          Ask about the site's content, such as which posts mention a product, or have this page checked for typos. It
          reads as you, and can't change anything yet.
        </EmptyState>
      )}
    </div>
  )
}

// The box to write in, a core form. Enter sends and Shift+Enter starts a new line. The one button sends, then stops the
// reply, so focus stays on it.
function Composer() {
  const assistant = useAssistant()
  const form = useRef<FormHandle>(null)
  const area = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState<{ text?: string }>({})

  const send = async () => {
    const text = values.text ?? ''
    if (assistant.replying || !text.trim()) return
    if (!form.current?.validate().isValid) return void focusInvalid(area.current, 'sent')
    setValues({})
    const report = await assistant.send(text, pageOf(location.hash))
    if (report) {
      setValues({ text })
      form.current?.applyReport(report)
      focusInvalid(area.current, 'sent', report)
    }
  }

  return (
    <div
      ref={area}
      className='cms-composer'
      onKeyDown={(event) => {
        const sends = event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
        if (!sends || !(event.target instanceof HTMLTextAreaElement)) return
        event.preventDefault()
        send()
      }}
    >
      <Form ref={form} schema={chatMessageSchema} values={values} onValuesChange={setValues} />
      <button
        type='button'
        className={`iight-button${assistant.replying ? '' : ' iight-button--primary'}`}
        onClick={assistant.replying ? assistant.stop : send}
      >
        {assistant.replying ? <Square /> : <ArrowUp />}
        {assistant.replying ? 'Stop' : 'Send'}
      </button>
    </div>
  )
}

// A chat: its messages, the box to write in, and a polite status that says when it's replying and reads each reply
// once it's done, since text read out as it streams would be noise
function Conversation() {
  const assistant = useAssistant()
  return (
    <div className='cms-chat'>
      <Messages key={assistant.chat?.id ?? 'new'} messages={assistant.messages} />
      <p className='cms-visually-hidden' role='status'>
        {assistant.status}
      </p>
      <Composer />
    </div>
  )
}

// The person's chats in a popover, for the panel's assistant
function Switcher() {
  const assistant = useAssistant()
  const id = useId()
  const close = () => document.getElementById(id)?.hidePopover()
  return (
    <>
      <button type='button' className='iight-button cms-assistant__switch' popoverTarget={id}>
        <span>{nameOf(assistant.chat)}</span>
        <span className='cms-visually-hidden'>, switch chats</span>
        <ChevronsUpDown />
      </button>
      <div id={id} className='cms-popover cms-chats' popover='auto'>
        <ChatList onPick={close} />
        <a href='#/chat' onClick={close}>
          All chats
        </a>
      </div>
    </>
  )
}

// The person's chats, latest first, each opening on its own. On the Chat page they're links, so they open there.
function ChatList({ onPick }: { onPick?: () => void }) {
  const assistant = useAssistant()
  if (!assistant.chats.length) return <p className='cms-muted'>No chats yet.</p>
  return (
    <>
      <ul className='cms-chats__list'>
        {assistant.chats.map((chat) => {
          const props = {
            'aria-current': chat.id === assistant.chat?.id ? ('true' as const) : undefined,
            children: (
              <>
                <span>{nameOf(chat)}</span>
                <span className='cms-muted'>{shortDate(chat.updatedAt)}</span>
              </>
            ),
          }
          return (
            <li key={chat.id}>
              {onPick ? (
                <button
                  type='button'
                  {...props}
                  onClick={() => {
                    onPick()
                    if (chat.id !== assistant.chat?.id) assistant.open(chat.id)
                  }}
                />
              ) : (
                <a href={`#/chat?id=${chat.id}`} {...props} />
              )}
            </li>
          )
        })}
      </ul>
      {assistant.more && (
        <button type='button' className='iight-button' onClick={assistant.showMore}>
          Show more chats
        </button>
      )}
    </>
  )
}

// A chat with its header: the chat's name, which opens the person's other chats, and New chat. The panel, its dialog
// and the reference page show it.
export function AssistantChat({ sheet }: { sheet?: boolean }) {
  const assistant = useAssistant()
  return (
    <div className={`cms-assistant${sheet ? ' cms-assistant--sheet' : ''}`}>
      <div className='cms-assistant__header'>
        <Switcher />
        <button
          type='button'
          className='cms-icon-button'
          aria-label='New chat'
          title='New chat'
          onClick={(event) => newChat(assistant, event.currentTarget)}
        >
          <SquarePen />
        </button>
      </div>
      <Conversation />
    </div>
  )
}

// The assistant under the page's panel, from 64rem. Below that, a button at the end of the bottom bar opens it in a
// dialog as big as the window, which a link into the admin closes, so the page it opens shows.
export function PanelAssistant() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <AssistantChat />
      <button type='button' className='iight-button cms-assistant__open' onClick={() => setOpen(true)}>
        <MessagesSquare />
        <span>Assistant</span>
      </button>
      {open && (
        <Dialog title='Assistant' onClose={() => setOpen(false)}>
          <div
            className='cms-assistant__sheet'
            onClick={(event) => {
              // After the link has been followed, which it isn't once it's gone
              const link = event.target instanceof Element && event.target.closest('a[href^="#/"]')
              if (link) setTimeout(() => setOpen(false))
            }}
          >
            <AssistantChat sheet />
          </div>
        </Dialog>
      )}
    </>
  )
}

function Rename({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const assistant = useAssistant()
  const toast = useToast()
  const form = useRef<FormHandle>(null)
  const area = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState({ title: chat.title ?? '' })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    if (!form.current?.validate().isValid) return void focusInvalid(area.current)
    setSaving(true)
    const report = await assistant.rename(values.title).finally(() => setSaving(false))
    if (report) {
      form.current?.applyReport(report)
      return void focusInvalid(area.current, 'saved', report)
    }
    toast('Renamed the chat.')
    area.current?.closest('dialog')?.close()
  }

  return (
    <Dialog
      title='Rename chat'
      onClose={onClose}
      footer={
        <button type='button' className='iight-button iight-button--primary' aria-busy={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div
        ref={area}
        onKeyDown={(event) => event.key === 'Enter' && event.target instanceof HTMLInputElement && save()}
      >
        <Form ref={form} schema={chatTitleSchema} values={values} onValuesChange={setValues} />
      </div>
    </Dialog>
  )
}

// The Chat page: the open chat at full width, with the person's chats in its panel. The chat's id is in the URL's
// query, as in #/chat?id=…, so a link or a reload opens it, and switching chats keeps the page.
export function ChatPage({ query }: { query: string }) {
  const assistant = useAssistant()
  const confirm = useConfirm()
  const toast = useToast()
  const [renaming, setRenaming] = useState(false)
  const id = new URLSearchParams(query).get('id')

  useEffect(() => {
    if (id && id !== assistant.chat?.id) assistant.open(id)
  }, [id])

  // The URL follows the chat once it changes, such as when a first message makes it
  const shown = useRef(assistant.chat?.id)
  useEffect(() => {
    if (assistant.chat?.id === shown.current) return
    shown.current = assistant.chat?.id
    const hash = assistant.chat ? `#/chat?id=${assistant.chat.id}` : '#/chat'
    if (location.hash !== hash) location.replace(hash)
  }, [assistant.chat?.id])

  const remove = async () => {
    const yes = await confirm({
      title: `Delete “${nameOf(assistant.chat)}” for good?`,
      body: 'Its messages go with it.',
      action: 'Delete chat',
      danger: true,
    })
    if (!yes) return
    await assistant.remove()
    toast('Deleted the chat.')
    focusHeading()
  }

  return (
    <div className='cms-chat-page'>
      <PageHeader title={nameOf(assistant.chat)} />
      <Conversation />
      <Panel
        label='Chats'
        sheet='Chats'
        actions={
          <button
            type='button'
            className='iight-button iight-button--primary'
            onClick={() => {
              assistant.open(null)
              document.querySelector<HTMLElement>('.cms-chat-page .cms-composer textarea')?.focus()
            }}
          >
            <SquarePen /> New chat
          </button>
        }
        footer={
          assistant.chat && (
            <>
              <button type='button' className='iight-button' onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button type='button' className='iight-button iight-button--danger' onClick={remove}>
                Delete
              </button>
            </>
          )
        }
      >
        <nav aria-label='Your chats'>
          <h2>Your chats</h2>
          <ChatList />
        </nav>
      </Panel>
      {renaming && assistant.chat && <Rename chat={assistant.chat} onClose={() => setRenaming(false)} />}
    </div>
  )
}
