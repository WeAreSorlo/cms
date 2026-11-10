# Contributing to Sorlo

This repo holds the CMS, `@sorlo/cms`, and its SDK, `@sorlo/sdk`. The form library the CMS is built on, Sorlo Forms (`@sorlo/forms`), has its own repo at [WeAreSorlo/forms](https://github.com/WeAreSorlo/forms).

## Layout

| Folder             | What it is                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| `packages/cms`     | `@sorlo/cms`: the Hono server (`src/`), the admin UI (`admin/`) and the `sorlo` CLI |
| `packages/sdk`     | `@sorlo/sdk`: the typed client for the delivery API, and `sorlo types pull`         |
| `examples/starter` | A minimal site project, for development and as the starting point for new sites     |

## Getting started

You need Node 22.18 or later, which runs a site's TypeScript itself, and Docker. Node 24 is what the site image uses. Clone [Sorlo Forms](https://github.com/WeAreSorlo/forms) beside this repo first, as `../core`, since the CMS links it from there until it's on npm: `git clone https://github.com/WeAreSorlo/forms.git ../core`.

```bash
npm install
npm run build       # the SDK and the CMS into their dist folders, and the admin into admin/dist
npm run db          # Postgres 17 on localhost:5432
cd examples/starter
npx sorlo migrate
npx sorlo make:user
npx sorlo make:api-key --types   # a key for the delivery API that can pull types
cd ../..
npm run dev         # builds the server code again, then runs sorlo dev: the admin is at http://localhost:3000/admin/
```

`npm run db` also creates a `sorlo_test` database for the tests and `sorlo_starter` for the starter, but only when it first creates the Postgres volume. On an older volume, add the starter's with `docker compose exec postgres createdb -U sorlo sorlo_starter`.

The packages point at their `dist` folders, as a site gets them, so the starter runs what's built. `npm run dev` in the workspace builds the SDK's and the CMS's server code first, with tsup, so restart it after changing either. The admin is the exception: in this workspace `sorlo dev` serves it from its source through Vite, which reloads it as you edit.

In this workspace's `sorlo dev`, `/admin/#/design` shows the admin's design system: its tokens, their contrast in the current theme, and every Sorlo Forms input. Sites, whose admin is the built one, don't have the page.

### A site of your own

A site outside this workspace can run on its packages too. Link them with folder dependencies, build the server code before `sorlo dev`, and keep the `.npmrc` line from [Starting a site](README.md#starting-a-site):

```json
"scripts": { "dev": "npm run build:server --prefix ../cms && sorlo dev" },
"dependencies": {
  "@sorlo/cms": "file:../cms/packages/cms",
  "@sorlo/sdk": "file:../cms/packages/sdk"
}
```

npm links each package's folder rather than copying it, so the packages' own dependencies come from this workspace, and `sorlo dev` serves the admin from its source through Vite, as it does here.

## How it fits together

- **The server,** in `packages/cms/src`, is a [Hono](https://hono.dev) app on Node, over Postgres through [Kysely](https://kysely.dev). `app.ts` puts the routes together, `db.ts` describes the tables, `migrations/` creates them, and `cli.ts` is the `sorlo` command.
- **Content types** are JSON files in a site's `schema/types`. The server checks entries with the same Sorlo Forms inputs that render them in the admin.
- **The admin,** in `packages/cms/admin`, is a React app that Vite builds into `admin/dist`, which the server serves at `/admin/`. Every form in it, sign-in included, is built with Sorlo Forms.
- **The SDK,** in `packages/sdk`, is the typed client for the delivery API, and `sorlo types pull`. It runs in sites' frontends, so it never imports server code.
- **Sorlo Forms stands alone.** Keep CMS concepts out of it. When the CMS needs something from it, add a general hook there for the CMS to implement.

## Working on Sorlo Forms at the same time

Sorlo Forms is linked from `../core` with a `file:` dependency, and its package points at `dist/`, as the SDK's and the CMS's do. Keep its build running while you change it:

```bash
cd ../core
npx tsup --watch
```

The admin's Vite config dedupes `react`, `react-dom`, `react-i18next` and `i18next`, so the linked Sorlo Forms uses the admin's copies instead of bringing its own.

## Checks

`npm test` runs against the `sorlo_test` database, so start Postgres first. It builds the SDK and the CMS's server code first, since the CLI's tests run the built `sorlo` command and the SDK's tests import the built SDK, and like the CLI it needs Node 22.18 or later. It also typechecks the `*.test-d.ts` files, which show the SDK rejecting wrong field names and values. There's also `npm run typecheck` for every package, and `npm run format` (or `format:fix`).

## Pull requests

- Run `npm run format`, `npm run typecheck` and `npm test` first.
- Open an issue before changing what the APIs accept or return, since sites and the SDK depend on their shape.
- Keep each pull request to one change, with tests for what it adds or fixes.
