import { typeSchema } from '../src/schemas'
import { ContentType, api, errorMessage } from './api'
import { useInputs } from './fields'
import Form, { FieldSchema, FormHandle } from 'iight'
import { useMemo, useRef, useState } from 'react'

// The builder is a form of its own, so a new choice in the settings never resets an editor open in it
const fieldsSchema: Array<FieldSchema> = [{ name: 'fields', label: 'Fields', type: 'schemabuilder' }]

const readOnly = 'Content types can only be changed in development, with iight dev. Their changes ship through git.'

// What a save said, kept for the page it moves to when a type is created or renamed
let flash: { message: string; notes: Array<string> } | undefined

// Every content type, each opening in the type editor
export function TypeList({ types, editable }: { types: Map<string, ContentType>; editable: boolean }) {
  return (
    <>
      <header>
        <h1>Content types</h1>
        {editable && <a href='#/schema/new'>New content type</a>}
      </header>
      {!editable && <p role='status'>{readOnly}</p>}
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Name</th>
            <th>Structure</th>
            <th>Fields</th>
          </tr>
        </thead>
        <tbody>
          {[...types.values()].map((type) => (
            <tr key={type.name}>
              <td>
                <a href={`#/schema/${type.name}`}>{type.label}</a>
              </td>
              <td>{type.name}</td>
              <td>{type.structure}</td>
              <td>{type.fields.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

// Create or change a content type: its settings, and its fields in core's schema builder. Saving writes the type's file
// and a content migration for the change, whose flags and TODOs the page lists.
export function TypeEditor({
  type,
  editable,
  onSaved,
}: {
  type?: ContentType
  editable: boolean
  onSaved: () => Promise<void>
}) {
  const settingsForm = useRef<FormHandle>(null)
  const fieldsForm = useRef<FormHandle>(null)
  const inputs = useInputs()
  const [settings, setSettings] = useState<Record<string, any>>(() => {
    const { fields, id, ...rest } = type ?? { structure: 'collection' }
    return rest
  })
  // What the settings form starts from, replaced only when a renamed field takes a setting with it
  const [shown, setShown] = useState(settings)
  const [fields, setFields] = useState<Array<FieldSchema>>(type?.fields ?? [])
  const [shownFields] = useState({ fields })
  const schema = useMemo(() => typeSchema(fields), [fields])
  // Taken once, by the page the save moved to, since the editor it left renders again before it goes
  const [result, setResult] = useState(() => {
    const saved = flash
    flash = undefined
    return saved
  })
  const [busy, setBusy] = useState(false)

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

  // Run an action, showing what went wrong if it fails
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setResult(undefined)
    try {
      await action()
    } catch (error) {
      setResult({ message: errorMessage(error), notes: [] })
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    act(async () => {
      if (!settingsForm.current?.validate().isValid) return
      const body = { ...settings, fields }
      const { status, body: reply } = type
        ? await api('PUT', `/types/${type.name}`, body)
        : await api('POST', '/types', body)

      if (status === 422) {
        settingsForm.current.applyReport(reply)
        fieldsForm.current?.applyReport(reply)
        return setResult({ message: 'The type has problems, shown with its settings and fields.', notes: [] })
      }

      const { file, notes } = reply.migration
      const saved = file
        ? { message: `Saved, with the migration migrations/${file}. Run iight migrate to update the entries.`, notes }
        : { message: 'Saved. No entries need a migration.', notes }
      await onSaved()
      if (reply.data.name === type?.name) return setResult(saved)
      flash = saved
      location.hash = `#/schema/${reply.data.name}`
    })

  const remove = () =>
    act(async () => {
      const question = `Delete the content type ${type!.label}? Its entries stay until you delete them, and iight migrate --check lists them.`
      if (!confirm(question)) return
      await api('DELETE', `/types/${type!.name}`)
      await onSaved()
      location.hash = '#/schema'
    })

  return (
    <>
      <header>
        <a href='#/schema'>Content types</a>
        <h1>{type ? type.label : 'New content type'}</h1>
      </header>

      {!editable && <p role='status'>{readOnly}</p>}
      <Form ref={settingsForm} schema={schema} values={shown} onValuesChange={setSettings} />
      <Form
        ref={fieldsForm}
        schema={fieldsSchema}
        inputs={inputs}
        values={shownFields}
        onValuesChange={(next) => changeFields(next.fields)}
      />

      {result && (
        <div role='status'>
          <p>{result.message}</p>
          {result.notes.length > 0 && (
            <ul>
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editable && (
        <div className='actions'>
          <button type='button' className='iight-button' disabled={busy} onClick={save}>
            Save
          </button>
          {type && (
            <button type='button' className='iight-button' disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </div>
      )}
    </>
  )
}
