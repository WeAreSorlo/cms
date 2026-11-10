# Starting a site

Nothing is on npm yet, so a site installs three packed tarballs from its own repo: `@sorlo/forms`, `@sorlo/cms` and `@sorlo/sdk`. They're the files `npm publish` will upload, and any host or Docker build installs them with no token or registry.

1. Pack them into the new site's `vendor/` folder, in a clone of [Sorlo Forms](https://github.com/WeAreSorlo/forms) and then in one of this repo. Each package's `prepack` builds it first, and `npm pack` needs the folder to exist.

   ```bash
   mkdir -p ~/Sites/example/vendor
   npm pack --pack-destination ~/Sites/example/vendor
   ```

   ```bash
   npm pack --workspace @sorlo/sdk --workspace @sorlo/cms --pack-destination ~/Sites/example/vendor
   ```

2. Give the site a `package.json` that installs them, with `overrides` pointing the CMS at the site's own Sorlo Forms and SDK. `$@sorlo/forms` means the version the site itself depends on.

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
       "@sorlo/cms": "file:vendor/sorlo-cms-0.1.0.tgz",
       "@sorlo/sdk": "file:vendor/sorlo-sdk-0.1.0.tgz",
       "@sorlo/forms": "file:vendor/sorlo-forms-0.1.0.tgz",
       "flydrive": "^2.2.0"
     },
     "overrides": {
       "@sorlo/forms": "$@sorlo/forms",
       "@sorlo/sdk": "$@sorlo/sdk"
     },
     "devDependencies": {
       "@types/node": "^24.0.0",
       "typescript": "^5.9.3"
     }
   }
   ```

3. Add an `.npmrc`, so a lookup of a `@sorlo` package that slips through goes to an address that doesn't exist and fails, rather than to npm:

   ```
   @sorlo:registry=https://registry.invalid/
   ```

4. Add a `sorlo.config.ts` like [the starter's](../examples/starter/sorlo.config.ts), with `url: process.env.APP_URL`, a `.env` with `DATABASE_URL`, and a `.gitignore` with `node_modules`, `.env*`, `*.env` and `storage`, but never `vendor`. With no fallback for `url`, a deploy that forgets `APP_URL` gets `sorlo start`'s warning and file URLs on the address requests come to, rather than file URLs that all say `localhost`. This `tsconfig.json` makes `tsc` flag what Node can't run:

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

5. Then:

   ```bash
   npm install
   npm run dev          # migrates, then the admin is at http://localhost:4100/admin/
   ```

   `sorlo dev` runs the migrations as it starts, then prints a link for making the first account, as [People](people.md#the-first-account) describes. Open it, and choose your name, email and password.

`schema/types` and `migrations` can start missing. Commit `vendor/`, `package.json` and `package-lock.json`.

- **Node runs the site's TypeScript,** `sorlo.config.ts` and `migrations/*.ts`, by stripping its types. So types come in with `import type`, as in the migrations `make:migration` writes, relative imports name the file, as in `./mail.ts`, and enums and namespaces can't be used. The `tsconfig.json` above flags each.
- **To update the CMS,** pack new versions into `vendor/`, delete the old tarballs, change the three version numbers in `package.json`, run `npm install`, and commit the three together. A tarball packed again with new contents under the same version fails `npm ci`'s integrity check, so every pack takes a new version.
- **Scripts and deploys run the local command,** as `npm run migrate` or `node_modules/.bin/sorlo migrate`, rather than `npx sorlo migrate`. Where a project has no `sorlo` installed, `npx` looks the name up on npm, and outside a terminal it installs and runs what it finds without asking.
- **npm's audit** sends each package's name and version to npm's audit service on every `npm install`, the tarballs' included. That publishes nothing, and the image's build passes `--no-audit`.

Next, [content types](content-types.md) describe the site's content, and [Deploying](deploying.md) takes it live.
