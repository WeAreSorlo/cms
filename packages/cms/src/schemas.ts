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
