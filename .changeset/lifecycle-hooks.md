---
'@sorlo/cms': minor
---

Lifecycle hooks: `contentHooks`, `mediaHooks` and `formHooks` in `sorlo.config.ts`, and in plugins, run a site's own code around every write to entries, files and form submissions. `beforeSave` can change what's written, and Sorlo checks its values again before they're stored. Any before hook can refuse a write with a `ValidationError`, which replies 422 with the usual report, keyed by dotted path or `_entry` for the whole record. `warn()` adds warnings beside a successful write's `data`. After hooks run once the write commits. Hooks get a `sorlo` API that reads and writes as the person making the change. Imports run them unless `sorlo import --no-hooks` is given, and a content migration opts in with `export const hooks = true`. A plugin can now come with hooks alone, without `fields` or `admin`.
