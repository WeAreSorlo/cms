import { inputs, normaliseConditions, schemaToTypeScript } from './core'
import type { ContentType } from './types'

// The TypeScript types of the entries the delivery API returns, which GET /types serves to `npx iight types pull`.
// They register with @iight/sdk, so its queries are typed without generics (PLAN.md section 9).
export function typesFile(types: Map<string, ContentType>) {
  const names = new Map([...types.keys()].map((type) => [type, inputs.identifier.formatIdentifier(type, 'pascal')]))

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
      schemaToTypeScript(type.fields, inputs, { name: `${type.name} values` }),
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

  return [
    '// Generated from the CMS by `npx iight types pull`. Pull again rather than editing it.',
    '',
    ...declarations,
    "declare module '@iight/sdk' {",
    '  interface EntryTypes {',
    ...[...names].map(([type, name]) => `    ${type}: Entry${name}`),
    '  }',
    '}',
    '',
    // Even with no content types, so the block above adds to the SDK's types instead of replacing them
    'export {}',
    '',
  ].join('\n')
}
