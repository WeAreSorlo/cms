<!-- BEGIN:sorlo-agent-rules -->

## Sorlo isn't in your training data

This project's CMS is Sorlo, `@sorlo/cms`, which is newer than your training data, so don't guess its APIs, file formats or commands. Before you change content types or shared groups in `schema/`, content migrations in `migrations/`, `sorlo.config.ts` or calls to `@sorlo/sdk`, read the pages that cover them in `node_modules/@sorlo/cms/docs/`, starting from its `README.md`, which lists them all. Fields and their options are Sorlo Forms inputs, which the README in `node_modules/@sorlo/forms/` describes. Both match the installed versions. Look for them from this file's folder upward, since in a workspace they can be in a parent folder's `node_modules`.

`sorlo dev` writes this block, and writes it again when it's missing or out of date, as `docs/cli.md` in `@sorlo/cms` explains. Taking it out of a diff only brings it back, so commit it with your work.

<!-- END:sorlo-agent-rules -->
