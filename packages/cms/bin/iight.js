#!/usr/bin/env node

// @iight/sdk installs an iight command too. A project with both packages gets this one, so it runs the SDK's.
if (process.argv[2] === 'types') await import('@iight/sdk/cli')
else {
  // Node runs the site project's iight.config.ts and migrations itself, by stripping their types
  if (!process.features.typescript) {
    console.error(
      `iight needs Node 22.18 or later, which runs iight.config.ts itself. This is Node ${process.version}.`,
    )
    process.exit(1)
  }
  // Stack traces name the lines of the CMS's TypeScript source, which its source maps carry
  process.setSourceMapsEnabled(true)
  await import('../dist/cli.js')
}
