#!/usr/bin/env node
import { register } from 'tsx/esm/api'

// shortcut: runs the SDK from its TypeScript source, build it to JavaScript before publishing to npm
register()
await import('../src/cli.ts')
