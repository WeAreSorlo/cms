import { inputs, normaliseConditions, schemaToTypeScript } from './core'
import { holdsOne, linkFields } from './fields'
import { allowedTypes, cmsInputs } from './relations'
import type { ContentType } from './types'
import type { FieldSchema, Input } from 'iight'

// The TypeScript types of the entries the delivery API returns and the values forms take, which GET /types serves to
// `npx iight types pull`. They register with @iight/sdk, so its queries and submissions are typed without generics
// (PLAN.md section 9). Each type's values come twice, from two inputs maps: as they're stored, with IDs for links, and
// as with() returns the fields that hold links, resolved Depth levels deep. depth is how many levels a query gets when
// it doesn't say.
export function typesFile(
  types: Map<string, ContentType>,
  depth = 2,
  forms: Array<{ name: string; fields: Array<FieldSchema> }> = [],
) {
  const names = new Map([...types.keys()].map((type) => [type, inputs.identifier.formatIdentifier(type, 'pascal')]))

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
  }

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

    return [
      schemaToTypeScript(type.fields, cmsInputs, { name: `${type.name} values` }),
      '',
      schemaToTypeScript(linkFields(type), returned, { name: `${type.name} resolved values` }).replace(
        ' = ',
        '<Depth extends number> = ',
      ),
      '',
      `export type Entry${name} = {`,
      '  id: string',
      `  type: ${JSON.stringify(type.name)}`,
      `  slug: ${slug}`,
      // A page's uri is its slug after its parent's, so it's there when the slug is
      `  uri: ${hierarchical ? slug : 'null'}`,
      `  parentId: ${hierarchical ? 'string | null' : 'null'}`,
      `  position: ${hierarchical ? 'number' : 'null'}`,
      `  values: ${name}Values`,
      '  createdAt: string',
      '  updatedAt: string',
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
    '// Generated from the CMS by `npx iight types pull`. Pull again rather than editing it.',
    '',
    "import type { Linked, Media } from '@iight/sdk'",
    '',
    ...declarations,
    ...formDeclarations,
    "declare module '@iight/sdk' {",
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
