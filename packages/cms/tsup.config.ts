import { defineConfig } from 'tsup'

export default defineConfig({
  // The CMS's own migrations stay files of their own, in dist/migrations, where migrationsDir looks for them
  entry: ['src/index.ts', 'src/cli.ts', 'src/migrations/*.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  // A site's own Prettier, imported only where it's installed
  external: ['prettier'],
})
