import { initialsOf, sectionOf } from '../admin/api'
import { expect, test } from 'vitest'

test("finds the nav item a page's URL belongs to", () => {
  expect(sectionOf('#/types/blog')).toBe('types/blog')
  expect(sectionOf('#/types/blog/archive')).toBe('types/blog')
  expect(sectionOf('#/types/blog/new')).toBe('types/blog')
  expect(sectionOf('#/types/blog?search=lamp')).toBe('types/blog')
  expect(sectionOf('#/media?filter=%5B%5D')).toBe('media')
  expect(sectionOf('#/forms/01a1831e/inbox')).toBe('forms')
  expect(sectionOf('#/automations/new/01a1831e')).toBe('automations')
  expect(sectionOf('#/schema/blog')).toBe('schema')
  expect(sectionOf('#/groups/seo')).toBe('groups')
  expect(sectionOf('#/media')).toBe('media')
  expect(sectionOf('#/keys/new')).toBe('keys')
  expect(sectionOf('#/users/invite?email=sam%40example.com')).toBe('users')
  expect(sectionOf('#/users/removed')).toBe('users')
  // Your account and its MCP tokens are no nav items, but the person's menu marks them
  expect(sectionOf('#/account')).toBe('account')
  expect(sectionOf('#/account/tokens')).toBe('account/tokens')
  expect(sectionOf('#/account/tokens/new')).toBe('account/tokens')
  // The pages for an invite's or a reset's link come before the shell
  expect(sectionOf('#/invite/abc')).toBeUndefined()

  // An entry's page names its type once it loads
  expect(sectionOf('#/entries/01a182d3')).toBeUndefined()
  expect(sectionOf('#/types')).toBeUndefined()
  expect(sectionOf('#/design')).toBeUndefined()
  expect(sectionOf('')).toBeUndefined()
})

test("takes someone's initials from the first and last words of their name", () => {
  expect(initialsOf('Levi Cole')).toBe('LC')
  expect(initialsOf('Augusta Ada King, Countess of Lovelace')).toBe('AL')
  expect(initialsOf('  ada  ')).toBe('A')
  expect(initialsOf('élodie durand')).toBe('ÉD')
  // A letter outside the Basic Multilingual Plane stays whole
  expect(initialsOf('𝒜da King')).toBe('𝒜K')
  expect(initialsOf('')).toBe('')
})
