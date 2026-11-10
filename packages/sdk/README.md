# @sorlo/sdk

A typed client for the delivery API of a [Sorlo](https://github.com/WeAreSorlo/cms) CMS, for a site's frontend. Types pulled from the CMS check every query and type every result, and it never imports server code, so it runs anywhere `fetch` does.

## Installing

```bash
npm install @sorlo/sdk
```

## Querying

```ts
import { createClient } from '@sorlo/sdk'

const cms = createClient({ url: process.env.SORLO_URL!, token: process.env.SORLO_TOKEN! })

const posts = await cms
  .entries('blog')
  .where('values.featured', '=', true)
  .orderBy('values.published_at', 'desc')
  .with('author')
  .paginate(10) // { data: EntryBlog[], pagination }
```

The token is an API key from the CMS's admin, or from `npx sorlo make:api-key`. Submitting a form needs no key, so it works from a browser:

```ts
const forms = createClient({ url: 'https://cms.example.com' })
await forms.form('contact_us').submit({ name: 'Ada', email: 'ada@example.com' })
```

## Types

`npx sorlo types pull` writes `src/sorlo-types.d.ts` from the CMS, reading its address from `SORLO_URL` and a key with the `types` permission from `SORLO_TOKEN`. Commit the file, so builds don't need the CMS, and pull again after changing a content type or a form. In CI, `node_modules/.bin/sorlo types pull --check` fails when it's out of date.

## Docs

- [The SDK](https://github.com/WeAreSorlo/cms/blob/main/docs/sdk.md): queries, links, previews, forms and types
- [The delivery API](https://github.com/WeAreSorlo/cms/blob/main/docs/api.md), which it calls

## License

MIT
