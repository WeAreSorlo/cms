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
      const kinds = new Set(fields.map((field) => (isChoice(field) ? 'choices' : (ruleTypes[field.type] ?? 'text'))))
      const choices = fields
        .flatMap((field): Array<any> => field.options?.choices ?? [])
        .flatMap((choice) => (choice?.choices?.length ? choice.choices : [choice]))
      const kind = kinds.size === 1 ? [...kinds][0] : 'text'
      return {
        value: path + name,
        label: `${uses.map(({ owner }) => owner).join(', ')} › ${fields[0].label ?? name}`,
        ...(kind === 'choices'
          ? { choices: [...new Map(choices.map((choice) => [String(choice?.value), choice])).values()] }
          : { type: kind }),
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

// An automation, rendered by the admin's automation editor and checked by its routes. Its conditions are core's
// conditional logic, taken from baseFields, which is core's baseInputSchemaFields(): the admin and the server each load
// their own build of core. Its rules test the event's data, so both list the fields of the same types and forms.
export function automationSchema(
  baseFields: Array<FieldSchema>,
  types: Iterable<HasFields & { name: string }>,
  forms: Array<HasFields & { id: string }>,
): Array<FieldSchema> {
  const conditions = baseFields.find((field) => field.name === 'conditions')!
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, options: { placeholder: 'Contact us notifications' } },
    { name: 'triggers', label: 'When', type: 'checkbox', required: true, options: { choices: [...events] } },
    {
      ...conditions,
      label: 'Only if',
      instructions:
        "Runs when any group has all of its rules matching, each testing the event's data. With no rules, every event it's triggered by runs it.",
      options: { ...conditions.options, fieldChoices: eventFields(types, forms) },
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
