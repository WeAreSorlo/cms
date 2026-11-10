# Drafts and publishing

Every entry has a draft, and once it's published, a live copy, which is what the delivery API serves. Save writes the draft as a new version, and the live site keeps its copy until Publish replaces it. Unpublish takes the live copy down and keeps the draft. An entry is a draft until it's published, published while its newest version is the live one, and changed once a newer version is saved.

- **Drafts can be unfinished.** A save runs every check but those an unfinished value fails: required fields, minimum lengths, and minimum numbers of items, rows, columns and selections. Publish runs them all, and the editor shows what it needs without blocking Save.
- **Publish saves the form first**, so one click publishes what the editor shows. It's all or nothing: when a check fails, nothing is saved. In the admin API it's `publish: true` in the body of the create and save routes, settled on 29 October 2026, rather than a route of its own.
- **Slugs.** A live entry keeps its slug until it's published again, so a publish replies 422 on the slug when a live sibling has it, even though no draft does.
- **Pages** go live only under a live parent. A page's live `uri` comes from its live parents' slugs, so a parent's new slug reaches the live pages under it when the parent is published. A new parent waits for Publish, but moving a page among its siblings changes the live order at once. Unpublishing a page takes the live pages under it down too.
- **Archiving** takes an entry and the pages under it off the live site, and restoring gives back drafts, to publish again.
- **A type can go without drafts**, with `"drafts": false` in its type file, or Drafts unticked in the type editor, for types such as site settings, where editors expect Save to go live. Then every save publishes and runs every check, and the editor has Save alone. Turning drafts off leaves any unpublished changes until an entry is next saved, and that save publishes them.
- **Content migrations** change the drafts and the live copies alike.
- **Upgrading**, `sorlo migrate` publishes every saved entry that isn't archived, as it stands, so a site keeps serving what it served before.

## Previews

A preview reads drafts in place of live copies, for a site's preview mode. It needs a key with the `preview` [permission](api.md#api-keys), which can add `status=draft` to any delivery route. It then reads every entry that isn't archived, published or not, with links resolved to drafts. Other keys get a 403 for it. Plain keys can sit in frontends, since they only ever see what's live, but keep preview keys on a server. The SDK's `createClient({ preview: true })` sends `status=draft` with every query.
