# Starting a site

A site is a project that installs `@sorlo/cms` from npm, which brings Sorlo Forms and the SDK with it. The quickest way to one is the [starter](https://github.com/WeAreSorlo/starter), a site project with a Next.js site that reads it and sample content, which `create-sorlo` makes for you:

```bash
npm create sorlo@latest
```

It asks for a folder, whether to run Postgres in Docker or use your own, and which AI provider [the assistant](assistant.md) uses, if any, whose package it installs and whose API key it asks for. Then it installs the site, sets up its database with the sample content, makes the site's API keys and, where git can commit, makes the folder a repository. Next:

```bash
cd my-site
npm run dev          # the CMS at http://localhost:4100 and the site at http://localhost:3000
```

`npm run dev` prints a link for making the first account, as [People](people.md#the-first-account) describes. `npm create sorlo@latest my-site -- --database-url <url>` asks nothing, and without a terminal, as in CI, the folder is `my-site`, Postgres runs in Docker and the assistant is off, as [create-sorlo's README](https://github.com/WeAreSorlo/cms/blob/main/packages/create-sorlo/README.md) describes. The starter's README, in the new folder, is the guide to the site.

The starter is a template repository too: choose Use this template on its page, then follow its README. To make a site from scratch instead:

1. Give the site a `package.json`:

   ```json
   {
     "name": "example",
     "private": true,
     "type": "module",
     "scripts": {
       "dev": "sorlo dev",
       "start": "sorlo start",
       "migrate": "sorlo migrate"
     },
     "dependencies": {
       "@sorlo/cms": "^0.1.0",
       "flydrive": "^2.2.0"
     },
     "devDependencies": {
       "@types/node": "^24.0.0",
       "typescript": "^5.9.3"
     }
   }
   ```

2. Add a `sorlo.config.ts` like [the sandbox's](https://github.com/WeAreSorlo/cms/blob/main/examples/sandbox/sorlo.config.ts), with `url: process.env.APP_URL`, a `.env` with `DATABASE_URL`, and a `.gitignore` with `node_modules`, `.env*`, `*.env` and `storage`. With no fallback for `url`, a deploy that forgets `APP_URL` gets `sorlo start`'s warning and file URLs on the address requests come to, rather than file URLs that all say `localhost`. This `tsconfig.json` makes `tsc` flag what Node can't run:

   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "strict": true,
       "noEmit": true,
       "skipLibCheck": true,
       "allowImportingTsExtensions": true,
       "erasableSyntaxOnly": true,
       "verbatimModuleSyntax": true,
       "types": ["node"]
     },
     "include": ["sorlo.config.ts", "migrations", "src"]
   }
   ```

3. Then:

   ```bash
   npm install
   npm run dev          # migrates, then the admin is at http://localhost:4100/admin/
   ```

   `sorlo dev` runs the migrations as it starts, then prints a link for making the first account, as [People](people.md#the-first-account) describes. Open it, and choose your name, email and password.

`schema/types` and `migrations` can start missing. Commit `package.json` and `package-lock.json`, and the `AGENTS.md` that `sorlo dev` writes, whose [notes](cli.md#notes-for-coding-agents) point coding agents at these docs.

- **Node runs the site's TypeScript,** `sorlo.config.ts` and `migrations/*.ts`, by stripping its types. So types come in with `import type`, as in the migrations `make:migration` writes, relative imports name the file, as in `./mail.ts`, and enums and namespaces can't be used. The `tsconfig.json` above flags each.
- **To update the CMS,** run `npm install @sorlo/cms@latest`, and commit `package.json` and `package-lock.json` together.
- **Scripts and deploys run the local command,** as `npm run migrate` or `node_modules/.bin/sorlo migrate`, rather than `npx sorlo migrate`. Where a project has no `sorlo` installed, `npx` looks the name up on npm, and outside a terminal it installs and runs what it finds without asking.

Next, [content types](content-types.md) describe the site's content, and [Deploying](deploying.md) takes it live.
