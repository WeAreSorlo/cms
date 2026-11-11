# Sorlo

An open-source, schema-driven CMS, built on [Sorlo Forms](https://github.com/WeAreSorlo/forms) (`@sorlo/forms`).

Content types are JSON files in your site's repo, which the admin's type editor writes along with the content migration for each change. Every form in the admin is a Sorlo Forms form, so the server checks each entry with the same inputs that render it. A frontend reads the content through a typed SDK, whose types come from the CMS.

## What it does

- **Content types in code,** made in the [type editor](docs/content-types.md) and committed with their [content migrations](docs/content-migrations.md), with relationship, media and form fields, and groups of fields that types share.
- **[Drafts and publishing](docs/drafts-and-publishing.md),** with previews of drafts on the site, and every save kept as a [version](docs/versions.md) to compare and restore.
- **[Bulk editing](docs/bulk-editing.md)** in a grid, a hundred entries at a time.
- **A [media library](docs/media.md),** on the local disk or in a bucket.
- **[Forms](docs/forms.md)** that marketers make in production, with an inbox, a honeypot and a rate limit.
- **[Automations](docs/automations.md),** which send emails and call signed webhooks when content changes.
- **[People](docs/people.md),** invited with one-time links, with password resets.
- **A [delivery API](docs/api.md) and a typed [SDK](docs/sdk.md),** whose pulled types check every query.
- **An [MCP server](docs/mcp.md)** for AI clients such as Claude Code, Cursor and VS Code, and an [assistant](docs/assistant.md) in the admin, which proposes changes for a person to apply.

## Quick start

Nothing is on npm yet, so try Sorlo with the sandbox site in this repo. It needs Node 22.18 or later and Docker, and links Sorlo Forms from a clone beside it, which it builds first:

```bash
git clone https://github.com/WeAreSorlo/forms.git core
git clone https://github.com/WeAreSorlo/cms.git cms
cd core && npm install && npm run build && cd ../cms
npm install
npm run build
npm run db               # Postgres 17 on localhost:5432
npm run dev              # migrates, then the admin is at http://localhost:4100/admin/
```

`npm run dev` prints a link for making the first account. Open it, and choose your name, email and password.

For a site of your own, [Starting a site](docs/starting-a-site.md) installs the packages from packed tarballs, and [Deploying](docs/deploying.md) takes it live.

## The packages

| Package                                               | What it is                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@sorlo/cms`](packages/cms)                          | The server, the admin and the `sorlo` command                                      |
| [`@sorlo/sdk`](packages/sdk)                          | The typed client for the delivery API, and `sorlo types pull`                      |
| [`@sorlo/forms`](https://github.com/WeAreSorlo/forms) | The React form library that every form in the admin is built with, in its own repo |

## Links

- [The docs](docs/README.md), a page for each part of the CMS
- [Contributing](CONTRIBUTING.md): the workspace, the checks and releases
- [Security](SECURITY.md): reporting a vulnerability
- [MIT license](LICENSE)
