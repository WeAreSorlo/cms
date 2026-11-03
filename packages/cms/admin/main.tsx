import './admin.scss'
import { ContentType, GroupsContext, SharedGroup, TypesContext, api, pathOf } from './api'
import { AutomationList, AutomationPage, NewAutomation, Runs } from './automations'
import { BulkEditor } from './bulk'
import { EntryEditor, EntryList, EntryPage, SingletonPage, TypeGone } from './entries'
import { FormEditor, FormList, FormPage, Inbox, isView } from './forms'
import { GroupEditor, GroupList } from './groups'
import { KeyEditor, KeyList, KeyPage } from './keys'
import { MediaLibrary } from './media'
import { MigrationsPage } from './migrations'
import { Shell } from './shell'
import './theme.scss'
import { TokenForm, TokenList, TokenPage } from './tokens'
import { TypeEditor, TypeList } from './types'
import {
  AccountPage,
  ForgotPage,
  InvitePage,
  JoinPage,
  RemovedUsers,
  ResetPage,
  SignIn,
  SignedIn,
  UserList,
  UserPage,
} from './users'
import { VersionPage } from './versions'
import 'iight/styles/base.scss'
import 'iight/styles/layout.scss'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

// The design system's reference page, at #/design. Only iight dev has it, so the built admin leaves it out.
const Design = import.meta.env.DEV ? lazy(() => import('./design')) : undefined

// The Chat page, in the assistant's own chunk
const ChatPage = lazy(() => import('./assistant').then((module) => ({ default: module.ChatPage })))

// The page for the URL's hash, such as #/types/blog, #/types/blog/bulk/<id>,<id>, #/entries/<id>,
// #/entries/<id>/versions/<number>, #/media, #/forms/<id>/inbox, #/automations/<id>/runs, #/migrations, #/keys/<id>,
// #/users/<id>, #/account, #/account/tokens/<id> with MCP on, #/chat?id=<id> with the assistant on, or #/schema/blog
// and #/groups/seo in the type editor. A list's search and filters follow its path, as in #/types/blog?search=lamp.
function Page({
  hash,
  types,
  groups,
  editable,
  mcp,
  ai,
  mail,
  me,
  reloadTypes,
  onUser,
}: {
  hash: string
  types: Map<string, ContentType>
  groups: Map<string, SharedGroup>
  editable: boolean
  // Whether /mcp is on, with whether tokens can be given Publish changes
  mcp: false | { publish: boolean }
  ai: boolean
  // Whether the site emails invites and reset links
  mail: boolean
  // Who's signed in
  me: string
  reloadTypes: () => Promise<Map<string, ContentType>>
  // Their name or email changed on their account page
  onUser: (user: SignedIn) => void
}) {
  const path = pathOf(hash)
  const query = hash.slice(path.length + 1)
  const [section, name, action, ids] = path.replace(/^#\/?/, '').split('/')
  const type = section === 'types' ? types.get(name) : undefined

  if (Design && section === 'design') {
    return (
      <Suspense>
        <Design />
      </Suspense>
    )
  }
  if (ai && section === 'chat') {
    return (
      <Suspense>
        <ChatPage query={query} />
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
  if (section === 'migrations') return <MigrationsPage editable={editable} />
  if (section === 'media') return <MediaLibrary query={query} />
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
  if (section === 'users' && name === 'invite') return <InvitePage key={query} query={query} mail={mail} />
  if (section === 'users' && name === 'removed') return <RemovedUsers />
  if (section === 'users' && name) return <UserPage key={name} id={name} me={me} mcp={!!mcp} />
  if (section === 'users') return <UserList me={me} />
  if (mcp && section === 'account' && name === 'tokens') {
    if (action === 'new') return <TokenForm key='new' publish={mcp.publish} />
    if (action) return <TokenPage key={action} id={action} publish={mcp.publish} />
    return <TokenList publish={mcp.publish} />
  }
  if (section === 'account') return <AccountPage onUser={onUser} mcp={!!mcp} />
  if (section === 'entries' && name && action === 'versions' && ids) {
    return <VersionPage key={hash} id={name} number={Number(ids)} types={types} />
  }
  if (section === 'entries' && name) return <EntryPage key={name} id={name} types={types} />
  if (type?.structure === 'singleton') return <SingletonPage key={type.name} type={type} />
  if (type && action === 'new') return <EntryEditor key={`${type.name}/new`} type={type} />
  if (type && action === 'bulk') return <BulkEditor key={hash} type={type} ids={ids?.split(',') ?? []} />
  if (type) {
    return <EntryList key={`${type.name}/${action}`} type={type} archived={action === 'archive'} query={query} />
  }
  if (section === 'types' && name) return <TypeGone name={name} />
  return <p>{types.size ? 'Choose a content type.' : 'Add a content type to schema/types to get started.'}</p>
}

function App() {
  // Undefined until we know whether a session exists
  const [user, setUser] = useState<null | SignedIn>()
  const [types, setTypes] = useState<Map<string, ContentType>>()
  const [groups, setGroups] = useState(new Map<string, SharedGroup>())
  const [editable, setEditable] = useState(false)
  // Whether /mcp is on, and with it the MCP tokens page, and whether tokens can be given Publish changes
  const [mcp, setMcp] = useState<false | { publish: boolean }>(false)
  // Whether the assistant is on, and with it the Chat page
  const [ai, setAi] = useState(false)
  // Whether the site emails invites and reset links
  const [mail, setMail] = useState(false)

  // The one copy of the URL's hash, so the shell and the page see each change in the same render
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const update = () => {
      // MCP tokens moved into your account, so their old addresses, such as #/tokens/new, open them there
      const moved = location.hash.replace(/^#\/tokens(?=[/?]|$)/, '#/account/tokens')
      if (moved !== location.hash) return location.replace(moved)
      setHash(location.hash)
    }
    update()
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    fetch('/api/session')
      .then(async (response) => setUser(response.ok ? (await response.json()).data : null))
      .catch(() => setUser(null))
  }, [])

  // Loaded again after each change in the type editor or through the assistant, with the shared groups
  const reloadTypes = useCallback(async () => {
    const { body } = await api('GET', '/types')
    const loaded = new Map<string, ContentType>(body.data.map((type: ContentType) => [type.name, type]))
    setTypes(loaded)
    setGroups(new Map(body.groups.map((group: SharedGroup) => [group.name, group])))
    setEditable(body.editable)
    setMcp(body.mcp)
    setAi(body.ai)
    setMail(body.mail)
    return loaded
  }, [])

  useEffect(() => {
    if (user) reloadTypes().catch(() => setTypes(new Map()))
  }, [user, reloadTypes])

  const signOut = async () => {
    await fetch('/api/session', { method: 'DELETE' })
    setUser(null)
  }

  // Signing in opens the admin where it was, and joining and resetting open it, or after a reset the account it
  // changed. The page that had focus goes, so the shell takes it.
  const [arriving, setArriving] = useState(false)
  const signedInTo = (page?: string) => (signedIn: SignedIn) => {
    setArriving(true)
    setUser(signedIn)
    if (page) location.hash = page
  }

  // The pages for an invite's or a reset's link, and for asking for one, show with a session or without one
  const [access, token] = pathOf(hash).replace(/^#\/?/, '').split('/')
  if (access === 'invite' && token) return <JoinPage key={token} token={token} onSignIn={signedInTo('#/')} />
  if (access === 'reset' && token) return <ResetPage key={token} token={token} onSignIn={signedInTo('#/account')} />
  if (access === 'forgot') return <ForgotPage />

  if (user === undefined) return null
  if (user === null) return <SignIn onSignIn={signedInTo()} />
  if (!types) return null

  // Around the shell too, since the assistant in its column shows proposed changes by the types' fields
  return (
    <TypesContext.Provider value={types}>
      <GroupsContext.Provider value={groups}>
        <Shell
          hash={hash}
          types={types}
          user={user}
          editable={editable}
          mcp={!!mcp}
          ai={ai}
          onSignOut={signOut}
          onTypes={reloadTypes}
          arriving={arriving}
        >
          <Page
            hash={hash}
            types={types}
            groups={groups}
            editable={editable}
            mcp={mcp}
            ai={ai}
            mail={mail}
            me={user.id}
            reloadTypes={reloadTypes}
            onUser={setUser}
          />
        </Shell>
      </GroupsContext.Provider>
    </TypesContext.Provider>
  )
}

// A file dropped where nothing takes it would open in the admin's place, so it does nothing there instead. Drop zones,
// such as the media library's and the assistant's, take theirs first, and a file input takes its own.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    const input = event.target instanceof HTMLInputElement && event.target.type === 'file'
    if (event.defaultPrevented || input || !event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'none'
  })
}

createRoot(document.getElementById('root')!).render(<App />)
