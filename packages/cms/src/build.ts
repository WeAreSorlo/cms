import type { Plugin } from '.'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { InlineConfig, Plugin as VitePlugin } from 'vite'

// The site's admin: sorlo build bundles an entry that mounts the CMS's admin with each plugin's fields into
// .sorlo/admin, which sorlo start serves, and sorlo dev serves the same entry through Vite

// The CMS's package, from dist or src alike
const cms = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(cms, 'package.json'), 'utf8'))

// @sorlo/cms/admin as the package has it, built as a library, and its source, which only the CMS's own workspace has
const library = join(cms, 'admin/dist/index.js')
const source = join(cms, 'admin/main.tsx')

// What build.json records, which sorlo start compares with sorlo.config.ts
const stampOf = (plugins: Array<Plugin>) => ({
  cms: version,
  plugins: plugins.map(({ name, admin, fields }) => ({ name, admin, fields: Object.keys(fields) })),
})

const page = `<!doctype html>
<html lang="en" class="sorlo-theme-admin">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sorlo</title>
    <script>
      // The theme switch's choice of light or dark, set before the first paint. Without one, the OS decides
      try {
        const theme = localStorage.getItem('sorlo-theme')
        if (theme) document.documentElement.dataset.theme = theme
      } catch {}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./entry.js"></script>
  </body>
</html>
`

// Writes .sorlo/build: the admin's page, and an entry that imports each plugin's fields from its admin module by
// their types, so a module without one fails the build, and mounts the admin with them
function writeEntry(site: string, plugins: Array<Plugin>) {
  const dir = join(site, '.sorlo/build')
  mkdirSync(dir, { recursive: true })
  // So no site has to ignore the folder
  writeFileSync(join(site, '.sorlo/.gitignore'), '*\n')
  writeFileSync(join(dir, 'index.html'), page)

  const inputs: Array<string> = []
  const imports = plugins.map(({ admin, fields }) => {
    // A path from sorlo.config.ts, or else a package
    const local = /^\.\.?\//.test(admin) || isAbsolute(admin)
    const from = local ? relative(dir, resolve(site, admin)).replaceAll('\\', '/') : admin
    const names = Object.keys(fields).map((type) => {
      const name = `field${inputs.length}`
      inputs.push(`${JSON.stringify(type)}: ${name}`)
      return `${JSON.stringify(type)} as ${name}`
    })
    return `import { ${names.join(', ')} } from ${JSON.stringify(from)}`
  })
  const lines = ["import { mount } from '@sorlo/cms/admin'", ...imports, `mount({ inputs: { ${inputs.join(', ')} } })`]
  const entry = join(dir, 'entry.js')
  writeFileSync(entry, `${lines.join('\n')}\n`)
  return entry
}

// The admin and every plugin share one React and one Sorlo Forms, the CMS's own, even where a plugin's package or a
// linked folder has a copy of its own
const shared: VitePlugin = {
  name: 'sorlo:shared',
  enforce: 'pre',
  resolveId(id, _importer, options) {
    if (/^(react|react-dom|@sorlo\/forms)(\/|$)/.test(id)) {
      return this.resolve(id, join(cms, 'package.json'), { ...options, skipSelf: true })
    }
  },
}

async function viteConfig(site: string, dev: boolean): Promise<InlineConfig> {
  const { default: react } = await import('@vitejs/plugin-react')
  const dir = join(site, '.sorlo')
  return {
    configFile: false,
    root: join(dir, 'build'),
    base: '/admin/',
    cacheDir: join(dir, 'vite'),
    plugins: [react(), shared],
    // The running CMS's admin, and in this workspace's sorlo dev its source, so it reloads as it changes
    resolve: { alias: { '@sorlo/cms/admin': dev && existsSync(source) ? source : library } },
    // Vite serves the files in these folders at /admin/@fs/ to anyone, and by default that's the site project, with its
    // .env and uploads. What the entry imports from elsewhere, such as a plugin's module, is still served.
    server: { fs: { allow: [dir, join(cms, 'admin')] } },
  }
}

// Builds the site's admin into .sorlo/admin, with a build.json saying what it was built with
export async function buildAdmin(site: string, plugins: Array<Plugin>) {
  if (!existsSync(library)) throw new Error("The CMS's admin hasn't been built. Run npm run build in @sorlo/cms first.")
  writeEntry(site, plugins)
  const out = join(site, '.sorlo/admin')
  const { build } = await import('vite')
  await build({
    ...(await viteConfig(site, false)),
    logLevel: 'warn',
    // The admin's own chunks are the CMS's to split, so a site isn't warned about them
    build: { outDir: out, emptyOutDir: true, chunkSizeWarningLimit: Infinity },
  })
  writeFileSync(join(out, 'build.json'), `${JSON.stringify(stampOf(plugins), null, 2)}\n`)
}

// The folder of the admin sorlo build wrote, or what's wrong with it: missing, or built for another version of the
// CMS or other plugins. A plugin package upgraded since isn't caught, which deploys avoid by building each time.
export function builtAdmin(site: string, plugins: Array<Plugin>): { dir: string } | { problem: string } {
  const dir = join(site, '.sorlo/admin')
  let built: unknown
  try {
    built = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
  } catch {
    return { problem: "The admin hasn't been built. Run npx sorlo build first." }
  }
  if (!isDeepStrictEqual(built, stampOf(plugins))) {
    return { problem: 'The admin was built for another version of Sorlo or other plugins. Run npx sorlo build again.' }
  }
  return { dir }
}

// Serves the site's admin from its entry through Vite, for sorlo dev, so the admin reloads as plugins change. Vite
// finds Sass only from its root, so the root is the CMS's admin, whose source this workspace's Sass compiles, and the
// page, with the site's entry from .sorlo/build, is served here.
export async function adminServer(site: string, plugins: Array<Plugin>, server: Server) {
  const entry = writeEntry(site, plugins)
  const config = await viteConfig(site, true)
  const { createServer } = await import('vite')
  const vite = await createServer({
    ...config,
    root: join(cms, 'admin'),
    appType: 'custom',
    optimizeDeps: { entries: [entry] },
    server: { ...config.server, middlewareMode: true, hmr: { server } },
  })
  const html = page.replace('./entry.js', `/@fs/${entry.replace(/^\//, '').replaceAll('\\', '/')}`)
  return {
    close: () => vite.close(),
    middlewares: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.split('?')[0] !== '/admin/') return vite.middlewares(req, res)
      try {
        const transformed = await vite.transformIndexHtml(req.url, html)
        res.setHeader('Content-Type', 'text/html')
        res.end(transformed)
      } catch (error) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
