import type { ContentType } from './types'
import type { FieldSchema, InputSchema, InputValidateValue } from 'iight'

// The CMS's own inputs, which store IDs: relationship links to entries, and media to files in the media library
// (PLAN.md section 12). Nothing here loads core or server code, so the admin imports them too and adds the pickers.

// Whether types such as image/png or image/* allow a mime, leaving out its parameters, as in audio/ogg; codecs=opus
export function allows(types: Array<string>, mime: string) {
  const essence = mime.split(';')[0]
  return types.some((type) => type === essence || (type.endsWith('/*') && essence.startsWith(type.slice(0, -1))))
}

// A field that takes one item holds its ID, and any other a list of IDs
export const holdsOne = (schema: InputSchema) => schema.options?.maximum === 1

export const idsOf = (value: unknown): Array<string> =>
  Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : []

export const isLink = (field: FieldSchema) => field.type === 'relationship' || field.type === 'media'

// Whether a field in a list, or in the groups, lists and layouts inside it, passes a test
export const someField = (fields: Array<FieldSchema>, test: (field: FieldSchema) => boolean): boolean =>
  fields.some(
    (field) =>
      test(field) ||
      someField(field.options?.fields ?? [], test) ||
      (field.options?.layouts ?? []).some((layout: { fields?: Array<FieldSchema> }) =>
        someField(layout.fields ?? [], test),
      ),
  )

// A type's top-level fields that are relationship or media fields or hold some, which with() can name
export const linkFields = (type: ContentType) => type.fields.filter((field) => someField([field], isLink))

// One ID, or a list of different IDs within the field's minimum and maximum. The server checks what they link to.
const validateValue: InputValidateValue = (value, schema) => {
  const ids = idsOf(value)
  const fail = (message: string) => ({ isValid: false, messages: [message], value })

  if (ids.length === 0 && (value === undefined || value === null || value === '' || Array.isArray(value))) {
    if (!schema.required) return { isValid: true, messages: [], value }
    return fail(holdsOne(schema) ? 'This field is required.' : 'At least one selection is required.')
  }

  const shaped = holdsOne(schema)
    ? typeof value === 'string'
    : Array.isArray(value) && value.every((id) => typeof id === 'string' && id !== '')
  if (!shaped) return fail('Invalid value.')
  if (new Set(ids).size < ids.length) return fail('Each item can only be chosen once.')

  const { minimum, maximum } = schema.options ?? {}
  if (typeof minimum === 'number' && ids.length < minimum) {
    return fail(`This field requires a minimum of ${minimum} item(s).`)
  }
  if (typeof maximum === 'number' && ids.length > maximum) {
    return fail(`This field requires a maximum of ${maximum} item(s).`)
  }
  return { isValid: true, messages: [], value }
}

const typeValue = (schema: InputSchema) => (holdsOne(schema) ? 'string' : 'Array<string>')

// Such as 1 entry or 3 files, for the admin's lists
const count = (one: string, many: string) => (value: unknown) => {
  const { length } = idsOf(value)
  return length ? `${length} ${length === 1 ? one : many}` : null
}

const limits: Array<FieldSchema> = [
  { name: 'minimum', label: 'Minimum', type: 'number', width: 50, options: { min: 0 } },
  {
    name: 'maximum',
    label: 'Maximum',
    type: 'number',
    width: 50,
    defaultValue: 1,
    instructions: 'With 1, the field holds a single item. Leave it empty for no limit.',
    options: { min: 1 },
  },
]

// The relationship field's settings, choosing among the site's content types by ID, so renaming a type breaks nothing.
// No types means any.
export const relationshipOptions = (types: Iterable<ContentType>): Array<FieldSchema> => [
  {
    name: 'types',
    label: 'Content types',
    type: 'checkbox',
    instructions: 'Leave them all unticked to link to entries of any type.',
    options: { choices: [...types].map((type) => ({ value: type.id, label: type.label })) },
  },
  ...limits,
]

export const relationship = {
  name: () => 'Relationship',
  description: () => 'Links to entries, of the content types you choose.',
  category: () => 'Relational',
  validateValue,
  typeValue,
  formatValue: count('entry', 'entries'),
}

// The media field's settings. Its types are MIME types with wildcards, as in iight.config.ts, and none means any.
export const media = {
  name: () => 'Media',
  description: () => 'Files from the media library, which it can also upload to.',
  category: () => 'Relational',
  optionFields: (): Array<FieldSchema> => [
    {
      name: 'types',
      label: 'File types',
      type: 'checkbox',
      instructions: 'Leave them all unticked to take any file in the library.',
      options: {
        choices: [
          { value: 'image/*', label: 'Images' },
          { value: 'video/*', label: 'Video' },
          { value: 'audio/*', label: 'Audio' },
          { value: 'application/*', label: 'Documents' },
        ],
      },
    },
    ...limits,
  ],
  validateValue,
  typeValue,
  formatValue: count('file', 'files'),
}
