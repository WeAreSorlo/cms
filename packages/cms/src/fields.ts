import type { ContentType, SharedGroup } from './types'
import type { FieldSchema, InputSchema, InputValidateValue } from 'iight'

// The CMS's own inputs, which store IDs: relationship links to entries, media to files in the media library
// (PLAN.md section 12) and form to one of the forms, and the Shared group field. Nothing here loads core or server code, so the admin imports them
// too and adds the pickers.

// Whether types such as image/png or image/* allow a mime, leaving out its parameters, as in audio/ogg; codecs=opus
export function allows(types: Array<string>, mime: string) {
  const essence = mime.split(';')[0]
  return types.some((type) => type === essence || (type.endsWith('/*') && essence.startsWith(type.slice(0, -1))))
}

export const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

// A value as text, as the inbox and emails show it: the labels of the choices it holds, yes or no, or JSON for a group
// or list of rows
export function showValue(field: FieldSchema, value: unknown) {
  if (isEmpty(value)) return '–'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  const choices: Array<{ value: string; label?: string }> | undefined = field.options?.choices
  if (choices)
    return [value]
      .flat()
      .map((item) => choices.find((choice) => choice.value === item)?.label ?? item)
      .join(', ')
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
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

type Layout = { id?: string; fields?: Array<FieldSchema> }

// Fields with each field and layout in them, at any depth, replaced by what change and changeLayout make of it, after
// the fields inside it have been
export function mapFields(
  fields: Array<FieldSchema>,
  change: (field: FieldSchema) => FieldSchema,
  changeLayout = (layout: Layout) => layout,
): Array<FieldSchema> {
  const inside = (list: Array<FieldSchema>) => mapFields(list, change, changeLayout)
  return fields.map((field) => {
    const { fields: children, layouts } = field.options ?? {}
    if (!Array.isArray(children) && !Array.isArray(layouts)) return change(field)
    return change({
      ...field,
      options: {
        ...field.options,
        ...(Array.isArray(children) && { fields: inside(children) }),
        ...(Array.isArray(layouts) && {
          layouts: layouts.map((layout: Layout) =>
            changeLayout(Array.isArray(layout.fields) ? { ...layout, fields: inside(layout.fields) } : layout),
          ),
        }),
      },
    })
  })
}

// A use of a shared group from schema/groups, which names it by id in options.group (PLAN.md section 19). Types expand
// each use into a group of the shared group's fields when they load, so only the type editor sees one.
export const shared = {
  name: () => 'Shared group',
  description: () => 'The fields of a shared group, which many types can use.',
  category: () => 'Layout',
  // Core never checks a group's required, so a use, like a group, has none
  coreFields: (fields: Array<FieldSchema>) => fields.filter((field) => field.name !== 'required'),
}

// The Shared group field's setting, choosing a shared group by id, so renaming one breaks nothing
export const sharedOptions = (groups: Iterable<SharedGroup>): Array<FieldSchema> => [
  {
    name: 'group',
    label: 'Shared group',
    type: 'select',
    required: true,
    options: { choices: [...groups].map((group) => ({ value: group.id, label: group.label })) },
  },
]

// Whether a field is a use of a shared group, as types have them once they load: a group that names its shared group
export const isUse = (field: FieldSchema) => field.type === 'group' && field.options?.group !== undefined

// The ids of the shared groups some fields use, at any depth, as their files have them
export const usesOf = (fields: Array<FieldSchema>) => {
  const ids: Array<string> = []
  mapFields(fields, (field) => {
    if (field.type === 'shared') ids.push(field.options?.group)
    return field
  })
  return ids
}

// Expanded fields as their file has them: each use back as the Shared group field it was, without its shared group's
// fields, since expanding only gave it the group type and those
export const collapseUses = (fields: Array<FieldSchema>) =>
  mapFields(fields, (field) => {
    if (!isUse(field)) return field
    const { fields: _, ...options } = field.options!
    return { ...field, type: 'shared', options }
  })

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

// A form made in the admin, by its ID, such as for a page that shows it, so renaming the form breaks nothing. Delivery
// returns the ID, which GET /v1/forms/:form serves.
export const form = {
  name: () => 'Form',
  description: () => 'One of the forms made in the admin, such as for a page to show.',
  category: () => 'Relational',
  optionFields: (): Array<FieldSchema> => [],
  validateValue: ((value, schema) =>
    validateValue(value, { ...schema, options: { ...schema.options, maximum: 1 } })) as InputValidateValue,
  typeValue: () => 'string',
  formatValue: count('form', 'forms'),
}
