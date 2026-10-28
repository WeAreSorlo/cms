# iight CMS

An open-source, schema-driven CMS built on iight core. `PLAN.md` holds the architecture, the decisions so far and the build order.

## Layout

| Folder         | What it is                                                                          |
| -------------- | ----------------------------------------------------------------------------------- |
| `packages/cms` | `@iight/cms`: the Hono server (`src/`), the admin UI (`admin/`) and the `iight` CLI |
| `playground`   | A site project for development, with its `iight.config.ts`                          |

## Getting started

You need Node 22.12 or later, and Docker.

```bash
npm install
npm run db          # Postgres 17 on localhost:5432
cd playground
npx iight migrate
npx iight make:user
npm run dev         # the admin is at http://localhost:3000/admin/
```

`npm run db` also creates an `iight_test` database for the tests, but only when it first creates the Postgres volume.

## The iight CLI

Run it from a site project, where it reads `iight.config.ts`.

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `iight dev`              | Serves the API and the admin on one port, `PORT` or 3000 |
| `iight migrate`          | Runs pending migrations as one batch                     |
| `iight migrate:rollback` | Rolls back the last batch                                |
| `iight migrate:status`   | Lists each migration and the batch it ran in             |
| `iight make:user`        | Creates an admin user                                    |

## The API so far

| Route                 | What it does                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/session`   | Signs in with `{ email, password }`. Replies `{ data: user }` and sets the `iight_session` cookie, or 422 with core's validation report |
| `GET /api/session`    | Replies `{ data: user }` for the signed-in user, or 401                                                                                 |
| `DELETE /api/session` | Signs out                                                                                                                               |

Row IDs are UUIDv7s. A failed validation replies 422 with core's report, and every other error replies `{ message }`, as Laravel does.

## Working on core at the same time

Core is linked from `../core` with a `file:` dependency, and its package points at `dist/`. Keep its build running while you change it:

```bash
cd ../core
npx tsup --watch
```

The admin's Vite config dedupes `react`, `react-dom`, `react-i18next` and `i18next`, so the linked core uses the admin's copies instead of bringing its own.

## Checks

`npm test` runs against the `iight_test` database, so start Postgres first. There's also `npm run typecheck`, and `npm run format` (or `format:fix`).
