import type { ChatMessage, ReplyNotice } from '../src/chats'
import type { Proposal } from '../src/proposals'
import { api, pathOf } from './api'
import type { ValidationReport } from 'iight'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type { ChatMessage, Proposal }
export type Reply = Extract<ChatMessage, { role: 'assistant' }>

// A chat someone else wrote, which anyone signed in can read once a version links to it
export interface SharedChat extends Chat {
  user: { id: string; name: string }
  messages: Array<ChatMessage>
}

// The page beside the assistant, such as an entry's editor, a form's, the media library or the bulk grid: whether it
// shows what a proposal changes, whether it holds changes the person hasn't saved, so a proposal isn't applied under
// them, and how it loads again once one is applied
export interface Beside {
  shows(proposal: Pick<Proposal, 'kind' | 'targetId'>): boolean
  touched(): boolean
  reload(): void | Promise<void>
}
export const editing: { page?: Beside } = {}

// Makes a page the one beside the assistant while it's shown, reading what it says as it is at the time. A page that's
// part of another, such as the media library picking for a field, leaves that page's be.
export function useBeside(beside: Beside, on = true) {
  const latest = useRef(beside)
  latest.current = beside
  useEffect(() => {
    if (!on) return
    const page: Beside = {
      shows: (proposal) => latest.current.shows(proposal),
      touched: () => latest.current.touched(),
      reload: () => latest.current.reload(),
    }
    editing.page = page
    return () => {
      if (editing.page === page) editing.page = undefined
    }
  }, [on])
}

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
  // Who's signed in, since someone else's chat opens read-only
  me: string
  // The open chat's proposals as they stand since its messages loaded, by id, such as once they're applied or skipped,
  // or an entry they change is saved
  decided: Record<string, Proposal>
  // Why proposals weren't applied, by id, until they're tried again
  problems: Record<string, string>
  // Applies, applies and publishes, or skips the open chat's proposals, a hundred at a time, saying how many are done
  // after each hundred, and resolves with how many weren't applied, which problems says why for
  decide(action: 'apply' | 'publish' | 'skip', ids: Array<string>, progress?: (done: number) => void): Promise<number>
  // Loads the open chat's proposals again, such as for their entries' status once one is saved
  refresh(): Promise<void>
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
export function useAssistantState(on: boolean, me: string): Assistant {
  const [chats, setChats] = useState<Array<Chat>>([])
  const [page, setPage] = useState({ number: 1, last: 1 })
  const [chat, setChat] = useState<Chat | null>(null)
  const [messages, setMessages] = useState<Array<ChatMessage>>([])
  const [replying, setReplying] = useState(false)
  const [status, setStatus] = useState('')
  const [decided, setDecided] = useState<Record<string, Proposal>>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  // Counts the chats opened, so a load or a reply that finishes after another chat is opened leaves it be
  const opened = useRef(0)
  const reply = useRef<AbortController | null>(null)
  // The open chat's id, for what runs after another render, such as a refresh an editor asks for
  const current = useRef<string | null>(null)
  current.current = chat?.id ?? null

  const listed = (chat: Chat) => setChats((chats) => [chat, ...chats.filter((other) => other.id !== chat.id)])

  // Opens a chat once it has loaded, leaving the one open till then, or a new chat at once
  const open = useCallback(
    async (id: string | null) => {
      reply.current?.abort()
      const mine = ++opened.current
      remember(id)
      setDecided({})
      setProblems({})
      if (!id) {
        setChat(null)
        setMessages([])
        return
      }
      try {
        const { body } = await api('GET', `/chats/${id}`)
        if (opened.current !== mine) return
        const { messages, user, ...chat } = body.data
        // Someone else's chat is read on the Chat page, and never becomes this person's to write in
        if (user.id !== me) return open(null)
        setChat(chat)
        setMessages(messages)
      } catch {
        if (opened.current === mine) open(null)
      }
    },
    [me],
  )

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
    // The Chat page opens the chat its URL names instead, which the remembered one mustn't take the place of
    const named = pathOf(location.hash) === '#/chat' && new URLSearchParams(location.hash.split('?')[1]).has('id')
    if (id && !named) open(id)
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

  const decide = async (
    action: 'apply' | 'publish' | 'skip',
    ids: Array<string>,
    progress?: (done: number) => void,
  ) => {
    let failed = 0
    if (!chat) return failed
    for (let start = 0; start < ids.length; start += 100) {
      const route = action === 'skip' ? 'skip' : 'apply'
      const batch = { ids: ids.slice(start, start + 100), publish: action === 'publish' }
      const { body } = await api('POST', `/chats/${chat.id}/proposals/${route}`, batch)
      // Skipping replies the proposals it skipped, and applying a result for each
      const results: Array<{ id: string; status: number; data?: Proposal; message?: string }> =
        action === 'skip'
          ? body.data.map((proposal: Proposal) => ({ id: proposal.id, status: 200, data: proposal }))
          : body.data
      setDecided((all) => ({
        ...all,
        ...Object.fromEntries(results.flatMap(({ id, data }) => (data ? [[id, data]] : []))),
      }))
      const problem = ({ status, message }: (typeof results)[number]) =>
        status === 200 ? '' : message || "It wasn't applied."
      setProblems((all) => ({ ...all, ...Object.fromEntries(results.map((result) => [result.id, problem(result)])) }))
      failed += results.filter(({ status }) => status !== 200).length
      progress?.(Math.min(start + 100, ids.length))
    }
    // Other proposals for the same entries show their status as it is now
    await refresh()
    return failed
  }

  const refresh = async () => {
    const id = current.current
    const mine = opened.current
    if (!id) return
    const body = await api('GET', `/chats/${id}`).then(
      (reply) => reply.body,
      () => null,
    )
    if (!body || opened.current !== mine) return
    const proposals = (body.data.messages as Array<ChatMessage>)
      .flatMap((message) => (message.role === 'assistant' ? message.parts : []))
      .flatMap((part) => (part.type === 'step' ? (part.proposals ?? []) : []))
    setDecided((all) => ({ ...all, ...Object.fromEntries(proposals.map((proposal) => [proposal.id, proposal])) }))
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
    me,
    decided,
    problems,
    decide,
    refresh,
  }
}
