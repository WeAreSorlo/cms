import type { Plugin, PluginField } from '../src'
import { flattenValidationReport, inputs, validateServerValues, validationError } from '../src/core'
import { registerPlugins } from '../src/plugins'
import { cmsInputs } from '../src/relations'
import { checkType } from '../src/types'
import { typesFile } from '../src/typescript'
import { expect, test } from 'vitest'

// A site's own field, as the .ts file that keeps its checks has it
const rating: PluginField = {
  name: () => 'Rating',
  validateValue: (value, schema) =>
    value == null || [1, 2, 3, 4, 5].includes(value)
      ? inputs.number.validateValue!(value, schema)
      : validationError(value, 'Choose from one to five stars.'),
  typeValue: () => 'number',
}

const reviews = {
  id: 'typ_reviews',
  name: 'reviews',
  label: 'Reviews',
  structure: 'collection',
  fields: [{ id: 'fld_score', type: 'rating', name: 'score', label: 'Score' }],
}

// Each test file has its own copy of cmsInputs, so this one's plugins stay here. The first test registers nothing.
test('a field type that a built-in field or another plugin has stops them all, listing every clash', () => {
  const problems = registerPlugins([
    { name: 'stars', fields: { rating, text: rating, markdown: rating }, admin: './fields/stars.tsx' },
    { name: 'sorlo-field-rating', fields: { rating, relationship: rating }, admin: 'sorlo-field-rating' },
    { name: 'broken' } as Plugin,
  ])

  expect(problems).toEqual([
    'text, from stars, is a built-in field type.',
    'markdown, from stars, is a built-in field type.',
    'rating, from sorlo-field-rating, is from stars too.',
    'relationship, from sorlo-field-rating, is a built-in field type.',
    'Plugin 3 needs a name, its fields and admin, the module with their components.',
  ])
  expect(cmsInputs.rating).toBeUndefined()
  expect(checkType(reviews, 'reviews')).toEqual(['Field "score" has an unknown type, rating.'])
})

test("a plugin's fields join the built-in ones in type files, the server's checks and type generation", async () => {
  expect(registerPlugins([{ name: 'stars', fields: { rating }, admin: './fields/rating.tsx' }])).toEqual([])

  // The server never renders, so its component renders nothing
  expect((cmsInputs.rating.default as () => unknown)()).toBeNull()
  expect(checkType(reviews, 'reviews')).toEqual([])

  const report = await validateServerValues(reviews.fields, { score: 9 }, cmsInputs)
  expect(flattenValidationReport(report).messages).toEqual({ score: ['Choose from one to five stars.'] })

  const types = new Map([['reviews', { ...reviews, structure: 'collection' as const }]])
  expect(typesFile(types)).toContain('score?: number')
})
