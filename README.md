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
npx iight make:api-key --types   # a key for the delivery API that can pull types
npm run dev         # the admin is at http://localhost:3000/admin/
```

`npm run db` also creates an `iight_test` database for the tests, but only when it first creates the Postgres volume.

In `iight dev`, `/admin/#/design` shows the admin's design system: its tokens, their contrast in the current theme, and every core input. `DESIGN.md` has the plan.

## The iight CLI

Run it from a site project, where it reads `iight.config.ts`, and before that the project's `.env` if there is one, for settings such as `DATABASE_URL` or `ANTHROPIC_API_KEY`. A variable the environment already sets keeps its value. Keep `.env` out of git, as the workspace's `.gitignore` does.

| Command                       | What it does                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iight dev`                   | Serves the API and the admin on one port, `PORT` or 3000, and runs automations                                                                                                     |
| `iight start`                 | Serves the API and the built admin for production on `PORT` or 3000, and runs automations. Types are read-only                                                                     |
| `iight migrate`               | Runs pending migrations as one batch: the CMS's own, then the site project's content migrations                                                                                    |
| `iight migrate --check`       | Lists the saved entries whose drafts no longer pass what a save checks, or whose live copies no longer pass what a publish checks, and fails if there are any. It migrates nothing |
| `iight migrate:rollback`      | Rolls back the last batch, content migrations first                                                                                                                                |
| `iight migrate:status`        | Lists the migrations of both kinds, and the batch each ran in                                                                                                                      |
| `iight make:migration [name]` | Writes a content migration for the changes to `schema/types`, named after the types it changes unless you give a name                                                              |
| `iight make:user`             | Creates an admin user                                                                                                                                                              |
| `iight make:api-key`          | Creates a key for the delivery API, shown just once. `--preview`, `--types` and `--submit` give it those [permissions](#api-keys)                                                  |

`iight start` listens on every interface unless `HOST` names one, such as `HOST=127.0.0.1` behind a proxy on the same machine. It serves the admin from `packages/cms/admin/dist`, which `npm run build` writes, so run that again after changing the admin. The package's `prepack` runs the build before `npm pack` and `npm publish`, so sites never build the admin.

## Content types

Each content type is a JSON file in the site project's `schema/types` folder, named after the type, as in `playground/schema/types`. `iight dev` checks every file when it starts, including each field's `defaultValue` against its input, and lists all the problems it finds. Restart it after editing a file by hand. The type editor reloads the types itself.

| Key                 | What it holds                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                | A stable ID, such as `typ_k3x9q2mz`, so a renamed type can be told apart from a new one                                              |
| `name`              | The file's name: a letter, then letters, digits or underscores                                                                       |
| `label`, `singular` | What the admin calls the type and one of its entries, such as `Blog posts` and `Blog post`                                           |
| `structure`         | `collection`, `hierarchical` for pages with parents, or `singleton` for a type of one entry                                          |
| `drafts`            | Optional, `false` for a type whose every save publishes, running every check, in place of keeping drafts. Drafts are on if not given |
| `icon`              | Optional, the name of an icon                                                                                                        |
| `titleField`        | Optional, the top-level field that titles an entry, which a list's search looks in                                                   |
| `slugField`         | Optional, a top-level `identifier` field. Slugs are unique among siblings, archived included                                         |
| `listColumns`       | Optional, the top-level fields the admin's lists show                                                                                |
| `fields`            | A core schema. Every field and flexible layout needs an `id`, such as `fld_k3x9q2mz`                                                 |

Each type's list in the admin has a panel beside it with New, Bulk edit and the archive, a search on the title field, and Filter, core's conditions input over the type's top-level fields. The search and the filter stay in the URL, as in `#/types/blog?search=lamp`, so a link shares them. They become the list API's `where`, which has every operator but starts with, so the list leaves those rules out and says so. A search or filter on a hierarchical type lists the pages that match, rather than the tree. The Media page has the same, beside its type filter, over names, alt text, captions, MIME types, dimensions and upload dates.

### The type editor

In `iight dev`, the admin's Content types page creates, edits and deletes types, with core's schema builder for their fields. Settings that name a field, such as `titleField`, follow it when the builder renames it. Saving writes the type's file, laid out by the site project's Prettier if it has one, then runs `make:migration` and shows the migration it wrote with its flags and TODOs. The editor doesn't run the migration, so you can check it and finish any TODOs first. A site with no snapshot yet gets one of the types as they were first, so its first change still gets its migration. A type with entries keeps its structure, archived ones counting, since nothing moves entries from one structure to another, so saving a new one is refused under Structure, as it is while a content migration hasn't run, since that may still rename a type's entries. Names are one whatever their case, since a disk may ignore it, a type's file the server didn't load at start, such as one a `git pull` brought, is never written over, and a name with entries left under it, from a type that's gone, isn't taken, since a type of that name would take them over. Save sends back the type as the editor loaded it, and is refused when its file has changed since, through the assistant, another tab or by hand, so it never writes back over that change. When anything after the write fails, such as another type's file that doesn't load, every file, the migrations and the loaded types go back as they were. Outside `iight dev` the page is read-only, and types change through git. With the [assistant](#the-assistant) on, it can also propose new types and changes to them, as [content types through the assistant](#content-types-through-the-assistant) describes.

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

### Form fields

A `form` field holds the ID of one of the [forms](#forms), such as the sign-up form an event's page shows, so renaming the form breaks nothing. The editor picks it from the forms by label, marking the closed ones, and saving checks that the form exists. It has no options. Delivery returns the ID, which `GET /v1/forms/:form` serves, and the SDK's types call it a `string`.

```json
{ "id": "fld_kt5appci", "type": "form", "name": "form", "label": "Form" }
```

### Shared groups

A shared group is a set of fields defined once and used by many types, such as SEO fields, so the types' copies can't drift apart. Each is a JSON file in the site project's `schema/groups` folder, beside `schema/types`, named after the group, as in `playground/schema/groups`:

```json
{
  "id": "grp_k3x9q2mz",
  "name": "seo",
  "label": "SEO",
  "fields": [
    { "id": "fld_l2g562g3", "type": "text", "name": "title", "label": "Title", "options": { "maxLength": 60 } },
    { "id": "fld_u8dwksgh", "type": "textarea", "name": "description", "label": "Description" }
  ]
}
```

| Key      | What it holds                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`     | A stable ID, such as `grp_k3x9q2mz`, which uses name it by, so renaming a group breaks nothing                    |
| `name`   | The file's name: a letter, then letters, digits or underscores. It also names the group's pulled type, `GroupSeo` |
| `label`  | What the admin calls the group                                                                                    |
| `fields` | A core schema, checked as a type's is. Every field and flexible layout needs an `id`, unique in the group         |

A type uses a group with a `shared` field, which names it by `id`:

```json
{
  "id": "fld_04fi4quz",
  "type": "shared",
  "name": "seo",
  "label": "Search and sharing",
  "options": { "group": "grp_k3x9q2mz" }
}
```

- A use has its own `name`, `label`, `instructions`, `width` and conditions. Its fields always come from the group, every one of them, and like a group it isn't `required`.
- Its values sit under its name, as a group's do: `values.seo.title`.
- Uses go anywhere a field can, inside groups, repeaters and flexible layouts included, and a type can use the same group more than once. A group can use other groups, but never itself, even through others.
- Types load with each use expanded into an ordinary `group` field holding the group's fields, so the editor, the checks, `with()`, `entry_relations`, the bulk grid, the delivery API and `iight migrate --check` treat it as one. The group keeps `options.group`, and its fields' ids get the use's in front, such as `fld_04fi4quz.fld_l2g562g3`, so two uses in one type never share one. So field ids in type and group files can't hold a dot.
- `iight dev` checks the group files with the types, listing ids two files share, groups that use themselves and uses that name a group that doesn't exist.

In `iight dev`, the admin's Shared groups page creates, edits and deletes groups as the type editor does types, writing a migration for every type each change reaches. Deleting one replies 409 while a type or another group uses it. The type editor's palette has a Shared group field, and beside the form it lists the type's groups at any depth:

- **Make shared** turns one of the type's own groups into a new shared group, with its fields and their ids, and swaps the type's copy for a use with the copy's `id`, name and settings. Saving the type then needs no migration.
- **Use shared group** swaps a copy for a use of a shared group, showing first which values the swap keeps and which it deletes.

## Drafts and publishing

Every entry has a draft, and once it's published, a live copy, which is what the delivery API serves. Save writes the draft as a new version, and the live site keeps its copy until Publish replaces it. Unpublish takes the live copy down and keeps the draft. An entry is a draft until it's published, published while its newest version is the live one, and changed once a newer version is saved.

- **Drafts can be unfinished.** A save runs every check but those an unfinished value fails: required fields, minimum lengths, and minimum numbers of items, rows, columns and selections. Publish runs them all, and the editor shows what it needs without blocking Save.
- **Publish saves the form first**, so one click publishes what the editor shows. It's all or nothing: when a check fails, nothing is saved. In the admin API it's `publish: true` in the body of the create and save routes, settled on 29 October 2026, rather than a route of its own.
- **Slugs.** A live entry keeps its slug until it's published again, so a publish replies 422 on the slug when a live sibling has it, even though no draft does.
- **Pages** go live only under a live parent. A page's live `uri` comes from its live parents' slugs, so a parent's new slug reaches the live pages under it when the parent is published. A new parent waits for Publish, but moving a page among its siblings changes the live order at once. Unpublishing a page takes the live pages under it down too.
- **Archiving** takes an entry and the pages under it off the live site, and restoring gives back drafts, to publish again.
- **A type can go without drafts**, with `"drafts": false` in its type file, or Drafts unticked in the type editor, for types such as site settings, where editors expect Save to go live. Then every save publishes and runs every check, and the editor has Save alone. Turning drafts off leaves any unpublished changes until an entry is next saved, and that save publishes them.
- **Content migrations** change the drafts and the live copies alike.
- **Upgrading**, `iight migrate` publishes every saved entry that isn't archived, as it stands, so a site keeps serving what it served before.

### Previews

A preview reads drafts in place of live copies, for a site's preview mode. It needs a key with the `preview` [permission](#api-keys), which can add `status=draft` to any delivery route. It then reads every entry that isn't archived, published or not, with links resolved to drafts. Other keys get a 403 for it. Plain keys can sit in frontends, since they only ever see what's live, but keep preview keys on a server. The SDK's `createClient({ preview: true })` sends `status=draft` with every query.

## Versions

Every save that changes an entry writes a version of it, numbered from 1, and records who saved it and when. The entry's panel lists its versions, newest first, and each one links to its page, `#/entries/<id>/versions/<number>`, for finding out who changed what, and when.

- **A save that changes nothing does nothing.** When the values and the parent match the entry's own, compared as they're stored so the order of keys doesn't count, a save writes no version, links or events, and leaves `updatedAt` and `updatedBy` as they were. It replies 200 with the entry as it is, and the editor says No changes. Publish still makes the newest version live when the live copy is older or missing, and bulk rows follow the same rule. A singleton that's been opened but never saved has no version yet, so its first save writes one.
- **Names.** A version is named on its page, such as Before the rebrand, in up to 100 characters, and an empty name clears it. A named version shows its name first, with its number under it.
- **Where it came from.** A version saved through the [assistant](#the-assistant) or an [MCP token](#mcp) records which, so the history says "Levi, with the assistant · 2 Nov" or "Levi, through Claude Desktop · 2 Nov", the token's name. A version's page links to the chat behind it, which anyone signed in can read once a version links to it. The link outlives the chat and the token, since revoking a token keeps its row and a deleted chat leaves its id, which the page says was deleted.
- **Publishes.** Each version records the last time it went live and who published it then, which the history shows as "Published by Levi · 30 Oct". Upgrading, `iight migrate` gives each live version its live copy's publish, the only one recorded before.
- **Comparing.** A version's page shows what it changed from the version before it, or from another picked in Compare with, the live one labelled as such, so comparing the current version with the live one shows what Publish would change. It goes from the older version to the newer, and names each changed field by its path of labels, such as SEO › Title, with what it held before and after. Long text shows the words added and removed, repeaters, flexible blocks and matrices show their items added, removed and changed, matched by position, and links show entries' titles and files' names. It opens on Show changes As JSON, which shows the two versions' values, for the more technical: JSON a line at a time, with every object's keys in order, marking the lines added and removed, and every key stored, those no field reads included. By field shows each field as above. A page's move shows first, as Parent, and its JSON holds `{ parentId, values }`, since each version records the parent it was saved under. Upgrading, `iight migrate` gives every existing version the parent its page has now, since nothing recorded parents before. Both versions come from the version route, brought up to date by the content migrations that ran since, so a renamed field doesn't show as removed and added. The first version, or one whose earlier versions were deleted, has nothing before it, so every field with a value counts as added.
- **Restore** puts a version's values in the entry's form, to save as its newest version. It's on every version but the current one. A page's version also puts its parent back in the parent picker, unless that parent has been archived, deleted or moved under the page since, when the page stays where it is.
- **Delete** removes a version for good, after asking. The current version, the live one and an archived entry's versions stay, and an archived entry's versions can't be renamed either. Numbers never shift, and new versions go on from the newest.
- **Keeping fewer.** `versions.keep` in `iight.config.ts` caps the versions each entry keeps. After each save that writes a version, in the same transaction, the oldest that are neither named nor live are deleted, beyond the newest `keep` of them. Named versions and the live one are kept on top of the count, and so the current version always is too. An entry already over the cap shrinks at its next save. With no setting, every version is kept.

```ts
// iight.config.ts
export default defineConfig({
  // ...
  versions: { keep: 50 },
})
```

## Bulk editing

Tick entries in a type's list, across as many of its pages as you like, and Bulk edit opens up to 100 of them in a grid, a row for each entry and a column for each field. Singletons have no list, so no bulk edit.

- **Columns.** The grid starts with the type's title field and list columns, and Columns picks the rest, remembered in the browser for each type. A group's fields are columns of their own, such as SEO › Title, and so are those of the groups inside it.
- **Cells** show their values as the list does. A click, or Enter or F2, edits a cell in place with its core input, the only input the grid holds. Repeater, matrix and flexible cells say how many items, rows or blocks they hold, and relationship and media cells what they link to. Each of those opens its whole field in a dialog. A field that a row's conditions hide says Hidden.
- **Keys.** Arrow keys move between cells, Home and End to the ends of a row, and with Ctrl or Cmd to the corners of the grid. Tab moves along a row and leaves the grid at either end. In a cell's input, Enter keeps the change and moves down, and Tab keeps it and moves along once it's past the input's own controls, such as a checkbox field's boxes. Shift+Enter moves up, or starts a new line in long text, and Escape puts back what was there.
- **Checks.** Each row is checked with core's `validateValues` as it changes, as the entry editor checks its form, with `allowIncomplete` while the type has drafts. Invalid cells show their messages, and a row's status names what's wrong with fields the grid doesn't show.
- **Saving.** Edits stay in the grid until Save, which sends the changed fields of the edited rows that pass their checks, in one request. Publish does the same with every check, and publishes them. A type without drafts has Save alone, which publishes. The rows that pass are saved, each with its version and events. The rest stay highlighted with their messages, and focus goes to the first cell to fix. Since only changed fields go, another editor's changes to an entry's other fields are kept.
- **Not yet:** pasting a range from a spreadsheet, fill-down, undo, Publish or Archive for ticked entries without editing them, and more than 100 entries at a time.

## Content migrations

Entries keep their values as JSON, so changing a content type never changes a table. A content migration changes the values inside entries instead. It's a file in the site project's `migrations` folder with an `up` and a `down`, as in Laravel.

`iight make:migration` compares `schema/types` with `migrations/.snapshot.json`, the types as the last migration left them, matching types, fields and layouts by `id`. Its first run only writes the snapshot, so run it once before you change a type by hand. The type editor, and Apply in the assistant, write it first, of the types as they were, when a site has none. Commit the migrations and the snapshot.

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
| Shared group changed                                  | Each of the changes above, for every type and path that uses the group, in one migration       |
| A group swapped for a use, or a use for another group | Keeps the values whose field names match, at any depth, and deletes the rest, flagged          |

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
- `make:migration` compares types as they load, with their uses of shared groups expanded, so the snapshot holds them that way too, and a use's fields are paths like any group's, such as `seo.title`. A swap is a group whose `options.group` changed under the same `id`, as the type editor's swaps keep it. Its fields are matched by name rather than by `id`, and a matched field whose type or settings changed gets a TODO or a flag, as any field does. A use added with an `id` of its own in place of a group is a removal and an addition, flagged.
- An `up` or `down` only declares changes to one entry's values. `iight migrate` runs them on every entry, 500 at a time, inside one transaction for each migration, and old versions run them too.
- Every save records the last content migration that ran. Opening an old version runs the `up` of each migration that ran after it was saved, so its values fit the fields as they are now. A version saved after a migration that has since been rolled back replies 409 until it runs again.
- While a content migration hasn't run, saving an entry replies 409, since the types already have its change and the entries don't yet.
- `iight migrate --check` leaves out entries that were never saved, such as a singleton that has only been opened.

## Media

The admin's Media page holds the site's files, in a grid with a type filter and a search on names, where each file's name, alt text and caption are edited. The files are kept on a FlyDrive disk, set up as `storage` in `iight.config.ts`. It takes FlyDrive's `DriveManager` options as they are, so another FlyDrive driver can take the local one's place, and each file's row records the disk it went to. `media` is optional, and sets what the library takes and how its files are served. [The assistant](#proposals) can propose names, alt text and captions too, after seeing the images, for a person to apply.

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
- Files are public at `/media/<id>/<name>`, since `<img>` can't send an API key. They're found by ID, so a URL can't reach outside the disk, and any name after the ID serves the same file, so renaming breaks no links. Downloads take the file's own name, whatever the URL ends in. They're served with `nosniff`, and in ranges of bytes for video and audio players.
- Pictures, video, audio and PDFs open in the browser's own viewers. Every other file, such as an SVG or an XML file, is served with `Content-Security-Policy: sandbox`, so a script in it can't run, even when its URL is opened on its own. A frontend that puts an SVG's markup into its own page loses that, so show SVGs with `<img>`.
- Deleting a file removes it from its disk too.

## Forms

Forms live in the database rather than in `schema/`, since marketers make them in production. The admin's Forms page creates and edits them with core's schema builder, which offers every one of core's inputs. Each form has a label and a `name`, such as `contact_us`, which the SDK and the generated types call it by.

- Each change to a form's fields saves a new version, and each submission records the version it was checked against, so the inbox shows it with that version's fields. Changing only the label or name keeps the version.
- Each form has an inbox of its submissions, newest first, with Spam and Archive views. Archived submissions can be restored, and any submission can be marked as spam by hand, such as one that got past the honeypot, or as not spam, such as a person's that filled it in.
- A form is open or closed. A closed form keeps its fields and submissions, still serves its fields, and replies 403 to every post until someone opens it on its page, Open form in its panel. Close form takes an open one's submissions away, such as once its event is over. Forms people make start open, and forms made through AI start closed, so nothing they make goes live without a person. The CMS records when each form was first opened, by any of Open form, Apply and publish or its page going live, and leaves it out of replies: over MCP, `update_form` changes only forms that have never been open, since a page may show one that has, and a change there would show at once. Rolling back `000019`, which adds `open`, waits until no form is closed, since without it every form takes submissions.
- The form's page shows HTML for pasting it into any page, which posts to the form with JavaScript off and takes the page's own styles. It posts to the form's ID, so renaming a form never breaks a page it's pasted into. Repeater, matrix, flexible and conditions fields are left out of it, since adding their items needs JavaScript.

### Submissions

`POST /v1/forms/:form` takes a submission, where `:form` is the form's ID or its name. The body is the values themselves, as JSON or as a plain HTML form post, and no key is needed.

- A plain form post names a group's fields as `address.town`, and a list of choices, such as a checkbox field, sends its name again for each one ticked. The text it sends takes each field's type, so `3` is a number and `on` ticks a boolean.
- The values go through `pickValues` and `validateServerValues`, as entries' do. JSON requests, and requests that accept JSON, get JSON replies. A plain form post gets a small page in place of each reply, with the same status and a link back to the page it came from.
- Each submission keeps the form's version, and the IP address, user agent and referer it came with.

Spam is kept out of the inbox in two ways:

- **A honeypot.** The pasted HTML has a field named `_website`, off screen and out of reach of screen readers and the keyboard. A submission that fills it in is kept as spam and gets the reply any other gets, so a bot can't tell. Field names start with a letter, so no field can take the name.
- **A rate limit.** Each IP address can make 10 posts in 10 minutes, valid or not, and is then refused with a 429 and `Retry-After` until the time is up. Requests that send an API key with the `submit` [permission](#api-keys) aren't limited, so a site's own server can submit for all its visitors. Other keys count as anyone, since they can sit in a site's pages. Behind a proxy on a private network, such as a load balancer, the address is the one the proxy forwarded for in `X-Forwarded-For`, which the CMS believes from no one else.

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

| Event                                               | Written when                                                                                                                                                                                       | Its data                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `entry.created`, `entry.updated`                    | An entry is saved or moved among its siblings. Each page whose `uri` or position changes with it gets one too                                                                                      | `{ entry }`, as the admin API returns it                     |
| `entry.published`, `entry.unpublished`              | An entry's live copy is made or changed, by Publish or by moving a page among its siblings, or taken down, by Unpublish or Archive. Each live page that changes or goes along with it gets one too | `{ entry }`, as the admin API returns it                     |
| `entry.archived`, `entry.restored`, `entry.deleted` | An entry is archived, restored or deleted, with one for each page that goes along with it                                                                                                          | `{ entry }`, as it was left                                  |
| `submission.created`                                | A form takes a submission, spam included                                                                                                                                                           | `{ form: { id, name, label }, submission }`, with its `spam` |
| `media.created`, `media.updated`, `media.deleted`   | A file is uploaded, edited or deleted                                                                                                                                                              | `{ media }`, with its `url`                                  |

Content migrations write no events. `entry.updated` comes with every draft save, so a site that rebuilds when its content changes should listen for `entry.published` and `entry.unpublished` instead. An automation has:

- **Triggers**, one or more of the events.
- **Conditions**, core's conditional logic, checked against the event's data and edited with core's `conditions` input. Any group can match, and a group matches when all its rules do. A rule's field is a path into the data, picked from a list: `entry.type`, `form.id`, `form.name`, `submission.spam` and `media.mime`, then each type's top-level fields as `entry.values.<name>` and each form's as `submission.values.<name>`, by label, such as "Blog posts › Featured". The list holds only the data of the events ticked in When: `entry.*` for entry events, `form.*` and `submission.*` for a form submitted, and `media.*` for file events. Each field's type decides the operators, and a choice field's choices, a type, a form or a yes or no are picked from a list too. The routes check rules against the same list, so a rule on a field that's gone is refused until it's changed. Values compare as text, so `false` matches `"spam": false`. With no groups, every event it's triggered by runs it.
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

The admin uses it with the session cookie, which every route but `/api/session` needs. Its entries are their drafts, with `archivedAt`, `createdBy` and `updatedBy`, `status`, which is `draft`, `published` or `changed`, and `publishedVersion`, the number of the version that's live, or null. Its media also have `createdBy`.

| Route                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`                        | Signs in with `{ email, password }`. Replies `{ data: user }` and sets the `iight_session` cookie, or 422 with core's validation report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/session`                         | Replies `{ data: user }` for the signed-in user, or 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /api/session`                      | Signs out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/types`                           | Lists the content types, each with its uses of shared groups expanded, `groups`, the shared groups as their files have them, `editable`, which is true in `iight dev`, and `mcp`, which is true when [MCP](#mcp) is on                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/types`                          | Creates a type from its settings and `fields`, giving it an `id`. Replies `{ data: type, migration: { file, notes } }`, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /api/types/:type`                     | Replaces a type, renaming its file when `name` changes, and writes a content migration for the change. Replies as `POST` does. A type with entries, archived ones included, keeps its structure, so a new one replies 422 on `structure`, as it does while a content migration hasn't run. With `loaded`, the type as the editor loaded it, it replies 409 when the type's file has changed since, and it replies 409 when the type was renamed or deleted by a change that went first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DELETE /api/types/:type`                  | Deletes a type's file and writes a migration that flags its entries, which stay. Replies `{ migration: { file, notes } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/groups`                         | Creates a shared group from `{ label, name, fields }`, giving it an `id`. Replies `{ data: group, migration: { file, notes } }`, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PUT /api/groups/:group`                   | Replaces a shared group, renaming its file when `name` changes, and writes a content migration for every type the change reaches. Replies as `POST` does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DELETE /api/groups/:group`                | Deletes a shared group's file, or replies 409 while a type or another group uses it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/types/:type/entries`             | Lists entries that aren't archived, or archived ones with `archived=true`, taking the delivery API's query parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/types/:type/entries`            | Creates an entry from `{ values, parentId, publish }`, where `parentId` is for hierarchicals. With `publish: true`, it runs every check and publishes the entry too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH /api/types/:type/entries`           | Saves the changed fields of 1 to 100 entries from `{ publish, entries: [{ id, values }] }`, replying with each one's result, as [bulk saves](#bulk-saves) describes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/types/:type/singleton`           | Replies a singleton's entry, created the first time it's opened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/entries/:id`                     | Replies an entry, archived or not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /api/entries/:id`                     | Saves `{ values, parentId, publish }` as the draft. With `publish: true`, it runs every check and publishes the draft too, or replies 409 while a page's parent isn't published. A moved page goes after its new siblings, and the `uri`s under it follow                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/entries/:id/unpublish`          | Takes the entry's live copy down, with the live pages under it, and keeps the draft. A type without drafts replies 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT /api/entries/:id/position`            | Moves a page to `{ position }` among its siblings, counting from 0, on the live site too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/entries/:id/archive`            | Archives an entry with its descendants that aren't archived, and takes them off the live site                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/entries/:id/restore`            | Restores an entry with the descendants archived along with it, as drafts, once its parent isn't archived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DELETE /api/entries/:id`                  | Deletes an archived entry for good, with its descendants and versions, or replies 409 while other entries link to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/entries/:id/used-by`             | Lists the entries that link to it, archived ones included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/entries/:id/versions`            | Lists the entry's versions, newest first, each as `{ number, name, createdBy, createdAt, publishedAt, publishedBy, via }`. Every save that changes the entry writes one. `createdBy` is the user who saved it, and `publishedBy` the user who last published it, each as `{ id, name }`, or null once that user is deleted. `name` and `publishedAt` are null until it's named or published. `via` is the assistant's chat or the MCP token it was saved through, as `{ kind: 'chat' \| 'token', id, name }`, `name` being the chat's title, null once it's deleted, or the token's name, or null for a save in the editor                                                                     |
| `GET /api/entries/:id/versions/:number`    | Replies a version, with its values brought up to date by the content migrations that ran since, and `parentId`, the parent it was saved under, or null at the top level. Restoring it means saving those values again under that parent                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PUT /api/entries/:id/versions/:number`    | Names a version with `{ name }`, of up to 100 characters, where an empty name clears it. Replies `{ data: version }`, as the list gives it, 422 with core's report, or 409 for an archived entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /api/entries/:id/versions/:number` | Deletes a version for good, replying 204, or 409 for the current version, the live one or an archived entry's. Numbers never shift                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/media`                           | Lists media, taking the delivery API's query parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/media`                          | Uploads one file, sent as the multipart field `file`. Replies 201 with `{ data: media }`, or 422 with core's report on `file` saying what's wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /api/media/:id`                       | Saves `{ name, alt, caption }`, or replies 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /api/media/:id`                    | Deletes a file from its disk, with its record, or replies 409 while entries link to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/media/:id/used-by`               | Lists the entries that link to the file, archived ones included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/forms`                           | Lists the forms, each with `embed`, the HTML that pastes it into a page, and `open`, false while it takes no submissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/forms`                          | Creates a form from `{ label, name, fields }`, at version 1. Replies 201 with `{ data: form }`, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/forms/:id`                       | Replies a form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PUT /api/forms/:id`                       | Saves `{ label, name, fields }`, as a new version when the fields change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/forms/:id/open`                 | Opens a form to submissions, replying `{ data: form }`. Forms made through AI start closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/forms/:id/close`                | Closes a form, which keeps its fields and submissions, and takes no more until it's opened again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/forms/:id/versions/:number`      | Replies a version's `fields`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/forms/:id/submissions`           | Lists the inbox, or the archive with `archived=true`, or spam with `spam=true`, taking `order`, `page` and `perPage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/submissions/:id/archive`        | Archives a submission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/submissions/:id/restore`        | Restores an archived submission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/submissions/:id/spam`           | Marks a submission as spam, taking it out of the inbox or the archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/submissions/:id/not-spam`       | Marks a submission as not spam, back in the inbox, or the archive if it was archived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/automations`                     | Lists the automations, or with `form=<id>`, those that form's submissions can run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/automations`                    | Creates an automation from `{ name, triggers, conditions, actions }`. Replies 201 with `{ data: automation }`, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/automations/:id`                 | Replies an automation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PUT /api/automations/:id`                 | Saves `{ name, triggers, conditions, actions }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DELETE /api/automations/:id`              | Deletes an automation, with its runs, including those still to come                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/automations/:id/runs`            | Lists its runs, each a try of one of its actions with its event, taking `order`, `page` and `perPage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/keys`                            | Lists the [API keys](#api-keys), each as `{ id, name, scopes, createdAt, createdBy, lastUsedAt }`. `createdBy` is `{ id, name }`, or null for a key from the CLI or one whose user is deleted, and `lastUsedAt` is null until the key is used                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/keys`                           | Makes a key from `{ name, scopes }`. Replies 201 with `{ data: key }`, whose `token` is the key itself, in this reply and no other, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PUT /api/keys/:id`                        | Saves `{ name, scopes }`, keeping the key itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /api/keys/:id`                     | Revokes a key, which gets 401s from then on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/tokens`                          | Lists the signed-in person's [MCP tokens](#mcp), each as `{ id, name, scopes, createdAt, lastUsedAt }`, and never anyone else's or revoked ones. `scopes` holds `drafts` for a token that saves drafts. Only there when MCP is on                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/tokens`                         | Makes a token from `{ name, scopes }`, where `scopes` is empty or `["drafts"]`. Replies 201 with `{ data: token }`, whose `token` is the token itself, in this reply and no other, or 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DELETE /api/tokens/:id`                   | Revokes one of the signed-in person's tokens, which gets 401s from then on. Its row stays, marked revoked, so the versions saved through it keep its name. Anyone else's replies 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/chats`                           | Lists the signed-in person's [chats with the assistant](#the-assistant), latest first, 20 a page with `page`, each as `{ id, title, createdAt, updatedAt }`, with `pagination`, and never anyone else's. Only there when the assistant is on                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/chats`                          | Makes an empty chat, replying 201 with `{ data: chat }`. The admin makes one when a new chat's first message is sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/chats/:id`                       | A chat, with its `user`, `{ id, name }`, and its `messages` as the admin shows them: `{ role: 'user', text }`, and for each reply `{ role: 'assistant', parts, notice }`, whose `parts` are `{ type: 'text', text }` and `{ type: 'step', text, failed, proposals }`, and whose `notice` is `{ tone, text }` when it ended early, or null. Each proposal is `{ id, kind, targetId, isNew, type, before, after, status, version, published, needs, title }`, with `entryStatus` for an entry that exists and `image`, where it's served, for an image file. A content type's proposal has `kind` `type`, `targetId` its `typ_` id, `type` its name when it was proposed, `before` and `after` its file as it was and as Apply writes it, `before` being null for a new one, `entries`, how many entries it has, archived ones included, and `migration`, what its content migration will say as `{ file: null, notes }` while it waits, the `{ file, notes }` Apply wrote once it's applied, or null when it needs or wrote none. The person's own chat, or anyone's once a version links to it, read-only. Any other replies 404                                     |
| `PUT /api/chats/:id`                       | Renames a chat with `{ title }`, of 1 to 100 characters, or replies 422 with core's report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /api/chats/:id`                    | Deletes a chat and its messages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/chats/:id/messages`             | Sends `{ text, page }`, `text` of up to 20,000 characters and `page` what the line above the box names, such as `{ entry, version }`, `{ type, ticked }`, `{ type, where, order, archived }`, `{ form }`, `{ media }` or `{ schema }`, a type open in the type editor by its name, and streams the reply as server-sent events: `text` with each piece, `step` as each tool runs, with the `proposals` it made, `restart` when the provider asks again, which drops the text since the last step, `notice` when the reply ends early, then `done` with the chat. Replies 422 with core's report before it starts, or 409 while another reply is writing to the chat. Closing the connection stops the reply, which keeps what it wrote                                                                                                                                                                                 |
| `POST /api/chats/:id/proposals/apply`      | Applies `{ ids, publish }`, 1 to 100 of the person's own chat's [proposals](#proposals), in order, each after the proposed forms and the new content type it needs, though a change to a content type that exists goes after the batch's entries, since its migration stops entries saving. Results reply in the order sent. Without `publish` an entry saves as a draft as the person, and with it the draft goes live with every check a publish runs and a form opens. A file's details and an entry of a type without drafts go live either way. A content type is written as the type editor saves it, with its content migration, which Apply never runs, and only with the type editor on, replying 403 otherwise, whatever `publish` says. Replies `{ data }` with a result for each as bulk editing does, `{ id, status, data, message, report }`: 200 with `data`, the proposal now applied, 409 once it's applied or skipped, or stale since what it changes was changed after it was proposed, or 422 when it doesn't pass its checks now, which leaves it waiting |
| `POST /api/chats/:id/proposals/skip`       | Skips `{ ids }`, with the entries proposed to show a form that's skipped, replying `{ data }` with the proposals skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The type and shared group routes reply 403 outside `iight dev`. Creating or saving an entry replies 409 while a content migration hasn't run.

#### Bulk saves

`PATCH /api/types/:type/entries` saves the grid's edits, in the shape the user chose on 30 October 2026. Each entry's `values` holds just the fields that changed. A group's fields merge into what's saved one by one, at any depth, and any other field's value replaces what's saved, so a list or a link is sent whole. `publish: true` publishes every entry that saves, after every check, and a type without drafts publishes anyway. Pages keep their parents.

```json
{
  "publish": false,
  "entries": [
    { "id": "0192f0c4-…", "values": { "title": "Hello", "seo": { "title": "Hi" } } },
    { "id": "0192f0c5-…", "values": { "price": -1 } }
  ]
}
```

Each entry saves on its own, in the order sent, through the same code as `PUT /api/entries/:id`, so those that pass are saved whatever happens to the rest. Each is read and locked in its save's transaction, and its changes merge into what that read finds, so another save's changes to its other fields are kept, however close together the two land. The reply is always 200, with a result for each entry: its `id` and the `status` that `PUT /api/entries/:id` would have replied. That's 200 with the saved entry in `data`, 422 with core's report in `report`, or another status with a `message`, such as 404 for an ID that isn't an entry of the type, and 409 for an archived entry or a page whose parent isn't live. When two entries take the same slug, the first saves and the second gets a 422 on its slug.

```json
{
  "data": [
    { "id": "0192f0c4-…", "status": 200, "data": { "id": "0192f0c4-…", "values": { "title": "Hello" } } },
    {
      "id": "0192f0c5-…",
      "status": 422,
      "report": {
        "isValid": false,
        "fields": { "price": { "isValid": false, "messages": ["This field requires a minimum value of 0."] } }
      }
    }
  ]
}
```

The whole request replies 400 unless it lists 1 to 100 entries as `{ id, values }`, each once, 404 for an unknown type, and 409 for a singleton or while a content migration hasn't run.

### API keys

The delivery API, `GET /types` and the SDK take a key, sent as `Authorization: Bearer <key>`. Make one on the admin's API keys page, which anyone signed in can use, under `iight start` too, or with `iight make:api-key`. Every key reads live entries and media, and its permissions, which the admin API calls `scopes`, add to that:

| Permission | Flag        | What it adds                                                                                                       |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `preview`  | `--preview` | Reads drafts with `status=draft`, as [Previews](#previews) describes. Other keys get a 403                         |
| `types`    | `--types`   | `GET /types`, which `npx iight types pull` reads. Other keys get a 403                                             |
| `submit`   | `--submit`  | Posts to forms without the [rate limit](#submissions), for a site's own server. Other keys are limited like anyone |

Keep a key that can preview or submit on a server, out of a site's pages. Keys made before 30 October 2026 have `types` and `submit`, since every key could do both then.

The admin lists each key's permissions, who made it and when, and when it was last used, which is written at most once a minute. Keys from `make:api-key` say the CLI made them. A key shows once, when it's made, since only its hash is stored, so a lost key means making another. Editing a key changes its name and permissions and keeps the key itself. Revoking one deletes it, and from then on it gets 401s.

### The delivery API

It's read-only, and serves media and the live copies of published entries, or with a preview key and `status=draft`, drafts (see [Previews](#previews)). It needs an [API key](#api-keys), sent as `Authorization: Bearer <key>`.

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

| Route                  | What it does                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/forms/:form`  | Replies `{ data: { id, name, label, version, fields, open } }`                                                                                                     |
| `POST /v1/forms/:form` | Takes a submission, replying 201 with `{ data: { id, version, values, createdAt } }`, 422 with core's report, or 403 while the form is closed. See [Forms](#forms) |

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

## MCP

AI clients such as Claude Code, Cursor and VS Code can read the site's content at `/mcp`, the CMS's MCP server, with a token a person makes in the admin, and change it with a token that saves drafts. Each token acts as the person who made it. It's off until `iight.config.ts` turns it on, and the client brings its own model, so it needs no AI settings:

```ts
export default defineConfig({
  // …
  mcp: true,
})
```

With it off, `/mcp` and the token routes reply 404 and the admin has no tokens page.

### Tokens

Each person makes their own on the admin's MCP tokens page, from the plug in the user's row of the nav, and sees and revokes only their own. A token shows once, when it's made, with the setup for each client below, since only its hash is stored. It starts with `iightpat_`, so neither people nor secret scanners take it for an API key, which starts with `iight_`. The page says when each token was last used, which is written at most once a minute. Revoking one marks it revoked, so its next request gets a 401, and keeps its row, so the versions saved through it keep its name. Deleting a person deletes their tokens.

A token only reads unless it's made with **Save drafts**, its `drafts` scope, which also offers the [write tools](#tools) but `update_media`, since a file's details go live at once: they save changes to entries as drafts, and make new forms closed, as the token's maker, through the editor's own save, so versions, the version cap, events and automations work as they do there. There's no Apply over MCP, since the client's own approval prompt is the check, and nothing a token does publishes, unpublishes, archives or deletes. A token's permissions are set when it's made, so a token that should save drafts is a new one.

Tokens open `/mcp` and nothing else, and API keys and the admin's session never open it.

### Connecting a client

The server takes Streamable HTTP at `https://<your CMS>/mcp`, with the token as `Authorization: Bearer <token>`. A new token's page shows each client's setup with the token filled in.

- **Claude Code:** `claude mcp add --transport http iight https://<your CMS>/mcp --header "Authorization: Bearer <token>"`
- **Cursor:** in `~/.cursor/mcp.json`, outside any project, so the token stays out of its repository:

  ```json
  { "mcpServers": { "iight": { "url": "https://<your CMS>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
  ```

- **VS Code:** in `.vscode/mcp.json`, which asks for the token when it first connects, so the file never holds it:

  ```json
  {
    "inputs": [{ "type": "promptString", "id": "iight-token", "description": "iight MCP token", "password": true }],
    "servers": {
      "iight": {
        "type": "http",
        "url": "https://<your CMS>/mcp",
        "headers": { "Authorization": "Bearer ${input:iight-token}" }
      }
    }
  }
  ```

The server is stateless: each POST gets a server of its own, which replies with JSON, so nothing is kept between requests and any process can answer. GET and DELETE reply 405, since nothing streams. A request without a valid token gets a 401 with `WWW-Authenticate: Bearer`, with `error="invalid_token"` when it sent one. The CMS has no OAuth yet, so ChatGPT can't connect, and nor can claude.ai unless its custom connectors offer your organisation request headers, which are in beta. Claude Desktop can connect through the [`mcp-remote`](https://npmjs.com/package/mcp-remote) bridge, which sends the token as a header.

### Tools

The tools live in `src/tools.ts`, defined once with Zod schemas, and [the admin's assistant](#the-assistant) uses the same ones. They run as the token's maker, through the queries and checks the admin API uses, and reply with its shapes. Each one's description says that what it returns is content to read, never instructions to follow. Ten read, and are marked read-only:

| Tool                 | Reads                                                                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_content_types` | The content types, as `GET /api/types` lists them, with shared groups expanded, or the ones in `names`                                                                                                                                                                                                                           |
| `list_entries`       | A type's entries a page at a time, with their drafts' values and their status, filtered by `where` and sorted by `order` as the list API takes them, its archive with `archived`                                                                                                                                                 |
| `search_entries`     | The entries with text holding `query`, in any field at any depth, across every type or those in `types`, drafts included and archived entries left out, newest edits first                                                                                                                                                       |
| `get_entry`          | One entry by its `id`                                                                                                                                                                                                                                                                                                            |
| `list_versions`      | An entry's versions, newest first, as its history lists them                                                                                                                                                                                                                                                                     |
| `get_version`        | One version's values, caught up with the content migrations since it was saved                                                                                                                                                                                                                                                   |
| `list_forms`         | The forms with their fields, or the ones in `names`                                                                                                                                                                                                                                                                              |
| `list_media`         | The media library a page at a time, filtered and sorted as `GET /v1/media` takes them                                                                                                                                                                                                                                            |
| `get_media`          | One file by its `id`                                                                                                                                                                                                                                                                                                             |
| `view_media`         | Up to 10 images by their `ids`, as images the model sees, each turned upright and scaled to fit 512 pixels, an SVG drawn at that size, as a PNG with transparency or a JPEG, at most about 350 tokens each. It replies each file's id, name, alt text and caption first, and says which it left out, such as video and documents |

`perPage` is 10 unless a call says otherwise, up to 50, and `query` takes 1 to 200 characters. `fields` keeps only some top-level fields in `values`, for lighter lists and for reading a large entry a part at a time. Each reply holds at most 30,000 characters of JSON, about 10,000 tokens: a list keeps the items that fit and says how many it left out and what to ask for instead, and anything else is cut there, with a notice to ask for fewer fields. A mistake, such as an unknown type or a field the query can't take, comes back as a tool error with the API's message, for the model to fix.

Form submissions can't be read, since they hold visitors' personal data. The assistant's tools for [content types](#content-types-through-the-assistant) are never offered here.

Six write, for the assistant, which proposes what they'd save rather than saving it, and all but `update_media` for tokens with Save drafts:

| Tool           | Changes                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_entry` | Makes a new entry's draft from `type`, `values` and, for a page, `parentId`. Not for singletons                                                                                                                                                                                                                                                |
| `update_entry` | Changes an entry's draft: only the top-level fields in `values`, each to its whole new value, where a group can hold only the fields inside it to change, and `parentId` to move a page                                                                                                                                                        |
| `replace_text` | Replaces `find` with `replace`, exactly as written, capitals included, in every text and long text field at any depth of every entry's draft, the `types` named, or only the entries in `ids`, 1 to 100, such as those the person means by “these”. An id that isn't an entry, is archived, isn't one of the `types` named or, over MCP, is of a type without drafts is an error naming it, and nothing changes. Slugs, links and choices are left alone, and so is text that already reads as the replacement, such as Acme Corp when replacing Acme with Acme Corp, so asking twice never doubles it. It goes through the entries in the order they were made, changing up to 100 a call, and says how many more mention it, with `after` to call again with, which goes on from where it stopped, and the other capitals it found, such as “Private preview” |
| `create_form`  | Makes a new form from `label`, `name` and `fields`, closed, so it takes no submissions until a person opens it                                                                                                                                                                                                                                 |
| `update_form`  | Changes a closed form's `label`, `name` or `fields`, and over MCP only one that has never been open. An open form only a person changes                                                                                                                                                                                                                                                        |
| `update_media` | Changes up to 100 files' `name`, `alt` or `caption` at once, such as alt text written from what `view_media` shows. Only the assistant has it, since a file's details change on the site once applied, and over MCP no one applies them                                                                                                        |

- Each runs every check its save would, as the person or the token's maker, so a failed check comes back as a tool error listing each message by its path, such as `values.slug: Another entry here already uses this slug.`, for the model to fix. A draft can be unfinished, so a reply also says what a publish would still need.
- None publishes, unpublishes, archives or deletes, and none touches archived entries or a page's order among its siblings, which changes on the live site at once. Over MCP they also leave types without drafts alone, since their saves go live at once, while in the assistant the person applies and publishes those.
- MCP annotates them as neither read-only nor open-world. `create_entry` and `create_form` aren't destructive or idempotent, `update_entry` and `update_form` are both, since they replace what a draft held, which stays a version back, and calling one twice changes no more than once, and `replace_text` is destructive but not idempotent, since a second call goes on to the entries past the first's.

## The assistant

With `ai` set in `iight.config.ts`, the admin has an assistant: Assistant at the top of the nav, which opens the Chat page with the person's chats beside it, and the same chat in a card under every page's panel, which knows the page it's on, so "fix the typos here" means the entry open in the editor. It reads with [the MCP server's tools](#tools), as the person who asks, and changes content with their write tools, as [proposals](#proposals) the person applies or skips. The card's title hides and shows its chat, its ⋮ holds New chat and the person's chats, and from 64rem wide the card's height and the panel's width change by dragging their edges or with arrow keys. Each browser remembers all three.

```ts
export default defineConfig({
  // …
  ai: {
    provider: 'anthropic',
    // The defaults
    model: 'claude-opus-5-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    effort: 'medium',
    fallback: true,
  },
})
```

- `provider` is `anthropic`, through the official `@anthropic-ai/sdk`. Providers implement an interface the CMS owns, in `src/ai.ts`, so others can follow.
- `model` takes any Claude model that accepts system messages partway through a chat, which is where the page goes. Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 do, and Claude Sonnet 5 doesn't.
- `apiKey` is only ever read on the server. Without it, the SDK reads `ANTHROPIC_API_KEY`, from the environment or the project's `.env`, or its other credentials.
- `effort` is how much the model thinks before it answers, `low`, `medium`, `high`, `xhigh` or `max`, which is most of what a reply costs and how long it takes.
- `fallback` runs a request that Anthropic's safety classifiers decline again on the model Anthropic recommends for that kind of decline, as `fallbacks: "default"`, since the classifiers can flag harmless content. `false` turns it off, and a model without fallbacks answers alone.

Without `ai`, there's no Assistant in the nav, Chat page or assistant beside pages, and the chat routes reply 404.

### What's sent to Anthropic

Each message sends Anthropic these, billed to the key's account:

- The system prompt: the assistant's instructions and the site's content types with their fields and options, or only their fields' names when they're over 30,000 characters. It's the same for every person and every message, so it caches until the types change.
- The sixteen tools, with their descriptions and inputs, and in `iight dev` the three for [content types](#content-types-through-the-assistant).
- The chat so far, each message as it was sent or returned, with the time and the page the person is on after each of their messages: an entry's, a form's or a media file's id, a version's number or a type's name, and on a list the ids of the entries “these” means, up to 100, or how many past that, never text from the page itself, such as titles, searches or filters. After it come the ids of the proposals the person applied or skipped since the last reply, those that went stale and those still waiting.
- What the tools read: entries with their drafts and versions, the names of the people who saved and published them, forms' fields, media files' details, and the images `view_media` shows, scaled to fit 512 pixels. Form submissions, email addresses and passwords never are.

The requests use two betas: `server-side-fallback-2026-07-01` for `fallback`, and `thinking-binding-controls-2026-08-01`, so a change to the content types drops the model's thinking from earlier in a chat rather than failing the chat.

### “This” and “these”

Beside a page, in the panel's assistant and its dialog below 64rem, a line above the box says what “this” means there, and it's exactly what the message sends as its page: an entry's title, such as Kubecon 2026, a version, such as Kubecon 2026, version 4, a form's label, the file last opened in the media library, such as logo.svg, or in the type editor, the type, such as Blog posts. On a list, it's the entries ticked, in the order they were ticked, such as Events: 3 ticked, or, with nothing ticked and a search or filter on, those they find, in the list's order, such as Events: 37 matching your filter, or else the type alone. The Chat page has no line, since it's no page of content.

- **Only ids reach the model.** The line uses the titles and names the admin already shows, while the system message names ids, type names and counts, since anyone can write a title or a search.
- **The server checks each one.** A ticked entry must be one of the type's entries that isn't archived, and one that isn't is left out, saying how many. A search or filter runs through the list's own query, on the archive for the archive, and a query the list API turns down sends the type alone. A form or a file must exist.
- **Past 100**, ticked or found, the model gets only the type and how many, and the line asks to tick fewer or narrow the search or filter, so a change to “these” never goes further than the person can see.
- **Tools take the ids**, such as `replace_text`'s `ids`, so “replace it in these” changes only them.

### Proposals

The write tools propose in the assistant, running every check the save would and saving nothing. Each proposal shows under the step that made it, as a version page compares fields, such as a long text's words removed and added, with Apply as draft, Apply and publish, and Skip:

- **Apply as draft** saves the draft as the person, through the editor's own save, so versions, the version cap, events and automations work as they do there, and the version links to the chat, which the history shows as "with the assistant".
- **Apply and publish** is the editor's Publish: the proposal's fields go onto the draft and the draft goes live in one go, with every check a publish runs, such as required fields, a live sibling's slug and a page's live parent. If one fails, nothing is saved, and the proposal says why and keeps waiting. Publishing makes the whole draft live, so the card says first when the entry has other changes that aren't live, or isn't live at all. Only the person's click publishes: the assistant never does, and neither does MCP.
- **Content types** have no drafts either, and publish nothing, so their cards have Apply and Skip alone, as [content types through the assistant](#content-types-through-the-assistant) describes.
- **Types without drafts and files** go live once applied, since they have no drafts, so their cards have Apply and publish alone and say so. A file's card shows its image beside its new name, alt text or caption, and applying goes through the media library's own save, with its `media.updated` event.
- **A find and replace, or alt text for many files,** comes back as a proposal for each entry or file, folded under its name, with Apply all as drafts, Apply and publish all, and Skip all. They send a hundred at a time, and a reply with proposals from several steps ends with the same buttons of its own.
- **A page with a form** comes back as a proposed form and a proposed entry whose form field holds the form's id, which its proposal gave it in advance. Applying the entry makes the form first, closed, and skipping the form skips the entry. The form opens exactly when a page that shows it goes live through Apply, by Apply and publish, a later Apply and publish after one failed, or as a type without drafts, which goes live once applied. In a batch with its page, such as Apply and publish all, it's made closed and never opened on its own, so a page that fails its checks never leaves its form taking submissions. Apply and publish on a form alone opens it.
- **It never overwrites a newer edit.** A change stores the top-level fields it sets and what they held when it was proposed. Apply locks the entry and goes ahead only if those fields, and a page's parent, still hold what they held and no content migration ran since, then sets only those fields, so an edit made since to another field is kept. Otherwise the proposal turns stale and says to ask again, as it does when what it changes was deleted since. A check that fails at Apply, such as a slug taken since, shows its message and leaves the proposal waiting, and in a find and replace marks its row Not applied.
- **The page beside it.** Apply asks for the page's changes to be saved first when it shows what a proposal changes and someone has changed it there: the entry's editor, the form's page or the bulk grid. Then the page loads again, as the media library does, so nothing it saves later sends back what it showed before. A save in the editor or the grid updates the cards' warnings too, such as that an entry has other changes that aren't live.
- **The model hears what became of them** with the person's next message, in the system message after it: which proposals were applied as drafts, applied and published, or skipped, which went stale and which still wait, as ids only. It counts from the last system message the model saw, so what a reply that failed or was stopped never carried goes with the next. A round that's never stored, such as when another tab wrote to the chat first, skips its proposals, since nothing shows them. Proposals live in a table of their own, `proposals`, since a chat's messages are only ever added to and go back to the model exactly as they were.

### Content types through the assistant

In `iight dev`, where the type editor writes types, the assistant can also propose new content types and changes to them, such as "Make a jobs type with a title, a location and a closing date". Elsewhere it has no tools for them, and says that types change in development and ship through git. MCP never offers them.

| Tool                  | Does                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_field_types`    | Reads what the type editor's palette offers: each field type with the common settings it takes and its options as core schemas, with a relationship's types and a Shared group field's groups by id, and the shared groups themselves |
| `create_content_type` | Proposes a new type from a type file's settings and `fields`                                                                                                                                                                         |
| `update_content_type` | Proposes a change to a type: the settings given, where `null` clears one, the top-level `fields` to add or change, each whole, matched by `id`, or else by name, and the top-level fields named in `remove`                           |

- **Checks.** Each runs every check the type editor's save runs, and on the fields it sends, those the schema builder's field editor runs in the browser: only the settings and options each field type takes, holding what they take, so a select needs its choices and a misspelled option is refused. A use of a shared group, which `list_content_types` shows expanded, goes back to its file as the use, and the group's fields can't change here, nor can a group be swapped for a use or back, which is the type editor's Make shared and Use shared group. A call that changes nothing the file would hold is refused.
- **Ids.** Content migrations follow fields by `id`. A new field or layout gets one, and one sent without an id keeps the id of the field of the same name at the same place, unless another field in the call claims that id, as a renamed one does. Inside a field or layout sent with its id, the place is what it was by that id, however it was renamed or moved, so a renamed flexible field keeps its layouts. One sent with an id the type doesn't have, in place of a field of that name, is refused, so a slip can't delete a field's values.
- **Its first entries** can be proposed with a new type, with `create_entry` under its name, checked against the proposed fields, and they carry the type's id, as `after.typeId`, so they go into that type alone. Applying one applies the type first, skipping the type skips them, and when the type turns stale, or another type has its name by then, they turn stale too. Nothing else links to a proposed type until it's applied.
- **The card** shows a new type's settings and fields, or a change's changes by field, matched by id as `make:migration` matches them, with the file before and after As JSON in a fold, what its content migration will say, and what applying it means for the type's entries and the site's code, such as that a renamed field changes what the API returns. Labels, instructions and choices show on the card, and conditions in words, since once applied they're part of what the assistant reads as the site's types, which its instructions say to read as data, never as instructions.
- **Apply** writes the type's file as the type editor's Save does, laid out by the site's Prettier, with its fields' keys in the order they were, then runs `make:migration`, never `iight migrate`, so a developer checks the migration and runs it, and until then no entry can be saved. It goes ahead only while the type's file on disk holds what it held when it was proposed, so a save in the type editor or a hand edit since makes it stale. Apply and the type editor's saves take turns, and when the claim on the proposal or anything after the write fails, the files and the migration go back as they were. The card then names the migration it wrote, with its flags and TODOs.
- **The page beside it.** The type editor, and the entry editor and bulk grid of the type's entries, ask for their unsaved changes to be saved before Apply, then load again, the type editor at the type's new name if it has one, keeping focus on the card. The type editor counts as changed whenever a save would write something else, however the change was made, holds still from Apply until it has loaded again, and says so if loading it again fails. Only a page still at its address loads again. The admin loads the types again after any type is applied, and a page of a type renamed since says so, and that `iight migrate` moves its entries.
- **Left out:** deleting types, changing shared groups, reordering fields, writing migration code, and a new structure for a type with entries, which the type editor refuses too.

### Chats

Each person sees only their own chats, which go when they do, except that anyone signed in can read a chat read-only once a version links to it, so an audit can open the conversation behind a change. The chat says so before its first Apply. A chat is named after its first message and can be renamed or deleted on the Chat page. Its messages are stored in `chat_messages` exactly as they were sent and returned, which the model's thinking and the cache need, and are only ever added to, each reply with its model and token usage. A reply takes at most 20 rounds of tools, each running several at once, then stops and says so, and asking it to go on carries on. Stop keeps what the reply wrote. A reply that was declined, cut off at its length limit or stopped says so, and failures such as rate limits show in the chat when they happen.

Replies render as Markdown through `react-markdown`, as React elements rather than HTML: HTML in a reply is dropped, and images never load, since an image's address could carry what a reply was made to send. For the same reason only links into the admin open from a reply. A web page's or an email address shows as text after its words, such as "the docs (https://…)", so nothing a reply was steered to write, such as an address carrying a draft's text, opens with a click.

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
- `createClient({ preview: true })` reads drafts, for a site's preview, sending `status=draft` with every query. It needs a key from `iight make:api-key --preview`, so keep it on a server. Its entries are typed as drafts, which can be unfinished: every field can be missing, at any depth, `slug`, `uri` and `publishedAt` can be null, and links resolve to drafts. `Draft<EntryBlog>` is that type.

`cms.form('contact_us').submit(values)` sends a form's values as JSON, typed by the form's fields, and resolves the submission as it was stored, `{ id, version, values, createdAt }`. Values that don't pass throw an `IightError` with status 422, whose `body` is core's report, for a core form's `applyReport`.

```ts
// In a browser, which needs no key to submit
const cms = createClient({ url: 'https://cms.example.com' })
await cms.form('contact_us').submit({ name: 'Ada', email: 'ada@example.com' })
```

The `token` is optional, since submitting needs none, but entries do. A site's own server sends a key with the `submit` permission when it submits for its visitors, so they aren't rate limited as one IP address.

`npx iight types pull` writes `src/iight-types.d.ts` from `GET /types`, reading the CMS's address from `IIGHT_URL` and a key with the `types` permission from `IIGHT_TOKEN`. It declares each content type's values and entry, such as `BlogValues` and `EntryBlog`, the fields `with` can resolve, such as `BlogResolvedValues`, and each form's values, such as `ContactUsFormValues`, and registers them with the SDK. Each shared group's values get a type of their own, such as `GroupSeo`, and `GroupSeoResolved<Depth>`, every field with its links resolved, when it holds relationship or media fields. The types that use it refer to them, so one component can take a group's values from every type that has it. Forms change in the admin, so pull again after changing one. Commit the file, so builds don't need the CMS, and leave it unformatted. In CI, `npx iight types pull --check` fails when the file is out of date. Each entry type builds on the SDK's `Entry`, writing only what its type narrows, so what the SDK adds to every entry reaches the file without another pull. A file pulled before 29 October 2026 doesn't, and needs pulling once more: with the newer SDK, it types every query as `never`.

A project with both packages, such as the playground, gets the CMS's `iight` command, which passes `types` on to the SDK. With `npm run dev` running and a key from `npx iight make:api-key --types`:

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
