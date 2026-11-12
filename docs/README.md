# Sorlo docs

How to build a site on Sorlo, in the order you'll need it. To work on Sorlo itself, see [CONTRIBUTING.md](https://github.com/WeAreSorlo/cms/blob/main/CONTRIBUTING.md).

The same pages come with `@sorlo/cms`, in `node_modules/@sorlo/cms/docs/`, matching the version installed, and `sorlo dev` points a site's coding agents at them, as [Notes for coding agents](cli.md#notes-for-coding-agents) describes.

## Getting started

- [Starting a site](starting-a-site.md): `npm create sorlo@latest`, or a site project by hand, its config and its first account
- [The Sorlo CLI](cli.md): every `sorlo` command, the notes `sorlo dev` keeps for coding agents, where the servers listen, and how they stop
- [Deploying](deploying.md): the site's image, migrations on each deploy, what a host provides, and proxies
- [Exporting and importing](export-and-import.md): a site's content as a folder, such as a starter's sample content

## Modelling content

- [Content types](content-types.md): the type editor, the type's file, relationship, media and form fields, and shared groups
- [Content migrations](content-migrations.md): changing a type's entries with it, from the CLI or the admin

## Editing

- [Drafts and publishing](drafts-and-publishing.md): drafts, live copies, previews and the Preview button
- [Versions](versions.md): each entry's history, comparing and restoring
- [Bulk editing](bulk-editing.md): many entries in a grid, and archiving or restoring them together
- [Media](media.md): the media library, its storage and what it takes
- [Forms](forms.md): forms, their submissions and their spam
- [Automations](automations.md): emails and webhooks when content changes
- [People](people.md): the first account, inviting, removing and signing in

## Building a frontend

- [The SDK](sdk.md): the typed client for the delivery API
- [The API](api.md): API keys, the delivery API and its replies
- [The admin API](admin-api.md): the routes the admin calls

## AI

- [MCP](mcp.md): AI clients reading and changing content through tokens
- [The assistant](assistant.md): the admin's own chat, and the changes it proposes
