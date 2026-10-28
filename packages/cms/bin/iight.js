#!/usr/bin/env node
import { register } from 'tsx/esm/api'

// tsx also loads the site project's iight.config.ts.
// shortcut: runs the CMS from its TypeScript source, build it to JavaScript before publishing to npm
register()
// @iight/sdk installs an iight command too. A project with both packages gets this one, so it runs the SDK's.
await import(process.argv[2] === 'types' ? '@iight/sdk/cli' : '../src/cli.ts')
