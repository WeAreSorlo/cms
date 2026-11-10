import type {
  ContactFormValues,
  EntryAuthors,
  EntryBlog,
  EntryDocs,
  EntryHome,
  GroupMeta,
  GroupOg,
  GroupOgResolved,
  GroupSeo,
} from './sorlo-types'
import type { FieldSchema } from '@sorlo/forms'
import {
  type Draft,
  type Entry,
  type Media,
  type Paginated,
  type SorloForm,
  type Submission,
  type With,
  createClient,
} from '@sorlo/sdk'
import { expectTypeOf, test } from 'vitest'

// Compile-time tests, which vitest typechecks rather than runs. The generated sorlo-types.d.ts types the SDK here.
const cms = createClient({ url: 'http://localhost:3000', token: 'sorlo_key' })

// A property a newer SDK could give every entry
declare module '@sorlo/sdk' {
  interface Entry {
    addedLater?: true
  }
}

test("generated entries build on the SDK's Entry, so what it gains reaches types pulled before it", () => {
  expectTypeOf<EntryBlog['addedLater']>().toEqualTypeOf<true | undefined>()
  expectTypeOf<EntryDocs['publishedAt']>().toEqualTypeOf<Entry['publishedAt']>()

  // And each narrows what's its own
  expectTypeOf<EntryBlog['type']>().toEqualTypeOf<'blog'>()
  expectTypeOf<EntryBlog['uri']>().toEqualTypeOf<null>()
  expectTypeOf<EntryDocs['position']>().toEqualTypeOf<number>()
})

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

test('a shared group has a type of its own, which with() resolves as it resolves any group', () => {
  // Every place that uses a group has its type, so one component can take them all
  type Page = Values<ReturnType<typeof cms.entries<'pages'>>>
  expectTypeOf<Page['seo']>().toEqualTypeOf<GroupSeo | undefined>()
  expectTypeOf<Page['meta']>().toEqualTypeOf<GroupMeta | undefined>()
  expectTypeOf<NonNullable<Page['seo']>['share']>().toEqualTypeOf<GroupOg | undefined>()
  expectTypeOf<NonNullable<Page['items']>[number]['share']>().toEqualTypeOf<GroupOg | undefined>()

  const resolved = cms.entries('pages').with('seo', 'items')
  type Seo = NonNullable<Values<typeof resolved>['seo']>
  expectTypeOf<Seo['title']>().toEqualTypeOf<string>()
  expectTypeOf<NonNullable<Seo['share']>['image']>().toEqualTypeOf<Media | null | undefined>()
  type Item = NonNullable<Values<typeof resolved>['items']>[number]
  expectTypeOf<Item['share']>().toEqualTypeOf<GroupOgResolved<2> | undefined>()

  // @ts-expect-error meta holds no links
  cms.entries('pages').with('meta')
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

test('submit() takes the values a form takes, and resolves what was stored', () => {
  const contact = cms.form('contact')
  expectTypeOf(contact.submit).parameter(0).toEqualTypeOf<ContactFormValues>()
  expectTypeOf(
    contact.submit({ name: 'Ada', email: 'ada@example.com', topics: ['sales'], address: { town: 'Leeds' } }),
  ).resolves.toEqualTypeOf<Submission<ContactFormValues>>()

  // A browser can send submissions without a key
  createClient({ url: 'http://localhost:3000' }).form('contact')

  // @ts-expect-error there's no form called survey
  cms.form('survey')
  // @ts-expect-error name is required
  contact.submit({ email: 'ada@example.com', address: { town: 'Leeds' } })
  // @ts-expect-error size takes a number
  contact.submit({ name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' }, size: 'big' })
  // @ts-expect-error topics takes the form's choices
  contact.submit({ name: 'Ada', email: 'ada@example.com', address: { town: 'Leeds' }, topics: ['jobs'] })
})

test("get() resolves a form whose fields Sorlo Forms' Form takes as its schema", () => {
  expectTypeOf(cms.form('contact').get()).resolves.toEqualTypeOf<SorloForm>()
  expectTypeOf<SorloForm['fields']>().toExtend<Array<FieldSchema>>()
})

test('a preview client types drafts, whose fields can be empty and which may never have been published', () => {
  const preview = createClient({ url: 'http://localhost:3000', token: 'sorlo_key', preview: true })
  const posts = preview.entries('blog')
  expectTypeOf(posts.first()).resolves.toEqualTypeOf<Draft<EntryBlog> | null>()
  expectTypeOf<Found<typeof posts>['slug']>().toEqualTypeOf<string | null>()
  expectTypeOf<Found<typeof posts>['publishedAt']>().toEqualTypeOf<string | null>()
  expectTypeOf<Values<typeof posts>['title']>().toEqualTypeOf<string | undefined>()

  // Required fields inside lists and blocks can be empty too, but a block always names its layout
  type Block = NonNullable<Values<typeof posts>['blocks']>[number]
  expectTypeOf<Block['_layout']>().toEqualTypeOf<'text' | 'gallery'>()
  expectTypeOf<Extract<Block, { _layout: 'text' }>['body']>().toEqualTypeOf<string | undefined>()

  // Links resolve to drafts, and files stay as they are
  const linked = preview.entries('blog').with('author', 'cover')
  type Author = NonNullable<Values<typeof linked>['author']>
  expectTypeOf<Author['values']['name']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Author['publishedAt']>().toEqualTypeOf<string | null>()
  expectTypeOf<Values<typeof linked>['cover']>().toEqualTypeOf<Media | null | undefined>()

  // Without preview, every entry is published
  expectTypeOf<Found<ReturnType<typeof cms.entries<'blog'>>>['publishedAt']>().toEqualTypeOf<string>()
})
