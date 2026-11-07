import { expandedType, form, media, relationship, shared } from '../src/fields'
import { chatMessageSchema, chatTitleSchema, maxAttached, mediaSchema } from '../src/schemas'
import { ContentType, GroupsContext, PageView, TypesContext, api, errorMessage, shortDate } from './api'
import { Chat, ChatFile, ChatMessage, Proposal, SharedChat, editing, useAssistant } from './chat'
import { compare, compareParent, compareTypes, linksOf } from './compare'
import { useLinkNames } from './fields'
import { Thumbnail } from './media'
import {
  Badge,
  Dialog,
  EmptyState,
  Notice,
  PageHeader,
  Panel,
  Toaster,
  focusHeading,
  focusInvalid,
  useConfirm,
  useToast,
} from './ui'
import { ChangeList, JsonChanges, kinds } from './versions'
import Form, { FieldSchema, FormHandle, Input, inputs } from '@sorlo/core'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CircleAlert,
  EllipsisVertical,
  FileX,
  LoaderCircle,
  Paperclip,
  Sparkles,
  Square,
  SquarePen,
  Target,
  X,
} from 'lucide-react'
import {
  ComponentProps,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useCallback,
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

// Finds an entry proposal's content type: one of the site's, or one proposed in the chat and not made yet, by the id the
// proposal carries, or for one made before entries carried it, the latest by that name, with its uses of shared groups
// expanded
function useTypeLookup() {
  const types = useContext(TypesContext)
  const groups = useContext(GroupsContext)
  const chatProposals = useContext(ChatProposals)
  return useCallback(
    (proposal: Proposal): ContentType | undefined => {
      const type = types.get(proposal.type ?? '')
      const typeId: string | undefined = proposal.kind === 'entry' ? proposal.after?.typeId : undefined
      if (proposal.kind !== 'entry' || (type && (!typeId || type.id === typeId))) return type
      const made = [...chatProposals.values()]
        .filter(
          (each) =>
            each.kind === 'type' && each.isNew && (typeId ? each.targetId === typeId : each.type === proposal.type),
        )
        .at(-1)
      return made && expandedType(made.after as ContentType, groups.values())
    },
    [types, groups, chatProposals],
  )
}

// An entry proposal's content type, as useTypeLookup finds it
function useTypeOf(proposal: Proposal) {
  const typeOf = useTypeLookup()
  return useMemo(() => typeOf(proposal), [typeOf, proposal])
}

// A field type's name, as the type editor's palette shows it, such as Long text for textarea
const fieldTypes: Record<string, { name?: () => string }> = { ...inputs, relationship, media, form, shared }
const typeName = (type: string) => fieldTypes[type]?.name?.() ?? type

// What a proposal is called, such as New event: Kubecon stall, or Changes to Launch day
function useProposalName(proposal: Proposal) {
  const type = useTypeOf(proposal)
  const title = proposal.title ? `“${proposal.title}”` : undefined
  if (proposal.kind === 'type') {
    return proposal.isNew ? `New content type: ${title}` : `Changes to the content type ${title}`
  }
  if (proposal.kind === 'media') return `New details for ${title ?? 'a file'}`
  if (proposal.kind === 'form') return proposal.isNew ? `New form: ${title}` : `Changes to the form ${title}`
  if (!proposal.isNew) return `Changes to ${title ?? 'an entry'}`
  return `New ${type?.singular?.toLowerCase() ?? `${type?.label ?? proposal.type} entry`}: ${title ?? 'Untitled'}`
}

// Whether a proposal can be applied as a draft: an entry of a type with drafts, one proposed in the chat included, or a
// form, which applied as a draft stays closed. A file's details and a type without drafts go live once applied.
const draftable = (proposal: Proposal, typeOf: (proposal: Proposal) => { drafts?: boolean } | undefined) =>
  proposal.kind === 'form' || (proposal.kind === 'entry' && typeOf(proposal)?.drafts !== false)

// A new type's fields, as a new form's card lists them, with the fields inside groups, repeaters and layouts under them,
// and each one's instructions and choices, since they're text the model wrote, which the assistant reads later as the
// site's types
function TypeFields({ fields }: { fields: Array<FieldSchema> }) {
  const groups = useContext(GroupsContext)
  return (
    <ul className='cms-proposal__fields'>
      {fields.map((field, index) => {
        const group = field.type === 'shared' && [...groups.values()].find((each) => each.id === field.options?.group)
        const layouts: Array<{ name: string; label?: string; fields?: Array<FieldSchema> }> =
          field.options?.layouts ?? []
        const choices: Array<{ value?: unknown; label?: string }> = field.options?.choices ?? []
        return (
          <li key={index}>
            {field.label || field.name}{' '}
            <span className='cms-muted'>
              {group ? `the shared group ${group.label}` : typeName(field.type)}
              {field.required && ', required'}
            </span>
            {field.instructions && <div className='cms-muted'>{field.instructions}</div>}
            {choices.length > 0 && (
              <div className='cms-muted'>
                Choices: {choices.map((choice) => choice.label || String(choice.value)).join(', ')}
              </div>
            )}
            {!!field.options?.fields?.length && <TypeFields fields={field.options.fields} />}
            {layouts.length > 0 && (
              <ul className='cms-proposal__fields'>
                {layouts.map((layout, index) => (
                  <li key={index}>
                    {layout.label || layout.name} <span className='cms-muted'>layout</span>
                    {!!layout.fields?.length && <TypeFields fields={layout.fields} />}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const structures = { collection: 'Collection', hierarchical: 'Hierarchical', singleton: 'Singleton' }

// A content type's proposal: a new type's settings and fields, or a change's changes by field, as make:migration matches
// them by id, with the file before and after as JSON in a fold, and what its content migration says
function TypeChanges({ proposal }: { proposal: Proposal }) {
  const after = proposal.after as ContentType
  const before = proposal.before as ContentType | null
  const changes = useMemo(() => (before ? compareTypes(before, after, typeName) : []), [before, after])
  const field = (name?: string) => after.fields.find((each) => each.name === name)
  const titled = field(after.titleField)
  const notes = proposal.migration?.notes ?? []
  return (
    <>
      {before ? (
        changes.length ? (
          <ol className='cms-changes'>
            {changes.map((change, index) => (
              <li key={index}>
                <div className='cms-change__head'>
                  <div className='cms-change__label'>{change.labels.join(' › ')}</div>
                  <Badge tone={kinds[change.kind][1]}>{kinds[change.kind][0]}</Badge>
                </div>
                {change.details.map((detail) => (
                  <p key={detail} className='cms-muted'>
                    {detail}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        ) : (
          <p className='cms-muted'>It changes nothing the type editor shows.</p>
        )
      ) : (
        <>
          <p className='cms-muted'>
            {structures[after.structure]}, {after.drafts === false ? 'without drafts' : 'with drafts'}
            {titled && `, titled by ${titled.label || titled.name}`}
          </p>
          <TypeFields fields={after.fields} />
        </>
      )}
      {notes.length > 0 && (
        <Notice tone='warning' quiet>
          {proposal.status === 'applied' ? 'Its migration says:' : 'The migration applying it writes will say:'}
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      )}
      {before && (
        <details className='cms-proposal__json'>
          <summary>As JSON</summary>
          <JsonChanges before={before} after={after} />
        </details>
      )}
    </>
  )
}

// What a proposal sets, as the version page compares fields: every field of a new entry, or the fields a change sets,
// a page's move first, or a file's name, alt text and caption beside the image. A new form lists its fields, and a
// change to one shows its JSON before and after. A content type shows its fields, or its changes by field.
function ProposalChanges({ proposal }: { proposal: Proposal }) {
  const type = useTypeOf(proposal)
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

  if (proposal.kind === 'type') return <TypeChanges proposal={proposal} />
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

// What applying a waiting change to a content type writes, and what it changes for the entries and the site's code
function typeWarning(proposal: Proposal) {
  const after = proposal.after as ContentType
  const before = proposal.before as ContentType | null
  const file = `schema/types/${after.name}.json`
  if (!before) return `Applying it writes ${file}. It needs no content migration, since the type has no entries yet.`
  const changes = compareTypes(before, after)
  const entries = proposal.entries === 1 ? '1 entry' : `${(proposal.entries ?? 0).toLocaleString('en')} entries`
  return [
    `Applying it writes ${file}${before.name !== after.name ? `, in place of ${before.name}.json` : ''}`,
    proposal.migration
      ? `, and a content migration for its ${entries}, archived ones included, which a person checks and runs on ` +
        'the Migrations page. Until it runs, no entry can be saved.'
      : '. It needs no content migration.',
    changes.some((change) => change.api) &&
      " It changes what the site's API returns, so the site's code that reads what it renames or removes needs " +
        'changing, and npx sorlo types pull updates its types.',
    before.drafts !== false &&
      after.drafts === false &&
      " Without drafts, every save publishes, and an entry's unpublished changes go live at its next save.",
  ]
    .filter(Boolean)
    .join('')
}

// What applying a waiting proposal does besides what it shows, so no one publishes more than they meant to
function useWarning(proposal: Proposal) {
  const type = useTypeOf(proposal)
  const chatProposals = useContext(ChatProposals)
  const forms = proposal.needs
    .map((id) => chatProposals.get(id))
    .filter((form) => form?.status === 'pending' && form.kind === 'form')
    .map((form) => `“${form!.title}”`)
  const made = proposal.needs.map((id) => chatProposals.get(id)).find((need) => need?.kind === 'type')
  if (proposal.status !== 'pending') return undefined
  if (proposal.kind === 'type') return typeWarning(proposal)
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
    made?.status === 'pending' && `Applying it makes the content type “${made.title}” first.`,
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
    ) : proposal.kind === 'type' ? (
      <>
        {proposal.isNew ? 'Made ' : 'Applied to '}
        <a href={`#/schema/${proposal.after.name}`}>the content type</a>
        {proposal.migration?.file ? (
          <>
            , with the migration <code>migrations/{proposal.migration.file}</code>, which waits to be run on{' '}
            <a href='#/migrations'>Migrations</a>
          </>
        ) : (
          ', which needed no content migration'
        )}
        .
      </>
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
  const typeOf = useTypeLookup()
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
    // The page beside holds still until it has loaded what was applied
    if (shown) beside?.hold?.(true)
    const at = location.hash
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
            : `${verb} the change${action === 'apply' && draftable(proposals[0], typeOf) ? ' as a draft' : ''}`,
        )
      }
      // One change says why under it, and a batch says how many weren't applied, each marked so
      if (many && failed) {
        const which = failed === ids.length ? `None of the ${ids.length} changes were` : `${failed} of them weren't`
        setProblem(`${which} applied. Each one marked Not applied says why when it's opened.`)
      }
      // Only a page still at the address it had, since the person may have left it meanwhile. Loading the types again
      // can take the page away, as a renamed type's editor goes, so it's the address that counts.
      if (shown && location.hash === at) await beside?.reload()
      setTimeout(focus)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      if (shown) beside?.hold?.(false)
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
  const typeOf = useTypeLookup()
  const { busy, done, total, problem, decide } = useDecide(proposals, focus)
  const count = proposals.length
  // Past a hundred, it says how far it's got
  const working = (verb: string) => (total > 100 ? `${verb} ${done} of ${total}…` : `${verb}…`)
  const progress = busy && working({ apply: 'Applying', publish: 'Publishing', skip: 'Skipping' }[busy])
  // Named for the proposal, starting with what the button says, other than while it works, when it says that
  const named = (label: string, action: typeof busy) =>
    busy === action ? undefined : name && `${label}: ${lower(name)}`
  const drafts = proposals.some((proposal) => draftable(proposal, typeOf))
  // Types have no drafts and publish nothing, so on their own they're applied. In a batch, a new type goes before the
  // entries that need it, and a change to a type after the batch's entries, since its migration stops entries saving.
  const typesOnly = proposals.every((proposal) => proposal.kind === 'type')
  const live = proposals.filter((proposal) => proposal.kind !== 'type' && !draftable(proposal, typeOf)).length
  return (
    <>
      <div className='cms-proposal__actions'>
        {typesOnly && (
          <button
            type='button'
            className='sorlo-button sorlo-button--primary'
            aria-label={named('Apply', 'apply')}
            aria-busy={busy === 'apply'}
            onClick={() => decide('apply')}
          >
            {busy === 'apply' ? working('Applying') : name ? 'Apply' : `Apply all ${count}`}
          </button>
        )}
        {!typesOnly && drafts && (
          <button
            type='button'
            className='sorlo-button'
            aria-label={named('Apply as draft', 'apply')}
            aria-busy={busy === 'apply'}
            onClick={() => decide('apply')}
          >
            {busy === 'apply' ? working('Applying') : name ? 'Apply as draft' : 'Apply all as drafts'}
          </button>
        )}
        {!typesOnly && (
          <button
            type='button'
            className='sorlo-button sorlo-button--primary'
            aria-label={named('Apply and publish', 'publish')}
            aria-busy={busy === 'publish'}
            onClick={() => decide('publish')}
          >
            {busy === 'publish' ? working('Publishing') : name ? 'Apply and publish' : `Apply and publish all ${count}`}
          </button>
        )}
        <button
          type='button'
          className='sorlo-button'
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
      {problem && (proposal.status === 'pending' || proposal.kind === 'type') && (
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

// The files attached to one of the person's messages, as the media field shows its files, and a file deleted since as
// a muted row
const SentFiles = ({ files }: { files: Array<ChatFile | null> }) => (
  <ul className='cms-picked'>
    {files.map((file, index) => (
      <li key={index} className={file ? undefined : 'cms-muted'}>
        {file ? (
          <Thumbnail media={file} />
        ) : (
          <span className='cms-picked__icon'>
            <FileX />
          </span>
        )}
        <span>{file?.name ?? 'Deleted file'}</span>
      </li>
    ))}
  </ul>
)

export function Message({ message }: { message: ChatMessage }) {
  const assistant = useAssistant()
  const readOnly = useContext(ReadOnly)
  const end = useRef<HTMLParagraphElement>(null)
  if (message.role === 'user') {
    return (
      <li className='cms-chat__mine'>
        {!!message.files?.length && <SentFiles files={message.files} />}
        {message.text}
      </li>
    )
  }
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

// A file attached to the message being written: going up, in the media library, or turned away with the reason why
export interface Attachment {
  key: number
  name: string
  file?: ChatFile
  problem?: string
}

// The files attached to the message being written, from Attach files, a drop or a paste. Each uploads to the media
// library as it's attached, one after another, as on the Media page, up to maxAttached a message.
function useAttachments(draft: Array<Attachment> = []) {
  const assistant = useAssistant()
  const [list, setList] = useState(draft)
  // Files past the limit, or the server's reason it turned the files down
  const [notice, setNotice] = useState('')
  // Read out politely: Uploading beach.jpg…, then Attached beach.jpg
  const [status, setStatus] = useState('')
  const queue = useRef(Promise.resolve())
  const keys = useRef(draft.length)
  // How each upload ends, by its attachment's key, for a message waiting to send
  const uploads = useRef(new Map<number, Promise<Partial<Attachment>>>())

  const upload = async (key: number, file: File) => {
    setStatus(`Uploading ${file.name}…`)
    const done = await assistant.upload(file)
    setList((all) => all.map((attachment) => (attachment.key === key ? { ...attachment, ...done } : attachment)))
    // A failure says why in its row, as an alert
    setStatus(done.file ? `Attached ${done.file.name}` : '')
    return done
  }

  const attach = (files: Array<File>) => {
    const room = Math.max(0, maxAttached - list.length)
    const left = files.slice(room)
    // Named only when it's one, so a long list can't push the box out of a narrow card
    const which = left.length === 1 ? `${left[0].name} wasn't attached` : `${left.length} files weren't attached`
    setNotice(left.length ? `${which}, since a message takes up to ${maxAttached} files.` : '')
    const added = files.slice(0, room).map((file) => ({ key: ++keys.current, file }))
    setList((all) => [...all, ...added.map(({ key, file }) => ({ key, name: file.name }))])
    for (const { key, file } of added) {
      const done = queue.current.then(() => upload(key, file))
      uploads.current.set(key, done)
      queue.current = done.then(() => {})
    }
  }

  // The attachments as they are once those still going up are done
  const settle = (attachments: Array<Attachment>) =>
    Promise.all(
      attachments.map(async (attachment) => ({ ...attachment, ...(await uploads.current.get(attachment.key)) })),
    )

  // Nothing uses an upload removed before sending, so it's deleted, unless something has linked to it since
  const remove = (attachment: Attachment) => {
    setList((all) => all.filter((other) => other.key !== attachment.key))
    setNotice('')
    uploads.current.delete(attachment.key)
    if (attachment.file) assistant.discard(attachment.file)
  }

  const uploading = list.some((attachment) => !attachment.file && !attachment.problem)
  return { list, setList, notice, setNotice, status, uploading, attach, settle, remove }
}

// What's attached to the message being written, above the box, each as the media field shows its files, with Remove,
// but for while the message waits for its files to send, as they were when Send was pressed
function Attached({
  attachments,
  locked,
  onRemove,
}: {
  attachments: ReturnType<typeof useAttachments>
  locked: boolean
  onRemove: () => void
}) {
  const id = useId()
  const { list, notice } = attachments
  if (!list.length && !notice) return null
  return (
    <div className='cms-composer__files'>
      {notice && <Notice tone='danger'>{notice}</Notice>}
      {list.length > 0 && (
        <>
          <ul className='cms-picked'>
            {list.map((attachment) => {
              const name = attachment.file?.name ?? attachment.name
              return (
                <li key={attachment.key} data-failed={attachment.problem ? true : undefined}>
                  {attachment.file ? (
                    <Thumbnail media={attachment.file} />
                  ) : (
                    <span className='cms-picked__icon'>
                      {attachment.problem ? <CircleAlert /> : <LoaderCircle className='cms-spin' />}
                    </span>
                  )}
                  {attachment.problem ? (
                    <span role='alert'>
                      {name}
                      <span id={`${id}-${attachment.key}`} className='cms-picked__problem'>
                        {attachment.problem}
                      </span>
                    </span>
                  ) : (
                    <span>
                      {name}
                      {!attachment.file && <span className='cms-muted'> Uploading…</span>}
                    </span>
                  )}
                  {!locked && (attachment.file || attachment.problem) && (
                    <button
                      type='button'
                      className='cms-icon-button'
                      aria-label={`Remove ${name}`}
                      title={`Remove ${name}`}
                      aria-describedby={attachment.problem ? `${id}-${attachment.key}` : undefined}
                      onClick={() => {
                        attachments.remove(attachment)
                        onRemove()
                      }}
                    >
                      <X />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          <p className='cms-muted'>Attaching uploads to the media library.</p>
        </>
      )}
    </div>
  )
}

// The box's field while a message waits for its files, read-only, so what's sent is what Send was pressed on
const waitingSchema = chatMessageSchema.map((field) => ({ ...field, readonly: true }))

// The box to write in, a core form. Enter sends and Shift+Enter starts a new line. The one button sends, then stops the
// reply, so focus stays on it. Beside a page, a line above the box names what the page shows, which each message sends
// as its page, so "this" and "these" mean just what the line says. Files attached show above the box, and pasting
// files into it attaches them. A message with files still needs words. One the server didn't take comes back to the
// box, saying why.
function Composer({ view, attachments }: { view?: PageView | null; attachments: ReturnType<typeof useAttachments> }) {
  const assistant = useAssistant()
  const toast = useToast()
  const form = useRef<FormHandle>(null)
  const area = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const attach = useRef<HTMLButtonElement>(null)
  const [values, setValues] = useState<{ text?: string }>({})
  // Send was pressed while files were still going up, so the message waits for them
  const [waiting, setWaiting] = useState(false)
  // A message that waits for its files still goes once the box has gone, as with the dialog closed
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  // Focus moves only while it's in the box's area, never from wherever the person has gone while a message waited
  const holdsFocus = () => !!area.current?.contains(document.activeElement)
  const focusRefused = () => area.current?.querySelector<HTMLElement>('[data-failed] button')?.focus()

  const send = async () => {
    const text = values.text ?? ''
    const sent = attachments.list
    if (assistant.replying || waiting || (!text.trim() && !sent.length)) return
    if (!form.current?.validate().isValid) return void focusInvalid(area.current, 'sent')
    // A file the upload turned away is removed first, as a failed field is fixed
    if (sent.some((attachment) => attachment.problem)) return focusRefused()
    // What goes is what Send was pressed on: these words and files, this page, and the chat open now, wherever the
    // person is by the time the files are up
    const to = assistant.hold()
    const page = view?.page ?? {}
    setWaiting(true)
    const settled = await attachments.settle(sent)
    if (mounted.current) setWaiting(false)
    const refused = settled.find((attachment) => attachment.problem)
    if (refused) {
      // Its row says why, as an alert
      if (!mounted.current) toast(`Your message wasn't sent, since ${refused.name} couldn't be uploaded.`)
      else if (holdsFocus()) focusRefused()
      return
    }
    // The draft goes, but for files attached since Send was pressed
    const keys = new Set(sent.map((attachment) => attachment.key))
    if (mounted.current) {
      setValues({})
      attachments.setList((all) => all.filter((attachment) => !keys.has(attachment.key)))
      attachments.setNotice('')
    }
    const unsent = await assistant.send(
      text,
      page,
      settled.flatMap(({ file }) => (file ? [file] : [])),
      to,
    )
    if (!unsent) return
    const why = unsent.problem ?? unsent.report?.fields.files?.messages.join(' ')
    if (!mounted.current) return toast(`Your message wasn't sent${why ? `: ${why}` : '.'}`)
    // Back in the box, before anything written or attached since
    setValues((now) => ({ text: now.text?.trim() ? `${text}\n\n${now.text}` : text }))
    attachments.setList((all) => [...settled, ...all])
    attachments.setNotice(why ?? '')
    if (unsent.report) {
      form.current?.applyReport(unsent.report)
      if (holdsFocus()) focusInvalid(area.current, 'sent', unsent.report)
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
      onPaste={(event) => {
        // Office apps put a picture of what was copied beside its text, which pastes as text as it always did, so only
        // files without text attach, such as a screenshot, or an image copied from a page, which comes with HTML alone
        const { files, types } = event.clipboardData
        if (!files.length || types.includes('text/plain')) return
        event.preventDefault()
        attachments.attach([...files])
      }}
    >
      {view && (
        <p className='cms-composer__about'>
          <Target />
          <span className='cms-visually-hidden'>“This” means </span>
          <span>{view.label}</span>
        </p>
      )}
      <Attached attachments={attachments} locked={waiting} onRemove={() => attach.current?.focus()} />
      <p className='cms-visually-hidden' role='status'>
        {attachments.status}
      </p>
      <Form
        ref={form}
        schema={waiting ? waitingSchema : chatMessageSchema}
        values={values}
        onValuesChange={setValues}
      />
      <input
        ref={picker}
        type='file'
        multiple
        hidden
        onChange={(event) => {
          // Copied, since clearing the input empties its list, so choosing the same file again attaches it again
          attachments.attach([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      <button
        ref={attach}
        type='button'
        className='cms-icon-button'
        aria-label='Attach files'
        title='Attach files'
        onClick={() => picker.current?.click()}
      >
        <Paperclip />
      </button>
      <button
        type='button'
        className={`sorlo-button${assistant.replying ? '' : ' sorlo-button--primary'}`}
        aria-busy={waiting || undefined}
        onClick={assistant.replying ? assistant.stop : () => send()}
      >
        {assistant.replying ? <Square /> : <ArrowUp />}
        {assistant.replying ? 'Stop' : waiting ? 'Uploading…' : 'Send'}
      </button>
    </div>
  )
}

// A chat: its messages, the box to write in, and a polite status that says when it's replying and reads each reply
// once it's done, since text read out as it streams would be noise. The message being written starts as draft says,
// for the reference page.
function Conversation({ view, draft }: { view?: PageView | null; draft?: Array<Attachment> }) {
  const assistant = useAssistant()
  const attachments = useAttachments(draft)
  const chat = useRef<HTMLDivElement>(null)
  const attach = useRef(attachments.attach)
  attach.current = attachments.attach

  // Files dropped anywhere on the assistant attach to the message being written: its card, header and all, its dialog,
  // or on the Chat page the chat, though not on a collapsed card, whose box is hidden. Text dropped in the box drops as
  // it always did.
  useEffect(() => {
    const own = chat.current!
    const zone =
      own.closest('dialog') ??
      own.closest<HTMLElement>('.cms-side__assistant') ??
      own.closest<HTMLElement>('.cms-assistant') ??
      own
    const takes = (event: DragEvent) =>
      !!event.dataTransfer?.types.includes('Files') && !zone.hasAttribute('data-collapsed')
    const over = (event: DragEvent) => {
      if (!takes(event)) return
      event.preventDefault()
      zone.setAttribute('data-attaching', '')
    }
    // Dragging over a child leaves the zone itself, so only leaving for somewhere outside it counts
    const leave = (event: DragEvent) => {
      if (!zone.contains(event.relatedTarget as Node)) zone.removeAttribute('data-attaching')
    }
    const drop = (event: DragEvent) => {
      if (!takes(event)) return
      event.preventDefault()
      zone.removeAttribute('data-attaching')
      attach.current([...event.dataTransfer!.files])
    }
    zone.addEventListener('dragover', over)
    zone.addEventListener('dragleave', leave)
    zone.addEventListener('drop', drop)
    return () => {
      zone.removeEventListener('dragover', over)
      zone.removeEventListener('dragleave', leave)
      zone.removeEventListener('drop', drop)
      zone.removeAttribute('data-attaching')
    }
  }, [])

  return (
    <div ref={chat} className='cms-chat'>
      <Messages key={assistant.chat?.id ?? 'new'} messages={assistant.messages} />
      <p className='cms-visually-hidden' role='status'>
        {assistant.status}
      </p>
      <Composer view={view} attachments={attachments} />
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
        <button type='button' className='sorlo-button cms-assistant__switch' popoverTarget={id}>
          <span>{nameOf(assistant.chat)}</span>
          <span className='cms-visually-hidden'>, switch chats</span>
          <ChevronsUpDown />
        </button>
      )}
      <div id={id} className='cms-popover cms-chats' popover='auto'>
        {menu && (
          <button
            type='button'
            className='sorlo-button'
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
        <button type='button' className='sorlo-button' onClick={assistant.showMore}>
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
  draft,
}: {
  sheet?: boolean
  view?: PageView | null
  collapsed?: boolean
  onCollapse?: (collapsed: boolean) => void
  draft?: Array<Attachment>
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
      <Conversation view={view} draft={draft} />
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
      <button type='button' className='sorlo-button cms-assistant__open' onClick={() => setOpen(true)}>
        <Sparkles />
        <span>Assistant</span>
      </button>
      {open && (
        <Dialog title='Assistant' onClose={() => setOpen(false)}>
          {/* Toasts of its own, since the page's, outside the dialog, are behind it and inert while it's open */}
          <Toaster>
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
          </Toaster>
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
        <button type='button' className='sorlo-button sorlo-button--primary' aria-busy={saving} onClick={save}>
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
            className='sorlo-button sorlo-button--primary'
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
              <button type='button' className='sorlo-button' onClick={() => setRenaming(true)}>
                Rename
              </button>
              <button type='button' className='sorlo-button sorlo-button--danger' onClick={remove}>
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
