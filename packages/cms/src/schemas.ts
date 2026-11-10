import type { FieldSchema } from '@sorlo/forms'

// Rendered by the admin's sign-in page and checked by POST /api/session
export const signInSchema: Array<FieldSchema> = [
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'password', label: 'Password', type: 'password', required: true },
]

// Asked for by sorlo make:user
export const userSchema: Array<FieldSchema> = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'password', label: 'Password', type: 'password', required: true, options: { minLength: 8 } },
]

// The first account, made in the admin while nobody has one, and checked by POST /api/session/setup, with the code the
// server printed. The admin leaves the code out of the form when its link brought one.
export const setupSchema: Array<FieldSchema> = [
  ...userSchema,
  {
    name: 'code',
    label: 'Setup code',
    type: 'text',
    required: true,
    instructions: 'The server printed it in its log as it started, in the link to this page.',
  },
]

// The address to invite, on the admin's Users page and checked by POST /api/invites. Forgot your password? asks for an
// address the same way, checked by POST /api/session/forgot.
export const inviteSchema: Array<FieldSchema> = [{ name: 'email', label: 'Email', type: 'email', required: true }]

// What someone invited chooses for themselves, on the invite's page and checked by POST /api/session/invite
export const joinSchema: Array<FieldSchema> = userSchema.filter((field) => field.name !== 'email')

// A new password, on a reset link's page and checked by POST /api/session/reset, and asked for by sorlo user:password
export const resetSchema: Array<FieldSchema> = [
  { name: 'password', label: 'New password', type: 'password', required: true, options: { minLength: 8 } },
]

// Your own name, email and password, on the admin's account page and checked by PUT /api/account, built with the email
// you have, since your current password shows, and is needed, once the email differs from it or a new password is given
export const accountSchema = (email: string): Array<FieldSchema> => [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  {
    name: 'newPassword',
    label: 'New password',
    type: 'password',
    instructions: 'Leave it empty to keep your password. A new one signs you out everywhere else.',
    options: { minLength: 8 },
  },
  {
    name: 'password',
    label: 'Current password',
    type: 'password',
    required: true,
    instructions: 'Needed to change your email or your password.',
    conditions: [
      { rules: [{ field: 'email', operator: 'notEquals', value: email }] },
      { rules: [{ field: 'newPassword', operator: 'notEmpty' }] },
    ],
  },
]

// What a key can do besides reading live content and media, each a flag of sorlo make:api-key
export const apiKeyScopes = [
  { value: 'preview', label: 'Preview: read drafts, with status=draft' },
  { value: 'types', label: 'Types: pull TypeScript types for the SDK, from GET /types' },
  { value: 'submit', label: 'Submit: post to forms without the rate limit' },
]

// A key's name and scopes, asked for by sorlo make:api-key, whose flags give the scopes, and edited on the admin's API
// keys page, whose routes check it
export const apiKeySchema: Array<FieldSchema> = [
  { name: 'name', label: 'Name', type: 'text', required: true, options: { placeholder: 'Website' } },
  {
    name: 'scopes',
    label: 'Permissions',
    type: 'checkbox',
    instructions:
      "Every key reads published content and media. Keep a key that previews or submits on a server, out of a site's pages.",
    options: { choices: apiKeyScopes },
  },
]

// What a personal token can do besides reading. Publish changes comes with Save drafts, and only
// where the site's config lets tokens publish.
export const tokenScopes = [
  { value: 'drafts', label: 'Save drafts' },
  { value: 'publish', label: 'Publish changes' },
]

// A personal token's permissions, asked for when it's made and on its page after, with Publish changes only where the
// site allows it
export const tokenScopesField = (publish: boolean): FieldSchema => ({
  name: 'scopes',
  label: 'Permissions',
  type: 'checkbox',
  instructions:
    "Every token reads the site's content as you. Save drafts also saves changes to entries as drafts, and makes " +
    'new forms that take no submissions until someone opens them. ' +
    (publish
      ? 'Publish changes also puts changes on the live site, and includes Save drafts. Neither unpublishes, archives ' +
        'or deletes anything.'
      : 'It never publishes, archives or deletes anything.'),
  options: { choices: publish ? tokenScopes : tokenScopes.filter(({ value }) => value !== 'publish') },
})

// A personal token's name and permissions, asked for on the admin's MCP tokens page, whose routes check them
export const tokenSchema = (publish: boolean): Array<FieldSchema> => [
  {
    name: 'name',
    label: 'Name',
    type: 'text',
    required: true,
    instructions: 'Such as the client and the computer it runs on, so you know which token to revoke.',
    options: { maxLength: 100, placeholder: 'Claude Code on my laptop' },
  },
  tokenScopesField(publish),
]

// A chat's name, edited on the admin's Chat page and checked by PUT /api/chats/:id
export const chatTitleSchema: Array<FieldSchema> = [
  { name: 'title', label: 'Name', type: 'text', required: true, options: { maxLength: 100 } },
]

// The most entries a message to the assistant names as "these", past which its model gets only how many
export const maxNamed = 100

// The most entries one Select all in a list ticks
export const maxTicked = 10_000

// A message to the admin's assistant, written in the box under its chat
export const chatMessageSchema: Array<FieldSchema> = [
  {
    name: 'text',
    label: 'Message',
    type: 'textarea',
    required: true,
    options: { maxLength: 20_000, rows: 1, placeholder: 'Ask about the content' },
  },
]

// The most files one message to the assistant attaches, as many as view_media shows at once
export const maxAttached = 10

// What POST /api/chats/:id/messages checks: the message, and the media files attached to it, which the admin uploads
// first, checked as a media field checks its files
export const chatSendSchema: Array<FieldSchema> = [
  ...chatMessageSchema,
  { name: 'files', label: 'Files', type: 'media', options: { maximum: maxAttached } },
]

// A media file's details, edited in the admin's media library and checked by PUT /api/media/:id
export const mediaSchema: Array<FieldSchema> = [
  { name: 'name', label: 'Name', type: 'text', required: true, options: { maxLength: 200 } },
  {
    name: 'alt',
    label: 'Alt text',
    type: 'textarea',
    instructions: "Describes the file for people who can't see or hear it.",
    options: { rows: 3, maxLength: 1000 },
  },
  {
    name: 'caption',
    label: 'Caption',
    type: 'textarea',
    instructions: 'Shown with the file, such as under a photo.',
    options: { rows: 2, maxLength: 1000 },
  },
]

// A version's name, given on its page in the admin and checked by PUT /api/entries/:id/versions/:number. Empty clears
// it.
export const versionSchema: Array<FieldSchema> = [
  {
    name: 'name',
    label: 'Name',
    type: 'text',
    instructions: 'Named versions are kept however many versions are saved after them.',
    options: { maxLength: 100, placeholder: 'Before the rebrand' },
  },
]

// A form's settings, rendered by the admin's form editor and checked by its routes. checkFormFields in types.ts checks
// its fields.
export const formSchema: Array<FieldSchema> = [
  { name: 'label', label: 'Label', type: 'text', required: true, width: 50, options: { placeholder: 'Contact us' } },
  {
    name: 'name',
    label: 'Name',
    type: 'identifier',
    required: true,
    width: 50,
    instructions: "What the SDK calls the form, as in cms.form('contact_us'). Embeds use its ID, which never changes.",
    options: { format: 'mixed', source: 'label' },
  },
]

// The events that trigger automations, each written by the change it names
export const events = [
  { value: 'entry.created', label: 'Entry created' },
  { value: 'entry.updated', label: 'Entry updated' },
  { value: 'entry.published', label: 'Entry published' },
  { value: 'entry.unpublished', label: 'Entry unpublished' },
  { value: 'entry.archived', label: 'Entry archived' },
  { value: 'entry.restored', label: 'Entry restored' },
  { value: 'entry.deleted', label: 'Entry deleted' },
  { value: 'submission.created', label: 'Form submitted' },
  { value: 'media.created', label: 'File uploaded' },
  { value: 'media.updated', label: 'File updated' },
  { value: 'media.deleted', label: 'File deleted' },
] as const

export type EventName = (typeof events)[number]['value']

// The actions an automation can take, as the layouts of its flexible actions field, whose settings are core schemas.
// actions.ts runs them, so a new action is a layout here and a run function there.
export const actionLayouts = [
  {
    name: 'email',
    label: 'Send an email',
    fields: [
      {
        name: 'to',
        label: 'To',
        type: 'email',
        required: true,
        options: { multiple: true, placeholder: 'sales@example.com, ada@example.com' },
      },
      {
        name: 'subject',
        label: 'Subject',
        type: 'text',
        instructions: 'Leave it empty for one that says what happened, such as "New submission: Contact us".',
      },
    ],
  },
  {
    name: 'webhook',
    label: 'Call a webhook',
    fields: [
      {
        name: 'url',
        label: 'URL',
        type: 'url',
        required: true,
        instructions: 'Gets a POST with the event as JSON.',
        options: { placeholder: 'https://example.com/hooks/cms' },
      },
      {
        name: 'secret',
        label: 'Signing secret',
        type: 'text',
        instructions:
          'Signs each request the Standard Webhooks way, so any of its libraries can check it came from here. Leave it empty to have one made when you save.',
        options: { placeholder: 'whsec_…' },
      },
      {
        name: 'headers',
        label: 'Headers',
        type: 'repeater',
        instructions: 'Sent with each request, such as an Authorization header.',
        options: {
          fields: [
            { name: 'name', label: 'Name', type: 'text', required: true, width: 40 },
            { name: 'value', label: 'Value', type: 'text', required: true, width: 60 },
          ],
        },
      },
      {
        name: 'timeout',
        label: 'Timeout',
        type: 'number',
        required: true,
        defaultValue: 10,
        instructions: 'Seconds to wait for a reply, after which it tries again later.',
        options: { min: 1, max: 30 },
      },
    ],
  },
] satisfies Array<{ name: string; label: string; fields: Array<FieldSchema> }>

interface HasFields {
  label: string
  fields: Array<FieldSchema>
}

// A rule's type for a field, by its input, as core's schema builder gives them. Choice fields give their choices.
const ruleTypes: Record<string, string> = {
  boolean: 'boolean',
  number: 'number',
  range: 'number',
  date: 'date',
  datetime: 'date',
}

const isChoice = (field: FieldSchema) => ['select', 'radio', 'checkbox'].includes(field.type)

// What rules on fields compare, as core's conditions input takes it: their choices, or their type. Fields of different
// kinds compare as text.
export function ruleKind(fields: Array<FieldSchema>): { type?: string; choices?: Array<any> } {
  const kinds = new Set(fields.map((field) => (isChoice(field) ? 'choices' : (ruleTypes[field.type] ?? 'text'))))
  const kind = kinds.size === 1 ? [...kinds][0] : 'text'
  if (kind !== 'choices') return { type: kind }
  const choices = fields
    .flatMap((field): Array<any> => field.options?.choices ?? [])
    .flatMap((choice) => (choice?.choices?.length ? choice.choices : [choice]))
  return { choices: [...new Map(choices.map((choice) => [String(choice?.value), choice])).values()] }
}

// The paths into an event's data that an automation's rules can test, as core's conditions input lists them: the
// event's own first, then the types' and the forms' top-level fields, by label, as "Blog posts › Featured". Groups
// are left out, since a rule can't compare them, and so is content, which holds no value.
function eventFields(types: Iterable<HasFields & { name: string }>, forms: Array<HasFields & { id: string }>) {
  const byLabel = <T extends HasFields>(list: Iterable<T>) => [...list].sort((a, b) => a.label.localeCompare(b.label))
  const typeList = byLabel(types)
  const formList = byLabel(forms)

  // A path such as entry.values.slug is the same field in every type with one, so it's listed once, labelled with
  // them all, as "Blog posts, Docs › Slug". Their choices go together, and fields of different kinds compare as text.
  const fieldsOf = (owners: Array<HasFields>, path: string) => {
    const named = new Map<string, Array<{ owner: string; field: FieldSchema }>>()
    for (const owner of owners) {
      for (const field of owner.fields) {
        if (field.type === 'group' || field.type === 'content') continue
        named.set(field.name, [...(named.get(field.name) ?? []), { owner: owner.label, field }])
      }
    }

    return [...named].map(([name, uses]) => {
      const fields = uses.map(({ field }) => field)
      return {
        value: path + name,
        label: `${uses.map(({ owner }) => owner).join(', ')} › ${fields[0].label ?? name}`,
        ...ruleKind(fields),
      }
    })
  }

  return [
    {
      value: 'entry.type',
      label: 'Entry type',
      choices: typeList.map((type) => ({ value: type.name, label: type.label })),
    },
    { value: 'form.id', label: 'Form', choices: formList.map((form) => ({ value: form.id, label: form.label })) },
    // Renaming a form breaks rules on its name, so its ID is the one to pick, but older automations use the name
    { value: 'form.name', label: 'Form name' },
    { value: 'submission.spam', label: 'Spam', type: 'boolean' },
    { value: 'media.mime', label: 'File type', example: 'image/png' },
    ...fieldsOf(typeList, 'entry.values.'),
    ...fieldsOf(formList, 'submission.values.'),
  ]
}

// The paths into each kind of event's data, by the first part of the event's name, such as entry in entry.published
const eventData = new Map([
  ['entry', ['entry.']],
  ['submission', ['form.', 'submission.']],
  ['media', ['media.']],
])

// An automation, rendered by the admin's automation editor and checked by its routes. Its conditions are core's
// conditional logic, taken from baseFields, which is core's baseInputSchemaFields(): the admin and the server each load
// their own build of core. Its rules test the event's data, so both list the fields of the same types and forms.
export function automationSchema(
  baseFields: Array<FieldSchema>,
  types: Iterable<HasFields & { name: string }>,
  forms: Array<HasFields & { id: string }>,
  triggers: Array<unknown> = [],
): Array<FieldSchema> {
  const conditions = baseFields.find((field) => field.name === 'conditions')!
  // Only the data of the events ticked in When, since a rule on another event's data tests a value that's never there.
  // Every event's while none is ticked.
  const starts = triggers.flatMap((trigger) => eventData.get(String(trigger).split('.')[0]) ?? [])
  const fieldChoices = eventFields(types, forms).filter(
    (choice) => !starts.length || starts.some((start) => choice.value.startsWith(start)),
  )
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, options: { placeholder: 'Contact us notifications' } },
    { name: 'triggers', label: 'When', type: 'checkbox', required: true, options: { choices: [...events] } },
    {
      ...conditions,
      label: 'Only if',
      instructions:
        "Runs when any group has all of its rules matching, each testing the event's data. With no rules, every event it's triggered by runs it.",
      options: { ...conditions.options, fieldChoices },
    },
    { name: 'actions', label: 'Then', type: 'flexible', required: true, options: { layouts: actionLayouts } },
  ]
}

// A shared group's settings, rendered by the admin's shared group editor and checked by its routes. checkGroup in
// types.ts checks its fields.
export const groupSchema: Array<FieldSchema> = [
  { name: 'label', label: 'Label', type: 'text', required: true, width: 50, options: { placeholder: 'SEO' } },
  {
    name: 'name',
    label: 'Name',
    type: 'identifier',
    required: true,
    width: 50,
    instructions: 'Names its file in schema/groups and its type in pulled types, such as GroupSeo.',
    options: { format: 'mixed' },
  },
]

// A content type's settings, rendered by the admin's type editor and checked by its routes. The choices come from the
// type's top-level fields, and checkType in types.ts checks the fields themselves. The icon is text to the routes,
// and a picker of Lucide's icons in the admin.
export function typeSchema(fields: Array<FieldSchema>): Array<FieldSchema> {
  const choices = (list: Array<FieldSchema>) =>
    list.map((field) => ({ value: field.name, label: field.label ?? field.name }))
  const structures = [
    { value: 'collection', label: 'Collection, such as blog posts' },
    { value: 'hierarchical', label: 'Hierarchical, for pages with parents' },
    { value: 'singleton', label: 'Singleton, a type of one entry' },
  ]
  return [
    { name: 'label', label: 'Label', type: 'text', required: true, width: 50, options: { placeholder: 'Blog posts' } },
    { name: 'name', label: 'Name', type: 'identifier', required: true, width: 50, options: { format: 'mixed' } },
    { name: 'singular', label: 'Singular label', type: 'text', width: 50, options: { placeholder: 'Blog post' } },
    {
      name: 'structure',
      label: 'Structure',
      type: 'select',
      required: true,
      width: 50,
      options: { choices: structures },
    },
    {
      name: 'drafts',
      label: 'Drafts',
      type: 'boolean',
      defaultValue: true,
      instructions: 'Without drafts, saving an entry publishes it, so a save runs every check that publishing does.',
      options: { message: "Save entries as drafts, and publish them when they're ready" },
    },
    {
      name: 'titleField',
      label: 'Title field',
      type: 'select',
      width: 50,
      options: { placeholder: 'None', choices: choices(fields) },
    },
    {
      name: 'slugField',
      label: 'Slug field',
      type: 'select',
      width: 50,
      options: { placeholder: 'None', choices: choices(fields.filter((field) => field.type === 'identifier')) },
    },
    { name: 'listColumns', label: 'List columns', type: 'checkbox', options: { choices: choices(fields) } },
    { name: 'icon', label: 'Icon', type: 'icon' },
  ]
}
