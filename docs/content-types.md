# Content types

A content type describes one kind of entry, such as blog posts, pages or the site's settings: its fields, and how its entries are arranged. In `sorlo dev`, make and change types on the admin's Content types page, which writes each one's file in `schema/types` with the content migration for the change. Commit the files with their migrations, since outside `sorlo dev` types change through git.

## The type editor

In `sorlo dev`, the admin's Content types page creates, edits and deletes types, with the Sorlo Forms schema builder for their fields. Saving writes the type's file, laid out by the site project's Prettier if it has one, then runs `make:migration` and shows the migration it wrote with its flags and TODOs. The editor doesn't run the migration, so you can check it and finish any TODOs first, then run it on the [Migrations page](content-migrations.md#running-migrations-from-the-admin).

- **Renames.** Settings that name a field, such as `titleField`, follow it when the builder renames it.
- **The first change.** A site with no snapshot yet gets one of the types as they were first, so its first change still gets its migration.
- **Structure.** A type with entries keeps its structure, archived ones counting, since nothing moves entries from one structure to another, so saving a new one is refused under Structure, as it is while a content migration hasn't run, since that may still rename a type's entries.
- **Names.** Names are one whatever their case, since a disk may ignore it. A type's file the server didn't load at start, such as one a `git pull` brought, is never written over, and a name with entries left under it, from a type that's gone, isn't taken, since a type of that name would take them over.
- **Changes made elsewhere.** Save sends back the type as the editor loaded it, and is refused when its file has changed since, through the assistant, another tab or by hand, so it never writes back over that change. When anything after the write fails, such as another type's file that doesn't load, every file, the migrations and the loaded types go back as they were.
- **Outside `sorlo dev`** the page is read-only, and types change through git.
- **The assistant.** With the [assistant](assistant.md) on, it can also propose new types and changes to them, as [content types through the assistant](assistant.md#content-types-through-the-assistant) describes.

## The type's file

Each content type is a JSON file in the site project's `schema/types` folder, named after the type, as in [the sandbox's](https://github.com/WeAreSorlo/cms/blob/main/examples/sandbox/schema/types/posts.json). `sorlo dev` checks every file when it starts, including each field's `defaultValue` against its input, and lists all the problems it finds. Restart it after editing a file by hand. The type editor reloads the types itself.

```json
{
  "id": "typ_s7k2p9qa",
  "name": "posts",
  "label": "Posts",
  "singular": "Post",
  "structure": "collection",
  "icon": "newspaper",
  "titleField": "title",
  "slugField": "slug",
  "listColumns": ["title", "published_at"],
  "fields": [
    { "id": "fld_t4w8n2xe", "type": "text", "name": "title", "label": "Title", "required": true },
    {
      "id": "fld_s9q3m7vd",
      "type": "identifier",
      "name": "slug",
      "label": "Slug",
      "required": true,
      "options": { "source": "title" }
    },
    { "id": "fld_p6j1r5kc", "type": "date", "name": "published_at", "label": "Published" },
    { "id": "fld_b2y8h4lz", "type": "textarea", "name": "body", "label": "Body" }
  ]
}
```

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
| `fields`            | A Sorlo Forms schema. Every field and flexible layout needs an `id`, such as `fld_k3x9q2mz`                                          |

## Lists

Each type's list in the admin has a panel beside it with New, Bulk edit and Archive for the [ticked entries](bulk-editing.md), and a link to the archive, a search on the title field, and Filter, the Sorlo Forms conditions input over the type's top-level fields. The search and the filter stay in the URL, as in `#/types/blog?search=lamp`, so a link shares them. They become the list API's `where`, which has every operator but starts with, so the list leaves those rules out and says so. A search or filter on a hierarchical type lists the pages that match, rather than the tree. The Media page has the same, beside its type filter, over names, alt text, captions, MIME types, dimensions and upload dates.

## Relationship and media fields

The CMS adds two field types to those of Sorlo Forms. A `relationship` field links to entries, and a `media` field to files in the media library. Both store IDs. The admin edits them with pickers: a search over the entries of the types a relationship takes, and the media library, which can upload files too.

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

- Saving checks that each ID is an entry or a file of a type the field takes. Archived entries count, so archiving one doesn't stop the entries that link to it from saving. `sorlo migrate --check` checks the same.
- Every save rebuilds the entry's rows in `entry_relations`, which record what its fields link to, nested ones included, and `sorlo migrate` rebuilds them after content migrations. The admin shows them as "Used by" on entries and files.
- Archiving an entry that others link to asks first in the admin. Deleting an entry or a file for good replies 409 while any entry links to it, archived ones included, so remove the links first. The type editor won't delete a type that relationship fields link to.
- Changing a `maximum` to or from 1 changes the shape of the field's values, which `make:migration` flags and `sorlo migrate --check` lists.

## Form fields

A `form` field holds the ID of one of the [forms](forms.md), such as the sign-up form an event's page shows, so renaming the form breaks nothing. The editor picks it from the forms by label, marking the closed ones, and saving checks that the form exists. It has no options. Delivery returns the ID, which `GET /v1/forms/:form` serves, and the SDK's types call it a `string`.

```json
{ "id": "fld_kt5appci", "type": "form", "name": "form", "label": "Form" }
```

## Shared groups

A shared group is a set of fields defined once and used by many types, such as SEO fields, so the types' copies can't drift apart. In `sorlo dev`, the admin's Shared groups page creates, edits and deletes groups as the type editor does types, writing a migration for every type each change reaches. Deleting one replies 409 while a type or another group uses it. The type editor's palette has a Shared group field, and beside the form it lists the type's groups at any depth:

- **Make shared** turns one of the type's own groups into a new shared group, with its fields and their ids, and swaps the type's copy for a use with the copy's `id`, name and settings. Saving the type then needs no migration.
- **Use shared group** swaps a copy for a use of a shared group, showing first which values the swap keeps and which it deletes.

Each group is a JSON file in the site project's `schema/groups` folder, beside `schema/types`, named after the group:

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
| `fields` | A Sorlo Forms schema, checked as a type's is. Every field and flexible layout needs an `id`, unique in the group  |

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
- Types load with each use expanded into an ordinary `group` field holding the group's fields, so the editor, the checks, `with()`, `entry_relations`, the bulk grid, the delivery API and `sorlo migrate --check` treat it as one. The group keeps `options.group`, and its fields' ids get the use's in front, such as `fld_04fi4quz.fld_l2g562g3`, so two uses in one type never share one. So field ids in type and group files can't hold a dot.
- `sorlo dev` checks the group files with the types, listing ids two files share, groups that use themselves and uses that name a group that doesn't exist.
