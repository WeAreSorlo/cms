# The Sorlo CLI

Run `sorlo` from a site project: `npx sorlo dev` in a terminal while you work on the site, and `node_modules/.bin/sorlo` in scripts and deploys, as [Starting a site](starting-a-site.md) explains. It reads `sorlo.config.ts`, and before that the project's `.env` if there is one, for settings such as `DATABASE_URL` or `ANTHROPIC_API_KEY`. A variable the environment already sets keeps its value. Keep `.env` out of git, as the workspace's `.gitignore` does.

| Command                       | What it does                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sorlo dev`                   | Serves the API and the admin on one port, `PORT` or 3000, on 127.0.0.1 unless `HOST` names another address, and runs automations                                                   |
| `sorlo start`                 | Serves the API and the built admin for production on `PORT` or 3000, and runs automations. Types are read-only                                                                     |
| `sorlo migrate`               | Runs pending migrations as one batch: the CMS's own, then the site project's content migrations. It refuses a waiting one with a TODO left, running nothing                        |
| `sorlo migrate --check`       | Lists the saved entries whose drafts no longer pass what a save checks, or whose live copies no longer pass what a publish checks, and fails if there are any. It migrates nothing |
| `sorlo migrate:rollback`      | Rolls back the last batch, content migrations first                                                                                                                                |
| `sorlo migrate:status`        | Lists the migrations of both kinds, and the batch each ran in                                                                                                                      |
| `sorlo make:migration [name]` | Writes a content migration for the changes to `schema/types`, named after the types it changes unless you give a name                                                              |
| `sorlo make:user`             | Creates an admin user                                                                                                                                                              |
| `sorlo user:password <email>` | Sets someone's password, asked for hidden, and signs them out everywhere, for a site whose only person forgot theirs and that sends no email                                       |
| `sorlo make:api-key`          | Creates a key for the delivery API, shown just once. `--preview`, `--types` and `--submit` give it those [permissions](api.md#api-keys)                                            |

Every command but `sorlo types` stops on a Node older than 22.18, which can't run `sorlo.config.ts`. `sorlo start` warns when [`url`](people.md) isn't set.

## Where the servers listen

`sorlo dev` listens on 127.0.0.1 alone, so only this machine reaches it, unless `HOST` names another address, such as `HOST=0.0.0.0 npx sorlo dev` for a phone on the same network or a container's port. An empty `HOST`, as a `.env` can leave it, counts as none. `sorlo start` listens on every interface unless `HOST` names one, such as `HOST=127.0.0.1` behind a proxy on the same machine, so a container needs no `HOST`. Both send every reply under `/admin/` with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so no other site can frame the admin and lay its own page over its buttons.

`sorlo start` serves the admin from `packages/cms/admin/dist`, which `npm run build` writes, so run that again after changing the admin. The package's `prepack` runs the build before `npm pack` and `npm publish`, so sites never build the admin, and a site's `sorlo dev` serves that built admin too, since only this workspace has its source.

## Logs and stopping

Both servers log a line as each request arrives and one as it's answered, such as `--> GET /v1/entries/blog?page=2 200 12ms`, but none for [`/health`](deploying.md), and errors go to stderr with stack traces that name the CMS's TypeScript source.

On SIGTERM, as a host stops a container, or SIGINT, as Ctrl-C does, they stop taking connections, let the automations worker finish the run it's on, such as a webhook waiting for its reply, end whatever is still open after 5 seconds, such as a chat's streaming reply, which then stops as it does when its person leaves, give what they cut a second to finish, such as that chat storing the reply it had written, close the database and exit 0. npm passes Ctrl-C on to the command it runs, which the terminal has sent it too, so a signal within a second of the first counts as the same one, and a later one exits at once.
