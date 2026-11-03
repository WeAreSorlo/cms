import { defineConfig } from 'tsup'

export default defineConfig({
  // The CMS's own migrations stay files of their own, in dist/migrations, where migrationsDir looks for them
  entry: ['src/index.ts', 'src/cli.ts', 'src/migrations/*.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  // Imported only where they're installed: Vite by iight dev in this workspace, and a site's own Prettier
  external: ['vite', 'prettier'],
})
