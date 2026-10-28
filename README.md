# iight CMS

An open-source, schema-driven CMS built on iight core. `PLAN.md` holds the architecture, the decisions so far and the build order.

## Layout

| Folder         | What it is                                                                          |
| -------------- | ----------------------------------------------------------------------------------- |
| `packages/cms` | `@iight/cms`: the Hono server (`src/`), the admin UI (`admin/`) and the `iight` CLI |
| `playground`   | A site project for development, with its `iight.config.ts`                          |

## Getting started

You need Node 22.12 or later, and Docker.

```bash
npm install
npm run db          # Postgres 17 on localhost:5432
cd playground
npx iight migrate
npx iight make:user
npx iight make:api-key   # a key for the delivery API
npm run dev         # the admin is at http://localhost:3000/admin/
```

`npm run db` also creates an `iight_test` database for the tests, but only when it first creates the Postgres volume.

## The iight CLI

Run it from a site project, where it reads `iight.config.ts`.

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `iight dev`              | Serves the API and the admin on one port, `PORT` or 3000 |
| `iight migrate`          | Runs pending migrations as one batch                     |
| `iight migrate:rollback` | Rolls back the last batch                                |
| `iight migrate:status`   | Lists each migration and the batch it ran in             |
| `iight make:user`        | Creates an admin user                                    |
| `iight make:api-key`     | Creates a key for the delivery API, shown just once      |

## Content types

Each content type is a JSON file in the site project's `schema/types` folder, named after the type, as in `playground/schema/types`. `iight dev` checks every file when it starts and lists all the problems it finds. Restart it after editing a type.

| Key                 | What it holds                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `id`                | A stable ID, such as `typ_k3x9q2mz`, so a renamed type can be told apart from a new one      |
| `name`              | The file's name: a letter, then letters, digits or underscores                               |
| `label`, `singular` | What the admin calls the type and one of its entries, such as `Blog posts` and `Blog post`   |
| `structure`         | `collection`, `hierarchical` for pages with parents, or `singleton` for a type of one entry  |
| `icon`              | Optional, the name of an icon                                                                |
| `titleField`        | Optional, the top-level field that titles an entry                                           |
| `slugField`         | Optional, a top-level `identifier` field. Slugs are unique among siblings, archived included |
| `listColumns`       | Optional, the top-level fields the admin's lists show                                        |
| `fields`            | A core schema. Every field and flexible layout needs an `id`, such as `fld_k3x9q2mz`         |

## The API

Row IDs are UUIDv7s. Records come back in `data`, and lists as `{ data, pagination: { page, perPage, total, lastPage } }`. A failed validation replies 422 with core's report, and every other error replies `{ message }`, as Laravel does.

An entry keeps its field values in `values`. `uri` is a hierarchical page's path, such as `docs/install/linux`, and `position` its place among its siblings. Both are null for the other structures.

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
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
```

### The admin API

The admin uses it with the session cookie, which every route but `/api/session` needs. Its entries also have `archivedAt`, `createdBy` and `updatedBy`.

| Route                                   | What it does                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                     | Signs in with `{ email, password }`. Replies `{ data: user }` and sets the `iight_session` cookie, or 422 with core's validation report |
| `GET /api/session`                      | Replies `{ data: user }` for the signed-in user, or 401                                                                                 |
| `DELETE /api/session`                   | Signs out                                                                                                                               |
| `GET /api/types`                        | Lists the content types                                                                                                                 |
| `GET /api/types/:type/entries`          | Lists live entries, or archived ones with `archived=true`, taking the delivery API's query parameters                                   |
| `POST /api/types/:type/entries`         | Creates an entry from `{ values, parentId }`, where `parentId` is for hierarchicals                                                     |
| `GET /api/types/:type/singleton`        | Replies a singleton's entry, created the first time it's opened                                                                         |
| `GET /api/entries/:id`                  | Replies an entry, archived or not                                                                                                       |
| `PUT /api/entries/:id`                  | Saves `{ values, parentId }`. A moved page goes after its new siblings, and the `uri`s under it follow                                  |
| `PUT /api/entries/:id/position`         | Moves a page to `{ position }` among its siblings, counting from 0                                                                      |
| `POST /api/entries/:id/archive`         | Archives an entry with its live descendants                                                                                             |
| `POST /api/entries/:id/restore`         | Restores an entry with the descendants archived along with it, once its parent is live                                                  |
| `DELETE /api/entries/:id`               | Deletes an archived entry for good, with its descendants and versions                                                                   |
| `GET /api/entries/:id/versions`         | Lists the entry's versions, newest first. Every save writes one                                                                         |
| `GET /api/entries/:id/versions/:number` | Replies a version with its values. Restoring it means saving those values again                                                         |

### The delivery API

It's read-only and serves live entries only. It needs a key from `iight make:api-key`, sent as `Authorization: Bearer <key>`.

| Route                              | What it does                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `GET /v1/entries/:type`            | Lists entries. A singleton is a list of one                                |
| `GET /v1/entries/:type/:id`        | Replies an entry by ID                                                     |
| `GET /v1/entries/:type/slug/:slug` | Replies a top-level entry by slug                                          |
| `GET /v1/entries/:type/uri/*`      | Replies a hierarchical page by `uri`, as in `/v1/entries/docs/uri/install` |

Lists take these query parameters, with `where` and `order` in JSON:

| Parameter         | What it holds                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `where`           | Groups of conditions, where any group matches when all its conditions do: `[[{"field":"values.featured","op":"=","value":true}],[{"field":"values.title","op":"like","value":"release"}]]` |
| `order`           | Fields and their directions, in order: `{"values.published_at":"desc"}`. Without it, entries come in the order they were made                                                              |
| `page`, `perPage` | The page from 1, and from 1 to 100 entries a page, 15 if not given                                                                                                                         |

- A field is `values.<name>` for a top-level field of the type, or an entry property: `id`, `slug`, `uri`, `parentId`, `position`, `createdAt` or `updatedAt`.
- The operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `like`, `not like`, `in`, `not in`, `between`, `not between`, `exists` and `not exists`.
- Field values compare as JSON, so `10` is more than `7`, and ISO dates compare as text. `like` ignores case and matches anywhere in the text. `in` takes a list, and `between` a list of two.
- `exists` means a value that isn't empty, as core sees it: a missing field, null, empty text and an empty list don't count. A missing field never matches a comparison, `!=` included.
- A query with a field the type doesn't have, an unknown operator, or a value that doesn't suit it replies 400 with a `{ message }` saying what's wrong.

## Working on core at the same time

Core is linked from `../core` with a `file:` dependency, and its package points at `dist/`. Keep its build running while you change it:

```bash
cd ../core
npx tsup --watch
```

The admin's Vite config dedupes `react`, `react-dom`, `react-i18next` and `i18next`, so the linked core uses the admin's copies instead of bringing its own.

## Checks

`npm test` runs against the `iight_test` database, so start Postgres first. There's also `npm run typecheck`, and `npm run format` (or `format:fix`).
