import { contrast, pairs } from '../admin/contrast'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compile } from 'sass'
import { expect, test } from 'vitest'

// The custom properties each of the admin theme's rules sets, by selector. A selector inside a media query comes after
// the same one outside it, so the first of each is the one outside.
const css = compile(fileURLToPath(new URL('../admin/theme.scss', import.meta.url))).css.replace(/\/\*[\s\S]*?\*\//g, '')
const rules = new Map<string, Record<string, string>>()
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const tokens = Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+)/g)].map(([, name, value]) => [name, value]),
  )
  if (!rules.has(selector.trim())) rules.set(selector.trim(), tokens)
}

const light = rules.get('.iight-theme-admin')!
const modes = { light, dark: { ...light, ...rules.get('.iight-theme-admin[data-theme=dark]') } }

test("sets every token in core's contract", () => {
  const require = createRequire(import.meta.url)
  const contract = readFileSync(require.resolve('iight/styles/themes/default.scss'), 'utf8').match(
    /--iight-[\w-]+(?=:)/g,
  )!

  expect(contract.filter((name) => !(name in light))).toEqual([])
})

test('chooses dark mode the same way from the OS and from data-theme', () => {
  expect(rules.get('.iight-theme-admin:not([data-theme=light])')).toEqual(
    rules.get('.iight-theme-admin[data-theme=dark]'),
  )
})

test.each(Object.entries(modes))('meets AA contrast in %s mode', (_, palette) => {
  const failures = pairs
    .map(([foreground, background, minimum]) => ({
      pair: `${foreground} on ${background}`,
      ratio: Math.round(contrast(palette[foreground], palette[background]) * 100) / 100,
      minimum,
    }))
    .filter(({ ratio, minimum }) => ratio < minimum)
  expect(failures).toEqual([])
})
