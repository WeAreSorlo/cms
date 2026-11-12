import { defineConfig } from 'tsup'

export default defineConfig({
  // validation is the field without its component or Markdown parser, for servers
  entry: ['src/index.ts', 'src/validation.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
})
