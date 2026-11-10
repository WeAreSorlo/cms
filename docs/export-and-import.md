# Exporting and importing

`sorlo export` writes a site's content to a folder, and `sorlo import` loads such a folder into a site that has no content yet. A starter keeps sample content this way: it commits the folder, and its setup script runs `sorlo migrate && sorlo import`.

```bash
npx sorlo export            # into content/
npx sorlo import            # from content/, into a site with no content
npx sorlo export samples    # or a folder you name
```

Both print what they moved, such as `Exported 12 entries, 3 files, 1 form and 1 automation to content/.`, or why they changed nothing, exiting 1.

## What's in it

- **Every saved entry,** archived ones included, each with its draft and its live copy.
- **Every media file,** with its name, alt text and caption.
- **Every form and every automation.**

People, sessions, invites, API keys, MCP tokens, chats and proposals stay out, since they're people's and access rather than content. So do entries' older versions, submissions, which hold visitors' details, and events and runs. A singleton that has been opened but never saved stays out too, since opening it makes it again.

## The folder

```
content/
  export.json
  entries/posts/0193a1f2-6c1e-7b3a-9d2f-5e8c1a4b7d90.json
  entries/pages/0193a1f8-….json
  media/0193a20c-….json
  media/0193a20c-….jpg
  forms/0193a2b0-….json
  automations/0193a2c4-….json
```

Each record is a JSON file named by its ID, entries in a folder for their type. IDs are kept, so the links between entries, media fields, form fields and automations' Form rules keep working. Files are written with two spaces, keys in a fixed order and records sorted, so exporting content that hasn't changed changes no file, and a diff shows what did.

**`export.json`** holds `format`, the folder's format, which is 1, so a later Sorlo can read older folders and refuses newer ones clearly, and `migration`, the last content migration the values have been through, or null for none.

**An entry** has the names the API gives it:

```json
{
  "id": "0193a1f2-6c1e-7b3a-9d2f-5e8c1a4b7d90",
  "parentId": null,
  "position": null,
  "slug": "hello-world",
  "uri": null,
  "values": { "title": "Hello, world", "slug": "hello-world", "body": "…" },
  "createdAt": "2026-11-10T09:12:03.120Z",
  "updatedAt": "2026-11-10T09:15:44.861Z",
  "archivedAt": null,
  "takenDownAt": null,
  "live": { "publishedAt": "2026-11-10T09:15:45.002Z" }
}
```

- `live` is null for an entry that isn't live. When the live copy is the draft as it stands, as for most published entries, it holds only `publishedAt`, so the values aren't written twice. When the live copy differs, as for an entry changed since it was published, it holds the live copy in full: `parentId`, `position`, `slug`, `uri`, `values`, `updatedAt` and `publishedAt`.
- `takenDownAt` is when a person last took the entry off the site, by unpublishing or archiving it, which stops an MCP token with Publish changes putting it back, as [MCP](mcp.md) describes.

**A media file** has `id`, `name`, `alt`, `caption`, `createdAt` and `updatedAt`, and its file beside it, named by its ID and the extension it's stored with. Its type, size and dimensions come from the file itself as it imports.

**A form** has `id`, `name`, `label`, `fields`, `open`, `firstOpenedAt`, `createdAt` and `updatedAt`.

**An automation** has `id`, `name`, `triggers`, `conditions`, `actions`, `createdAt` and `updatedAt`.

## Exporting

- **One snapshot.** Everything is read in one transaction, so a save made meanwhile can't leave the folder half old and half new.
- **Into an empty folder, or over an earlier export.** A folder holding anything else is refused, so naming the wrong one can't empty a project. Over an earlier export, it replaces `export.json`, `entries`, `media`, `forms` and `automations`, so a deleted entry's file goes, and leaves anything else there, such as a README. It's written beside the folder first, so a failure leaves the folder as it was.
- **A missing file stops it,** naming the file, so an export is never short without saying so.
- **Secrets.** A webhook's signing secret and headers are exported as they are, and export lists the files that hold them. Keep such a folder private, or blank the secret before committing it, and import makes a new one, as saving a new webhook does. A starter's sample secret can be shared with its frontend's `.env.example` this way, but a site's own belongs only in its own environment.

## Importing

- **Only into a site with no entries, media, forms or automations.** Anything else is refused, naming what's there, and nothing changes. People can be there already, so a second run of a starter's setup stops at its import rather than adding the samples twice.
- **All or nothing.** It runs in one transaction, and stores the files last. A failure leaves the site as it was, deleting any file it stored.
- **Values catch up.** Values from before this site's newest content migrations go through those migrations' `up`, as restoring an old version does, renamed types included, so an export made before the latest migration still imports. An export made after a migration this site hasn't run is refused: migrate, then import again.
- **The admin's checks.** Each draft must pass what a save checks, and each live copy what a publish checks, as `sorlo migrate --check` checks them. Each form must pass what saving a form checks, each automation what saving one checks, and each file what an upload checks, `media.types` and `media.maxFileSize` included. Every problem is listed, with its file and field, and nothing is imported.
- **What it writes.** An entry gets one version for its live copy and, when its draft differs, a second for the draft, so its status reads as it did, with no person, so the versions say The CLI. A form starts again at version 1, and the files go to the default disk. It writes no events, so a webhook that's part of the import doesn't fire for every entry, and nothing is emailed.

Moving content into a site that already has some, such as between environments, isn't done yet.
