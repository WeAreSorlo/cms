import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The test files share one database
    fileParallelism: false,
    // Also typechecks the *.test-d.ts files, the SDK's compile-time tests
    typecheck: { enabled: true },
  },
})
