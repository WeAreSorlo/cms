import { signInSchema } from '../src/schemas'
import Form, { FormHandle } from 'iight'
import 'iight/styles/base.scss'
import 'iight/styles/layout.scss'
import 'iight/styles/themes/default.scss'
import { useEffect, useRef, useState } from 'react'
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
      className='iight-theme-default'
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

function App() {
  // Undefined until we know whether a session exists
  const [user, setUser] = useState<null | User>()

  useEffect(() => {
    fetch('/api/session')
      .then(async (response) => setUser(response.ok ? (await response.json()).data : null))
      .catch(() => setUser(null))
  }, [])

  const signOut = async () => {
    await fetch('/api/session', { method: 'DELETE' })
    setUser(null)
  }

  if (user === undefined) return null
  if (user === null) return <SignIn onSignIn={setUser} />

  return (
    <main className='iight-theme-default'>
      <p>
        Signed in as {user.name} ({user.email}).
      </p>
      <button type='button' className='iight-button' onClick={signOut}>
        Sign out
      </button>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
