import { collapseUses, mapFields } from '../src/fields'
import { typeSchema } from '../src/schemas'
import { ContentType, SharedGroup, api, errorMessage, navigation, usePageView } from './api'
import { useBeside } from './chat'
import { toJson } from './compare'
import { iconInput, useInputs } from './fields'
import { MakeShared, TypeGroups, UseShared } from './groups'
import { Badge, EmptyState, Notice, PageHeader, Panel, TypeIcon, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FieldSchema, FormHandle } from '@sorlo/core'
import { Blocks, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

// The builder is a form of its own, so a new choice in the settings never resets an editor open in it
const fieldsSchema: Array<FieldSchema> = [{ name: 'fields', label: 'Fields', type: 'schemabuilder' }]

const settingsInputs = { icon: iconInput }

const readOnly = 'Content types can only be changed in development, with sorlo dev. Their changes ship through git.'

// What a save said, kept for the page it moves to when a type is created or renamed
let flash: { message: string; migration?: boolean; notes: Array<string> } | undefined

// What the settings form starts from for a type, where drafts are on unless its file says otherwise
const settingsOf = (type?: ContentType) => {
  const { fields, id, ...rest } = type ?? { structure: 'collection' }
  return { drafts: true, ...rest } as Record<string, any>
}

// A type's settings and fields as its file would hold them, as the server writes them, so two compare equal when a save
// would write the same
const asFile = (settings: Record<string, any>, fields: Array<FieldSchema>) =>
  toJson({
    name: settings.name,
    label: settings.label,
    singular: settings.singular || undefined,
    structure: settings.structure,
    drafts: settings.drafts === false ? false : undefined,
    icon: settings.icon || undefined,
    titleField: settings.titleField || undefined,
    slugField: settings.slugField || undefined,
    listColumns: settings.listColumns?.length ? settings.listColumns : undefined,
    fields,
  })

// Every content type, each opening in the type editor
export function TypeList({ types, editable }: { types: Map<string, ContentType>; editable: boolean }) {
  const newType = editable && (
    <a className='sorlo-button sorlo-button--primary' href='#/schema/new'>
      <Plus /> New content type
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='Content types' />
      <Panel label='Content types' actions={newType} />
      {!editable && <Notice>{readOnly}</Notice>}
      {types.size === 0 ? (
        <EmptyState icon={<Blocks />} action={newType}>
          {editable ? 'No content types yet.' : 'No content types yet. Add one to schema/types to get started.'}
        </EmptyState>
      ) : (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Label</th>
                <th>Name</th>
                <th>Structure</th>
                <th className='cms-table__number'>Fields</th>
              </tr>
            </thead>
            <tbody>
              {[...types.values()].map((type) => (
                <tr key={type.name}>
                  <td>
                    <a className='cms-type-link' href={`#/schema/${type.name}`}>
                      <TypeIcon name={type.icon} />
                      {type.label}
                    </a>
                  </td>
                  <td>
                    <code>{type.name}</code>
                  </td>
                  <td>
                    <Badge>{type.structure}</Badge>
                  </td>
                  <td className='cms-table__number'>{type.fields.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Create or change a content type: its settings, and its fields in core's schema builder. Saving writes the type's file
// and a content migration for the change, whose flags and TODOs the page lists. Its own groups can become shared, or
// give way to a shared group, beside the form. Beside the assistant, "this" is the type, and a proposal for it applied
// there loads it again.
export function TypeEditor({
  type,
  editable,
  onSaved,
}: {
  type?: ContentType
  editable: boolean
  // Loads the types again, replying them
  onSaved: () => Promise<Map<string, ContentType>>
}) {
  const settingsForm = useRef<FormHandle>(null)
  const fieldsForm = useRef<FormHandle>(null)
  // Around both forms, for finding the fields that stop a save
  const forms = useRef<HTMLFieldSetElement>(null)
  const inputs = useInputs()
  const confirm = useConfirm()
  const toast = useToast()
  const [settings, setSettings] = useState(() => settingsOf(type))
  // What the settings form starts from, replaced only when a renamed field takes a setting with it
  const [shown, setShown] = useState(settings)
  // As the type's file has them, with each use of a shared group as its Shared group field
  const [fields, setFields] = useState<Array<FieldSchema>>(() => collapseUses(type?.fields ?? []))
  // What the builder starts from, replaced only when a group is swapped for a shared one
  const [shownFields, setShownFields] = useState({ fields })
  // The group a swap dialog is open for, and the swapped one, whose link takes focus once it shows
  const [making, setMaking] = useState<FieldSchema>()
  const [using, setUsing] = useState<FieldSchema>()
  const [swapped, setSwapped] = useState<string>()
  const schema = useMemo(() => typeSchema(fields), [fields])
  // Taken once, by the page the save moved to, since the editor it left renders again before it goes
  const [result, setResult] = useState(() => {
    const saved = flash
    flash = undefined
    return saved
  })
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()

  // The type as the editor loaded it, or last saved it, which Save sends back, so the server can refuse to write over a
  // change made since, and which tells whether the forms hold changes
  const [base, setBase] = useState(type)
  // From Apply until the editor has loaded what the assistant changed, or for good once loading it again failed
  const [held, setHeld] = useState(false)
  const [failed, setFailed] = useState('')
  const locked = held || !!failed

  usePageView(base ? { page: { schema: base.name }, label: base.label } : null)
  // The forms hold changes when a save would write something else than what was loaded, however they were made, such
  // as by typing, pasting or dictating, which the assistant beside the editor asks to have saved before it applies a
  // proposal to the type
  const loaded = useMemo(() => base && asFile(settingsOf(base), collapseUses(base.fields)), [base])
  // Once a proposal for the type is applied, the editor loads it again, or opens it under its new name, leaving focus
  // where it is, since a later Save would otherwise send back what it showed before
  useBeside(
    {
      shows: (proposal) => proposal.kind === 'type' && proposal.targetId === base?.id,
      touched: () => !!loaded && asFile(settings, fields) !== loaded,
      hold: setHeld,
      reload: async () => {
        try {
          const now = [...(await onSaved()).values()].find((each) => each.id === base?.id)
          if (!now) throw new Error("it isn't one of the site's content types now")
          if (now.name !== base!.name) {
            navigation.keepFocus = true
            return location.replace(`#/schema/${now.name}`)
          }
          setSettings(settingsOf(now))
          setShown(settingsOf(now))
          setFields(collapseUses(now.fields))
          setShownFields({ fields: collapseUses(now.fields) })
          setBase(now)
          setResult(undefined)
          setFailed('')
        } catch (error) {
          setFailed(
            `The assistant changed this type, but the editor couldn't load it again: ${errorMessage(error)}. Reload ` +
              'the page before you change it.',
          )
        }
      },
    },
    !!type,
  )

  // Settings that name a field follow it when the builder renames it, and let it go when it's removed
  const changeFields = (next: Array<FieldSchema> = []) => {
    const follow = (name: unknown) => {
      const id = fields.find((field) => field.name === name)?.id
      return id ? next.find((field) => field.id === id)?.name : undefined
    }
    const followed: Record<string, any> = {
      ...settings,
      titleField: follow(settings.titleField),
      slugField: follow(settings.slugField),
      listColumns: (settings.listColumns ?? []).map(follow).filter(Boolean),
    }
    const moved =
      ['titleField', 'slugField'].some((key) => (settings[key] || undefined) !== followed[key]) ||
      JSON.stringify(settings.listColumns ?? []) !== JSON.stringify(followed.listColumns)
    if (moved) {
      setSettings(followed)
      setShown(followed)
    }
    setFields(next)
  }

  // One of the type's own groups, at any depth, swapped for a use of a shared group, which keeps the group's id and its
  // own settings, so its entries keep the values whose names match
  const swap = (field: FieldSchema, group: SharedGroup) => {
    const { fields: _, ...options } = field.options ?? {}
    const use = { ...field, type: 'shared', options: { ...options, group: group.id } }
    const next = mapFields(fields, (each) => (each.id === field.id ? use : each))
    changeFields(next)
    setShownFields({ fields: next })
    setSwapped(field.id)
  }

  // The swap's button went with its group, so once the dialog has closed and handed focus back, it moves to the shared
  // group the use links to
  useEffect(() => {
    if (!swapped || making || using) return
    document.querySelector<HTMLElement>(`[data-use="${swapped}"]`)?.focus()
    setSwapped(undefined)
  })

  // Run an action, showing what went wrong if it fails. The buttons stay enabled, so the focused one keeps focus, and
  // a second click is ignored here instead.
  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy || locked) return
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

  // Once the forms have shown their messages
  const showInvalid = () => focusInvalid(forms.current).then(setProblem)

  const save = () =>
    act('save', async () => {
      if (!settingsForm.current?.validate().isValid) return showInvalid()
      const body = { ...settings, fields, ...(base && { loaded: base }) }
      const { status, body: reply } = type
        ? await api('PUT', `/types/${type.name}`, body)
        : await api('POST', '/types', body)

      if (status === 422) {
        settingsForm.current.applyReport(reply)
        fieldsForm.current?.applyReport(reply)
        return showInvalid()
      }

      // The migration it wrote stays on the page, since it names a file to check and may have TODOs
      const { file, notes } = reply.migration
      const saved = file
        ? { message: `Saved, with the migration migrations/${file}.`, migration: true, notes }
        : { message: 'Saved. No entries need a migration.', notes }
      toast('Saved')
      setBase(reply.data)
      await onSaved()
      if (reply.data.name === type?.name) return setResult(saved)
      flash = saved
      location.hash = `#/schema/${reply.data.name}`
    })

  // It asks before the action starts, so the question's dialog hands focus back to Delete
  const remove = async () => {
    if (locked) return
    const sure = await confirm({
      title: `Delete the content type ${type!.label}?`,
      body: 'Its entries stay until you delete them, and sorlo migrate --check lists them.',
      action: 'Delete',
      danger: true,
    })
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/types/${type!.name}`)
      toast('Deleted')
      await onSaved()
      location.hash = '#/schema'
    })
  }

  return (
    <div>
      <PageHeader
        back={{ href: '#/schema', label: 'Content types' }}
        title={type ? type.label : 'New content type'}
        meta={type && <Badge>{type.structure}</Badge>}
      />

      <fieldset ref={forms} className='cms-lock' disabled={locked}>
        {failed && <Notice tone='danger'>{failed}</Notice>}
        {held && <Notice>Loading the assistant's change to this type…</Notice>}
        {!editable && <Notice>{readOnly}</Notice>}
        {result && (
          <Notice tone='success'>
            {result.message}
            {result.migration && (
              <>
                {' '}
                <a href='#/migrations'>Review and run it on Migrations</a>.
              </>
            )}
            {result.notes.length > 0 && (
              <ul>
                {result.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
        <Form ref={settingsForm} schema={schema} inputs={settingsInputs} values={shown} onValuesChange={setSettings} />
        <Form
          ref={fieldsForm}
          schema={fieldsSchema}
          inputs={inputs}
          values={shownFields}
          onValuesChange={(next) => changeFields(next.fields)}
        />
      </fieldset>

      <Panel
        label='Details'
        problem={problem}
        actions={
          editable && (
            <button
              type='button'
              className='sorlo-button sorlo-button--primary'
              aria-busy={busy === 'save'}
              aria-disabled={locked || undefined}
              onClick={save}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          )
        }
        footer={
          editable &&
          type && (
            <button
              type='button'
              className='sorlo-button sorlo-button--danger'
              aria-disabled={locked || undefined}
              onClick={remove}
            >
              <Trash2 /> Delete
            </button>
          )
        }
      >
        {/* How the menu will show the type, following the settings as they're typed */}
        <section>
          <h2>In the menu</h2>
          <p className='cms-type-preview'>
            <TypeIcon name={settings.icon} />
            {settings.label || 'Untitled'}
          </p>
        </section>
        <fieldset className='cms-lock' disabled={locked}>
          <TypeGroups fields={fields} editable={editable} onMakeShared={setMaking} onUseShared={setUsing} />
        </fieldset>
      </Panel>

      {making && (
        <MakeShared
          field={making}
          onClose={() => setMaking(undefined)}
          onMade={async (group) => {
            await onSaved()
            swap(making, group)
            toast(`Made ${group.label} shared. Save to use it here.`)
          }}
        />
      )}
      {using && <UseShared field={using} onClose={() => setUsing(undefined)} onUse={(group) => swap(using, group)} />}
    </div>
  )
}
