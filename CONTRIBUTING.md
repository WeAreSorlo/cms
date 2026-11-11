# Contributing to Sorlo

This repo holds the CMS, `@sorlo/cms`, and its SDK, `@sorlo/sdk`. The form library the CMS is built on, Sorlo Forms (`@sorlo/forms`), has its own repo at [WeAreSorlo/forms](https://github.com/WeAreSorlo/forms).

## Layout

| Folder             | What it is                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| `packages/cms`     | `@sorlo/cms`: the Hono server (`src/`), the admin UI (`admin/`) and the `sorlo` CLI |
| `packages/sdk`     | `@sorlo/sdk`: the typed client for the delivery API, and `sorlo types pull`         |
| `examples/sandbox` | A minimal site project for working on the CMS, which `npm run dev` and the docs use |

## Getting started

You need Node 22.18 or later, which runs a site's TypeScript itself, and Docker. Node 24 is what the site image uses. Clone [Sorlo Forms](https://github.com/WeAreSorlo/forms) beside this repo first, as `../core`, and build it, since the CMS links it from there until it's on npm, and its `dist` isn't in git:

```bash
git clone https://github.com/WeAreSorlo/forms.git ../core
(cd ../core && npm install && npm run build)
```

Then, in this repo:

```bash
npm install
npm run build       # the SDK and the CMS into their dist folders, and the admin into admin/dist
npm run db          # Postgres 17 on localhost:5432
npm run dev         # builds the server code again, then runs sorlo dev: the admin is at http://localhost:4100/admin/
```

`sorlo dev` runs the migrations as it starts, then prints a link for making the first account, as [People](docs/people.md#the-first-account) describes. Then, in another terminal, make a key for the delivery API that can pull types:

```bash
cd examples/sandbox
npx sorlo make:api-key --types
```

`npm run db` also creates a `sorlo_test` database for the tests and `sorlo_sandbox` for the sandbox, but only when it first creates the Postgres volume. On an older volume, add the sandbox's with `docker compose exec postgres createdb -U sorlo sorlo_sandbox`.

The packages point at their `dist` folders, as a site gets them, so the sandbox runs what's built. `npm run dev` in the workspace builds the SDK's and the CMS's server code first, with tsup, so restart it after changing either. The admin is the exception: in this workspace `sorlo dev` serves it from its source through Vite, which reloads it as you edit.

The sandbox's `sorlo.config.ts` sets [`previews`](docs/drafts-and-publishing.md#the-preview-button) for posts, so their editor has a Preview button, which opens a frontend on port 3000 that the sandbox doesn't have. `npx sorlo export` and `npx sorlo import` in `examples/sandbox` move its content to and from a folder, as [Exporting and importing](docs/export-and-import.md) describes.

In this workspace's `sorlo dev`, `/admin/#/design` shows the admin's design system: its tokens, their contrast in the current theme, and every Sorlo Forms input. Sites, whose admin is the built one, don't have the page.

### A site of your own

A site outside this workspace can run on its packages too. Link them with folder dependencies, build the server code before `sorlo dev`, and keep the `.npmrc` line from [Starting a site](docs/starting-a-site.md):

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
- **The docs,** in `docs/`, go in the CMS's package too: its build copies them to `packages/cms/docs`, where `sorlo dev`'s [notes for coding agents](docs/cli.md#notes-for-coding-agents) point a site's agents. So a link in them stays inside the folder or is a full URL, which `test/docs.test.ts` checks. The notes themselves are in `packages/cms/src/agents.ts`, and changing them changes `examples/sandbox/AGENTS.md` at the next `npm run dev`, so commit the two together.
- **Sorlo Forms stands alone.** Keep CMS concepts out of it. When the CMS needs something from it, add a general hook there for the CMS to implement.

## Working on Sorlo Forms at the same time

Sorlo Forms is linked from `../core` with a `file:` dependency, and its package points at `dist/`, as the SDK's and the CMS's do. Keep its build running while you change it:

```bash
cd ../core
npx tsup --watch
```

The admin's Vite config dedupes `react` and `react-dom`, so the linked Sorlo Forms uses the admin's copies instead of bringing its own.

## Checks

`npm test` runs against the `sorlo_test` database, so start Postgres first. It builds the SDK and the CMS's server code first, since the CLI's tests run the built `sorlo` command and the SDK's tests import the built SDK, and like the CLI it needs Node 22.18 or later. It also typechecks the `*.test-d.ts` files, which show the SDK rejecting wrong field names and values. There's also `npm run typecheck` for every package, and `npm run format` (or `format:fix`).

CI, in `.github/workflows/ci.yml`, runs the format check, the typecheck, the build and the tests on Node 24, against a Postgres 17 service, for every push to `main` and every pull request. It checks out Sorlo Forms beside the repo, as `core`, and builds it. While WeAreSorlo/forms is private, it reads it with a deploy key: a read-only one in that repo's settings under Deploy keys, whose private half is this repo's Actions secret `FORMS_DEPLOY_KEY`. Once it's public, the secret can go.

## Pull requests

- Run `npm run format`, `npm run typecheck` and `npm test` first.
- Open an issue before changing what the APIs accept or return, since sites and the SDK depend on their shape.
- Keep each pull request to one change, with tests for what it adds or fixes, and a changeset if sites will notice it.

## Changesets

A change that sites will notice comes with a changeset, which sets the next version and writes the changelog. Run `npx changeset`, choose patch, minor or major, and describe the change for the changelog. It writes a file in `.changeset/` to commit with the change. Changes to tests, docs or CI need none.

The CMS and the SDK share one version, since the CMS writes the types the SDK reads, so a changeset for either releases both.

## Releasing

The release workflow, `.github/workflows/release.yml`, runs from the Actions tab, with Run workflow, until the packages are on npm, and on every push to `main` from then on:

- While changesets are waiting, it opens or updates a "Version Packages" pull request, which bumps both versions, writes each package's `CHANGELOG.md` and deletes the changesets.
- Once that pull request is merged, it runs the tests, packs the tarballs and publishes them to npm, with provenance, then tags them, such as `@sorlo/cms@0.2.0`, and makes GitHub releases.

It publishes through npm's trusted publishing, so no npm token is stored anywhere. Only the publish job can get a short-lived one, and the job before it, with no publish rights, runs the tests and packs the tarballs. To version without the pull request, run `npm run version-packages`, then commit and push.

GitHub doesn't start workflows for pull requests made with its own token, so CI doesn't run on the "Version Packages" pull request. It only changes the versions, the changelogs and the lockfile.

### The first publish

npm sets up trusted publishing only for a package that already exists, so the first version of each is published by hand, once:

1. Make the repository public, since provenance needs a public repository. Then, in its settings, turn on private vulnerability reporting and Dependabot alerts under Advanced Security, and "Allow GitHub Actions to create and approve pull requests" under Actions → General.
2. Publish Sorlo Forms first, as its own CONTRIBUTING.md says. Then point the CMS at it on npm: in `packages/cms/package.json`, `@sorlo/forms` becomes `^0.1.0` in place of `file:../../../core`, and `@sorlo/sdk` becomes `^0.1.0` in place of `*`, which a published package can't keep. Run `npm install`, and add `push: branches: [main]` to the release workflow's `on`.
3. Publish from a clean checkout of `main`, with `npm login`, the SDK before the CMS, which depends on it: `npm publish --workspace @sorlo/sdk --provenance=false`, then `npm publish --workspace @sorlo/cms --provenance=false`. `publishConfig` asks for provenance, which npm can make only in CI, and the flag overrides it this once. To tag them as the workflow tags later releases, run `npx changeset git-tag` and `git push --tags`.
4. Add each package's trusted publisher on npmjs.com, in the package's settings under Trusted Publisher: GitHub Actions, organization `WeAreSorlo`, repository `cms`, workflow `release.yml`, no environment, with `npm publish` allowed, since Changesets can't use staged publishing yet. `npm trust github @sorlo/sdk --file release.yml --repo WeAreSorlo/cms --allow-publish`, and the same for `@sorlo/cms`, does it from the command line. npm expires the setup unless its first publish comes within 2 days, so add it when a release is ready to merge.
5. Once a release has gone out through the workflow, choose "Require two-factor authentication and disallow tokens" under each package's Publishing access.
