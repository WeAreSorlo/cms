# iight CMS

An open-source, schema-driven CMS built on iight core. `PLAN.md` holds the architecture, the decisions so far and the build order.

## Layout

| Folder         | What it is                                                                          |
| -------------- | ----------------------------------------------------------------------------------- |
| `packages/cms` | `@iight/cms`: the Hono server (`src/`), the admin UI (`admin/`) and the `iight` CLI |
| `packages/sdk` | `@iight/sdk`: the typed client for the delivery API, and `iight types pull`         |
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

| Command                       | What it does                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `iight dev`                   | Serves the API and the admin on one port, `PORT` or 3000, and runs automations                                        |
| `iight migrate`               | Runs pending migrations as one batch: the CMS's own, then the site project's content migrations                       |
| `iight migrate --check`       | Lists the saved entries that no longer pass their type's checks, and fails if there are any. It migrates nothing      |
| `iight migrate:rollback`      | Rolls back the last batch, content migrations first                                                                   |
| `iight migrate:status`        | Lists the migrations of both kinds, and the batch each ran in                                                         |
| `iight make:migration [name]` | Writes a content migration for the changes to `schema/types`, named after the types it changes unless you give a name |
| `iight make:user`             | Creates an admin user                                                                                                 |
| `iight make:api-key`          | Creates a key for the delivery API, shown just once                                                                   |

## Content types

Each content type is a JSON file in the site project's `schema/types` folder, named after the type, as in `playground/schema/types`. `iight dev` checks every file when it starts, including each field's `defaultValue` against its input, and lists all the problems it finds. Restart it after editing a file by hand. The type editor reloads the types itself.

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

### The type editor

In `iight dev`, the admin's Content types page creates, edits and deletes types, with core's schema builder for their fields. Settings that name a field, such as `titleField`, follow it when the builder renames it. Saving writes the type's file, laid out by the site project's Prettier if it has one, then runs `make:migration` and shows the migration it wrote with its flags and TODOs. The editor doesn't run the migration, so you can check it and finish any TODOs first. Outside `iight dev` the page is read-only, and types change through git.

### Relationship and media fields

The CMS adds two field types to core's. A `relationship` field links to entries, and a `media` field to files in the media library. Both store IDs. The admin edits them with pickers: a search over the entries of the types a relationship takes, and the media library, which can upload files too.

```json
{
  "id": "fld_g2we5u9g",
  "type": "relationship",
  "name": "author",
  "options": { "types": ["typ_7ky6hnq7"], "maximum": 1 }
}
```

| Option               | What it holds                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`              | For a relationship, the `id`s of the content types it links to, so renaming a type breaks nothing. For media, MIME types with wildcards, as in `media.types`. None means any            |
| `minimum`, `maximum` | How many items it takes. With a maximum of 1 the field holds one ID, such as `"author": "0192f0c4-…"`, and otherwise a list of IDs. The type editor starts new fields at a maximum of 1 |

- Saving checks that each ID is an entry or a file of a type the field takes. Archived entries count, so archiving one doesn't stop the entries that link to it from saving. `iight migrate --check` checks the same.
- Every save rebuilds the entry's rows in `entry_relations`, which record what its fields link to, nested ones included, and `iight migrate` rebuilds them after content migrations. The admin shows them as "Used by" on entries and files.
- Archiving an entry that others link to asks first in the admin. Deleting an entry or a file for good replies 409 while any entry links to it, archived ones included, so remove the links first. The type editor won't delete a type that relationship fields link to.
- Changing a `maximum` to or from 1 changes the shape of the field's values, which `make:migration` flags and `iight migrate --check` lists.

## Content migrations

Entries keep their values as JSON, so changing a content type never changes a table. A content migration changes the values inside entries instead. It's a file in the site project's `migrations` folder with an `up` and a `down`, as in Laravel.

`iight make:migration` compares `schema/types` with `migrations/.snapshot.json`, the types as the last migration left them, matching types, fields and layouts by `id`. Its first run only writes the snapshot, so run it once before you change a type. Commit the migrations and the snapshot.

| Change                                                | What the migration does                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Field added                                           | Nothing, or fills in its `defaultValue`. A new required field without one is flagged           |
| Field renamed or moved                                | Renames it, and back in `down`. A move into or out of a list or layout gets a stub with a TODO |
| Field removed                                         | Deletes its values, flagged, since `down` can't bring them back                                |
| Field type changed                                    | A stub with a TODO for the conversion                                                          |
| Choices or settings narrowed, or a field now required | Nothing, flagged for `iight migrate --check`                                                   |
| Layout renamed or removed                             | Renames the blocks' `_layout`, or deletes the blocks, flagged                                  |
| Type renamed                                          | Renames the type of its entries                                                                |
| Type removed                                          | Flagged. Its entries stay until you delete them                                                |

```ts
// migrations/2026_10_28_120000_blog.ts
import type { ContentMigration } from '@iight/cms'

export const up: ContentMigration = ({ entries }) => {
  entries.renameField('blog', 'title', 'headline')
  // Flagged: deletes the values of summary, which down can't bring back. Old versions keep them
  entries.removeField('blog', 'summary')
}

export const down: ContentMigration = ({ entries }) => {
  // The values of summary can't come back
  entries.renameField('blog', 'headline', 'title')
}
```

| Helper                         | What it does to each of the type's entries                                             |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `renameField(type, from, to)`  | Moves a field's value to another name or place                                         |
| `removeField(type, path)`      | Deletes a field's value                                                                |
| `addField(type, path, value)`  | Gives the field this value where it has none                                           |
| `mapField(type, path, change)` | Replaces the field's value with what `change` returns for it                           |
| `renameLayout(type, from, to)` | Renames a flexible field's layout, as in `('blog', 'blocks.quote', 'blocks.citation')` |
| `removeLayout(type, path)`     | Deletes the blocks of a layout                                                         |
| `renameType(from, to)`         | Renames a type, unless the new name already has entries                                |
| `update(type, change)`         | Any other change: `change` takes an entry's values and returns new ones                |

- Paths name fields as the schema nests them: `address.town` in a group, `pets.name` in every item of a repeater or matrix, and `blocks.quote.credit` in the blocks of the `quote` layout.
- An `up` or `down` only declares changes to one entry's values. `iight migrate` runs them on every entry, 500 at a time, inside one transaction for each migration, and old versions run them too.
- Every save records the last content migration that ran. Opening an old version runs the `up` of each migration that ran after it was saved, so its values fit the fields as they are now. A version saved after a migration that has since been rolled back replies 409 until it runs again.
- While a content migration hasn't run, saving an entry replies 409, since the types already have its change and the entries don't yet.
- `iight migrate --check` leaves out entries that were never saved, such as a singleton that has only been opened.

## Media

The admin's Media page holds the site's files, in a grid with a type filter and a search on names, where each file's name, alt text and caption are edited. The files are kept on a FlyDrive disk, set up as `storage` in `iight.config.ts`. It takes FlyDrive's `DriveManager` options as they are, so another FlyDrive driver can take the local one's place, and each file's row records the disk it went to. `media` is optional, and sets what the library takes and how its files are served.

```ts
import { defaultMediaTypes, defineConfig } from '@iight/cms'
import { FSDriver } from 'flydrive/drivers/fs'

export default defineConfig({
  database: { url: process.env.DATABASE_URL! },
  storage: {
    default: 'local',
    services: {
      local: () => new FSDriver({ location: new URL('./storage/', import.meta.url), visibility: 'public' }),
    },
  },
  media: {
    types: [...defaultMediaTypes, 'application/zip'],
    maxFileSize: 100 * 1024 * 1024,
    cacheControl: 'public, max-age=86400',
  },
})
```

| Setting        | What it holds                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`        | The MIME types uploads may have, with wildcards such as `image/*`. `defaultMediaTypes` is `image/*`, `video/*`, `audio/*` and `application/pdf` |
| `maxFileSize`  | The largest file in bytes, 50 MB if not given. Each upload is held in memory while it's checked, so a big limit needs memory to match           |
| `cacheControl` | The `Cache-Control` header of served files, `public, max-age=3600` if not given                                                                 |

- An upload's type is read from its content by [file-type](https://github.com/sindresorhus/file-type), never from its name or the type the browser sends. It knows about 180 formats, such as MOV, HEIC, Office files and ZIP archives. SVGs, which are XML text, are known by their `svg` root element.
- A type with no signature in its content, such as CSV or plain text, can't be allowed, so `iight dev` won't start with one in `types`.
- An image's `width` and `height` are read on upload by sharp, as it shows after EXIF rotation. They're null for other files, and for images sharp can't read, such as BMP.
- A file is stored as `<id>.<extension>`, so its name never reaches the disk. Names lose folders and control, invisible and reserved characters, and end in an extension of the file's real type, so a PNG named `evil.html` becomes `evil.html.png`.
- Files are public at `/media/<id>/<name>`, since `<img>` can't send an API key. They're found by ID, so a URL can't reach outside the disk, and any name after the ID serves the same file, so renaming breaks no links. They're served with `nosniff`, and in ranges of bytes for video and audio players.
- Pictures, video, audio and PDFs open in the browser's own viewers. Every other file, such as an SVG or an XML file, is served with `Content-Security-Policy: sandbox`, so a script in it can't run, even when its URL is opened on its own. A frontend that puts an SVG's markup into its own page loses that, so show SVGs with `<img>`.
- Deleting a file removes it from its disk too.

## Forms

Forms live in the database rather than in `schema/`, since marketers make them in production. The admin's Forms page creates and edits them with core's schema builder, which offers every one of core's inputs. Each form has a label and a `name`, such as `contact_us`, which the SDK and the generated types call it by.

- Each change to a form's fields saves a new version, and each submission records the version it was checked against, so the inbox shows it with that version's fields. Changing only the label or name keeps the version.
- Each form has an inbox of its submissions, newest first, with Spam and Archive views. Archived submissions can be restored, and any submission can be marked as spam by hand, such as one that got past the honeypot, or as not spam, such as a person's that filled it in.
- The form's page shows HTML for pasting it into any page, which posts to the form with JavaScript off and takes the page's own styles. It posts to the form's ID, so renaming a form never breaks a page it's pasted into. Repeater, matrix and flexible fields are left out of it, since adding their items needs JavaScript.

### Submissions

`POST /v1/forms/:form` takes a submission, where `:form` is the form's ID or its name. The body is the values themselves, as JSON or as a plain HTML form post, and no key is needed.

- A plain form post names a group's fields as `address.town`, and a list of choices, such as a checkbox field, sends its name again for each one ticked. The text it sends takes each field's type, so `3` is a number and `on` ticks a boolean.
- The values go through `pickValues` and `validateServerValues`, as entries' do. JSON requests, and requests that accept JSON, get JSON replies. A plain form post gets a small page in place of each reply, with the same status and a link back to the page it came from.
- Each submission keeps the form's version, and the IP address, user agent and referer it came with.

Spam is kept out of the inbox in two ways:

- **A honeypot.** The pasted HTML has a field named `_website`, off screen and out of reach of screen readers and the keyboard. A submission that fills it in is kept as spam and gets the reply any other gets, so a bot can't tell. Field names start with a letter, so no field can take the name.
- **A rate limit.** Each IP address can make 10 posts in 10 minutes, valid or not, and is then refused with a 429 and `Retry-After` until the time is up. Requests that send a delivery API key aren't limited, so a site's own server can submit for all its visitors. Behind a proxy on a private network, such as a load balancer, the address is the one the proxy forwarded for in `X-Forwarded-For`, which the CMS believes from no one else.

Any site's JavaScript can call the form routes, unless `forms.origins` in `iight.config.ts` lists the sites that can.

```ts
// iight.config.ts
export default defineConfig({
  // ...
  forms: {
    origins: ['https://example.com'],
    rateLimit: { posts: 10, minutes: 10 },
  },
})
```

| Setting     | What it holds                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `origins`   | The sites whose JavaScript can call the form routes, through CORS. Any site can if not given. Plain HTML forms and servers can always post |
| `rateLimit` | How many `posts` an IP address can make in a number of `minutes`, 10 in 10 if not given                                                    |

The rate limit counts posts in the CMS's process, so each process behind a load balancer keeps its own count.

## Automations

Every change writes an event, in the same transaction as the change, so an event is kept exactly when its change is. A worker in the server's own process hands each event to the automations it triggers and runs their actions. The admin's Automations page creates and edits them, and shows each one's runs.

| Event                                               | Written when                                                                                                  | Its data                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `entry.created`, `entry.updated`                    | An entry is saved or moved among its siblings. Each page whose `uri` or position changes with it gets one too | `{ entry }`, as the admin API returns it                     |
| `entry.archived`, `entry.restored`, `entry.deleted` | An entry is archived, restored or deleted, with one for each page that goes along with it                     | `{ entry }`, as it was left                                  |
| `submission.created`                                | A form takes a submission, spam included                                                                      | `{ form: { id, name, label }, submission }`, with its `spam` |
| `media.created`, `media.updated`, `media.deleted`   | A file is uploaded, edited or deleted                                                                         | `{ media }`, with its `url`                                  |

Content migrations write no events. An automation has:

- **Triggers**, one or more of the events.
- **Conditions**, core's conditional logic, checked against the event's data. Any group can match, and a group matches when all its rules do. A rule's field is a path into the data, such as `entry.type`, `entry.values.featured`, `form.name`, `submission.values.email` or `submission.spam`, and values compare as text, so `false` matches `"spam": false`. With no groups, every event it's triggered by runs it.
- **Actions**, run in order. They're the blocks of a flexible field, so each action's settings are a core schema, in `src/schemas.ts`, and `src/actions.ts` runs it.

| Action         | Settings                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Send an email  | `to`, addresses separated by commas, and `subject`, which says what happened if it's left empty, such as "New submission: Contact us". The email lists the record's fields by their labels |
| Call a webhook | `url`, a signing `secret`, which saving makes when it's left empty, `headers` to send, such as `Authorization`, and a `timeout` in seconds for the reply, from 1 to 30 and 10 if not given |

A form's page lists the automations its submissions can run, with a link that starts one that emails them, skipping spam. It's an automation like any other, so it can call a webhook too.

### Webhooks

A webhook gets a `POST` of the event as JSON. `id` is the event's ID, which stays the same on every try, so a receiver can drop the ones it already has.

```json
{
  "id": "0192f0c4-…",
  "event": "submission.created",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "data": { "form": { "id": "0192f0c4-…", "name": "contact_us", "label": "Contact us" }, "submission": { "…": "…" } }
}
```

Requests are signed the [Standard Webhooks](https://www.standardwebhooks.com) way, with `webhook-id` (the event's ID), `webhook-timestamp` and `webhook-signature`, which is `v1,` and a base64 HMAC-SHA256 of `<id>.<timestamp>.<body>`, keyed with the bytes of the secret after `whsec_`. Its libraries check them in most languages:

```ts
import { Webhook } from 'standardwebhooks'

// Throws unless the request is signed with the secret, and recent
const event = new Webhook(secret).verify(body, headers)
```

- A reply from 200 to 299 succeeds. Anything else fails, redirects included, which aren't followed. The first 2000 characters of the reply go in the runs.
- Webhooks can't reach loopback, private, link-local or shared addresses, cloud metadata services among them, unless `webhooks.allowNetworks` lists the network. A name is checked by the address it resolves to, and the request goes to that address, so it can't resolve somewhere else in between.

### Runs and retries

Each try of each action is a run, which the automation's runs page lists, newest first, with what came back or why it failed.

- An action that fails is tried again 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours later, 6 tries in all unless `automations.attempts` says otherwise. An action that's still failing holds back the ones after it, and once its tries run out, they don't run.
- Each try runs the action as it is then, so fixing a webhook's URL counts from its next try.
- An action runs at least once. A crash partway through can run it again, which is why receivers should drop event IDs they've seen.
- Each process takes events and runs with `SKIP LOCKED`, so two processes on one database never take the same one. A process runs one action at a time.

```ts
// iight.config.ts
import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({ host: 'smtp.example.com', port: 587, auth: { user, pass } })

export default defineConfig({
  // ...
  mail: { from: 'iight <cms@example.com>', send: (message) => transporter.sendMail(message) },
  automations: { attempts: 6 },
  webhooks: { allowNetworks: ['10.0.0.0/8'] },
})
```

| Setting                  | What it holds                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail.from`              | Who emails come from                                                                                                                                                                                                                     |
| `mail.send`              | Sends one email, `{ from, to, subject, text, html }` with `to` a list of addresses, which nodemailer's `sendMail` takes as it is. What it resolves goes in the runs, and what it throws fails the try. Email actions fail until it's set |
| `automations.attempts`   | How many times an action is tried before it's given up, 6 if not given                                                                                                                                                                   |
| `webhooks.allowNetworks` | The internal networks webhooks may reach, such as `10.0.0.0/8` for a site's own services, or an address such as `127.0.0.1`                                                                                                              |

The playground's `send` prints each email in the terminal, and it allows webhooks to this machine.

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

A media file has the `url` that serves it, on the address the request came to, which is `https` behind a proxy that sends `X-Forwarded-Proto: https`. `width` and `height` are null for files that aren't images, and `alt` and `caption` are null until they're written.

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
  "url": "http://localhost:3000/media/0192f0c4-…/team-photo.jpg",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "updatedAt": "2026-10-28T12:00:00.000Z"
}
```

### The admin API

The admin uses it with the session cookie, which every route but `/api/session` needs. Its entries also have `archivedAt`, `createdBy` and `updatedBy`, and its media `createdBy`.

| Route                                   | What it does                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                     | Signs in with `{ email, password }`. Replies `{ data: user }` and sets the `iight_session` cookie, or 422 with core's validation report           |
| `GET /api/session`                      | Replies `{ data: user }` for the signed-in user, or 401                                                                                           |
| `DELETE /api/session`                   | Signs out                                                                                                                                         |
| `GET /api/types`                        | Lists the content types, with `editable`, which is true in `iight dev`                                                                            |
| `POST /api/types`                       | Creates a type from its settings and `fields`, giving it an `id`. Replies `{ data: type, migration: { file, notes } }`, or 422 with core's report |
| `PUT /api/types/:type`                  | Replaces a type, renaming its file when `name` changes, and writes a content migration for the change. Replies as `POST` does                     |
| `DELETE /api/types/:type`               | Deletes a type's file and writes a migration that flags its entries, which stay. Replies `{ migration: { file, notes } }`                         |
| `GET /api/types/:type/entries`          | Lists live entries, or archived ones with `archived=true`, taking the delivery API's query parameters                                             |
| `POST /api/types/:type/entries`         | Creates an entry from `{ values, parentId }`, where `parentId` is for hierarchicals                                                               |
| `GET /api/types/:type/singleton`        | Replies a singleton's entry, created the first time it's opened                                                                                   |
| `GET /api/entries/:id`                  | Replies an entry, archived or not                                                                                                                 |
| `PUT /api/entries/:id`                  | Saves `{ values, parentId }`. A moved page goes after its new siblings, and the `uri`s under it follow                                            |
| `PUT /api/entries/:id/position`         | Moves a page to `{ position }` among its siblings, counting from 0                                                                                |
| `POST /api/entries/:id/archive`         | Archives an entry with its live descendants                                                                                                       |
| `POST /api/entries/:id/restore`         | Restores an entry with the descendants archived along with it, once its parent is live                                                            |
| `DELETE /api/entries/:id`               | Deletes an archived entry for good, with its descendants and versions, or replies 409 while other entries link to it                              |
| `GET /api/entries/:id/used-by`          | Lists the entries that link to it, archived ones included                                                                                         |
| `GET /api/entries/:id/versions`         | Lists the entry's versions, newest first. Every save writes one                                                                                   |
| `GET /api/entries/:id/versions/:number` | Replies a version, with its values brought up to date by the content migrations that ran since. Restoring it means saving those values again      |
| `GET /api/media`                        | Lists media, taking the delivery API's query parameters                                                                                           |
| `POST /api/media`                       | Uploads one file, sent as the multipart field `file`. Replies 201 with `{ data: media }`, or 422 with core's report on `file` saying what's wrong |
| `PUT /api/media/:id`                    | Saves `{ name, alt, caption }`, or replies 422 with core's report                                                                                 |
| `DELETE /api/media/:id`                 | Deletes a file from its disk, with its record, or replies 409 while entries link to it                                                            |
| `GET /api/media/:id/used-by`            | Lists the entries that link to the file, archived ones included                                                                                   |
| `GET /api/forms`                        | Lists the forms, each with `embed`, the HTML that pastes it into a page                                                                           |
| `POST /api/forms`                       | Creates a form from `{ label, name, fields }`, at version 1. Replies 201 with `{ data: form }`, or 422 with core's report                         |
| `GET /api/forms/:id`                    | Replies a form                                                                                                                                    |
| `PUT /api/forms/:id`                    | Saves `{ label, name, fields }`, as a new version when the fields change                                                                          |
| `GET /api/forms/:id/versions/:number`   | Replies a version's `fields`                                                                                                                      |
| `GET /api/forms/:id/submissions`        | Lists the inbox, or the archive with `archived=true`, or spam with `spam=true`, taking `order`, `page` and `perPage`                              |
| `POST /api/submissions/:id/archive`     | Archives a submission                                                                                                                             |
| `POST /api/submissions/:id/restore`     | Restores an archived submission                                                                                                                   |
| `POST /api/submissions/:id/spam`        | Marks a submission as spam, taking it out of the inbox or the archive                                                                             |
| `POST /api/submissions/:id/not-spam`    | Marks a submission as not spam, back in the inbox, or the archive if it was archived                                                              |
| `GET /api/automations`                  | Lists the automations, or with `form=<id>`, those that form's submissions can run                                                                 |
| `POST /api/automations`                 | Creates an automation from `{ name, triggers, conditions, actions }`. Replies 201 with `{ data: automation }`, or 422 with core's report          |
| `GET /api/automations/:id`              | Replies an automation                                                                                                                             |
| `PUT /api/automations/:id`              | Saves `{ name, triggers, conditions, actions }`                                                                                                   |
| `DELETE /api/automations/:id`           | Deletes an automation, with its runs, including those still to come                                                                               |
| `GET /api/automations/:id/runs`         | Lists its runs, each a try of one of its actions with its event, taking `order`, `page` and `perPage`                                             |

The type routes reply 403 outside `iight dev`. Creating or saving an entry replies 409 while a content migration hasn't run.

### The delivery API

It's read-only, and serves media and live entries once they've been saved. A singleton's entry is created when it's first opened, but it's served only from its first save, when its required fields are filled in. It needs a key from `iight make:api-key`, sent as `Authorization: Bearer <key>`.

| Route                              | What it does                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /v1/entries/:type`            | Lists entries. A singleton is a list of one                                                  |
| `GET /v1/entries/:type/:id`        | Replies an entry by ID                                                                       |
| `GET /v1/entries/:type/slug/:slug` | Replies a top-level entry by slug                                                            |
| `GET /v1/entries/:type/uri/*`      | Replies a hierarchical page by `uri`, as in `/v1/entries/docs/uri/install`                   |
| `GET /v1/media`                    | Lists media                                                                                  |
| `GET /v1/media/:id`                | Replies a media file by ID                                                                   |
| `GET /types`                       | Replies the TypeScript types of these entries and of the forms' values, as text, for the SDK |

The form routes are public, and need no key. `:form` is a form's ID or its name.

| Route                  | What it does                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/forms/:form`  | Replies `{ data: { id, name, label, version, fields } }`                                                                             |
| `POST /v1/forms/:form` | Takes a submission, replying 201 with `{ data: { id, version, values, createdAt } }`, or 422 with core's report. See [Forms](#forms) |

Lists take these query parameters, with `where` and `order` in JSON:

| Parameter         | What it holds                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `where`           | Groups of conditions, where any group matches when all its conditions do: `[[{"field":"values.featured","op":"=","value":true}],[{"field":"values.title","op":"like","value":"release"}]]` |
| `order`           | Fields and their directions, in order: `{"values.published_at":"desc"}`. Without it, entries come in the order they were made                                                              |
| `page`, `perPage` | The page from 1, and from 1 to 100 entries a page, 15 if not given                                                                                                                         |
| `with`            | Top-level fields whose links come resolved, a JSON list such as `["author","blocks"]`. Entry routes that reply one entry take it too                                                       |
| `depth`           | How many levels of links `with` resolves, from 1 to `delivery.maxDepth`. `delivery.depth` if not given                                                                                     |

- A field is `values.<name>` for a top-level field of the type, or an entry property: `id`, `slug`, `uri`, `parentId`, `position`, `createdAt` or `updatedAt`.
- For media, a field is one of their properties: `id`, `name`, `mime`, `size`, `width`, `height`, `alt`, `caption`, `createdAt` or `updatedAt`. `[[{"field":"mime","op":"like","value":"image/"}]]` finds images.
- The operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `like`, `not like`, `in`, `not in`, `between`, `not between`, `exists` and `not exists`.
- Field values compare as JSON, so `10` is more than `7`, and ISO dates compare as text. `like` ignores case and matches anywhere in the text. `in` takes a list, and `between` a list of two.
- `exists` means a value that isn't empty, as core sees it: a missing field, null, empty text and an empty list don't count. A missing field never matches a comparison, `!=` included.
- A query with a field the type doesn't have, an unknown operator, or a value that doesn't suit it replies 400 with a `{ message }` saying what's wrong.

`with` names relationship and media fields, or fields that hold them. Naming a group, repeater or flexible field resolves every link inside it.

- A linked entry comes back as the delivery API returns entries, and a file as `/v1/media` does. A linked entry's own links come resolved too, down to `depth` levels, so at the default of 2 a post's author comes with the author's avatar. Past the depth, links stay IDs, and links that loop repeat until it runs out.
- What the delivery API doesn't serve, such as an archived entry, is left out: null in a field that holds one item, and missing from a list.
- Each level takes one query for its entries and one for its files, whatever their types. Each level can also multiply the entries a reply holds, which is why `delivery.maxDepth` caps it.

```ts
// iight.config.ts
export default defineConfig({
  // ...
  delivery: { depth: 2, maxDepth: 5 },
})
```

| Setting    | What it holds                                                                           |
| ---------- | --------------------------------------------------------------------------------------- |
| `depth`    | The levels of links `with` resolves when a request doesn't send `depth`, 2 if not given |
| `maxDepth` | The most levels a request can ask for, 5 if not given                                   |

## The SDK

`@iight/sdk` is the delivery API's client for frontends. Types pulled from the CMS check every query and type every result, and it never imports server code.

```ts
import { createClient } from '@iight/sdk'

const cms = createClient({ url: process.env.IIGHT_URL!, token: process.env.IIGHT_TOKEN! })

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
- Results are the API's plain JSON. A failed request throws an `IightError` with the HTTP `status`, the API's `message` and the reply's `body`. When the CMS can't be reached, fetch's own error comes through.
- `createClient` takes a `fetch` to use in place of the global one.

`cms.form('contact_us').submit(values)` sends a form's values as JSON, typed by the form's fields, and resolves the submission as it was stored, `{ id, version, values, createdAt }`. Values that don't pass throw an `IightError` with status 422, whose `body` is core's report, for a core form's `applyReport`.

```ts
// In a browser, which needs no key to submit
const cms = createClient({ url: 'https://cms.example.com' })
await cms.form('contact_us').submit({ name: 'Ada', email: 'ada@example.com' })
```

The `token` is optional, since submitting needs none, but entries do. A site's own server sends its key when it submits for its visitors, so they aren't rate limited as one IP address.

`npx iight types pull` writes `src/iight-types.d.ts` from `GET /types`, reading the CMS's address from `IIGHT_URL` and an API key from `IIGHT_TOKEN`. It declares each content type's values and entry, such as `BlogValues` and `EntryBlog`, the fields `with` can resolve, such as `BlogResolvedValues`, and each form's values, such as `ContactUsFormValues`, and registers them with the SDK. Forms change in the admin, so pull again after changing one. Commit the file, so builds don't need the CMS, and leave it unformatted. In CI, `npx iight types pull --check` fails when the file is out of date.

A project with both packages, such as the playground, gets the CMS's `iight` command, which passes `types` on to the SDK. With `npm run dev` running and a key from `npx iight make:api-key`:

```bash
cd playground
export IIGHT_URL=http://localhost:3000 IIGHT_TOKEN=<key>
npm run types      # pulls src/iight-types.d.ts
npm run frontend   # runs src/frontend.ts, a typed script
```

## Working on core at the same time

Core is linked from `../core` with a `file:` dependency, and its package points at `dist/`. Keep its build running while you change it:

```bash
cd ../core
npx tsup --watch
```

The admin's Vite config dedupes `react`, `react-dom`, `react-i18next` and `i18next`, so the linked core uses the admin's copies instead of bringing its own.

## Checks

`npm test` runs against the `iight_test` database, so start Postgres first. It also typechecks the `*.test-d.ts` files, which show the SDK rejecting wrong field names and values. There's also `npm run typecheck` for every package, and `npm run format` (or `format:fix`).
