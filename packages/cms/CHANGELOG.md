# @sorlo/cms

## 0.4.0

### Minor Changes

- 9ba105e: Lifecycle hooks: `contentHooks`, `mediaHooks` and `formHooks` in `sorlo.config.ts`, and in plugins, run a site's own code around every write to entries, files and form submissions. `beforeSave` can change what's written, and Sorlo checks its values again before they're stored. Any before hook can refuse a write with a `ValidationError`, which replies 422 with the usual report, keyed by dotted path or `_entry` for the whole record. `warn()` adds warnings beside a successful write's `data`. After hooks run once the write commits. Hooks get a `sorlo` API that reads and writes as the person making the change. Imports run them unless `sorlo import --no-hooks` is given, and a content migration opts in with `export const hooks = true`. A plugin can now come with hooks alone, without `fields` or `admin`.

### Patch Changes

- @sorlo/sdk@0.4.0

## 0.3.0

### Minor Changes

- 0180450: A rich text field, `lexical`, for content types and shared groups, on Lexical. It stores Lexical's JSON, with links to entries and files by ID, which Used by lists. Its `output` option says how the delivery API returns it: as HTML, by default, or as JSON, which can hold blocks, whose kinds are its `layouts`, as a flexible field's are, and whose links `with` resolves. The CMS includes it from the new `@sorlo/field-lexical`, so it needs no setup, and a site lists `lexical({ entryLinks })` in `plugins` to say where links to its entries go. Plugin fields can say what their values link to and how they're delivered, with `links`, `resolve`, `deliver` and `deliveredType`, and content migrations reach blocks in rich text as they do a flexible field's.

  <!-- Release note: @sorlo/field-lexical 0.1.0 is new, so publish it by hand, as CONTRIBUTING's "A new package" says, and check it's live on npm before the Version Packages pull request merges. Otherwise the publish job fails on it and skips @sorlo/cms, which depends on it. -->

### Patch Changes

- @sorlo/sdk@0.3.0

## 0.2.0

### Minor Changes

- ac2a7eb: `ai` in `sorlo.config.ts` takes a provider rather than options, so a site brings its own: `ai: anthropic()` from the new `@sorlo/ai-anthropic`, which holds what the CMS did for Anthropic, or any object with a `name` and a `reply` method, typed `AiProvider`. The CMS no longer depends on `@anthropic-ai/sdk`. Messages are made of the CMS's own parts, which a migration converts stored chats to, and `@sorlo/cms` exports their types and `AiError`. A config that still has `{ provider: 'anthropic' }` stops `sorlo` with what to change.
- 0269020: `sorlo make:plugin <name>` makes a field package in the site's `plugins` folder, `sorlo-field-<name>`, with its three entries built by tsup and a field that starts as Sorlo Forms' text field. It adds the package to `package.json` as a `file:` dependency and to `sorlo.config.ts`'s `plugins`, then installs and builds it and installs the site, or with `--no-install` prints those steps.
- 9ef942b: A Markdown field, `markdown`, for content types and shared groups: a textarea with format buttons and a preview, whose value is the Markdown as written. The CMS includes it from the new `@sorlo/field-markdown`, so it needs no setup.
- 72db3fd: Plugins, and a build step for the admin. `plugins` in `sorlo.config.ts` adds field types for content types and shared groups, from packages or from the site's own folder, as `{ name, fields, admin }`, whose type `@sorlo/cms` exports as `Plugin`. A field type that's built in or that another plugin has stops every command with a list.

  This is a breaking change: `sorlo start` now serves the admin that the new `sorlo build` writes into `.sorlo/admin`, with the site's plugins, and stops with "Run npx sorlo build" when there's none, or it was built for another version or other plugins. Add `RUN node_modules/.bin/sorlo build` after `COPY . .` in the site's Dockerfile, and `.sorlo` to its `.dockerignore`, as Deploying shows. `sorlo dev` needs no build. `@sorlo/cms/admin` is the admin as a library, which only the build's generated entry uses, and Vite and `@vitejs/plugin-react` are now dependencies of `@sorlo/cms`.

### Patch Changes

- @sorlo/sdk@0.2.0

## 0.1.1

### Patch Changes

- 4fdad90: The docs that come with the CMS install it from npm rather than from packed tarballs, and lead with the [starter](https://github.com/WeAreSorlo/starter) template.
- @sorlo/sdk@0.1.1
