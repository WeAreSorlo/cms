---
'@sorlo/cms': minor
---

Plugins, and a build step for the admin. `plugins` in `sorlo.config.ts` adds field types for content types and shared groups, from packages or from the site's own folder, as `{ name, fields, admin }`, whose type `@sorlo/cms` exports as `Plugin`. A field type that's built in or that another plugin has stops every command with a list.

This is a breaking change: `sorlo start` now serves the admin that the new `sorlo build` writes into `.sorlo/admin`, with the site's plugins, and stops with "Run npx sorlo build" when there's none, or it was built for another version or other plugins. Add `RUN node_modules/.bin/sorlo build` after `COPY . .` in the site's Dockerfile, and `.sorlo` to its `.dockerignore`, as Deploying shows. `sorlo dev` needs no build. `@sorlo/cms/admin` is the admin as a library, which only the build's generated entry uses, and Vite and `@vitejs/plugin-react` are now dependencies of `@sorlo/cms`.
