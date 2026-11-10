# The SDK

`@sorlo/sdk` is the delivery API's client for frontends. Types pulled from the CMS check every query and type every result, and it never imports server code. Make a key for it in the admin, pull the types with `npx sorlo types pull`, as [Types](#types) describes, then query the content.

## Queries

```ts
import { createClient } from '@sorlo/sdk'

const cms = createClient({ url: process.env.SORLO_URL!, token: process.env.SORLO_TOKEN! })

const posts = await cms
  .entries('blog')
  .where('values.featured', '=', true)
  .orWhere('values.title', 'like', 'release')
  .orderBy('values.published_at', 'desc')
  .paginate(10) // { data: EntryBlog[], pagination }
```

- Fields and entry properties go by the API's names, such as `values.featured` and `createdAt`. `where` adds a condition to the current group, and `orWhere` starts a new group.
- `paginate(perPage = 15, page = 1)` replies `{ data, pagination }`, `first()` the first entry or `null`, and `all()` every entry, fetched 100 at a time.
- `with('author', 'cover')` asks for those fields' links to come resolved, and `depth(3)` for how many levels, from 1 to 10. The results are typed to match: after `cms.entries('blog').with('author')`, `post.values.author` is an `EntryAuthors` or null, and its own links are resolved a level less. Without `with`, it stays a `string`. `With<EntryBlog, 'author'>` is that type, for typing a frontend's own functions, and `Media` is a file's.
- Results are the API's plain JSON. A failed request throws a `SorloError` with the HTTP `status`, the API's `message` and the reply's `body`. When the CMS can't be reached, fetch's own error comes through.
- `createClient` takes a `fetch` to use in place of the global one.
- `createClient({ preview: true })` reads drafts, for a site's preview, sending `status=draft` with every query. It needs a key from `sorlo make:api-key --preview`, so keep it on a server. Its entries are typed as drafts, which can be unfinished: every field can be missing, at any depth, `slug`, `uri` and `publishedAt` can be null, and links resolve to drafts. `Draft<EntryBlog>` is that type.

## Forms

`cms.form('contact_us').get()` resolves a form as the CMS serves it, `{ id, name, label, version, fields, open }`, which the SDK types as `SorloForm`. Its `fields` are the schema of a [Sorlo Forms](https://github.com/WeAreSorlo/forms) `Form`, so a frontend renders the form with no cast. A closed form still serves its fields, with `open` false, so a page can say it's closed. A form that doesn't exist throws a `SorloError` with status 404, and no key is needed.

```tsx
import Form from '@sorlo/forms'

export async function Contact() {
  const form = await cms.form('contact_us').get()
  return <Form schema={form.fields} />
}
```

`cms.form('contact_us').submit(values)` sends a form's values as JSON, typed by the form's fields, and resolves the submission as it was stored, `{ id, version, values, createdAt }`. Values that don't pass throw a `SorloError` with status 422, whose `body` is the validation report, for the `applyReport` of a Sorlo Forms `Form`.

```ts
// In a browser, which needs no key to submit
const cms = createClient({ url: 'https://cms.example.com' })
await cms.form('contact_us').submit({ name: 'Ada', email: 'ada@example.com' })
```

The `token` is optional, since submitting needs none, but entries do. A site's own server sends a key with the `submit` permission when it submits for its visitors, so they aren't rate limited as one IP address.

## Types

`npx sorlo types pull` writes `src/sorlo-types.d.ts` from `GET /types`, reading the CMS's address from `SORLO_URL` and a key with the `types` permission from `SORLO_TOKEN`. It declares each content type's values and entry, such as `BlogValues` and `EntryBlog`, the fields `with` can resolve, such as `BlogResolvedValues`, and each form's values, such as `ContactUsFormValues`, and registers them with the SDK. Each shared group's values get a type of their own, such as `GroupSeo`, and `GroupSeoResolved<Depth>`, every field with its links resolved, when it holds relationship or media fields. The types that use it refer to them, so one component can take a group's values from every type that has it. Forms change in the admin, so pull again after changing one. Commit the file, so builds don't need the CMS, and leave it unformatted. In CI, `node_modules/.bin/sorlo types pull --check` fails when the file is out of date, and runs the frontend's own `sorlo` rather than whatever `npx` might find on npm. Each entry type builds on the SDK's `Entry`, writing only what its type narrows, so what the SDK adds to every entry reaches the file without another pull. A file pulled before 29 October 2026 doesn't, and needs pulling once more: with the newer SDK, it types every query as `never`.

## In the starter

A project with both packages, such as the starter, gets the CMS's `sorlo` command, which passes `types` on to the SDK. With `npm run dev` running and a key from `npx sorlo make:api-key --types`:

```bash
cd examples/starter
export SORLO_URL=http://localhost:4100 SORLO_TOKEN=<key>
npm run types      # pulls src/sorlo-types.d.ts
npm run frontend   # runs src/frontend.ts, a typed script
```
