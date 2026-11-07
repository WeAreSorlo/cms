#!/usr/bin/env node

// @sorlo/sdk installs a sorlo command too. A project with both packages gets this one, so it runs the SDK's.
if (process.argv[2] === 'types') await import('@sorlo/sdk/cli')
else {
  // Node runs the site project's sorlo.config.ts and migrations itself, by stripping their types
  if (!process.features.typescript) {
    console.error(
      `Sorlo needs Node 22.18 or later, which runs sorlo.config.ts itself. This is Node ${process.version}.`,
    )
    process.exit(1)
  }
  // Stack traces name the lines of the CMS's TypeScript source, which its source maps carry
  process.setSourceMapsEnabled(true)
  await import('../dist/cli.js')
}
