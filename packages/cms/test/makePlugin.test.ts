import { withPlugin } from '../src/makePlugin'
import { expect, test } from 'vitest'

const add = (source: string) => withPlugin(source, 'badge', 'sorlo-field-badge')

test('make:plugin imports the plugin after the imports, and starts plugins in the config object', () => {
  expect(
    add(
      [
        '// The site',
        "import { defineConfig } from '@sorlo/cms'",
        'import {',
        '  FSDriver,',
        "} from 'flydrive/drivers/fs'",
        '',
        'export default defineConfig({',
        "  database: { url: 'postgres://localhost/site' },",
        '})',
        '',
      ].join('\n'),
    ),
  ).toBe(
    [
      '// The site',
      "import { defineConfig } from '@sorlo/cms'",
      'import {',
      '  FSDriver,',
      "} from 'flydrive/drivers/fs'",
      "import { badge } from 'sorlo-field-badge/plugin'",
      '',
      'export default defineConfig({',
      '  plugins: [badge()],',
      "  database: { url: 'postgres://localhost/site' },",
      '})',
      '',
    ].join('\n'),
  )

  // A plain object, and no imports yet
  expect(add("export default {\n  database: { url: 'x' },\n}\n")).toBe(
    "import { badge } from 'sorlo-field-badge/plugin'\nexport default {\n  plugins: [badge()],\n  database: { url: 'x' },\n}\n",
  )
})

test('make:plugin adds to plugins the config has, and leaves a config it can’t place it in alone', () => {
  const config = (plugins: string) =>
    `import { rating } from 'sorlo-field-rating/plugin'\n\nexport default {\n  plugins: ${plugins},\n}\n`
  const added = (plugins: string) =>
    `import { rating } from 'sorlo-field-rating/plugin'\nimport { badge } from 'sorlo-field-badge/plugin'\n\nexport default {\n  plugins: ${plugins},\n}\n`
  expect(add(config('[rating()]'))).toBe(added('[badge(), rating()]'))
  expect(add(config('[]'))).toBe(added('[badge()]'))

  expect(add('const config = { database: { url: "x" } }\nexport default config\n')).toBeUndefined()
})
