import { signInSchema } from '../src/schemas'
import { ContentType, api } from './api'
import { EntryEditor, EntryList, EntryPage, SingletonPage } from './entries'
import { MediaLibrary } from './media'
import { TypeEditor, TypeList } from './types'
import Form, { FormHandle } from 'iight'
import 'iight/styles/base.scss'
import 'iight/styles/layout.scss'
import 'iight/styles/themes/default.scss'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface User {
  id: string
  email: string
  name: string
}

function SignIn({ onSignIn }: { onSignIn: (user: User) => void }) {
  const form = useRef<FormHandle>(null)
  const [values, setValues] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (submitting || !form.current?.validate().isValid) return
    setSubmitting(true)
    setError('')

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })

      if (response.ok) onSignIn((await response.json()).data)
      else if (response.status === 422) form.current?.applyReport(await response.json())
      else throw new Error(response.statusText)
    } catch {
      setError("Couldn't sign in. Try again in a moment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Core's form has no submit button, so Enter in a field submits from here
    <main
      className='iight-theme-default sign-in'
      onKeyDown={(event) => event.key === 'Enter' && event.target instanceof HTMLInputElement && submit()}
    >
      <h1>Sign in</h1>
      <Form ref={form} schema={signInSchema} onValuesChange={setValues} />
      {error && <p role='alert'>{error}</p>}
      <button type='button' className='iight-button' disabled={submitting} onClick={submit}>
        Sign in
      </button>
    </main>
  )
}

// The page for the URL's hash, such as #/types/blog, #/entries/<id>, #/media or #/schema/blog in the type editor
function Page({
  types,
  editable,
  reloadTypes,
}: {
  types: Map<string, ContentType>
  editable: boolean
  reloadTypes: () => Promise<void>
}) {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const update = () => setHash(location.hash)
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])

  const [section, name, action] = hash.replace(/^#\/?/, '').split('/')
  const type = section === 'types' ? types.get(name) : undefined

  if (section === 'schema' && name === 'new') return <TypeEditor key='new' editable={editable} onSaved={reloadTypes} />
  if (section === 'schema' && types.has(name)) {
    return <TypeEditor key={name} type={types.get(name)} editable={editable} onSaved={reloadTypes} />
  }
  if (section === 'schema') return <TypeList types={types} editable={editable} />
  if (section === 'media') return <MediaLibrary />
  if (section === 'entries' && name) return <EntryPage key={name} id={name} types={types} />
  if (type?.structure === 'singleton') return <SingletonPage key={type.name} type={type} />
  if (type && action === 'new') return <EntryEditor key={`${type.name}/new`} type={type} />
  if (type) return <EntryList key={`${type.name}/${action}`} type={type} archived={action === 'archive'} />
  return <p>{types.size ? 'Choose a content type.' : 'Add a content type to schema/types to get started.'}</p>
}

function App() {
  // Undefined until we know whether a session exists
  const [user, setUser] = useState<null | User>()
  const [types, setTypes] = useState<Map<string, ContentType>>()
  const [editable, setEditable] = useState(false)

  useEffect(() => {
    fetch('/api/session')
      .then(async (response) => setUser(response.ok ? (await response.json()).data : null))
      .catch(() => setUser(null))
  }, [])

  // Loaded again after each change in the type editor
  const reloadTypes = useCallback(async () => {
    const { body } = await api('GET', '/types')
    setTypes(new Map(body.data.map((type: ContentType) => [type.name, type])))
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
    <div className='iight-theme-default admin'>
      <nav>
        <strong>iight</strong>
        {[...types.values()].map((type) => (
          <a key={type.name} href={`#/types/${type.name}`}>
            {type.label}
          </a>
        ))}
        <a href='#/media'>Media</a>
        <a href='#/schema'>Content types</a>
        <p>
          Signed in as {user.name}.{' '}
          <button type='button' className='iight-button' onClick={signOut}>
            Sign out
          </button>
        </p>
      </nav>
      <main>
        <Page types={types} editable={editable} reloadTypes={reloadTypes} />
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
