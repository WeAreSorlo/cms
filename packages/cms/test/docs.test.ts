import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

// The docs as @sorlo/cms carries them, which a site's coding agents read in node_modules/@sorlo/cms/docs

const run = promisify(execFile)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const copy = new URL('../docs/', import.meta.url)

// A heading's anchor, as GitHub makes it
const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replaceAll(' ', '-')

test('the package carries every page of the docs, and every link between them works there', async () => {
  await run('npm', ['run', 'build:docs'], { cwd })
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd })
  const packed: Array<string> = JSON.parse(stdout)[0].files.map(({ path }: { path: string }) => path)
  const pages = await readdir(new URL('../../../docs/', import.meta.url))
  expect(packed.filter((path) => path.startsWith('docs/')).sort()).toEqual(pages.map((page) => `docs/${page}`).sort())

  const texts = new Map(
    await Promise.all(pages.map(async (page) => [page, await readFile(new URL(page, copy), 'utf8')] as const)),
  )
  const anchors = (page: string) => [...texts.get(page)!.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => anchor(heading))
  // Every link but a full URL reaches a page in the folder, and its #anchor a heading there, so none leaves the folder
  for (const [page, text] of texts) {
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue
      const [file, hash] = target.split('#')
      expect(pages, `${page} links to ${target}`).toContain(file || page)
      if (hash) expect(anchors(file || page), `${page} links to ${target}`).toContain(hash)
    }
  }
}, 30_000)
