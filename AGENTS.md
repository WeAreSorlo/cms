# Notes for coding agents

This repo holds `@sorlo/cms`, the Hono server, React admin and `sorlo` CLI, and `@sorlo/sdk`, the typed client for the delivery API. Beside them is `create-sorlo`, which makes a site from the starter. `examples/sandbox` is the site the workspace runs. [CONTRIBUTING.md](CONTRIBUTING.md) has setup, the layout and how the pieces fit, and [`docs/`](docs/README.md) documents every feature. This file is the short version.

## Commands

Node 24, and Docker for Postgres.

- `npm run db` starts Postgres, which the tests need.
- `npm run format`, `npm run typecheck`, `npm test` and `npm run build`, from the root. Run all four before you finish.
- `npm run build:server` rebuilds the server and SDK code, since `sorlo` runs it from `dist/`. `npm run dev` does that, then runs the sandbox with its admin at http://localhost:4100/admin/.

## Rules

- **Sorlo Forms stands alone.** The CMS builds on `@sorlo/forms` but never adds CMS concepts to it. When the CMS needs something from it, it implements a general hook that Sorlo Forms offers.
- **No package depends on one site,** `examples/sandbox` included.
- **Shapes are promises.** Open an issue before changing what the APIs accept or return, or the shape of a `sorlo.config.ts` setting, since sites and the SDK rely on them.
- **The CMS's own migrations,** in `packages/cms/src/migrations`, only ever gain new files. A migration that has shipped is never edited.
- **Docs and changesets:** update the page in `docs/` that covers what you change, and add a changeset with `npx changeset` for anything sites will notice. The CMS and the SDK share one version, and `create-sorlo` has its own.
- **Formatting:** 120 columns, no semicolons, single quotes and sorted imports, which `npm run format:fix` applies.
