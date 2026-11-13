# create-sorlo

Makes a new [Sorlo](https://github.com/WeAreSorlo/cms) site from the [starter](https://github.com/WeAreSorlo/starter): a Sorlo site project, a Next.js site that reads it, and sample content that uses each of Sorlo's features.

```bash
npm create sorlo@latest
```

It needs Node 22.18 or later, and Postgres, which Docker can run for you. It asks for three things:

- **The folder,** which has to be empty or not there yet.
- **The Postgres to use:** Postgres in Docker, which the site's `npm run db` starts, or your own, whose `DATABASE_URL` goes in `cms/.env`.
- **The AI provider of the admin's assistant,** none unless you choose Anthropic or OpenAI. Choosing one installs its package, passes it as `ai` in `cms/sorlo.config.ts` and asks for its API key, without showing it as you type, which goes in `cms/.env`. Left empty, the provider reads its key from the environment. Another provider, or your own, goes in by hand, as the CMS's [docs on the assistant](https://github.com/WeAreSorlo/cms/blob/main/docs/assistant.md#writing-a-provider) say.

Then it downloads the starter's `main` from GitHub, runs `npm install`, starts Postgres if it's Docker's, and runs `npm run setup`, which creates the database, runs the migrations, imports the sample content and makes the site's API keys. Where git is installed and has your name and email, the folder becomes a repository with a first commit. Then:

```bash
cd my-site
npm run dev
```

`npm run dev` prints a link for making the first account, and serves the CMS at http://localhost:4100 and the site at http://localhost:3000. The starter's README, in the new folder, is the guide to the rest.

## Without the questions

Give the folder, and your own Postgres with `--database-url`, after a `--` so that npm passes it on:

```bash
npm create sorlo@latest my-site -- --database-url postgres://user:password@localhost:5432/my_site
```

Without a terminal to ask in, as in CI, it asks nothing: the folder is `my-site`, Postgres runs in Docker, unless you give them, and the assistant is off.

To try a change to the starter, `CREATE_SORLO_TARBALL` names a tarball to use instead of the download, one folder holding the starter as GitHub's tarballs do, such as `git archive --format=tar.gz --prefix=starter/ -o starter.tar.gz HEAD` makes in a clone.

## Docs

- [Starting a site](https://github.com/WeAreSorlo/cms/blob/main/docs/starting-a-site.md), including a site made by hand
- [The starter's README](https://github.com/WeAreSorlo/starter#readme)
- [Every page of the docs](https://github.com/WeAreSorlo/cms/blob/main/docs/README.md)

## License

MIT
