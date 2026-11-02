import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

// The iight CLI, run from a site project as a site runs it

const bin = fileURLToPath(new URL('../bin/iight.js', import.meta.url))

test(".env sets what the environment doesn't, before iight.config.ts loads", async () => {
  // A site project whose config prints what it sees, with a command that needs no database
  const dir = await mkdtemp(join(tmpdir(), 'iight-site-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(
    join(dir, 'iight.config.ts'),
    'console.log(JSON.stringify({ a: process.env.IIGHT_TEST_A, b: process.env.IIGHT_TEST_B }))\n' +
      "export default { database: { url: 'postgres://localhost/unused' } }\n",
  )
  await writeFile(join(dir, '.env'), 'IIGHT_TEST_A=from the file\nIIGHT_TEST_B="from the file"\n')
  await mkdir(join(dir, 'schema/types'), { recursive: true })

  try {
    const env = { ...process.env, IIGHT_TEST_B: 'from the environment' }
    const { stdout } = await promisify(execFile)(process.execPath, [bin, 'make:migration'], { cwd: dir, env })
    expect(stdout.split('\n')[0]).toBe('{"a":"from the file","b":"from the environment"}')
  } finally {
    await rm(dir, { recursive: true })
  }
}, 30_000)
