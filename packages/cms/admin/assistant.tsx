import { chatMessageSchema, chatTitleSchema, mediaSchema } from '../src/schemas'
import { PageView, TypesContext, api, errorMessage, shortDate } from './api'
import { Chat, ChatMessage, Proposal, SharedChat, editing, useAssistant } from './chat'
import { compare, compareParent, linksOf } from './compare'
import { useLinkNames } from './fields'
import {
  Badge,
  Dialog,
  EmptyState,
  Notice,
  PageHeader,
  Panel,
  focusHeading,
  focusInvalid,
  useConfirm,
  useToast,
} from './ui'
import { ChangeList, JsonChanges } from './versions'
import Form, { FieldSchema, FormHandle, Input, inputs } from 'iight'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CircleAlert,
  EllipsisVertical,
  Sparkles,
  Square,
  SquarePen,
  Target,
} from 'lucide-react'
import {
  ComponentProps,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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

// Only links into the admin open from a reply, and web pages' and email addresses show as text after their words, so
// nothing a reply was steered to write, such as an address that carries a draft's text, opens with a click
// (PLAN.md section 21). Images never load, since an image's address can carry it too.
const linkable = (url: string) => (/^(#\/|https?:|mailto:)/i.test(url) ? url : null)

function Link({ href, children }: ComponentProps<'a'>) {
  if (href?.startsWith('#/')) return <a href={href}>{children}</a>
  // A bare address, as written, shows once
  const bare =
    typeof children === 'string' &&
    href?.replace(/^(https?:\/\/|mailto:)/i, '') === children.replace(/^(https?:\/\/|mailto:)/i, '')
  if (!href || bare) return <>{children}</>
  return (
    <>
      {children} ({href})
    </>
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

// Whether the chat is someone else's, read from a version, so its proposals have no Apply or Skip
const ReadOnly = createContext(false)

// A chat's proposals as they stand, by id, so an entry can name the proposed form that applying it makes first
const ChatProposals = createContext(new Map<string, Proposal>())

const statuses = {
  pending: ['Waiting', 'neutral'],
  applied: ['Applied', 'success'],
  skipped: ['Skipped', 'neutral'],
  stale: ['Not applied', 'warning'],
} as const

// What a proposal is called, such as New event: Kubecon stall, or Changes to Launch day
function useProposalName(proposal: Proposal) {
  const type = useContext(TypesContext).get(proposal.type ?? '')
  const title = proposal.title ? `“${proposal.title}”` : undefined
  if (proposal.kind === 'media') return `New details for ${title ?? 'a file'}`
  if (proposal.kind === 'form') return proposal.isNew ? `New form: ${title}` : `Changes to the form ${title}`
  if (!proposal.isNew) return `Changes to ${title ?? 'an entry'}`
  return `New ${type?.singular?.toLowerCase() ?? `${type?.label ?? proposal.type} entry`}: ${title ?? 'Untitled'}`
}

// Whether a proposal can be applied as a draft: an entry of a type with drafts, or a form, which applied as a draft
// stays closed. A file's details and a type without drafts go live once applied.
const draftable = (proposal: Proposal, types: Map<string, { drafts?: boolean }>) =>
  proposal.kind === 'form' || (proposal.kind === 'entry' && types.get(proposal.type ?? '')?.drafts !== false)

// What a proposal sets, as the version page compares fields: every field of a new entry, or the fields a change sets,
// a page's move first, or a file's name, alt text and caption beside the image. A new form lists its fields, and a
// change to one shows its JSON before and after.
function ProposalChanges({ proposal }: { proposal: Proposal }) {
  const type = useContext(TypesContext).get(proposal.type ?? '')
  const changes = useMemo(() => {
    if (proposal.kind === 'media') return compare(mediaSchema, proposal.before, proposal.after)
    if (proposal.kind !== 'entry' || !type) return []
    const before = proposal.isNew ? undefined : proposal.before
    const moved =
      type.structure === 'hierarchical' && Object.hasOwn(proposal.after, 'parentId')
        ? compareParent(before?.parentId, proposal.after.parentId)
        : []
    return [...moved, ...compare(type.fields, before?.values, proposal.after.values)]
  }, [proposal, type])
  const linked = linksOf(changes)
  const found = useLinkNames(linked.entries, linked.files, linked.forms)
  // A form proposed in the chat has its label before it's made
  const chatProposals = useContext(ChatProposals)
  const links = { ...found }
  for (const form of chatProposals.values()) {
    if (form.kind === 'form' && form.isNew) links[form.targetId] ??= form.title ?? null
  }

  if (proposal.kind === 'form' && !proposal.isNew) {
    return <JsonChanges before={proposal.before} after={proposal.after} />
  }
  if (proposal.kind === 'form') {
    const fields: Array<FieldSchema> = proposal.after.fields ?? []
    return (
      <ul className='cms-proposal__fields'>
        {fields.map((field, index) => (
          <li key={index}>
            {field.label || field.name}{' '}
            <span className='cms-muted'>
              {(inputs as Record<string, Input>)[field.type]?.name?.() ?? field.type}
              {field.required && ', required'}
            </span>
          </li>
        ))}
      </ul>
    )
  }
  const list = changes.length ? (
    <ChangeList changes={changes} links={links} nested />
  ) : (
    <p className='cms-muted'>It changes nothing the fields show.</p>
  )
  // The image the details describe, which is decorative here, since the card names the file
  return proposal.kind === 'media' && proposal.image ? (
    <div className='cms-proposal__file'>
      <img src={proposal.image} alt='' />
      {list}
    </div>
  ) : (
    list
  )
}

// What applying a waiting proposal does besides what it shows, so no one publishes more than they meant to
function useWarning(proposal: Proposal) {
  const type = useContext(TypesContext).get(proposal.type ?? '')
  const chatProposals = useContext(ChatProposals)
  const forms = proposal.needs
    .map((id) => chatProposals.get(id))
    .filter((form) => form?.status === 'pending')
    .map((form) => `“${form!.title}”`)
  if (proposal.status !== 'pending') return undefined
  if (proposal.kind === 'media') return 'Applying it changes the file on the site at once, since files have no drafts.'
  if (proposal.kind === 'form') {
    return proposal.isNew
      ? 'Applied as a draft, it takes no submissions until someone opens it. Apply and publish opens it.'
      : 'Apply and publish opens it to submissions.'
  }
  return [
    type?.drafts === false && `${type.label} has no drafts, so applying it publishes it at once.`,
    proposal.entryStatus === 'changed' &&
      "Its draft has other changes that aren't live yet, which publishing makes live too.",
    proposal.entryStatus === 'draft' && "It isn't live yet, so publishing makes all of it live, not just this change.",
    forms.length > 0 &&
      `Applying it makes the form ${forms.join(' and ')} first, which opens when the page is published.`,
  ]
    .filter(Boolean)
    .join(' ')
}

// What became of a proposal, which focus moves to once it's decided
function Outcome({ proposal, focus }: { proposal: Proposal; focus: React.RefObject<HTMLParagraphElement | null> }) {
  if (proposal.status === 'stale') {
    return (
      <div ref={focus} tabIndex={-1}>
        <Notice tone='warning' quiet>
          Not applied, since what it changes was changed or deleted after it was proposed. Ask again for a fresh
          proposal.
        </Notice>
      </div>
    )
  }
  const said =
    proposal.status === 'skipped' ? (
      'Skipped.'
    ) : proposal.status !== 'applied' ? null : proposal.kind === 'media' ? (
      "Applied, so the file's details are on the site now."
    ) : proposal.kind === 'form' ? (
      <>
        {proposal.isNew ? 'Made ' : 'Applied to '}
        <a href={`#/forms/${proposal.targetId}`}>the form</a>
        {proposal.published ? ', which takes submissions now' : ", which takes no submissions until it's opened"}.
      </>
    ) : (
      <>
        {proposal.published ? 'Applied and published, ' : 'Applied as a draft, '}
        <a href={`#/entries/${proposal.targetId}/versions/${proposal.version}`}>version {proposal.version}</a>.
      </>
    )
  return (
    said && (
      <p ref={focus} className='cms-proposal__outcome' tabIndex={-1}>
        {proposal.status === 'applied' && <Check />}
        <span>{said}</span>
      </p>
    )
  )
}

// Applies, publishes or skips some proposals, once the page beside the chat has saved what it holds for one of them,
// and then loads that page again
function useDecide(proposals: Array<Proposal>, focus: () => void) {
  const assistant = useAssistant()
  const types = useContext(TypesContext)
  const toast = useToast()
  const [busy, setBusy] = useState<'apply' | 'publish' | 'skip'>()
  // How many are done, of how many there were when it started, since decided ones leave the list as it goes
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [problem, setProblem] = useState('')

  const decide = async (action: 'apply' | 'publish' | 'skip') => {
    if (busy) return
    setProblem('')
    const beside = editing.page
    const shown = action !== 'skip' && proposals.some((proposal) => beside?.shows(proposal))
    if (shown && beside?.touched()) {
      return setProblem(
        "You've changed this on the page beside the chat without saving. Save it first, then apply this.",
      )
    }
    const ids = proposals.map((proposal) => proposal.id)
    setBusy(action)
    setTotal(ids.length)
    try {
      const failed = await assistant.decide(action, ids, setDone)
      const many = ids.length > 1
      const verb = action === 'publish' ? 'Applied and published' : 'Applied'
      if (action === 'skip') toast(many ? `Skipped ${ids.length} changes` : 'Skipped the change')
      else if (many && failed === ids.length) toast(`None of the ${ids.length} changes were applied`)
      else if (failed < ids.length) {
        toast(
          many
            ? `${verb} ${ids.length - failed} of ${ids.length} changes`
            : `${verb} the change${action === 'apply' && draftable(proposals[0], types) ? ' as a draft' : ''}`,
        )
      }
      // One change says why under it, and a batch says how many weren't applied, each marked so
      if (many && failed) {
        const which = failed === ids.length ? `None of the ${ids.length} changes were` : `${failed} of them weren't`
        setProblem(`${which} applied. Each one marked Not applied says why when it's opened.`)
      }
      if (shown) await beside?.reload()
      setTimeout(focus)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(undefined)
      setDone(0)
    }
  }
  return { busy, done, total, problem, decide }
}

// A proposal's name after a verb, such as Apply changes to Launch day
const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

// Apply and Skip, or Apply all and Skip all, with what stopped them
function Decide({
  proposals,
  name,
  focus,
}: {
  proposals: Array<Proposal>
  // For one proposal, what it's called, which names its buttons
  name?: string
  focus: () => void
}) {
  const types = useContext(TypesContext)
  const { busy, done, total, problem, decide } = useDecide(proposals, focus)
  const count = proposals.length
  // Past a hundred, it says how far it's got
  const working = (verb: string) => (total > 100 ? `${verb} ${done} of ${total}…` : `${verb}…`)
  const progress = busy && working({ apply: 'Applying', publish: 'Publishing', skip: 'Skipping' }[busy])
  // Named for the proposal, starting with what the button says, other than while it works, when it says that
  const named = (label: string, action: typeof busy) =>
    busy === action ? undefined : name && `${label}: ${lower(name)}`
  const drafts = proposals.some((proposal) => draftable(proposal, types))
  const live = proposals.filter((proposal) => !draftable(proposal, types)).length
  return (
    <>
      <div className='cms-proposal__actions'>
        {drafts && (
          <button
            type='button'
            className='iight-button'
            aria-label={named('Apply as draft', 'apply')}
            aria-busy={busy === 'apply'}
            onClick={() => decide('apply')}
          >
            {busy === 'apply' ? working('Applying') : name ? 'Apply as draft' : 'Apply all as drafts'}
          </button>
        )}
        <button
          type='button'
          className='iight-button iight-button--primary'
          aria-label={named('Apply and publish', 'publish')}
          aria-busy={busy === 'publish'}
          onClick={() => decide('publish')}
        >
          {busy === 'publish' ? working('Publishing') : name ? 'Apply and publish' : `Apply and publish all ${count}`}
        </button>
        <button
          type='button'
          className='iight-button'
          aria-label={named('Skip', 'skip')}
          aria-busy={busy === 'skip'}
          onClick={() => decide('skip')}
        >
          {busy === 'skip' ? working('Skipping') : name ? 'Skip' : 'Skip all'}
        </button>
      </div>
      <p className='cms-visually-hidden' role='status'>
        {progress || ''}
      </p>
      {!name && drafts && live > 0 && (
        <p className='cms-muted'>
          {live === 1 ? '1 of them goes' : `${live} of them go`} live when applied, since they have no drafts.
        </p>
      )}
      {problem && (
        <p className='cms-problem' role='alert'>
          <CircleAlert /> {problem}
        </p>
      )}
    </>
  )
}

// A proposal: what it changes, as the version page compares it, then Apply and Skip, or what became of it
function ProposalCard({ proposal, folded = false }: { proposal: Proposal; folded?: boolean }) {
  const assistant = useAssistant()
  const readOnly = useContext(ReadOnly)
  const chatProposals = useContext(ChatProposals)
  const name = useProposalName(proposal)
  const warning = useWarning(proposal)
  const outcome = useRef<HTMLParagraphElement>(null)
  const problem = assistant.problems[proposal.id]

  return (
    <section className='cms-proposal' aria-label={name}>
      {!folded && <p className='cms-proposal__name'>{name}</p>}
      <ProposalChanges proposal={proposal} />
      {warning && <p className='cms-muted'>{warning}</p>}
      <Outcome proposal={proposal} focus={outcome} />
      {proposal.status === 'pending' && !readOnly && (
        <Decide proposals={[proposal]} name={name} focus={() => outcome.current?.focus()} />
      )}
      {problem && proposal.status === 'pending' && (
        <p className='cms-problem' role='alert'>
          <CircleAlert /> {problem}
        </p>
      )}
    </section>
  )
}

// How many of some decided proposals weren't applied, since what they change was changed or deleted since
const notApplied = (proposals: Array<Proposal>) => {
  const stale = proposals.filter((proposal) => proposal.status === 'stale').length
  return stale ? `, ${stale} not applied` : ''
}

// What a step proposed: one change, or for a find and replace, a change for each entry, folded under its name, with
// Apply all and Skip all for those still waiting
function Proposals({ proposals }: { proposals: Array<Proposal> }) {
  const readOnly = useContext(ReadOnly)
  const head = useRef<HTMLParagraphElement>(null)
  if (proposals.length === 1) return <ProposalCard proposal={proposals[0]} />
  const pending = proposals.filter((proposal) => proposal.status === 'pending')
  return (
    <section className='cms-proposals' aria-label={`${proposals.length} changes`}>
      <p ref={head} className='cms-proposals__head' tabIndex={-1}>
        {pending.length
          ? `${pending.length} of ${proposals.length} changes wait for you`
          : `${proposals.length} changes, none still waiting${notApplied(proposals)}`}
      </p>
      {pending.length > 0 && !readOnly && <Decide proposals={pending} focus={() => head.current?.focus()} />}
      <ol className='cms-proposals__list'>
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <Folded proposal={proposal} />
          </li>
        ))}
      </ol>
    </section>
  )
}

// A proposal in a list of them, shut until it's opened, and marked when it wasn't applied
function Folded({ proposal }: { proposal: Proposal }) {
  const assistant = useAssistant()
  const name = useProposalName(proposal)
  const failed = proposal.status === 'pending' && !!assistant.problems[proposal.id]
  const [label, tone] = failed ? (['Not applied', 'danger'] as const) : statuses[proposal.status]
  return (
    <details className='cms-proposal__fold'>
      <summary>
        <span>{name}</span> <Badge tone={tone}>{label}</Badge>
      </summary>
      <ProposalCard proposal={proposal} folded />
    </details>
  )
}

export function Message({ message }: { message: ChatMessage }) {
  const assistant = useAssistant()
  const readOnly = useContext(ReadOnly)
  const end = useRef<HTMLParagraphElement>(null)
  if (message.role === 'user') return <li className='cms-chat__mine'>{message.text}</li>
  const latest = (proposal: Proposal) => ({ ...proposal, ...assistant.decided[proposal.id] })
  const steps = message.parts.filter((part) => part.type === 'step' && part.proposals?.length)
  const all = steps.flatMap((step) => (step.type === 'step' ? (step.proposals ?? []).map(latest) : []))
  const pending = all.filter((proposal) => proposal.status === 'pending')
  return (
    <li className='cms-chat__reply'>
      {message.parts.map((part, index) =>
        part.type === 'text' ? (
          <Rendered key={index} text={part.text} />
        ) : (
          <div key={index} className='cms-chat__part'>
            <p className='cms-chat__step' data-failed={part.failed || undefined}>
              {part.failed ? <CircleAlert /> : <Check />}
              {part.text}
            </p>
            {!!part.proposals?.length && <Proposals proposals={part.proposals.map(latest)} />}
          </div>
        ),
      )}
      {message.notice && (
        <Notice tone={message.notice.tone} quiet>
          {message.notice.text}
        </Notice>
      )}
      {/* With several steps' proposals, the line stays once they're decided, since focus moves to it */}
      {!readOnly && (pending.length > 0 || steps.length > 1) && (
        <div className='cms-proposals__end'>
          {steps.length > 1 && (
            <>
              <p ref={end} tabIndex={-1}>
                {pending.length
                  ? `${pending.length} changes wait for you`
                  : `${all.length} changes, none still waiting${notApplied(all)}`}
              </p>
              {pending.length > 0 && <Decide proposals={pending} focus={() => end.current?.focus()} />}
            </>
          )}
          {pending.some((proposal) => proposal.kind === 'entry') && (
            <p className='cms-muted'>
              Applying a change links its version to this chat, which anyone signed in can read.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

// The messages, kept at the end as a reply comes in, until the person scrolls back. Only scrolling up counts, since a
// scroll to the end can land short when the reply has grown again by the time its event comes.
function Messages({ messages }: { messages: Array<ChatMessage> }) {
  const assistant = useAssistant()
  const proposals = useMemo(
    () =>
      new Map(
        messages
          .flatMap((message) => (message.role === 'assistant' ? message.parts : []))
          .flatMap((part) => (part.type === 'step' ? (part.proposals ?? []) : []))
          .map((proposal) => [proposal.id, { ...proposal, ...assistant.decided[proposal.id] }]),
      ),
    [messages, assistant.decided],
  )
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
        <ChatProposals.Provider value={proposals}>
          <ol>
            {messages.map((message, index) => (
              <Message key={index} message={message} />
            ))}
          </ol>
        </ChatProposals.Provider>
      ) : (
        <EmptyState icon={<Sparkles />}>
          Ask about the site's content, or for changes to it, such as which posts mention a product, or fixing this
          page's typos. It reads as you, and proposes changes for you to apply as drafts.
        </EmptyState>
      )}
    </div>
  )
}

// The box to write in, a core form. Enter sends and Shift+Enter starts a new line. The one button sends, then stops the
// reply, so focus stays on it. Beside a page, a line above the box names what the page shows, which each message sends
// as its page, so "this" and "these" mean just what the line says.
function Composer({ view }: { view?: PageView | null }) {
  const assistant = useAssistant()
  const form = useRef<FormHandle>(null)
  const area = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState<{ text?: string }>({})

  const send = async () => {
    const text = values.text ?? ''
    if (assistant.replying || !text.trim()) return
    if (!form.current?.validate().isValid) return void focusInvalid(area.current, 'sent')
    setValues({})
    const report = await assistant.send(text, view?.page ?? {})
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
      {view && (
        <p className='cms-composer__about'>
          <Target />
          <span className='cms-visually-hidden'>“This” means </span>
          <span>{view.label}</span>
        </p>
      )}
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
function Conversation({ view }: { view?: PageView | null }) {
  const assistant = useAssistant()
  return (
    <div className='cms-chat'>
      <Messages key={assistant.chat?.id ?? 'new'} messages={assistant.messages} />
      <p className='cms-visually-hidden' role='status'>
        {assistant.status}
      </p>
      <Composer view={view} />
    </div>
  )
}

// The person's chats in a popover, from the chat's name in the dialog below 64rem, or from ⋮ in the panel's card, whose
// menu has New chat too, since the card's header holds only its title beside it
function Switcher({ menu }: { menu?: boolean }) {
  const assistant = useAssistant()
  const id = useId()
  const close = () => document.getElementById(id)?.hidePopover()
  return (
    <>
      {menu ? (
        <button
          type='button'
          className='cms-icon-button cms-assistant__menu'
          aria-label='Chats'
          title='Chats'
          popoverTarget={id}
        >
          <EllipsisVertical />
        </button>
      ) : (
        <button type='button' className='iight-button cms-assistant__switch' popoverTarget={id}>
          <span>{nameOf(assistant.chat)}</span>
          <span className='cms-visually-hidden'>, switch chats</span>
          <ChevronsUpDown />
        </button>
      )}
      <div id={id} className='cms-popover cms-chats' popover='auto'>
        {menu && (
          <button
            type='button'
            className='iight-button'
            onClick={(event) => {
              close()
              newChat(assistant, event.currentTarget)
            }}
          >
            <SquarePen /> New chat
          </button>
        )}
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

// A chat with its header. In the panel's card and on the reference page, that's the title, which hides and shows the
// chat as an accordion's heading does, and ⋮, which opens New chat and the person's chats. In the dialog below 64rem,
// whose own title says Assistant, it's the chat's name, which opens the person's other chats, and New chat.
export function AssistantChat({
  sheet,
  view,
  collapsed = false,
  onCollapse,
}: {
  sheet?: boolean
  view?: PageView | null
  collapsed?: boolean
  onCollapse?: (collapsed: boolean) => void
}) {
  const assistant = useAssistant()
  return (
    <div className={`cms-assistant${sheet ? ' cms-assistant--sheet' : ''}`}>
      <div className='cms-assistant__header'>
        {sheet ? (
          <>
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
          </>
        ) : (
          <>
            <h2 className='cms-assistant__title'>
              <button type='button' aria-expanded={!collapsed} onClick={() => onCollapse?.(!collapsed)}>
                Assistant
                {collapsed ? <ChevronUp /> : <ChevronDown />}
              </button>
            </h2>
            {!collapsed && <Switcher menu />}
          </>
        )}
      </div>
      <Conversation view={view} />
    </div>
  )
}

// The assistant under the page's panel, from 64rem, which the shell keeps collapsed or not. Below that, a button at the
// end of the bottom bar opens it in a dialog as big as the window, which a link into the admin closes, so the page it
// opens shows.
export function PanelAssistant({
  view,
  collapsed,
  onCollapse,
}: {
  view: PageView | null
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <AssistantChat view={view} collapsed={collapsed} onCollapse={onCollapse} />
      <button type='button' className='iight-button cms-assistant__open' onClick={() => setOpen(true)}>
        <Sparkles />
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
            <AssistantChat sheet view={view} />
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

// Someone else's chat, which anyone signed in can read once a version links to it, so an audit can open the
// conversation behind a change. It has nothing to write in, and its proposals have no Apply or Skip.
function SharedChatView({ chat }: { chat: SharedChat }) {
  const person = chat.user.name
  return (
    <>
      <PageHeader title={nameOf(chat)} meta={<Badge>Read-only</Badge>} />
      <Notice>
        {person}'s chat with the assistant, which you can read since it changed entries. Only {person} can write in it.
      </Notice>
      <ReadOnly.Provider value>
        <div className='cms-chat'>
          <Messages key={chat.id} messages={chat.messages} />
        </div>
      </ReadOnly.Provider>
    </>
  )
}

// The Chat page: the open chat at full width, with the person's chats in its panel. The chat's id is in the URL's
// query, as in #/chat?id=…, so a link or a reload opens it, and switching chats keeps the page. Someone else's chat,
// from a version's link, shows read-only.
export function ChatPage({ query }: { query: string }) {
  const assistant = useAssistant()
  const confirm = useConfirm()
  const toast = useToast()
  const [renaming, setRenaming] = useState(false)
  const [shared, setShared] = useState<SharedChat>()
  const id = new URLSearchParams(query).get('id')

  useEffect(() => {
    setShared(undefined)
    if (!id || id === assistant.chat?.id) return
    if (assistant.chats.some((chat) => chat.id === id)) return void assistant.open(id)
    // A chat that isn't among the person's own may be someone else's, which never becomes theirs to write in
    let gone = false
    api('GET', `/chats/${id}`)
      .then(({ body }) => {
        if (gone) return
        if (body.data.user.id === assistant.me) assistant.open(id)
        else setShared(body.data)
      })
      .catch(() => void (gone || assistant.open(id)))
    return () => void (gone = true)
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
      {shared ? (
        <SharedChatView chat={shared} />
      ) : (
        <>
          <PageHeader title={nameOf(assistant.chat)} />
          <Conversation />
        </>
      )}
      <Panel
        label='Chats'
        sheet='Chats'
        actions={
          <button
            type='button'
            className='iight-button iight-button--primary'
            onClick={() => {
              assistant.open(null)
              // Someone else's chat gives way to the new one too, which has no id yet
              setShared(undefined)
              if (location.hash !== '#/chat') location.replace('#/chat')
              setTimeout(() => document.querySelector<HTMLElement>('.cms-chat-page .cms-composer textarea')?.focus())
            }}
          >
            <SquarePen /> New chat
          </button>
        }
        footer={
          !shared &&
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
