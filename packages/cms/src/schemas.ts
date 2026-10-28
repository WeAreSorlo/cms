import type { FieldSchema } from 'iight'

// Rendered by the admin's sign-in page and checked by POST /api/session
export const signInSchema: Array<FieldSchema> = [
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'password', label: 'Password', type: 'password', required: true },
]

// Asked for by iight make:user
export const userSchema: Array<FieldSchema> = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'password', label: 'Password', type: 'password', required: true, options: { minLength: 8 } },
]

// Asked for by iight make:api-key
export const apiKeySchema: Array<FieldSchema> = [{ name: 'name', label: 'Name', type: 'text', required: true }]

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

// The events that trigger automations, each written by the change it names (PLAN.md section 11)
export const events = [
  { value: 'entry.created', label: 'Entry created' },
  { value: 'entry.updated', label: 'Entry updated' },
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

// An automation, rendered by the admin's automation editor and checked by its routes. Its conditions are core's
// conditional logic, taken from baseFields, which is core's baseInputSchemaFields(): the admin and the server each load
// their own build of core.
export function automationSchema(baseFields: Array<FieldSchema>): Array<FieldSchema> {
  const conditions = baseFields.find((field) => field.name === 'conditions')!
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, options: { placeholder: 'Contact us notifications' } },
    { name: 'triggers', label: 'When', type: 'checkbox', required: true, options: { choices: [...events] } },
    {
      ...conditions,
      label: 'Only if',
      instructions:
        "Runs when any group has all of its rules matching. A rule's field is a path in the event's data, such as entry.type, entry.values.featured, form.name, submission.values.email, submission.spam or media.mime. With no groups, every event it's triggered by runs it.",
    },
    { name: 'actions', label: 'Then', type: 'flexible', required: true, options: { layouts: actionLayouts } },
  ]
}

// A content type's settings, rendered by the admin's type editor and checked by its routes. The choices come from the
// type's top-level fields, and checkType in types.ts checks the fields themselves.
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
    { name: 'icon', label: 'Icon', type: 'text', options: { placeholder: 'newspaper' } },
  ]
}
