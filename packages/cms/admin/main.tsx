import { signInSchema } from '../src/schemas'
import './admin.scss'
import { ContentType, GroupsContext, SharedGroup, TypesContext, api } from './api'
import { AutomationList, AutomationPage, NewAutomation, Runs } from './automations'
import { BulkEditor } from './bulk'
import { EntryEditor, EntryList, EntryPage, SingletonPage } from './entries'
import { FormEditor, FormList, FormPage, Inbox, isView } from './forms'
import { GroupEditor, GroupList } from './groups'
import { KeyEditor, KeyList, KeyPage } from './keys'
import { MediaLibrary } from './media'
import { Shell } from './shell'
import './theme.scss'
import { TypeEditor, TypeList } from './types'
import { Notice, focusInvalid } from './ui'
import Form, { FormHandle } from 'iight'
import 'iight/styles/base.scss'
import 'iight/styles/layout.scss'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

// The design system's reference page, at #/design. Only iight dev has it, so the built admin leaves it out.
const Design = import.meta.env.DEV ? lazy(() => import('./design')) : undefined

interface User {
  id: string
  email: string
  name: string
}

function SignIn({ onSignIn }: { onSignIn: (user: User) => void }) {
  const form = useRef<FormHandle>(null)
  // Around the form, for finding the fields that stop it
  const area = useRef<HTMLDivElement>(null)
  const [values, setValues] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    document.title = 'Sign in · iight'
  }, [])

  // Moves focus to the first field to fix, once the form has shown its messages
  const showInvalid = () => focusInvalid(area.current)

  // The button stays enabled while it signs in, so it keeps focus, and a second go is ignored here instead
  const submit = async () => {
    if (submitting) return
    if (!form.current?.validate().isValid) return showInvalid()
    setSubmitting(true)
    setError('')

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })

      if (response.ok) onSignIn((await response.json()).data)
      else if (response.status === 422) {
        form.current?.applyReport(await response.json())
        showInvalid()
      } else throw new Error(response.statusText)
    } catch {
      setError("Couldn't sign in. Try again in a moment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Core's form has no submit button, so Enter in a field submits from here
    <main
      className='cms-sign-in'
      onKeyDown={(event) => event.key === 'Enter' && event.target instanceof HTMLInputElement && submit()}
    >
      <p className='cms-sign-in__mark'>iight</p>
      <div className='cms-sign-in__card' ref={area}>
        <h1>Sign in</h1>
        {error && <Notice tone='danger'>{error}</Notice>}
        <Form ref={form} schema={signInSchema} onValuesChange={setValues} />
        <button type='button' className='iight-button iight-button--primary' aria-busy={submitting} onClick={submit}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </main>
  )
}

// The page for the URL's hash, such as #/types/blog, #/types/blog/bulk/<id>,<id>, #/entries/<id>, #/media,
// #/forms/<id>/inbox, #/automations/<id>/runs, #/keys/<id>, or #/schema/blog and #/groups/seo in the type editor
function Page({
  hash,
  types,
  groups,
  editable,
  reloadTypes,
}: {
  hash: string
  types: Map<string, ContentType>
  groups: Map<string, SharedGroup>
  editable: boolean
  reloadTypes: () => Promise<void>
}) {
  const [section, name, action, ids] = hash.replace(/^#\/?/, '').split('/')
  const type = section === 'types' ? types.get(name) : undefined

  if (Design && section === 'design') {
    return (
      <Suspense>
        <Design />
      </Suspense>
    )
  }
  if (section === 'schema' && name === 'new') return <TypeEditor key='new' editable={editable} onSaved={reloadTypes} />
  if (section === 'schema' && types.has(name)) {
    return <TypeEditor key={name} type={types.get(name)} editable={editable} onSaved={reloadTypes} />
  }
  if (section === 'schema') return <TypeList types={types} editable={editable} />
  if (section === 'groups' && name === 'new') {
    return <GroupEditor key='new' editable={editable} onSaved={reloadTypes} />
  }
  if (section === 'groups' && groups.has(name)) {
    return <GroupEditor key={name} group={groups.get(name)} editable={editable} onSaved={reloadTypes} />
  }
  if (section === 'groups') return <GroupList groups={groups} editable={editable} />
  if (section === 'media') return <MediaLibrary />
  if (section === 'forms' && name === 'new') return <FormEditor key='new' />
  if (section === 'forms' && name && isView(action)) return <Inbox key={`${name}/${action}`} id={name} view={action} />
  if (section === 'forms' && name) return <FormPage key={name} id={name} />
  if (section === 'forms') return <FormList />
  if (section === 'automations' && name === 'new') return <NewAutomation key={`new/${action}`} formId={action} />
  if (section === 'automations' && name && action === 'runs') return <Runs key={name} id={name} />
  if (section === 'automations' && name) return <AutomationPage key={name} id={name} />
  if (section === 'automations') return <AutomationList />
  if (section === 'keys' && name === 'new') return <KeyEditor key='new' />
  if (section === 'keys' && name) return <KeyPage key={name} id={name} />
  if (section === 'keys') return <KeyList />
  if (section === 'entries' && name) return <EntryPage key={name} id={name} types={types} />
  if (type?.structure === 'singleton') return <SingletonPage key={type.name} type={type} />
  if (type && action === 'new') return <EntryEditor key={`${type.name}/new`} type={type} />
  if (type && action === 'bulk') return <BulkEditor key={hash} type={type} ids={ids?.split(',') ?? []} />
  if (type) return <EntryList key={`${type.name}/${action}`} type={type} archived={action === 'archive'} />
  return <p>{types.size ? 'Choose a content type.' : 'Add a content type to schema/types to get started.'}</p>
}

function App() {
  // Undefined until we know whether a session exists
  const [user, setUser] = useState<null | User>()
  const [types, setTypes] = useState<Map<string, ContentType>>()
  const [groups, setGroups] = useState(new Map<string, SharedGroup>())
  const [editable, setEditable] = useState(false)

  // The one copy of the URL's hash, so the shell and the page see each change in the same render
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const update = () => setHash(location.hash)
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    fetch('/api/session')
      .then(async (response) => setUser(response.ok ? (await response.json()).data : null))
      .catch(() => setUser(null))
  }, [])

  // Loaded again after each change in the type editor, with the shared groups
  const reloadTypes = useCallback(async () => {
    const { body } = await api('GET', '/types')
    setTypes(new Map(body.data.map((type: ContentType) => [type.name, type])))
    setGroups(new Map(body.groups.map((group: SharedGroup) => [group.name, group])))
    setEditable(body.editable)
  }, [])

  useEffect(() => {
    if (user) reloadTypes().catch(() => setTypes(new Map()))
  }, [user, reloadTypes])

  const signOut = async () => {
    await fetch('/api/session', { method: 'DELETE' })
    setUser(null)
  }

  if (user === undefined) return null
  if (user === null) return <SignIn onSignIn={setUser} />
  if (!types) return null

  return (
    <Shell hash={hash} types={types} user={user} onSignOut={signOut}>
      <TypesContext.Provider value={types}>
        <GroupsContext.Provider value={groups}>
          <Page hash={hash} types={types} groups={groups} editable={editable} reloadTypes={reloadTypes} />
        </GroupsContext.Provider>
      </TypesContext.Provider>
    </Shell>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
