# @sorlo/cms

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
