import { idsOf } from '../src/fields'
import { versionSchema } from '../src/schemas'
import {
  ContentType,
  Entry,
  SectionContext,
  api,
  date,
  errorMessage,
  formatValue,
  personOf,
  shortDate,
  titleOf,
  usePageView,
} from './api'
import { Change, compare, compareParent, diffLines, diffWords, linksOf, parentField, toJson } from './compare'
import { Version, restoreOnOpen, viaText } from './entries'
import { useLinkNames } from './fields'
import { Badge, Loading, Notice, PageHeader, Panel, StatusBadge, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FieldSchema, FormHandle } from '@sorlo/forms'
import { Trash2 } from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'

// Comparing versions: a version's page, with what it changed from the version before it or from
// another one, its name, and Restore and Delete

export const kinds = {
  added: ['Added', 'success'],
  removed: ['Removed', 'danger'],
  changed: ['Changed', 'warning'],
} as const

// Such as Launch copy, or Version 3 for a version with no name
export const nameOf = (version: Version) => version.name ?? `Version ${version.number}`

// Who last published a version, and through which MCP token or with the assistant, and when
const publishedBy = (version: Version) =>
  `${personOf(version.publishedBy)}${viaText(version.publishedVia)} · ${shortDate(version.publishedAt!)}`

// Who saved a version, and through which MCP token or with the assistant, and when
const savedBy = (version: Version) =>
  `${personOf(version.createdBy)}${viaText(version.via)} · ${shortDate(version.createdAt)}`

// A value as text: entries' titles and files' names, Yes or No for a box, and otherwise what the lists show
function valueText(field: FieldSchema, value: unknown, links: Record<string, string | null>) {
  if (field === parentField && value === null) return 'None, at the top'
  if (field.type === 'relationship' || field.type === 'media' || field.type === 'form') {
    const gone = { media: 'A deleted file', relationship: 'A deleted entry', form: 'A form not made yet' }[field.type]
    return idsOf(value)
      .map((id) => (links[id] === undefined ? 'Loading…' : (links[id] ?? gone)))
      .join(', ')
  }
  if (field.type === 'boolean') return value ? 'Yes' : 'No'
  return formatValue(field, value)
}

// A long text's words, with those added and removed marked, and named for screen readers, which don't announce
// <ins> and <del>
const TextChanges = ({ before, after }: { before: string; after: string }) => (
  <p className='cms-change__text'>
    {diffWords(before, after).map(({ kind, text }, index) => {
      if (kind === 'same') return text
      const Mark = kind === 'added' ? 'ins' : 'del'
      return (
        <Mark key={index}>
          <span className='cms-visually-hidden'>{kind === 'added' ? 'Added: ' : 'Removed: '}</span>
          {text}
        </Mark>
      )
    })}
  </p>
)

// Each changed field by its path of labels: what it held before and after, a long text's words added and removed, or
// the items of a list added, removed and changed, with the changes inside them
export function ChangeList({
  changes,
  links,
  nested = false,
}: {
  changes: Array<Change>
  // Linked entries' titles and files' names by ID
  links: Record<string, string | null>
  nested?: boolean
}) {
  // Items can nest to any depth, so only the top level's labels are headings
  const Label = nested ? 'div' : 'h3'
  return (
    <ol className='cms-changes'>
      {changes.map((change, index) => (
        <li key={index}>
          <div className='cms-change__head'>
            <Label className='cms-change__label'>{change.labels.join(' › ')}</Label>
            <Badge tone={kinds[change.kind][1]}>{kinds[change.kind][0]}</Badge>
          </div>
          {change.items ? (
            <ol className='cms-change__items'>
              {change.items.map((item, index) => (
                <li key={index}>
                  <div className='cms-change__head'>
                    <div className='cms-change__label'>{item.label}</div>
                    <Badge tone={kinds[item.kind][1]}>{kinds[item.kind][0]}</Badge>
                  </div>
                  {item.changes.length > 0 && <ChangeList changes={item.changes} links={links} nested />}
                </li>
              ))}
            </ol>
          ) : change.kind === 'changed' && (change.field.type === 'textarea' || change.field.type === 'markdown') ? (
            <TextChanges before={String(change.before)} after={String(change.after)} />
          ) : (
            <dl className='cms-pairs'>
              {change.kind !== 'added' && (
                <div>
                  <dt>Before</dt>
                  <dd>{valueText(change.field, change.before, links)}</dd>
                </div>
              )}
              {change.kind !== 'removed' && (
                <div>
                  <dt>After</dt>
                  <dd>{valueText(change.field, change.after, links)}</dd>
                </div>
              )}
            </dl>
          )}
        </li>
      ))}
    </ol>
  )
}

// Two versions' values as JSON, for the more technical, a line each: the lines added and removed marked with a sign and
// a tint, and named for screen readers. It shows every key stored, those no field reads included.
export const JsonChanges = ({ before, after }: { before: unknown; after: unknown }) => (
  <pre className='cms-json-diff'>
    {diffLines(toJson(before), toJson(after)).flatMap(({ kind, text }, part) =>
      text
        .replace(/\n$/, '')
        .split('\n')
        .map((line, index) => {
          if (kind === 'same') return <span key={`${part}.${index}`}>{`  ${line}`}</span>
          const Mark = kind === 'added' ? 'ins' : 'del'
          return (
            <Mark key={`${part}.${index}`}>
              <span className='cms-visually-hidden'>{kind === 'added' ? 'Added: ' : 'Removed: '}</span>
              <span aria-hidden>{kind === 'added' ? '+ ' : '− '}</span>
              {line}
            </Mark>
          )
        }),
    )}
  </pre>
)

// A version's page. It compares the version with the one before it, or with any other picked, such as the live one,
// which shows what publishing it would change, always from the older of the two to the newer. Its panel has Restore,
// except for the current version, its name, and Delete, except for the current and live versions. An archived
// entry's versions can only be read.
export function VersionPage({ id, number, types }: { id: string; number: number; types: Map<string, ContentType> }) {
  const [entry, setEntry] = useState<Entry>()
  const [versions, setVersions] = useState<Array<Version>>()
  // Versions' values by number, as the version route brings them up to date with the content migrations
  const [values, setValues] = useState<Record<number, { values: Record<string, any>; parentId: string | null }>>({})
  const requested = useRef(new Set<number>())
  // The version it's compared with, or null for none, when every field counts as added
  const [against, setAgainst] = useState<number | null>()
  const [compareStart, setCompareStart] = useState<{ against: string; view: string }>()
  // As JSON, as the user chose on 31 October 2026, or field by field
  const [view, setView] = useState('json')
  const [name, setName] = useState<{ name?: string }>({})
  const [nameStart, setNameStart] = useState<{ name: string }>()
  const nameForm = useRef<FormHandle>(null)
  const nameArea = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState<string>()
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    Promise.all([api('GET', `/entries/${id}`), api('GET', `/entries/${id}/versions`)])
      .then(([found, listed]) => {
        setEntry(found.body.data)
        setVersions(listed.body.data)
      })
      .catch((error) => setError(errorMessage(error)))
  }, [id])

  const showSection = useContext(SectionContext)
  useEffect(() => {
    if (entry) showSection(`types/${entry.type}`)
  }, [entry, showSection])

  const version = versions?.find((version) => version.number === number)

  // Compared with the version before it at first, which is the next one down the list, since numbers never shift
  useEffect(() => {
    if (!versions || !version || compareStart) return
    const before = versions.find((other) => other.number < number)?.number ?? null
    setAgainst(before)
    setCompareStart({ against: before === null ? '' : String(before), view: 'json' })
    // So Save name sends the name it has until the field changes
    setNameStart({ name: version.name ?? '' })
    setName({ name: version.name ?? '' })
  }, [versions])

  const wanted = [number, against].filter((wanted) => typeof wanted === 'number' && !requested.current.has(wanted))
  useEffect(() => {
    if (!version) return
    for (const wanting of wanted as Array<number>) {
      requested.current.add(wanting)
      api('GET', `/entries/${id}/versions/${wanting}`)
        .then(({ body }) => setValues((all) => ({ ...all, [wanting]: body.data })))
        .catch((error) => setError(errorMessage(error)))
    }
  }, [version, wanted.join()])

  const type = entry && types.get(entry.type)
  // The assistant beside the page takes "this" to be the version
  usePageView(
    entry && type
      ? { page: { entry: entry.id, version: number }, label: `${titleOf(type, entry)}, version ${number}` }
      : null,
  )
  const [older, newer] =
    typeof against !== 'number' ? [undefined, number] : against < number ? [against, number] : [number, against]
  const ready = !!type && newer in values && (older === undefined || older in values)
  const changes = useMemo(() => {
    if (!ready) return undefined
    const [was, is] = [older === undefined ? undefined : values[older], values[newer]]
    // A page's move comes first, as its parent picker does in the editor
    const moved = type!.structure === 'hierarchical' ? compareParent(was?.parentId, is.parentId) : []
    return [...moved, ...compare(type!.fields, was?.values, is.values)]
  }, [ready, older, newer])
  const linked = linksOf(changes ?? [])
  const links = useLinkNames(linked.entries, linked.files, linked.forms)

  const drafts = type?.drafts !== false
  const current = versions?.[0]
  // A version as the list to compare with names it, such as Launch copy (version 3, live)
  const describe = (other: Version) => {
    const notes = [
      other.name && `version ${other.number}`,
      drafts && other.number === entry?.publishedVersion && 'live',
      other === current && 'current',
    ].filter(Boolean)
    return notes.length ? `${nameOf(other)} (${notes.join(', ')})` : nameOf(other)
  }

  const compareSchema = useMemo<Array<FieldSchema>>(
    () => [
      {
        name: 'against',
        label: 'Compare with',
        type: 'select',
        options: {
          placeholder: 'Nothing, so every field counts as added',
          choices: (versions ?? [])
            .filter((other) => other.number !== number)
            .map((other) => ({ value: String(other.number), label: describe(other) })),
        },
      },
      {
        name: 'view',
        label: 'Show changes',
        type: 'radio',
        options: {
          choices: [
            { value: 'fields', label: 'By field' },
            { value: 'json', label: 'As JSON' },
          ],
        },
      },
    ],
    [versions, entry],
  )

  if (error) return <Notice tone='danger'>{error}</Notice>
  if (!entry || !type || !versions) return <Loading />
  if (!version) return <Notice tone='danger'>Version {number} doesn't exist, or it was deleted.</Notice>

  const archived = !!entry.archivedAt
  // A page's versions as JSON hold the parent each was saved under beside its values
  const asJson = (saved: (typeof values)[number]) =>
    type.structure === 'hierarchical' ? { parentId: saved.parentId, values: saved.values } : saved.values
  const isCurrent = version === current
  const live = drafts && version.number === entry.publishedVersion
  const editor = type.structure === 'singleton' ? `#/types/${type.name}` : `#/entries/${entry.id}`
  const sideOf = (side: number | undefined) => {
    const shown = versions.find((other) => other.number === side)
    return shown ? `${describe(shown)} · ${savedBy(shown)}` : 'Nothing'
  }

  // Run an action, showing what went wrong if it fails. A second click while one runs is ignored.
  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(name)
    setProblem('')
    try {
      await action()
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(undefined)
    }
  }

  // Restoring puts the version's values in the entry's form, to save as its newest version, as Restore there does
  const restore = () => {
    restoreOnOpen(entry.id, version)
    location.hash = editor
  }

  const saveName = () =>
    act('name', async () => {
      const showInvalid = () => focusInvalid(nameArea.current).then(setProblem)
      if (!nameForm.current!.validate().isValid) return showInvalid()
      const { status, body } = await api('PUT', `/entries/${entry.id}/versions/${number}`, { name: name.name ?? '' })
      if (status === 422) {
        nameForm.current!.applyReport(body)
        return showInvalid()
      }
      setVersions((all) => all?.map((other) => (other.number === number ? body.data : other)))
      toast(body.data.name ? `Named version ${number}` : `Removed the name of version ${number}`)
    })

  // It asks before the action starts, so the dialog hands focus back to Delete
  const remove = async () => {
    const sure = await confirm({
      title: `Delete ${version.name ? `${version.name} (version ${number})` : `version ${number}`} for good?`,
      body: "This can't be undone. The other versions keep their numbers.",
      action: 'Delete version',
      danger: true,
    })
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/entries/${entry.id}/versions/${number}`)
      toast(`Deleted version ${number}`)
      location.hash = editor
    })
  }

  return (
    <div>
      <PageHeader
        back={{ href: editor, label: titleOf(type, entry) }}
        title={nameOf(version)}
        meta={
          <>
            {version.name && <span className='cms-muted'>Version {number}</span>}
            {isCurrent && <Badge tone='accent'>Current</Badge>}
            {live && <StatusBadge status='published' />}
          </>
        }
      />

      {archived && (
        <Notice tone='warning'>
          Archived on {date(entry.archivedAt!)}. Restore the entry to restore, name or delete its versions.
        </Notice>
      )}
      {number > 1 && !versions.some((other) => other.number < number) && (
        <Notice>The versions before this one were deleted, so there's nothing earlier to compare it with.</Notice>
      )}
      {compareStart && (
        <Form
          schema={compareSchema}
          values={compareStart}
          onValuesChange={(next) => {
            setAgainst(next.against ? Number(next.against) : null)
            setView(next.view)
          }}
        />
      )}

      <h2>Changes</h2>
      <dl className='cms-pairs'>
        <div>
          <dt>Before</dt>
          <dd>{sideOf(older)}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>{sideOf(newer)}</dd>
        </div>
      </dl>
      {!changes ? (
        <Loading />
      ) : view === 'json' ? (
        <JsonChanges before={older === undefined ? undefined : asJson(values[older])} after={asJson(values[newer])} />
      ) : changes.length ? (
        <ChangeList changes={changes} links={links} />
      ) : (
        <p className='cms-muted'>Nothing changed between them.</p>
      )}

      <Panel
        label='About this version'
        problem={problem}
        actions={
          !isCurrent &&
          !archived && (
            <button type='button' className='sorlo-button sorlo-button--primary' onClick={restore}>
              Restore
            </button>
          )
        }
        footer={
          !isCurrent &&
          !live &&
          !archived && (
            <button
              type='button'
              className='sorlo-button sorlo-button--danger'
              aria-busy={busy === 'delete'}
              onClick={remove}
            >
              <Trash2 /> {busy === 'delete' ? 'Deleting…' : 'Delete version'}
            </button>
          )
        }
      >
        <section>
          <h2>Saved</h2>
          <p>{savedBy(version)}</p>
          {version.via?.kind === 'chat' &&
            (version.via.name === null ? (
              <p className='cms-muted'>The chat it came from has been deleted.</p>
            ) : (
              <p>
                <a href={`#/chat?id=${version.via.id}`}>Read the chat it came from</a>
              </p>
            ))}
        </section>
        {drafts && version.publishedAt && (
          <section>
            <h2>Last published</h2>
            <p>{publishedBy(version)}</p>
          </section>
        )}
        {!archived && nameStart && (
          // Core's form has no submit button, so Enter in the field saves from here
          <div
            ref={nameArea}
            className='cms-version-name'
            onKeyDown={(event) => event.key === 'Enter' && event.target instanceof HTMLInputElement && saveName()}
          >
            <Form ref={nameForm} schema={versionSchema} values={nameStart} onValuesChange={setName} />
            <button type='button' className='sorlo-button' aria-busy={busy === 'name'} onClick={saveName}>
              {busy === 'name' ? 'Saving…' : 'Save name'}
            </button>
          </div>
        )}
      </Panel>
    </div>
  )
}
