#!/usr/bin/env node

// The site runs its sorlo.config.ts with Node's type stripping, as the CMS's own sorlo command checks
if (!process.features.typescript) {
  console.error(`Sorlo needs Node 22.18 or later, which runs sorlo.config.ts itself. This is Node ${process.version}.`)
  process.exit(1)
}
await import('../dist/cli.js')
