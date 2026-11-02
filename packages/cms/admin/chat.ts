import type { ChatMessage, ReplyNotice } from '../src/chats'
import { api } from './api'
import type { ValidationReport } from 'iight'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type { ChatMessage }
export type Reply = Extract<ChatMessage, { role: 'assistant' }>

// A chat as the admin API returns it
export interface Chat {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

// The assistant, which the shell keeps across pages, so the Chat page and the panel show the same chat (PLAN.md
// section 21). A new chat is made when its first message is sent.
export interface Assistant {
  // The person's chats, latest first, a page at a time
  chats: Array<Chat>
  more: boolean
  showMore(): Promise<void>
  // The open chat, or null for a new one, and its messages, the reply that's coming in last
  chat: Chat | null
  messages: Array<ChatMessage>
  replying: boolean
  // What the assistant's polite status says: that it's replying, then the reply once it's done
  status: string
  open(id: string | null): Promise<void>
  // Resolves with core's report when the server turns the message down
  send(text: string, page: object): Promise<ValidationReport | undefined>
  stop(): void
  rename(title: string): Promise<ValidationReport | undefined>
  remove(): Promise<void>
}

export const AssistantContext = createContext<Assistant | null>(null)
export const useAssistant = () => useContext(AssistantContext)!

// The chat open in this browser, so a reload opens it again
const remembered = 'iight-chat'
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(remembered, id)
    else localStorage.removeItem(remembered)
  } catch {}
}

// The server-sent events of a reply as they arrive
async function* eventsOf(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunks = (buffer + read.value).split('\n\n')
    buffer = chunks.pop()!
    for (const chunk of chunks) {
      const event = /^event: (.*)$/m.exec(chunk)?.[1]
      const data = /^data: (.*)$/m.exec(chunk)?.[1]
      if (event && data) yield { event, data: JSON.parse(data) }
    }
  }
}

// What a screen reader is told of a finished reply: its text, then its notice
const spoken = (reply: Reply) =>
  [
    ...reply.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    ...(reply.notice ? [reply.notice.text] : []),
  ].join(' ') || 'The reply is done.'

const stopped: ReplyNotice = { tone: 'info', text: 'Stopped.' }

// The assistant's state for the shell, which only loads anything with the assistant on
export function useAssistantState(on: boolean): Assistant {
  const [chats, setChats] = useState<Array<Chat>>([])
  const [page, setPage] = useState({ number: 1, last: 1 })
  const [chat, setChat] = useState<Chat | null>(null)
  const [messages, setMessages] = useState<Array<ChatMessage>>([])
  const [replying, setReplying] = useState(false)
  const [status, setStatus] = useState('')
  // Counts the chats opened, so a load or a reply that finishes after another chat is opened leaves it be
  const opened = useRef(0)
  const reply = useRef<AbortController | null>(null)

  const listed = (chat: Chat) => setChats((chats) => [chat, ...chats.filter((other) => other.id !== chat.id)])

  // Opens a chat once it has loaded, leaving the one open till then, or a new chat at once
  const open = useCallback(async (id: string | null) => {
    reply.current?.abort()
    const mine = ++opened.current
    remember(id)
    if (!id) {
      setChat(null)
      setMessages([])
      return
    }
    try {
      const { body } = await api('GET', `/chats/${id}`)
      if (opened.current !== mine) return
      const { messages, ...chat } = body.data
      setChat(chat)
      setMessages(messages)
    } catch {
      if (opened.current === mine) open(null)
    }
  }, [])

  useEffect(() => {
    if (!on) return
    api('GET', '/chats')
      .then(({ body }) => {
        setChats(body.data)
        setPage({ number: 1, last: body.pagination.lastPage })
      })
      .catch(() => {})
    let id = null
    try {
      id = localStorage.getItem(remembered)
    } catch {}
    if (id) open(id)
  }, [on, open])

  const showMore = async () => {
    const { body } = await api('GET', `/chats?page=${page.number + 1}`)
    setChats((chats) => [...chats, ...body.data.filter((chat: Chat) => !chats.some((other) => other.id === chat.id))])
    setPage({ number: page.number + 1, last: body.pagination.lastPage })
  }

  const send = async (text: string, page: object) => {
    if (reply.current) return
    const controller = new AbortController()
    reply.current = controller
    setReplying(true)
    setStatus('Replying…')

    // The reply as it comes in, shown once a frame while its chat is open
    let answer: Reply | null = { role: 'assistant', parts: [], notice: null }
    const mine = opened.current
    const here = () => opened.current === mine
    const show = () => here() && answer && setMessages((messages) => [...messages.slice(0, -1), answer!])
    let frame = 0
    const later = () => (frame ||= requestAnimationFrame(() => ((frame = 0), show())))
    setMessages((messages) => [...messages, { role: 'user', text }, answer!])

    try {
      let id = chat?.id
      if (!id) {
        const { body } = await api('POST', '/chats', {})
        id = body.data.id as string
        listed(body.data)
        if (here()) {
          remember(id)
          setChat(body.data)
        }
      }
      const response = await fetch(`/api/chats/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, page }),
        signal: controller.signal,
      })
      if (response.status === 422) {
        // Taken back, for the person to fix
        answer = null
        if (here()) setMessages((messages) => messages.slice(0, -2))
        return await response.json()
      }
      if (!response.ok) {
        const message = (await response.json().catch(() => null))?.message ?? response.statusText
        answer = { ...answer!, notice: { tone: 'danger', text: message } }
        return
      }
      for await (const { event, data } of eventsOf(response)) {
        if (!answer) break
        const parts: Reply['parts'] = answer.parts
        const last = parts.at(-1)
        if (event === 'text' && last?.type === 'text') {
          answer = { ...answer, parts: [...parts.slice(0, -1), { ...last, text: last.text + data.text }] }
        } else if (event === 'text') answer = { ...answer, parts: [...parts, { type: 'text', text: data.text }] }
        // The provider is asking again, so what it wrote since the last step goes
        else if (event === 'restart') {
          answer = { ...answer, parts: parts.slice(0, parts.map((part) => part.type).lastIndexOf('step') + 1) }
        } else if (event === 'step') answer = { ...answer, parts: [...parts, data] }
        else if (event === 'notice') answer = { ...answer, notice: data }
        else if (event === 'done') {
          listed(data.chat)
          if (here()) setChat(data.chat)
        }
        later()
      }
    } catch {
      answer = answer && {
        ...answer,
        notice: controller.signal.aborted
          ? stopped
          : { tone: 'danger', text: "Couldn't reach the server, so the reply stopped." },
      }
    } finally {
      cancelAnimationFrame(frame)
      reply.current = null
      setReplying(false)
      show()
      if (answer && here()) setStatus(spoken(answer))
    }
  }

  const rename = async (title: string) => {
    if (!chat) return
    const { status, body } = await api('PUT', `/chats/${chat.id}`, { title })
    if (status === 422) return body
    setChat(body.data)
    setChats((chats) => chats.map((other) => (other.id === chat.id ? body.data : other)))
  }

  const remove = async () => {
    if (!chat) return
    await api('DELETE', `/chats/${chat.id}`)
    setChats((chats) => chats.filter((other) => other.id !== chat.id))
    await open(null)
  }

  return {
    chats,
    more: page.number < page.last,
    showMore,
    chat,
    messages,
    replying,
    status,
    open,
    send,
    stop: () => reply.current?.abort(),
    rename,
    remove,
  }
}
