import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The test files share one database
    fileParallelism: false,
  },
})
