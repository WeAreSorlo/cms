import type { EntryBlog, EntryDocs, EntryHome } from './iight-types'
import { type Paginated, createClient } from '@iight/sdk'
import { expectTypeOf, test } from 'vitest'

// Compile-time tests, which vitest typechecks rather than runs. The generated iight-types.d.ts types the SDK here.
const cms = createClient({ url: 'http://localhost:3000', token: 'iight_key' })

test('results take their types from the generated file', () => {
  expectTypeOf(cms.entries('blog').paginate(10)).resolves.toEqualTypeOf<Paginated<EntryBlog>>()
  expectTypeOf(cms.entries('docs').where('parentId', 'not exists').first()).resolves.toEqualTypeOf<EntryDocs | null>()
  expectTypeOf(cms.entries('home').all()).resolves.toEqualTypeOf<Array<EntryHome>>()

  cms
    .entries('blog')
    .where('values.views', 'between', [5, 10])
    .where('createdAt', '>', new Date())
    .orWhere('slug', 'like', 'release')
    .orderBy('values.published_at', 'desc')
})

test('wrong field names fail to typecheck', () => {
  // @ts-expect-error blog has no field called author
  cms.entries('blog').where('values.author', '=', 'Ada')
  // @ts-expect-error fields are named values.<name>, as the API names them
  cms.entries('blog').where('title', '=', 'Hello')
  // @ts-expect-error
  cms.entries('blog').orderBy('values.author')
  // @ts-expect-error there's no content type called news
  cms.entries('news')
})

test('wrong values fail to typecheck', () => {
  // @ts-expect-error featured holds a boolean
  cms.entries('blog').where('values.featured', '=', 'yes')
  // @ts-expect-error views holds a number
  cms.entries('blog').orWhere('values.views', '>', '5')
  // @ts-expect-error in takes a list
  cms.entries('blog').where('values.views', 'in', 5)
  // @ts-expect-error between takes two values
  cms.entries('blog').where('values.views', 'between', [5])
  // @ts-expect-error exists takes no value
  cms.entries('blog').where('values.featured', 'exists', true)
  // @ts-expect-error like matches text, which position isn't
  cms.entries('docs').where('position', 'like', '1')
  // @ts-expect-error
  cms.entries('blog').orderBy('createdAt', 'newest')
})
