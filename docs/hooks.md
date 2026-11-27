# Hooks

Hooks run a site's own code around every write: saving, publishing, unpublishing, archiving and restoring entries, uploading files and changing their details, and taking form submissions. A before hook can change what a save writes, or refuse a write. An after hook runs once the write has committed. Hooks can never write values that stray from the schema, since Sorlo checks whatever a hook returns before it's stored. So what the delivery API returns stays what the [generated types](sdk.md) promise.

```ts
// sorlo.config.ts
import { ValidationError, defineConfig } from '@sorlo/cms'

export default defineConfig({
  // …
  contentHooks: {
    '*': {
      beforePublish: ({ values }) => {
        if (values.template) throw new ValidationError({ template: 'Templates are only for duplicating.' })
      },
    },
    posts: {
      beforeSave: ({ values }) => ({ ...values, minutes: readingTime(values.body) }),
      afterPublish: ({ entry }) => searchIndex.put(entry),
    },
  },
  mediaHooks: {
    beforeSave: ({ values }) => ({ ...values, alt: values.alt ?? '' }),
  },
  formHooks: {
    contact_us: {
      afterSave: ({ values }) => crm.addLead(values),
    },
  },
})
```

## Where hooks go

| Setting        | Keyed by                                     | Hooks                                                                                                                                                             |
| -------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contentHooks` | Content type name, with `'*'` for every type | `beforeSave`, `afterSave`, `beforePublish`, `afterPublish`, `beforeUnpublish`, `afterUnpublish`, `beforeArchive`, `afterArchive`, `beforeRestore`, `afterRestore` |
| `mediaHooks`   | Nothing: they run for every file             | `beforeSave`, `afterSave`                                                                                                                                         |
| `formHooks`    | Form name, with `'*'` for every form         | `beforeSave`, `afterSave`, `beforeArchive`, `afterArchive`, `beforeRestore`, `afterRestore`                                                                       |

[Plugins](plugins.md) can bring hooks too, in the same three settings. For each write, Sorlo runs every plugin's hooks first, in the order `plugins` lists them, then the site's. Within each, `'*'` runs before the type's or form's own. Each `beforeSave` gets the values the one before it returned.

The servers check the settings as they start. A name that isn't a hook, or a hook that isn't a function, stops them with a list, and a type name with no content type gets a warning, since the type editor can add the type later. A form's hooks follow its `name`, so renaming a form on its page leaves them behind.

## What a hook gets

Each hook gets one object:

| Key         | What it is                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `operation` | `create` or `update` for the save hooks, and otherwise the action: `publish`, `unpublish`, `archive` or `restore`                                                                                                              |
| `values`    | The values being written, as [below](#which-values-a-hook-gets). An after hook gets the values that were written                                                                                                               |
| `original`  | The values as they were stored before the write, or `null` on create                                                                                                                                                           |
| `entry`     | The record as it was stored before the write, or `null` on create. An after hook gets it as the write left it. It's an entry as the [admin API](admin-api.md) returns one, a file as the media library has it, or a submission |
| `user`      | The person making the change, `{ id, email, name }`, or `null` for a public form post, `sorlo import` or `sorlo migrate`                                                                                                       |
| `source`    | Where the write came from: `admin`, `api` (a public form post), `mcp`, `assistant`, `bulk`, `import` or `migration`                                                                                                            |
| `sorlo`     | The server's own content API, acting as `user`, as [below](#the-sorlo-api)                                                                                                                                                     |
| `context`   | One object that the hooks of a write share with the writes they make through `sorlo`, so a hook can tell its own writes apart                                                                                                  |
| `warn`      | `warn(path, message)` adds a warning, which comes back beside a successful write                                                                                                                                               |

### Which values a hook gets

| Hooks                                                            | `values`                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `beforeSave`, `afterSave`                                        | The values the save writes: for a file, its `{ name, alt, caption }`, and for a submission, the form's values |
| `beforePublish`, `afterPublish`                                  | The values going live, which are the draft's once `beforeSave` has run                                        |
| `beforeUnpublish`, `afterUnpublish`                              | The live copy's values, which can differ from the draft's. `entry` is still the draft                         |
| `beforeArchive`, `afterArchive`, `beforeRestore`, `afterRestore` | The draft's values, or a submission's                                                                         |

For the unpublish, archive and restore hooks, `original` is the same as `values`, since those actions don't change them.

## Changing a save

`beforeSave` returns the values to write, or nothing to keep them. Changing `values` in place does nothing, so return them.

A save goes in this order:

1. Sorlo checks the values sent, as it always does. A save that fails here replies 422, and no hooks run.
2. The `beforeSave` hooks run, in order, on the values that passed.
3. Sorlo checks each hook's values again, in the save's own mode, so a draft save can still hold unfinished values and a publish runs every check, as [Drafts and publishing](drafts-and-publishing.md) describes. Checks that need a finished entry belong in `beforePublish`.
4. For a publish, the `beforePublish` hooks run on those values.
5. The write commits, then the after hooks run.

Values a hook returns that fail Sorlo's checks fail the write with a 500, whose message names the hook, such as `contentHooks.posts.beforeSave in sorlo.config.ts returned values that don't pass their checks.` The server's log lists what failed. The person saving can't fix a hook's values, so this is a server error, not a 422. Any other error a before hook throws fails the write the same way.

A save that changes nothing, once its hooks have run, writes nothing and runs no after hooks. Only `beforeSave` returns values, since publishing, unpublishing, archiving and restoring don't change them. Their before hooks check and refuse.

## Refusing a write

Any before hook refuses a write by throwing a `ValidationError`, with messages by dotted path:

```ts
import { ValidationError } from '@sorlo/cms'

throw new ValidationError({
  title: 'Another announcement has this title.',
  'dates.0.end': 'This ends before it starts.',
  _entry: 'These dates overlap “Winter sale”.',
})
```

`_entry` is a message about the whole entry, file or submission, not one field. No field can be named `_entry`, since field names start with a letter. A path can name one message or a list of them.

The messages merge into Sorlo's own report, so a refused write is a 422 with `{ isValid, fields }`, as any failed check is:

```json
{
  "isValid": false,
  "fields": {
    "title": { "isValid": false, "messages": ["Another announcement has this title."] },
    "_entry": { "isValid": false, "messages": ["These dates overlap “Winter sale”."] }
  }
}
```

The editor shows a field's messages on the field, and `_entry`'s beside the buttons. A refused publish, unpublish, archive or restore replies the same 422. Bulk editing, bulk archive and bulk restore give each refused entry a row with `status: 422` and its `report`, and go on with the others. Archiving takes the pages under an entry with it, so its hooks run for each of them, and a refusal from any one refuses the archive. Archiving takes entries off the site with their archive hooks, not their unpublish hooks.

## Warnings

`warn(path, message)` adds a warning that doesn't block the write, keyed as a refusal is. A successful write's reply carries them beside `data`, nested as Sorlo's report nests messages, and only when a hook warned:

```json
{
  "data": { "id": "…", "values": { "…": "…" } },
  "warnings": {
    "fields": {
      "title": { "messages": ["Titles over 60 characters get cut in search results."] },
      "_entry": { "messages": ["Another announcement runs on these dates."] }
    }
  }
}
```

The editor shows each warning above the form once the save is done. Bulk rows and the public form route's JSON replies carry `warnings` too, and over [MCP](mcp.md) they're in the tool's note for the model.

## After hooks

After hooks run once the write has committed, so a failing one can't undo it. Its error goes in the server's log, and the reply still succeeds. A check that must hold belongs in a before hook. They run before the reply is sent, so keep them quick, and hand slow work, such as calling another service that can be down, to an [automation](automations.md), which is queued, retried and logged. Automations stay the admin's way to act on the same events.

## The sorlo API

`sorlo` reads and writes content as the person making the change. Its writes take the path the admin's do, checks and hooks included, with the same `context`, so they can't stray from the schema either.

In a before hook, `sorlo` reads and writes inside the write's own transaction. So it sees what the write has done so far, such as a new page's parent, and its writes go with that write: they commit when it commits, and they're taken back when it's refused or fails, by this hook, a later one, Sorlo's own checks, or a failing import or migration. Their after hooks run once the write commits. In an after hook, the write has committed, so `sorlo`'s writes are writes of their own.

```ts
const post = await sorlo.entries.get(id) // an entry as the admin API returns it, or null
const { data, pagination } = await sorlo.entries.list('posts', {
  where: [[{ field: 'values.category', op: '=', value: id }]],
  order: { updatedAt: 'desc' },
  page: 1,
  perPage: 50,
})
await sorlo.entries.create('posts', { values, parentId, publish })
await sorlo.entries.update(id, { values: { count: 3 }, publish })
await sorlo.entries.publish(id) // and unpublish, archive, restore
await sorlo.media.get(id)
await sorlo.media.update(id, { alt: 'A lighthouse at dusk' })
```

- `list` takes the [admin list's query](admin-api.md): `where` groups joined by OR, each a list of conditions that must all match, `order`, `page`, `perPage` up to 100, and `archived`.
- `update` merges the top-level fields named into the entry's values, as [bulk editing](bulk-editing.md) does, and keeps its parent unless `parentId` is given. `publish` publishes the save, and a type without drafts publishes every save.
- Writes resolve `{ data, warnings }`. A refused write throws a `ValidationError`, whose `report` is the write's 422 report. Refusing it in a hook of its own doesn't refuse the write whose hook made it: uncaught, it fails that write as a server error instead.
- Each write takes a last option, `{ skipPermissions: true }`, which writes without the person's permissions. With no person behind a write, as for a public form post, an import or a migration, `sorlo` can only read without it.
- Hooks that write through `sorlo` set something in `context` to stop loops, such as an `afterSave` that updates a related entry whose own `afterSave` updates this one:

  ```ts
  afterSave: async ({ entry, sorlo, context }) => {
    if (context.syncing) return
    context.syncing = true
    await sorlo.entries.update(entry.values.category, { values: { updated: entry.updatedAt } })
  }
  ```

  Writes nested more than five deep throw, since that's likely a loop.

- A before hook can't write its own entry or file through `sorlo`, since the save writes it after its hooks, over what the hook wrote. Return values from `beforeSave` instead, or write it in an after hook.
- A content migration's before hooks can read through `sorlo`, but not write, since what they wrote would say it's from before the migration, which would then run on it again. Write in `afterSave`, which runs once the migration commits.

## Worked-out values

A value worked out on save, such as reading time or text for search, is an ordinary field in the type's file that `beforeSave` fills in. Types, delivery, filters and the SDK treat it as any other field, and it's stored, so content migrations don't need the hooks to keep it.

The editor shows the field like any other, so people can edit it. The hook's value wins on every save, unless its code keeps a value someone set by hand, which it can tell by comparing `values` with `original`:

```ts
contentHooks: {
  posts: {
    beforeSave: ({ values, original }) => {
      // Someone changed it by hand in this save, so it stays
      if (original && values.minutes !== original.minutes) return
      const words = String(values.body ?? '').split(/\s+/).filter(Boolean).length
      return { ...values, minutes: Math.ceil(words / 200) }
    },
  },
},
```

Keeping people from editing a field at all is for roles, which aren't here yet. A site can also work such values out in its own build instead, from what the delivery API returns, and store nothing.

## Every write path

Hooks run for writes from the admin, bulk editing, the public form routes, the [assistant](assistant.md)'s Apply, [MCP](mcp.md) tokens' saves and publishes, and `sorlo` itself. The assistant checks a proposal with a dry run, which runs no hooks, since a hook's own writes would escape it. Applying the proposal runs them.

- **Imports** run them by default: `beforeSave` on each entry's draft, and on a live copy that differs, `beforePublish` on each live copy, `mediaHooks.beforeSave` on each file, and the after hooks once the import commits. A refusal or a failure stops the import, with the record's file in the list. `sorlo import --no-hooks` skips them. See [Exporting and importing](export-and-import.md).
- **Content migrations** skip them by default, so a migration stays a pure transform of values. One opts in with `export const hooks = true` in its file. Then each draft and live copy it changes goes through `beforeSave`, with the values before the migration as `original`, checked as a save of it would be, and each draft through `afterSave` once the migration commits. An old version catches up with a migration by running it as it's opened, which can't run hooks, so the version that a draft or live copy a hook changed comes from takes the values the hook gave it. A refusal fails the migration. Rolling back with `sorlo migrate:rollback` runs no hooks. See [Content migrations](content-migrations.md).
- **Bots' submissions,** those that fill in the honeypot, never reach the hooks, though they're kept as spam as before. Marking a submission as spam, or not, runs no hooks either.
- Moving a page among its siblings, opening a singleton for the first time and deleting for good run no hooks. Nor do reads: what delivery returns is what the generated types promise, so there's no hook to reshape it.
