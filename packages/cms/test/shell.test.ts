import { sectionOf } from '../admin/api'
import { expect, test } from 'vitest'

test("finds the nav item a page's URL belongs to", () => {
  expect(sectionOf('#/types/blog')).toBe('types/blog')
  expect(sectionOf('#/types/blog/archive')).toBe('types/blog')
  expect(sectionOf('#/types/blog/new')).toBe('types/blog')
  expect(sectionOf('#/forms/01a1831e/inbox')).toBe('forms')
  expect(sectionOf('#/automations/new/01a1831e')).toBe('automations')
  expect(sectionOf('#/schema/blog')).toBe('schema')
  expect(sectionOf('#/groups/seo')).toBe('groups')
  expect(sectionOf('#/media')).toBe('media')

  // An entry's page names its type once it loads
  expect(sectionOf('#/entries/01a182d3')).toBeUndefined()
  expect(sectionOf('#/types')).toBeUndefined()
  expect(sectionOf('#/design')).toBeUndefined()
  expect(sectionOf('')).toBeUndefined()
})
