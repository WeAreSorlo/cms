# @sorlo/cms

Sorlo is an open-source, schema-driven CMS. This package is all of it but the frontend's client: a [Hono](https://hono.dev) server over Postgres with the delivery and admin APIs, the admin, and the `sorlo` command. Content types are JSON files in your project, and the server checks entries with the same [Sorlo Forms](https://github.com/WeAreSorlo/forms) inputs that render them in the admin. Drafts, versions, media, forms, automations, an MCP server and an AI assistant come with it.

The quickest start is the [starter](https://github.com/WeAreSorlo/starter), a template repository with a site project, a Next.js site that reads it, and sample content.

## Installing

It needs Node 22.18 or later, which runs a site's TypeScript itself, and Postgres.

```bash
npm install @sorlo/cms flydrive
```

[FlyDrive](https://flydrive.dev) keeps the media files, on the local disk or in a bucket.

## A site

A site is a project with a `sorlo.config.ts`:

```ts
import { defineConfig } from '@sorlo/cms'
import { FSDriver } from 'flydrive/drivers/fs'

export default defineConfig({
  database: { url: process.env.DATABASE_URL! },
  // The admin's public address, which emailed links and file URLs start from
  url: process.env.APP_URL,
  storage: {
    default: 'local',
    services: {
      local: () => new FSDriver({ location: new URL('./storage/', import.meta.url), visibility: 'public' }),
    },
  },
})
```

With `DATABASE_URL` in the project's `.env`:

```bash
npx sorlo dev        # migrates, then the admin is at http://localhost:4100/admin/
```

`sorlo dev` prints a link for making the first account.

In `sorlo dev`, the admin's Content types page writes each type's file in `schema/types`, such as `schema/types/posts.json`, with the content migration for each change. A frontend reads the content through [`@sorlo/sdk`](https://www.npmjs.com/package/@sorlo/sdk), typed from the CMS's types.

## Docs

- [Starting a site](https://github.com/WeAreSorlo/cms/blob/main/docs/starting-a-site.md) and [deploying it](https://github.com/WeAreSorlo/cms/blob/main/docs/deploying.md)
- [The `sorlo` command](https://github.com/WeAreSorlo/cms/blob/main/docs/cli.md)
- [Content types](https://github.com/WeAreSorlo/cms/blob/main/docs/content-types.md) and [content migrations](https://github.com/WeAreSorlo/cms/blob/main/docs/content-migrations.md)
- [Every page](https://github.com/WeAreSorlo/cms/blob/main/docs/README.md)

The same pages come with the package, in `node_modules/@sorlo/cms/docs/`, matching the version installed. `sorlo dev` points coding agents at them in the project's `AGENTS.md`.

## License

MIT
