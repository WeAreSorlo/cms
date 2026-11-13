import { defineConfig } from 'tsup'

export default defineConfig({
  // validation and plugin are the fields without their components or Lexical, for servers
  entry: ['src/index.tsx', 'src/validation.ts', 'src/plugin.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
})
