import { inputs, normaliseConditions, schemaToTypeScript } from './core'
import { holdsOne, isLink, linkFields, someField } from './fields'
import { allowedTypes, cmsInputs } from './relations'
import { type ContentType, type SharedGroup, expandFields } from './types'
import type { FieldSchema, Input, InputTypeValue } from '@sorlo/core'

// The TypeScript types of the entries the delivery API returns and the values forms take, which GET /types serves to
// `npx sorlo types pull`. They register with @sorlo/sdk, so its queries and submissions are typed without generics
// (PLAN.md section 9). Each type's values come twice, from two inputs maps: as they're stored, with IDs for links, and
// as with() returns the fields that hold links, resolved Depth levels deep. depth is how many levels a query gets when
// it doesn't say. Each shared group's values are a type of their own, such as GroupSeo, and GroupSeoResolved<Depth>
// when they hold links, which the types that use it refer to (PLAN.md section 19).
export function typesFile(
  types: Map<string, ContentType>,
  depth = 2,
  forms: Array<{ name: string; fields: Array<FieldSchema> }> = [],
  groups = new Map<string, SharedGroup>(),
) {
  const names = new Map([...types.keys()].map((type) => [type, inputs.identifier.formatIdentifier(type, 'pascal')]))

  // Each shared group's fields, with the groups it uses expanded, by id
  const byId = new Map([...groups.values()].map((group) => [group.id, group]))
  const expanded = new Map([...groups.values()].map((group) => [group.id, expandFields(group.fields, byId)]))
  const groupName = (id: string) => inputs.identifier.formatIdentifier(`group ${byId.get(id)!.name}`, 'pascal')
  const holdsLinks = (id: string) => someField(expanded.get(id)!, isLink)

  // A use of a shared group is typed by the group's name, and any other group by its fields
  const group = (use: (id: string) => string): Input => ({
    ...cmsInputs.group,
    typeValue: (schema, typeFields) =>
      schema.options?.group === undefined ? cmsInputs.group.typeValue!(schema, typeFields) : use(schema.options.group),
  })

  const stored: Record<string, Input> = { ...cmsInputs, group: group(groupName) }

  // A linked entry's own links resolve a level less, which the SDK's Linked counts down
  const returned: Record<string, Input> = {
    ...cmsInputs,
    relationship: {
      ...cmsInputs.relationship,
      typeValue: (schema) => {
        const entries = allowedTypes(types, schema).map((type) => `Entry${names.get(type)}`)
        const linked = `Linked<${entries.join(' | ') || 'never'}, Depth>`
        return holdsOne(schema) ? `${linked} | null` : `Array<${linked}>`
      },
    },
    media: { ...cmsInputs.media, typeValue: (schema) => (holdsOne(schema) ? 'Media | null' : 'Array<Media>') },
    group: group((id) => (holdsLinks(id) ? `${groupName(id)}Resolved<Depth>` : groupName(id))),
  }

  const groupDeclarations = [...groups.values()].flatMap((group) => {
    const fields = expanded.get(group.id)!
    const resolved = schemaToTypeScript(fields, returned, { name: `group ${group.name} resolved` })
    return [
      schemaToTypeScript(fields, stored, { name: `group ${group.name}` }),
      '',
      // with() returns the whole group, with its links resolved
      ...(holdsLinks(group.id) ? [resolved.replace(' = ', '<Depth extends number> = '), ''] : []),
    ]
  })

  const declarations = [...types.values()].map((type) => {
    const name = names.get(type.name)
    const hierarchical = type.structure === 'hierarchical'

    // Saving checks that a required slug is there, but a singleton's entry is created empty the first time it's opened
    const slugField = type.fields.find((field) => field.name === type.slugField)
    const slug = !slugField
      ? 'null'
      : slugField.required && !normaliseConditions(slugField).length && type.structure !== 'singleton'
        ? 'string'
        : 'string | null'

    // An entry is the SDK's Entry with what this type narrows, so what the SDK adds to every entry reaches files pulled
    // before it
    return [
      schemaToTypeScript(type.fields, stored, { name: `${type.name} values` }),
      '',
      schemaToTypeScript(linkFields(type), returned, { name: `${type.name} resolved values` }).replace(
        ' = ',
        '<Depth extends number> = ',
      ),
      '',
      `export type Entry${name} = Omit<Entry, 'type' | 'slug' | 'uri' | 'parentId' | 'position' | 'values'> & {`,
      `  type: ${JSON.stringify(type.name)}`,
      `  slug: ${slug}`,
      // A page's uri is its slug after its parent's, so it's there when the slug is
      `  uri: ${hierarchical ? slug : 'null'}`,
      `  parentId: ${hierarchical ? 'string | null' : 'null'}`,
      `  position: ${hierarchical ? 'number' : 'null'}`,
      `  values: ${name}Values`,
      '}',
      '',
    ].join('\n')
  })

  // Forms take core's inputs, as submissions send them
  const formNames = new Map(forms.map((form) => [form.name, inputs.identifier.formatIdentifier(form.name, 'pascal')]))
  const formDeclarations = forms.map((form) =>
    [schemaToTypeScript(form.fields, inputs, { name: `${form.name} form values` }), ''].join('\n'),
  )

  return [
    '// Generated from the CMS by `npx sorlo types pull`. Pull again rather than editing it.',
    '',
    "import type { Entry, Linked, Media } from '@sorlo/sdk'",
    '',
    ...groupDeclarations,
    ...declarations,
    ...formDeclarations,
    "declare module '@sorlo/sdk' {",
    '  interface EntryTypes {',
    ...[...names].map(([type, name]) => `    ${type}: Entry${name}`),
    '  }',
    '  interface ResolvedTypes<Depth extends number> {',
    ...[...names].map(([type, name]) => `    ${type}: ${name}ResolvedValues<Depth>`),
    '  }',
    '  interface FormTypes {',
    ...[...formNames].map(([form, name]) => `    ${form}: ${name}FormValues`),
    '  }',
    '  interface DeliverySettings {',
    `    depth: ${depth}`,
    '  }',
    '}',
    '',
  ].join('\n')
}
