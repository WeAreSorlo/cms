# Content migrations

Entries keep their values as JSON, so changing a content type never changes a table. A content migration changes the values inside entries instead. It's a file in the site project's `migrations` folder with an `up` and a `down`, as in Laravel.

To change a type:

1. Change it in the [type editor](content-types.md#the-type-editor), which writes its migration, or edit its file by hand and run `npx sorlo make:migration`.
2. Read the migration's flags, and write the conversion for each TODO, deleting its `// TODO:` comment.
3. Run it with `npx sorlo migrate`, or with Run on the admin's [Migrations page](#running-migrations-from-the-admin). Until then, entries can't be saved.
4. Commit the type's file, the migration and `migrations/.snapshot.json`. Each deploy runs `sorlo migrate` [before it takes traffic](deploying.md).

`sorlo make:migration` compares `schema/types` with `migrations/.snapshot.json`, the types as the last migration left them, matching types, fields and layouts by `id`. Its first run only writes the snapshot, so run it once before you change a type by hand. The type editor, and Apply in the assistant, write it first, of the types as they were, when a site has none. Commit the migrations and the snapshot.

| Change                                                | What the migration does                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Field added                                           | Nothing, or fills in its `defaultValue`. A new required field without one is flagged           |
| Field renamed or moved                                | Renames it, and back in `down`. A move into or out of a list or layout gets a stub with a TODO |
| Field removed                                         | Deletes its values, flagged, since `down` can't bring them back                                |
| Field type changed                                    | A stub with a TODO for the conversion                                                          |
| Choices or settings narrowed, or a field now required | Nothing, flagged for `sorlo migrate --check`                                                   |
| Layout renamed or removed                             | Renames the blocks' `_layout`, or deletes the blocks, flagged                                  |
| Type renamed                                          | Renames the type of its entries                                                                |
| Type removed                                          | Flagged. Its entries stay until you delete them                                                |
| Shared group changed                                  | Each of the changes above, for every type and path that uses the group, in one migration       |
| A group swapped for a use, or a use for another group | Keeps the values whose field names match, at any depth, and deletes the rest, flagged          |

```ts
// migrations/2026_10_28_120000_blog.ts
import type { ContentMigration } from '@sorlo/cms'

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
- An `up` or `down` only declares changes to one entry's values. `sorlo migrate` runs them on every entry, 500 at a time, inside one transaction for each migration, and old versions run them too.
- Every save records the last content migration that ran. Opening an old version runs the `up` of each migration that ran after it was saved, so its values fit the fields as they are now. A version saved after a migration that has since been rolled back replies 409 until it runs again.
- While a content migration hasn't run, saving an entry replies 409, since the types already have its change and the entries don't yet.
- A TODO's stub changes nothing, so once its conversion is written, delete its `// TODO:` comment. `sorlo migrate`, and the admin, refuse a waiting migration whose file still has one, since running the stub would mark the migration as run with nothing converted.
- The server loads each migration file as it is now, so one finished or fixed while `sorlo dev` runs needs no restart, and a file that changes between being read and being loaded doesn't run, so what was checked of it is what runs. A file the migration imports, such as a helper of the site's, still loads once.
- Content migrations change values that the links between entries in `entry_relations` are built from, so each records, in its own transaction, that the links are due a rebuild. `sorlo migrate`, the admin's Run and the servers as they start rebuild them once none waits, since until then the types are ahead of the values, and a rebuild would drop the links of every field a waiting migration renames. A rebuild that a restart or a failure cuts short stays due, and one goes a batch of 500 entries at a time, so saves carry on meanwhile.
- `sorlo migrate --check` leaves out entries that were never saved, such as a singleton that has only been opened.

## Running migrations from the admin

The admin's Migrations page, in the nav after Shared groups, lists every migration, the CMS's own and the site's, in the order `sorlo migrate` runs them. Each waiting content migration says what it does, from the helper calls its `up` makes, such as "Blog posts: renames title to headline" or "Blog posts: deletes the values of summary", with its flags, its TODOs and why its file doesn't load, and the ones that ran follow with their batches. While anything waits, a notice above every other page says what that stops: saving entries, for content migrations, and the pages whose tables are behind, for the CMS's own.

In `sorlo dev`, the page's panel has Run, which is `sorlo migrate`:

- **What runs.** Every waiting migration, the CMS's first, each in its own transaction, as one batch, then the links between entries rebuilt once none waits, as content migrations have it. There's no picking.
- **It asks first** when what waits deletes values, naming each, such as "Blog posts: the values of summary", from the `removeField` and `removeLayout` calls, whether `make:migration` wrote them or you did. `update` and `mapField` run code of their own, which the page says, and ask nothing.
- **It refuses**, running nothing, while a waiting migration has a TODO left or a file that doesn't load, and when what waits has changed since the page showed it, such as a migration the type editor wrote in another tab, so a run is always what the page showed.
- **It runs in the background**, and every page follows it: which migration, such as 2 of 3, how many rows it has been through, then the links. Closing the tab doesn't stop it, and restarting `sorlo dev` mid-run rolls back only the migration it was in.
- **A failure** changes nothing of the migration that threw, while the ones before it stay run and those after it still wait, and the links stay as they were until every content migration has run. The page says which and why, so you can fix it and run them again. A failure outside any migration, such as the database going away before the next one started, names the one it stopped before.
- **One run goes at a time.** A second Run, from another tab or person, is refused while one goes, and follows it instead. An `npx sorlo migrate` beside it fails on the migration the other ran first, which it rolls back.
- **Check entries**, once nothing waits, lists what `sorlo migrate --check` lists, each entry linking to its editor.

Under `sorlo start` the page lists what waits without running it, since there are no roles yet and migrations belong to each deploy, as a release step that runs `node_modules/.bin/sorlo migrate`, as [Deploying](deploying.md) has it. The admin never rolls back: `npx sorlo migrate:rollback` does, and undoing a type change for good also means putting back its file, the snapshot and the migration with git. The assistant and MCP have no tool for any of it. `sorlo dev` also runs what waits as it starts, as `sorlo migrate` does, without the page's question about deleting values, so a new database needs nothing more before its [first account](people.md#the-first-account) is made in the admin.
