# The Sorlo CLI

Run `sorlo` from a site project: `npx sorlo dev` in a terminal while you work on the site, and `node_modules/.bin/sorlo` in scripts and deploys, as [Starting a site](starting-a-site.md) explains. It reads `sorlo.config.ts`, and before that the project's `.env` if there is one, for settings such as `DATABASE_URL` or `ANTHROPIC_API_KEY`. A variable the environment already sets keeps its value. Keep `.env` out of git, as the workspace's `.gitignore` does.

| Command                       | What it does                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sorlo dev`                   | Runs what `sorlo migrate` would, then serves the API and the admin on one port, `PORT` or 4100, on 127.0.0.1 unless `HOST` names another address, and runs automations             |
| `sorlo build`                 | Builds the admin with the site's [plugins](plugins.md) into `.sorlo/admin`, for `sorlo start`, as [The admin's build](#the-admins-build) describes                                 |
| `sorlo start`                 | Serves the API and the admin `sorlo build` wrote, for production, on `PORT` or 4100, and runs automations. Types are read-only                                                     |
| `sorlo migrate`               | Runs pending migrations as one batch: the CMS's own, then the site project's content migrations. It refuses a waiting one with a TODO left, running nothing                        |
| `sorlo migrate --check`       | Lists the saved entries whose drafts no longer pass what a save checks, or whose live copies no longer pass what a publish checks, and fails if there are any. It migrates nothing |
| `sorlo migrate:rollback`      | Rolls back the last batch, content migrations first                                                                                                                                |
| `sorlo migrate:status`        | Lists the migrations of both kinds, and the batch each ran in                                                                                                                      |
| `sorlo make:migration [name]` | Writes a content migration for the changes to `schema/types`, named after the types it changes unless you give a name                                                              |
| `sorlo make:user`             | Creates an admin user from the terminal, such as in a script. The first is usually made in the admin, as [People](people.md#the-first-account) describes                           |
| `sorlo export [folder]`       | Writes the site's content to a folder, `content` unless named, as [Exporting and importing](export-and-import.md) describes                                                        |
| `sorlo import [folder]`       | Loads an export, from `content` unless named, into a site with no content yet                                                                                                      |
| `sorlo user:password <email>` | Sets someone's password, asked for hidden, and signs them out everywhere, for a site whose only person forgot theirs and that sends no email                                       |
| `sorlo make:api-key`          | Creates a key for the delivery API, shown just once. `--preview`, `--types` and `--submit` give it those [permissions](api.md#api-keys)                                            |

Every command but `sorlo types` stops on a Node older than 22.18, which can't run `sorlo.config.ts`, and when a plugin's field type is taken, listing each, as [Plugins](plugins.md) describes. `sorlo start` warns when [`url`](people.md#settings) isn't set. It also sets `NODE_ENV` to `production`, unless the environment or `.env` sets it, as `next start` does, so a `sorlo.config.ts` that checks it gets its production settings wherever the server runs.

## Migrations as `sorlo dev` starts

`sorlo dev` runs what `sorlo migrate` would before it starts, printing the same lines, so a new clone, or a `git pull` that brings migrations, needs nothing else. When a waiting migration has a TODO left, it runs none of them, as `sorlo migrate` refuses to, says so, and starts anyway, so the admin's Migrations page shows what waits and runs it once the TODO is done. A database it can't reach gets a line rather than a stack trace. `sorlo start` doesn't migrate, since that's each deploy's release step, as [Deploying](deploying.md) has it.

## Notes for coding agents

Coding agents know nothing of Sorlo from their training, so `sorlo dev` keeps notes for them in the site project's `AGENTS.md`, which most agents read as they start, as `next dev` does for Next. The notes point them at these docs, which come with `@sorlo/cms` in `node_modules/@sorlo/cms/docs/`, matching the installed version, and at Sorlo Forms' README:

```md
<!-- BEGIN:sorlo-agent-rules -->

## Sorlo isn't in your training data

This project's CMS is Sorlo, `@sorlo/cms`, which is newer than your training data, so don't guess its APIs, file formats or commands. Before you change content types or shared groups in `schema/`, content migrations in `migrations/`, `sorlo.config.ts` or calls to `@sorlo/sdk`, read the pages that cover them in `node_modules/@sorlo/cms/docs/`, starting from its `README.md`, which lists them all. Fields and their options are Sorlo Forms inputs, which the README in `node_modules/@sorlo/forms/` describes. Both match the installed versions. Look for them from this file's folder upward, since in a workspace they can be in a parent folder's `node_modules`.

`sorlo dev` writes this block, and writes it again when it's missing or out of date, as `docs/cli.md` in `@sorlo/cms` explains. Taking it out of a diff only brings it back, so commit it with your work.

<!-- END:sorlo-agent-rules -->
```

- **`sorlo dev` writes them as it starts,** before it loads the types. It makes `AGENTS.md` if there's none, adds the notes at the end of one without them, after a blank line, and otherwise replaces only what's between their markers, leaving the rest of the file as it was. When they're current it writes nothing, and when it writes it prints a line. A start marker with no end after it gets a warning instead, and the file is left as it is, since only you can tell where the old notes stopped.
- **Commit `AGENTS.md`** with the rest of the project, so every clone has the notes. A new version of the CMS can change them, and `sorlo dev` then updates them.
- **To turn them off,** set `agentRules: false` in `sorlo.config.ts`. `sorlo dev` then leaves `AGENTS.md` alone, so delete the notes from it yourself.
- **Claude Code** reads `AGENTS.md` itself, but reads a `CLAUDE.md` instead when it finds one, in the folder it starts in or above it. So a project with a `CLAUDE.md` needs a line with `@AGENTS.md` in it, which `sorlo dev` says when it writes the notes. `sorlo dev` never writes `CLAUDE.md` itself, since one in a site project inside a workspace would stop Claude Code reading the workspace's own `AGENTS.md`.

`sorlo start` and the other commands never touch `AGENTS.md`.

## Where the servers listen

Both servers listen on port 4100 unless `PORT` names another, such as `PORT=4200` in the project's `.env`, which leaves 3000 to a site's frontend. A port that's in use stops a server with what to do, rather than a stack trace:

```
Port 4100 is in use, by another Sorlo server or something else. Stop it, or choose another port with PORT, such as PORT=4101.
```

`sorlo dev` listens on 127.0.0.1 alone, so only this machine reaches it, unless `HOST` names another address, such as `HOST=0.0.0.0 npx sorlo dev` for a phone on the same network or a container's port. An empty `HOST`, as a `.env` can leave it, counts as none. `sorlo start` listens on every interface unless `HOST` names one, such as `HOST=127.0.0.1` behind a proxy on the same machine, so a container needs no `HOST`. Both send every reply under `/admin/` with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so no other site can frame the admin and lay its own page over its buttons.

## The admin's build

`sorlo build` bundles the site's admin into `.sorlo/admin`, with Vite: the CMS's admin, which `@sorlo/cms` carries built, and each [plugin](plugins.md)'s components, sharing one React and one Sorlo Forms. It writes `.sorlo/.gitignore` too, holding `*`, so git leaves the folder alone and no site has to ignore it. It reads `sorlo.config.ts` but connects to nothing, so it runs without the database, as in an image's build.

`sorlo start` serves that folder, and stops with what to do when it can't:

```
The admin hasn't been built. Run npx sorlo build first.
The admin was built for another version of Sorlo or other plugins. Run npx sorlo build again.
```

The second comes from `.sorlo/admin/build.json`, which records the CMS's version and the plugins the admin was built with, and which the server never serves. A plugin package upgraded without a build isn't caught, so build on every deploy, as [Deploying](deploying.md)'s image does.

`sorlo dev` needs no build. It serves the same entry through Vite, so a plugin's components reload as they change, and keeps it in `.sorlo/build`, with Vite's cache in `.sorlo/vite`. Vite serves only the files in `.sorlo` and the CMS's admin, and what they import, so the project's `.env` and uploads stay out of reach.

## Logs and stopping

Both servers log a line as each request arrives and one as it's answered, such as `--> GET /v1/entries/blog?page=2 200 12ms`, but none for [`/health`](deploying.md), and errors go to stderr with stack traces that name the CMS's TypeScript source.

On SIGTERM, as a host stops a container, or SIGINT, as Ctrl-C does, they stop taking connections, let the automations worker finish the run it's on, such as a webhook waiting for its reply, end whatever is still open after 5 seconds, such as a chat's streaming reply, which then stops as it does when its person leaves, give what they cut a second to finish, such as that chat storing the reply it had written, close the database and exit 0. npm passes Ctrl-C on to the command it runs, which the terminal has sent it too, so a signal within a second of the first counts as the same one, and a later one exits at once.
