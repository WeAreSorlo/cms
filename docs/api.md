# The API

A site's frontend reads its content from the delivery API with an API key. Make one on the admin's API keys page, or with `npx sorlo make:api-key`, then ask for a type's entries:

```bash
curl -H "Authorization: Bearer <key>" http://localhost:4100/v1/entries/blog
```

The [SDK](sdk.md) makes the same requests with types pulled from the CMS. The admin has an API of its own, which [the admin API](admin-api.md) describes.

## API keys

The delivery API, `GET /types` and the SDK take a key, sent as `Authorization: Bearer <key>`. Make one on the admin's API keys page, which anyone signed in can use, under `sorlo start` too, or with `sorlo make:api-key`. Every key reads live entries and media, and its permissions, which the admin API calls `scopes`, add to that:

| Permission | Flag        | What it adds                                                                                                               |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `preview`  | `--preview` | Reads drafts with `status=draft`, as [Previews](drafts-and-publishing.md#previews) describes. Other keys get a 403         |
| `types`    | `--types`   | `GET /types`, which `npx sorlo types pull` reads. Other keys get a 403                                                     |
| `submit`   | `--submit`  | Posts to forms without the [rate limit](forms.md#submissions), for a site's own server. Other keys are limited like anyone |

Keep a key that can preview or submit on a server, out of a site's pages. Keys made before 30 October 2026 have `types` and `submit`, since every key could do both then.

The admin lists each key's permissions, who made it and when, and when it was last used, which is written at most once a minute. Keys from `make:api-key` say the CLI made them. A key shows once, when it's made, since only its hash is stored, so a lost key means making another. Editing a key changes its name and permissions and keeps the key itself. Revoking one deletes it, and from then on it gets 401s.

## The delivery API

It's read-only, and serves media and the live copies of published entries, or with a preview key and `status=draft`, drafts (see [Previews](drafts-and-publishing.md#previews)). It needs an [API key](#api-keys), sent as `Authorization: Bearer <key>`.

Any site's JavaScript can read `/v1/entries` and `/v1/media`, unless `delivery.origins` lists the sites that can. A browser's preflight needs no key, and gets the methods and headers it may send, `Authorization` among them, and every reply can be read, a 401 or 400 included, so a page can show its message. No cookie is involved, so an allowed site gets nothing a visitor's session could give it. `/types` and media files, at `/media/:id/:name`, send no CORS headers, since images and video show without them.

| Route                              | What it does                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/entries/:type`            | Lists entries. A singleton is a list of one                                                                                              |
| `GET /v1/entries/:type/:id`        | Replies an entry by ID                                                                                                                   |
| `GET /v1/entries/:type/slug/:slug` | Replies a top-level entry by slug                                                                                                        |
| `GET /v1/entries/:type/uri/*`      | Replies a hierarchical page by `uri`, as in `/v1/entries/docs/uri/install`                                                               |
| `GET /v1/media`                    | Lists media                                                                                                                              |
| `GET /v1/media/:id`                | Replies a media file by ID                                                                                                               |
| `GET /types`                       | Replies the TypeScript types of these entries and of the forms' values, as text, for the SDK. It needs a key with the `types` permission |

The form routes are public, and need no key. `:form` is a form's ID or its name.

| Route                  | What it does                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/forms/:form`  | Replies `{ data: { id, name, label, version, fields, open } }`                                                                                                               |
| `POST /v1/forms/:form` | Takes a submission, replying 201 with `{ data: { id, version, values, createdAt } }`, 422 with the validation report, or 403 while the form is closed. See [Forms](forms.md) |

Lists take these query parameters, with `where` and `order` in JSON:

| Parameter         | What it holds                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `where`           | Groups of conditions, where any group matches when all its conditions do: `[[{"field":"values.featured","op":"=","value":true}],[{"field":"values.title","op":"like","value":"release"}]]` |
| `order`           | Fields and their directions, in order: `{"values.published_at":"desc"}`. Without it, entries come in the order they were made                                                              |
| `page`, `perPage` | The page from 1, and from 1 to 100 entries a page, 15 if not given                                                                                                                         |
| `status`          | `published`, the default, or `draft` to read drafts, which needs a preview key and replies 403 for others. Every entry and media route takes it                                            |
| `with`            | Top-level fields whose links come resolved, a JSON list such as `["author","blocks"]`. Entry routes that reply one entry take it too                                                       |
| `depth`           | How many levels of links `with` resolves, from 1 to `delivery.maxDepth`. `delivery.depth` if not given                                                                                     |

- A field is `values.<name>` for a top-level field of the type, or an entry property: `id`, `slug`, `uri`, `parentId`, `position`, `createdAt` or `updatedAt`.
- For media, a field is one of their properties: `id`, `name`, `mime`, `size`, `width`, `height`, `alt`, `caption`, `createdAt` or `updatedAt`. `[[{"field":"mime","op":"like","value":"image/"}]]` finds images.
- The operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `like`, `not like`, `in`, `not in`, `between`, `not between`, `exists` and `not exists`.
- Field values compare as JSON, so `10` is more than `7`, and ISO dates compare as text. `like` ignores case and matches anywhere in the text. `in` takes a list, and `between` a list of two.
- `exists` means a value that isn't empty, as Sorlo Forms sees it: a missing field, null, empty text and an empty list don't count. A missing field never matches a comparison, `!=` included.
- A query with a field the type doesn't have, an unknown operator, or a value that doesn't suit it replies 400 with a `{ message }` saying what's wrong.
- A query takes as many conditions and sort fields as it needs, and `like` values of any length, but many make it slow, so we advise against them, above all over large entries. Each condition and each sort field reads its field out of every entry again, and Postgres lowercases a `like` pattern again for every entry it compares. Over 10,000 entries of about 20 KB each, 20 conditions took about 0.4 s and 164, about as many as fit in a URL, about 5 s, against 26 ms for 20 over small entries. Sorting by 30 fields took 1.3 s, and a 15,000-character `like` 0.6 s over small entries. The admin's lists and the MCP tools take the same queries, and the admin's filter makes two groups for each is not or does not contain rule, one for an empty field, so a filter group's conditions double with each such rule.

`with` names relationship and media fields, or fields that hold them. Naming a group, repeater or flexible field resolves every link inside it.

- A linked entry comes back as the delivery API returns entries, and a file as `/v1/media` does. A linked entry's own links come resolved too, down to `depth` levels, so at the default of 2 a post's author comes with the author's avatar. Past the depth, links stay IDs, and links that loop repeat until it runs out.
- What the delivery API doesn't serve, such as an archived entry, is left out: null in a field that holds one item, and missing from a list.
- Each level takes one query for its entries and one for its files, whatever their types. Each level can also multiply the entries a reply holds, which is why `delivery.maxDepth` caps it.
- One reply holds at most 2,000 linked entries and files, counting each place it shows one, since an entry linked from several places is written out at each. Past that it replies 400, `This reply would hold more than 2,000 linked entries and files. Ask for fewer with perPage, depth or with.`, before loading the level that would pass it. The page's own entries don't count. `delivery.maxLinks` sets the number, and `Infinity` lifts it, which we advise against: anyone with a key can send `with`, and before this limit eight entries that link to each other made a 73 MB reply at depth 5, and ten made 360 MB with 1.9 GB of memory.

```ts
// sorlo.config.ts
export default defineConfig({
  // ...
  delivery: { depth: 2, maxDepth: 5, maxLinks: 2000, origins: ['https://example.com'] },
})
```

| Setting    | What it holds                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `depth`    | The levels of links `with` resolves when a request doesn't send `depth`, 2 if not given                    |
| `maxDepth` | The most levels a request can ask for, 5 if not given                                                      |
| `maxLinks` | The most linked entries and files one reply can hold, 2,000 if not given. `Infinity` lifts it              |
| `origins`  | The sites whose JavaScript can read `/v1/entries` and `/v1/media`, through CORS. Any site can if not given |

## Replies

Row IDs are UUIDv7s. Records come back in `data`, and lists as `{ data, pagination: { page, perPage, total, lastPage } }`. A failed validation replies 422 with the validation report of [Sorlo Forms](https://github.com/WeAreSorlo/forms), whose `fields` hold each field's messages by its path, and every other error replies `{ message }`, as Laravel does.

An entry keeps its field values in `values`. `uri` is a hierarchical page's path, such as `docs/install/linux`, and `position` its place among its siblings. Both are null for the other structures. `publishedAt` is when it was last published, and the delivery API's `updatedAt` is its live copy's, so saving a draft moves neither.

```json
{
  "id": "0192f0c4-…",
  "type": "blog",
  "slug": "hello-world",
  "uri": null,
  "parentId": null,
  "position": null,
  "values": { "title": "Hello world", "slug": "hello-world" },
  "createdAt": "2026-10-28T12:00:00.000Z",
  "updatedAt": "2026-10-28T12:00:00.000Z",
  "publishedAt": "2026-10-28T12:00:00.000Z"
}
```

A media file has the `url` that serves it, on [`url`](people.md)'s address, or where that isn't set, on the address the request came to, which is `https` behind a proxy that sends `X-Forwarded-Proto: https`. `width` and `height` are null for files that aren't images, and `alt` and `caption` are null until they're written.

```json
{
  "id": "0192f0c4-…",
  "name": "team-photo.jpg",
  "mime": "image/jpeg",
  "size": 482113,
  "width": 1600,
  "height": 1067,
  "alt": "Twelve people on a beach, waving",
  "caption": "The team at the offsite",
  "url": "http://localhost:4100/media/0192f0c4-…/team-photo.jpg",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
```
