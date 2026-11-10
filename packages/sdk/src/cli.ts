import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// `npx sorlo types pull`, which writes the CMS's content types and forms into a frontend as TypeScript.
// Commit the file, so builds don't need the CMS, and run `--check` in CI to catch schema changes.

const file = 'src/sorlo-types.d.ts'

async function pull(check: boolean) {
  const { SORLO_URL: url, SORLO_TOKEN: token } = process.env
  if (!url || !token) {
    throw new Error("Set SORLO_URL to the CMS's address, and SORLO_TOKEN to a key from `sorlo make:api-key --types`.")
  }

  const response = await fetch(`${url.replace(/\/+$/, '')}/types`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch((error) => {
    throw new Error(`Couldn't reach the CMS at ${url}: ${error.cause?.message ?? error.message}`)
  })
  if (!response.ok) {
    const message = await response.json().then(
      (body) => body.message,
      () => response.statusText,
    )
    throw new Error(`The CMS at ${url} replied ${response.status}: ${message}`)
  }
  const types = await response.text()

  if (!check) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, types)
    console.log(`Wrote ${file}.`)
    return
  }

  const current = await readFile(file, 'utf8').catch(() => undefined)
  if (current !== types) {
    throw new Error(`${file} is ${current === undefined ? 'missing' : 'out of date'}. Run npx sorlo types pull.`)
  }
  console.log(`${file} is up to date.`)
}

const [command, action, ...flags] = process.argv.slice(2)

if (command !== 'types' || action !== 'pull' || flags.some((flag) => flag !== '--check')) {
  console.log(
    [
      'Usage: sorlo types pull [--check]',
      '',
      `Writes ${file} from the CMS at SORLO_URL, with the API key in SORLO_TOKEN.`,
      '--check changes nothing, and fails when the file is out of date.',
    ].join('\n'),
  )
  process.exitCode = command ? 1 : 0
} else {
  await pull(flags.includes('--check')).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
