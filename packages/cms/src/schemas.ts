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
