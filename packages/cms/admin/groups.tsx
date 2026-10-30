import { isUse, someField, usesOf } from '../src/fields'
import { groupSchema } from '../src/schemas'
import { ContentType, GroupsContext, SharedGroup, TypesContext, api, errorMessage } from './api'
import { useInputs } from './fields'
import { Dialog, EmptyState, Notice, PageHeader, focusInvalid, useConfirm, useToast } from './ui'
import Form, { FieldSchema, FormHandle } from 'iight'
import { CircleAlert, Component, Plus, Trash2 } from 'lucide-react'
import { MouseEvent, useContext, useRef, useState } from 'react'

// Shared groups (PLAN.md section 19): fields defined once in schema/groups, which types use through Shared group
// fields. Their list and editor sit beside content types, and the type editor swaps a type's own groups for them.

// The builder is a form of its own, as in the type editor
const fieldsSchema: Array<FieldSchema> = [{ name: 'fields', label: 'Fields', type: 'schemabuilder' }]

const readOnly = 'Shared groups can only be changed in development, with iight dev. Their changes ship through git.'

// What a save said, kept for the page it moves to when a group is created or renamed
let flash: { message: string; notes: Array<string> } | undefined

const byId = (groups: Map<string, SharedGroup>) => new Map([...groups.values()].map((group) => [group.id, group]))

// The types that use a shared group, through other groups too, and the groups that use it
function usersOf(group: SharedGroup, types: Map<string, ContentType>, groups: Map<string, SharedGroup>) {
  const uses = (field: FieldSchema) => isUse(field) && field.options!.group === group.id
  return [
    ...[...types.values()]
      .filter((type) => someField(type.fields, uses))
      .map((type) => ({ href: `#/schema/${type.name}`, label: type.label })),
    ...[...groups.values()]
      .filter((other) => usesOf(other.fields).includes(group.id))
      .map((other) => ({ href: `#/groups/${other.name}`, label: other.label })),
  ]
}

// Every shared group, each opening in its editor
export function GroupList({ groups, editable }: { groups: Map<string, SharedGroup>; editable: boolean }) {
  const types = useContext(TypesContext)
  const newGroup = editable && (
    <a className='iight-button iight-button--primary' href='#/groups/new'>
      <Plus /> New shared group
    </a>
  )

  return (
    <div className='cms-page'>
      <PageHeader title='Shared groups' actions={newGroup} />
      {!editable && <Notice>{readOnly}</Notice>}
      {groups.size === 0 ? (
        <EmptyState icon={<Component />} action={newGroup}>
          {editable
            ? 'No shared groups yet. Make one here, or with Make shared in the type editor.'
            : 'No shared groups yet. Add one to schema/groups to get started.'}
        </EmptyState>
      ) : (
        <div className='cms-table-wrap'>
          <table className='cms-table'>
            <thead>
              <tr>
                <th>Label</th>
                <th>Name</th>
                <th>Used by</th>
                <th className='cms-table__number'>Fields</th>
              </tr>
            </thead>
            <tbody>
              {[...groups.values()].map((group) => {
                const users = usersOf(group, types, groups)
                return (
                  <tr key={group.name}>
                    <td>
                      <a href={`#/groups/${group.name}`}>{group.label}</a>
                    </td>
                    <td>
                      <code>{group.name}</code>
                    </td>
                    <td>
                      {users.length ? users.map((user) => user.label).join(', ') : <span className='cms-muted'>–</span>}
                    </td>
                    <td className='cms-table__number'>{group.fields.length}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Create or change a shared group: its settings, and its fields in core's schema builder. Saving writes its file and a
// content migration for every type that uses it, whose flags and TODOs the page lists.
export function GroupEditor({
  group,
  editable,
  onSaved,
}: {
  group?: SharedGroup
  editable: boolean
  onSaved: () => Promise<void>
}) {
  const settingsForm = useRef<FormHandle>(null)
  const fieldsForm = useRef<FormHandle>(null)
  // Around both forms, for finding the fields that stop a save
  const forms = useRef<HTMLDivElement>(null)
  const types = useContext(TypesContext)
  const groups = useContext(GroupsContext)
  const inputs = useInputs(group?.id)
  const confirm = useConfirm()
  const toast = useToast()
  const [shown] = useState({ label: group?.label, name: group?.name })
  const [settings, setSettings] = useState<Record<string, any>>(shown)
  const [fields, setFields] = useState<Array<FieldSchema>>(group?.fields ?? [])
  const [shownFields] = useState({ fields })
  // Taken once, by the page the save moved to, since the editor it left renders again before it goes
  const [result, setResult] = useState(() => {
    const saved = flash
    flash = undefined
    return saved
  })
  const [problem, setProblem] = useState('')
  // The action under way, such as save
  const [busy, setBusy] = useState<string>()
  const users = group ? usersOf(group, types, groups) : []

  // Run an action, showing what went wrong if it fails, as the type editor does
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

  // Once the forms have shown their messages
  const showInvalid = () => focusInvalid(forms.current).then(setProblem)

  const save = () =>
    act('save', async () => {
      if (!settingsForm.current?.validate().isValid) return showInvalid()
      const body = { ...settings, fields }
      const { status, body: reply } = group
        ? await api('PUT', `/groups/${group.name}`, body)
        : await api('POST', '/groups', body)

      if (status === 422) {
        settingsForm.current.applyReport(reply)
        fieldsForm.current?.applyReport(reply)
        return showInvalid()
      }

      // The migration it wrote stays on the page, since it names a file to check and may have TODOs
      const { file, notes } = reply.migration
      const saved = file
        ? { message: `Saved, with the migration migrations/${file}. Run iight migrate to update the entries.`, notes }
        : { message: 'Saved. No entries need a migration.', notes }
      toast('Saved')
      await onSaved()
      if (reply.data.name === group?.name) return setResult(saved)
      flash = saved
      location.hash = `#/groups/${reply.data.name}`
    })

  // A group in use can't be deleted, which the API says without a question first
  const remove = async () => {
    const sure =
      users.length > 0 ||
      (await confirm({
        title: `Delete the shared group ${group!.label}?`,
        body: 'No type uses it, so no entries change.',
        action: 'Delete',
        danger: true,
      }))
    if (!sure) return
    act('delete', async () => {
      await api('DELETE', `/groups/${group!.name}`)
      toast('Deleted')
      await onSaved()
      location.hash = '#/groups'
    })
  }

  return (
    <div className='cms-page cms-editor'>
      <PageHeader
        back={{ href: '#/groups', label: 'Shared groups' }}
        title={group ? group.label : 'New shared group'}
      />

      <div className='cms-editor__body'>
        <div ref={forms} className='cms-editor__form'>
          {!editable && <Notice>{readOnly}</Notice>}
          {result && (
            <Notice tone='success'>
              {result.message}
              {result.notes.length > 0 && (
                <ul>
                  {result.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          <Form ref={settingsForm} schema={groupSchema} values={shown} onValuesChange={setSettings} />
          <Form
            ref={fieldsForm}
            schema={fieldsSchema}
            inputs={inputs}
            values={shownFields}
            onValuesChange={(next) => setFields(next.fields ?? [])}
          />
        </div>

        <aside className='cms-editor__aside' aria-label='Details'>
          <section className='cms-used-by'>
            <h2>Used by</h2>
            {users.length ? (
              <ul>
                {users.map((user) => (
                  <li key={user.href}>
                    <a href={user.href}>{user.label}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='cms-muted'>No type uses it yet.</p>
            )}
          </section>
        </aside>
      </div>

      {editable && (
        <div className='cms-action-bar'>
          <button
            type='button'
            className='iight-button iight-button--primary'
            aria-busy={busy === 'save'}
            onClick={save}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          {problem && (
            <p className='cms-problem' role='alert'>
              <CircleAlert /> {problem}
            </p>
          )}
          {group && (
            <button type='button' className='iight-button iight-button--danger cms-action-bar__end' onClick={remove}>
              <Trash2 /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// A type's groups at any depth, by the labels of the fields and layouts they sit in: its own, which can become shared,
// and its uses of shared groups, whose fields aren't its own
function groupsIn(
  fields: Array<FieldSchema>,
  at: Array<string> = [],
): Array<{ field: FieldSchema; at: Array<string> }> {
  return fields.flatMap((field) => {
    const here = [...at, field.label || field.name]
    if (field.type === 'shared') return [{ field, at: here }]
    return [
      ...(field.type === 'group' ? [{ field, at: here }] : []),
      ...groupsIn(field.options?.fields ?? [], here),
      ...(field.options?.layouts ?? []).flatMap((layout: { name: string; label?: string; fields?: FieldSchema[] }) =>
        groupsIn(layout.fields ?? [], [...here, layout.label || layout.name]),
      ),
    ]
  })
}

// The type editor's groups, beside its form: Make shared and Use shared group for each of its own, and a link to the
// shared group each use takes its fields from
export function TypeGroups({
  fields,
  editable,
  onMakeShared,
  onUseShared,
}: {
  fields: Array<FieldSchema>
  editable: boolean
  onMakeShared: (field: FieldSchema) => void
  onUseShared: (field: FieldSchema) => void
}) {
  const groups = useContext(GroupsContext)
  const shared = byId(groups)
  const found = groupsIn(fields)
  if (!found.length) return null

  return (
    <section>
      <h2>Groups</h2>
      <ul className='cms-groups'>
        {found.map(({ field, at }) => {
          // Named by their text and the group, such as Make shared Search and sharing
          const label = `group-${field.id}`
          const named = (action: string) => ({
            id: `${action}-${field.id}`,
            'aria-labelledby': `${action}-${field.id} ${label}`,
          })
          const group = field.type === 'shared' ? shared.get(field.options?.group) : undefined
          return (
            <li key={field.id}>
              <span id={label}>{at.join(' › ')}</span>
              {field.type === 'shared' ? (
                <span className='cms-muted'>
                  Uses{' '}
                  {group ? (
                    <a href={`#/groups/${group.name}`} data-use={field.id}>
                      {group.label}
                    </a>
                  ) : (
                    'a shared group'
                  )}
                </span>
              ) : (
                editable && (
                  <div className='cms-groups__actions'>
                    <button
                      {...named('make')}
                      type='button'
                      className='iight-button'
                      onClick={() => onMakeShared(field)}
                    >
                      Make shared
                    </button>
                    {groups.size > 0 && (
                      <button
                        {...named('use')}
                        type='button'
                        className='iight-button'
                        onClick={() => onUseShared(field)}
                      >
                        Use shared group
                      </button>
                    )}
                  </div>
                )
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Close the dialog a button is in, which hands focus back to what opened it
const closeDialog = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget.closest('dialog')?.close()

// Make shared: a new shared group from one of a type's own groups, with its fields, its name and its label to start
// from. The type editor then swaps its copy for a use.
export function MakeShared({
  field,
  onMade,
  onClose,
}: {
  field: FieldSchema
  onMade: (group: SharedGroup) => Promise<void>
  onClose: () => void
}) {
  const form = useRef<FormHandle>(null)
  const area = useRef<HTMLDivElement>(null)
  const [shown] = useState({ label: field.label || field.name, name: field.name })
  const [values, setValues] = useState<Record<string, any>>(shown)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const make = async (event: MouseEvent<HTMLButtonElement>) => {
    const dialog = event.currentTarget.closest('dialog')
    if (busy) return
    if (!form.current?.validate().isValid) return focusInvalid(area.current)
    setBusy(true)
    setProblem('')
    try {
      const { status, body } = await api('POST', '/groups', { ...values, fields: field.options?.fields ?? [] })
      if (status === 422) {
        form.current.applyReport(body)
        // The fields' problems have no field here to show under
        const fields = body.fields?.fields?.messages
        return fields ? setProblem(fields.join(' ')) : focusInvalid(area.current)
      }
      await onMade(body.data)
      dialog?.close()
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Make ${field.label || field.name} shared`}
      onClose={onClose}
      footer={
        <div className='cms-dialog-actions'>
          <button type='button' className='iight-button' onClick={closeDialog}>
            Cancel
          </button>
          <button type='button' className='iight-button iight-button--primary' aria-busy={busy} onClick={make}>
            {busy ? 'Making…' : 'Make shared'}
          </button>
        </div>
      }
    >
      <div ref={area}>
        <p>
          Its fields become a shared group in schema/groups, which other types can use too. This type uses it once you
          save, and its entries keep their values.
        </p>
        <Form ref={form} schema={groupSchema} values={shown} onValuesChange={setValues} />
        {problem && <Notice tone='danger'>{problem}</Notice>}
      </div>
    </Dialog>
  )
}

// Which of a copy's fields keep their values when a shared group's fields take their place, matched by name at every
// depth as the migration matches them, which lose them, and which keep them but change type
function compare(
  copy: Array<FieldSchema>,
  group: Array<FieldSchema>,
  groups: Map<string, SharedGroup>,
  path = '',
  found = { kept: [] as Array<string>, lost: [] as Array<string>, converted: [] as Array<string> },
) {
  const inside = (field: FieldSchema) =>
    (field.type === 'shared' ? groups.get(field.options?.group)?.fields : field.options?.fields) ?? []
  const kind = (field: FieldSchema) => (field.type === 'shared' ? 'group' : field.type)
  for (const field of copy) {
    const at = `${path}${field.name}`
    const match = group.find((other) => other.name === field.name)
    const layouts: Array<{ name: string; fields?: Array<FieldSchema> }> = field.options?.layouts ?? []
    if (!match) found.lost.push(at)
    else if (kind(match) !== kind(field)) found.converted.push(at)
    else if (!inside(field).length && !layouts.length) found.kept.push(at)
    else {
      compare(inside(field), inside(match), groups, `${at}.`, found)
      for (const layout of layouts) {
        const other = match.options?.layouts?.find((each: { name: string }) => each.name === layout.name)
        if (other) compare(layout.fields ?? [], other.fields ?? [], groups, `${at}.${layout.name}.`, found)
        else found.lost.push(`${at}.${layout.name}`)
      }
    }
  }
  return found
}

// Use shared group: one of a type's own groups swapped for a use of a shared group, showing which values the swap
// keeps and which it loses before the type editor makes it
export function UseShared({
  field,
  onUse,
  onClose,
}: {
  field: FieldSchema
  onUse: (group: SharedGroup) => void
  onClose: () => void
}) {
  const groups = useContext(GroupsContext)
  const shared = byId(groups)
  const schema: Array<FieldSchema> = [
    {
      name: 'group',
      label: 'Shared group',
      type: 'select',
      required: true,
      options: { choices: [...groups.values()].map((group) => ({ value: group.id, label: group.label })) },
    },
  ]
  // One with the copy's name, if there is one
  const [shown] = useState({ group: (groups.get(field.name) ?? [...groups.values()][0])?.id })
  const [values, setValues] = useState<Record<string, any>>(shown)
  const group = shared.get(values.group)
  const { kept, lost, converted } = compare(field.options?.fields ?? [], group?.fields ?? [], shared)

  return (
    <Dialog
      title={`Use a shared group for ${field.label || field.name}`}
      onClose={onClose}
      footer={
        <div className='cms-dialog-actions'>
          <button type='button' className='iight-button' onClick={closeDialog}>
            Cancel
          </button>
          <button
            type='button'
            className='iight-button iight-button--primary'
            onClick={(event) => {
              if (!group) return
              onUse(group)
              closeDialog(event)
            }}
          >
            {group ? `Use ${group.label}` : 'Use it'}
          </button>
        </div>
      }
    >
      <p>
        Its fields give way to the shared group's, and saving writes a migration that keeps the values whose field names
        match.
      </p>
      <Form schema={schema} values={shown} onValuesChange={setValues} />
      {group && (
        <>
          <p>
            {kept.length ? `Keeps the values of ${kept.join(', ')}.` : 'Keeps no values, since no field names match.'}
          </p>
          {lost.length > 0 && (
            <Notice tone='warning'>
              Deletes the values of {lost.join(', ')}. The migration flags them, and old versions keep them.
            </Notice>
          )}
          {converted.length > 0 && (
            <Notice tone='warning'>
              {converted.join(', ')} {converted.length > 1 ? 'change' : 'changes'} type, so the migration has a TODO to
              convert {converted.length > 1 ? 'their' : 'its'} values.
            </Notice>
          )}
        </>
      )}
    </Dialog>
  )
}
