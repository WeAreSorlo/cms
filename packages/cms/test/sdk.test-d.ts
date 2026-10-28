import type { EntryAuthors, EntryBlog, EntryDocs, EntryHome } from './iight-types'
import { type Media, type Paginated, type With, createClient } from '@iight/sdk'
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

// The entries a query finds, and the values they hold
type Found<Q> = Q extends { first(): Promise<infer E> } ? NonNullable<E> : never
type Values<Q> = Found<Q> extends { values: infer V } ? V : never

test('links stay IDs without with()', () => {
  const posts = cms.entries('blog')
  expectTypeOf<Values<typeof posts>['author']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Values<typeof posts>['related']>().toEqualTypeOf<Array<string> | undefined>()
  expectTypeOf(posts.with().first()).resolves.toEqualTypeOf<EntryBlog | null>()

  // Queries compare the stored IDs
  cms.entries('blog').where('values.author', '=', '0192f0c4-0000-7000-8000-000000000000')
})

test('with() types the fields it names as what they link to, and leaves the rest IDs', () => {
  const posts = cms.entries('blog').with('author', 'cover')
  type Author = NonNullable<Values<typeof posts>['author']>
  expectTypeOf<Author['type']>().toEqualTypeOf<'authors'>()
  expectTypeOf<Author['values']['name']>().toEqualTypeOf<string>()
  expectTypeOf<Values<typeof posts>['author']>().toExtend<object | null | undefined>()
  expectTypeOf<Values<typeof posts>['cover']>().toEqualTypeOf<Media | null | undefined>()
  expectTypeOf<Values<typeof posts>['related']>().toEqualTypeOf<Array<string> | undefined>()
  expectTypeOf<Values<typeof posts>['title']>().toEqualTypeOf<string>()

  // The same as the With helper, for typing a frontend's own functions
  expectTypeOf(posts.all()).resolves.toEqualTypeOf<Array<With<EntryBlog, 'author' | 'cover'>>>()
  expectTypeOf(cms.entries('blog').with('author').with('cover').first()).resolves.toEqualTypeOf<With<
    EntryBlog,
    'author' | 'cover'
  > | null>()
})

test('with() resolves the links inside groups, repeaters and flexible blocks', () => {
  const posts = cms.entries('blog').with('blocks', 'credits')
  type Block = NonNullable<Values<typeof posts>['blocks']>[number]
  expectTypeOf<Extract<Block, { _layout: 'gallery' }>['images']>().toEqualTypeOf<Array<Media>>()
  type Credit = NonNullable<Values<typeof posts>['credits']>[number]
  expectTypeOf<NonNullable<Credit['person']>['values']['name']>().toEqualTypeOf<string>()
  expectTypeOf<Credit['role']>().toEqualTypeOf<string | undefined>()
})

test("what with() links to has its own links resolved, down to the depth the CMS's settings give", () => {
  // The CMS's depth is 2, so an author's avatar comes with them, and a related post's author does too
  const posts = cms.entries('blog').with('author', 'related')
  expectTypeOf<NonNullable<Values<typeof posts>['author']>['values']['avatar']>().toEqualTypeOf<
    Media | null | undefined
  >()
  type Related = NonNullable<Values<typeof posts>['related']>[number]
  expectTypeOf<NonNullable<Related['values']['author']>>().toEqualTypeOf<EntryAuthors>()
  expectTypeOf<Related['values']['related']>().toEqualTypeOf<Array<EntryBlog> | undefined>()
  expectTypeOf<Related['values']['cover']>().toEqualTypeOf<Media | null | undefined>()

  // At depth 1 the linked entries keep their links as IDs, and deeper levels resolve further
  const shallow = cms.entries('blog').with('author').depth(1)
  expectTypeOf<NonNullable<Values<typeof shallow>['author']>>().toEqualTypeOf<EntryAuthors>()
  const deep = cms.entries('blog').depth(3).with('related')
  type Deeper = NonNullable<NonNullable<Values<typeof deep>['related']>[number]['values']['related']>[number]
  expectTypeOf<NonNullable<Deeper['values']['author']>>().toEqualTypeOf<EntryAuthors>()
  expectTypeOf<Deeper['values']['related']>().toEqualTypeOf<Array<EntryBlog> | undefined>()
})

test('with() takes only fields that hold links, and depth() a level from 1 to 10', () => {
  // @ts-expect-error title holds no links
  cms.entries('blog').with('title')
  // @ts-expect-error blog has no field called editor
  cms.entries('blog').with('editor')
  // @ts-expect-error docs have no links at all
  cms.entries('docs').with('title')
  // @ts-expect-error
  cms.entries('blog').depth(0)
  // @ts-expect-error
  cms.entries('blog').depth(11)
})

test('wrong field names fail to typecheck', () => {
  // @ts-expect-error blog has no field called editor
  cms.entries('blog').where('values.editor', '=', 'Ada')
  // @ts-expect-error fields are named values.<name>, as the API names them
  cms.entries('blog').where('title', '=', 'Hello')
  // @ts-expect-error
  cms.entries('blog').orderBy('values.editor')
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
