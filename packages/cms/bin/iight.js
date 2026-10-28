#!/usr/bin/env node
import { register } from 'tsx/esm/api'

// tsx also loads the site project's iight.config.ts.
// shortcut: runs the CMS from its TypeScript source, build it to JavaScript before publishing to npm
register()
await import('../src/cli.ts')
