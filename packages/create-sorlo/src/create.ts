import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const starter = 'https://github.com/WeAreSorlo/starter/archive/refs/heads/main.tar.gz'
const defaultFolder = 'my-site'

const usage = `Usage: npm create sorlo@latest [folder] [-- --database-url <url>]

Makes a Sorlo site from the starter, a Sorlo site project and a Next.js site with sample content, then installs it
and runs its setup.

  folder                 Where the site goes: a folder that's empty or not there yet
  --database-url <url>   Your own Postgres, which goes in cms/.env, rather than Postgres in Docker
  -h, --help             Shows this

It asks for what isn't given. Without a terminal to ask in, as in CI, the folder is ${defaultFolder} and Postgres runs
in Docker, through the site's npm run db.`

export function parseOptions(args: Array<string>) {
  const { values, positionals } = parseArgs({
    args,
    options: { 'database-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (positionals.length > 1) throw new Error(`Give one folder, not ${positionals.length}.`)
  return { folder: positionals[0], databaseUrl: values['database-url'], help: values.help ?? false }
}

// Why the site can't go in this folder, if it can't
export function checkFolder(folder: string) {
  const root = resolve(folder)
  if (!existsSync(root)) return
  if (!statSync(root).isDirectory()) return `${folder} is a file.`
  if (readdirSync(root).length) return `${folder} isn't empty. Choose a new folder, or an empty one.`
}

export function checkDatabaseUrl(url: string) {
  // The URL parser drops tabs and newlines, which would start another line in cms/.env
  if (/\s/.test(url) || !['postgres:', 'postgresql:'].includes(URL.parse(url)?.protocol ?? '')) {
    return 'Give a Postgres URL, such as postgres://user:password@localhost:5432/my_site.'
  }
}

// cms/.env.example with the URL in place of its DATABASE_URL, as the starter's setup sets a variable
export function withDatabaseUrl(env: string, url: string) {
  const line = /^DATABASE_URL=.*$/m
  return line.test(env) ? env.replace(line, () => `DATABASE_URL=${url}`) : `${env.trimEnd()}\nDATABASE_URL=${url}\n`
}

// A folder's name as npm allows a package's: lowercase letters, digits, -, ., _ and ~, not starting with . or _
export function packageName(folder: string) {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[._]+/, '')
}

export async function create(args: Array<string>) {
  let options: ReturnType<typeof parseOptions>
  try {
    options = parseOptions(args)
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`)
    process.exit(1)
  }
  if (options.help) return console.log(usage)

  // Without a terminal, as in CI or with piped input, the defaults stand in for answers
  const interactive = Boolean(process.stdin.isTTY)
  let prompt: ReturnType<typeof createPrompt> | undefined

  let folder = options.folder ?? defaultFolder
  if (options.folder === undefined && interactive) {
    prompt ??= createPrompt()
    const answer = await prompt.ask(`Which folder should the site go in? (${defaultFolder}) `, (answer) =>
      checkFolder(answer || defaultFolder),
    )
    folder = answer || defaultFolder
  }
  const folderProblem = checkFolder(folder)
  if (folderProblem) fail(folderProblem)

  let databaseUrl = options.databaseUrl
  if (databaseUrl === undefined && interactive) {
    prompt ??= createPrompt()
    const docker = await prompt.ask("Run Postgres in Docker, with the site's npm run db? (Y/n) ", (answer) =>
      /^(y|yes|n|no|)$/i.test(answer) ? undefined : 'Answer y or n.',
    )
    if (/^n/i.test(docker)) databaseUrl = await prompt.ask('The DATABASE_URL of your Postgres: ', checkDatabaseUrl)
  }
  // The terminal goes back to how it was, for the commands that follow
  prompt?.close()
  const databaseProblem = databaseUrl === undefined ? undefined : checkDatabaseUrl(databaseUrl)
  if (databaseProblem) fail(databaseProblem)

  const root = resolve(folder)
  const shown = relative(process.cwd(), root)
  const where = shown ? `in ${shown}` : 'here'

  console.log('Downloading the starter.')
  const tarball = await download().catch((error) => fail(error.message))
  const unpacked = unpack(root, tarball)
  if (unpacked !== true) fail(unpacked)

  // The starter's licence is the starter's. A new site chooses its own
  rmSync(join(root, 'LICENSE'), { force: true })
  const packageFile = join(root, 'package.json')
  const project = JSON.parse(readFileSync(packageFile, 'utf8'))
  project.name = packageName(basename(root)) || project.name
  writeFileSync(packageFile, `${JSON.stringify(project, null, 2)}\n`)

  // Setup keeps a cms/.env that's there, so the site's database is the one it creates and migrates
  if (databaseUrl !== undefined) {
    const example = readFileSync(join(root, 'cms/.env.example'), 'utf8')
    writeFileSync(join(root, 'cms/.env'), withDatabaseUrl(example, databaseUrl))
    console.log('Wrote cms/.env, with your DATABASE_URL.')
  }

  // Setup would take a DATABASE_URL in the environment over cms/.env's, the database the site has from now on
  const env = { ...process.env, DATABASE_URL: undefined }
  const steps = [['install'], ...(databaseUrl === undefined ? [['run', 'db']] : []), ['run', 'setup']]
  for (const [index, step] of steps.entries()) {
    console.log(`\nRunning npm ${step.join(' ')}`)
    // npm is npm.cmd on Windows, which only a shell runs
    const { status } = spawnSync('npm', step, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
    if (status !== 0) {
      const rest = steps.slice(index).map((command) => `npm ${command.join(' ')}`)
      fail(`\nnpm ${step.join(' ')} stopped. Once what it says is fixed, run ${rest.join(', then ')} ${where}.`)
    }
  }

  if (gitInit(root)) console.log('\nMade a git repository, with a first commit.')
  if (process.env.DATABASE_URL) {
    console.warn("\nDATABASE_URL is set in your environment, so the site's commands use it rather than cms/.env's.")
  }
  const next = [...(shown ? [`cd ${/^[\w./-]+$/.test(shown) ? shown : JSON.stringify(shown)}`] : []), 'npm run dev']
  console.log(`\nThe site is ready ${where}. Next:\n\n${next.map((line) => `  ${line}`).join('\n')}\n`)
  console.log('npm run dev prints a link for making the first account.')
}

// The starter's tarball, from GitHub or, with CREATE_SORLO_TARBALL, a file
async function download() {
  const file = process.env.CREATE_SORLO_TARBALL
  if (file) return readFileSync(file)
  try {
    const response = await fetch(starter)
    if (!response.ok) throw new Error(`it replied ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    const { message, cause } = error as Error & { cause?: Error }
    throw new Error(`Couldn't download the starter from ${starter}: ${cause?.message ?? message}`)
  }
}

// Unpacks the tarball's one folder, as GitHub makes it, into root. Returns why it couldn't, leaving root as it was
function unpack(root: string, tarball: Buffer) {
  const existed = existsSync(root)
  mkdirSync(root, { recursive: true })
  const result = spawnSync('tar', ['-xzf', '-', '--strip-components=1', '-C', root], {
    input: tarball,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  if (result.status === 0) return true
  // It was empty, or not there
  if (existed) for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true })
  else rmSync(root, { recursive: true, force: true })
  return `Couldn't unpack the starter with tar: ${result.error?.message ?? String(result.stderr).trim()}`
}

// As create-next-app does: a repository with a first commit, unless the folder is in one already, or git isn't
// installed or can't commit, as when it has no name and email
function gitInit(root: string) {
  const git = (...args: Array<string>) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0
  if (!git('--version') || git('rev-parse', '--is-inside-work-tree')) return false
  if (
    git('init') &&
    (git('config', 'init.defaultBranch') || git('checkout', '-b', 'main')) &&
    git('add', '-A') &&
    git('commit', '-m', 'Initial commit from create-sorlo')
  ) {
    return true
  }
  rmSync(join(root, '.git'), { recursive: true, force: true })
  return false
}

// Questions on the terminal, as the CMS's sorlo asks them, each asked again until its answer passes check
function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on('SIGINT', stop)
  const lines = rl[Symbol.asyncIterator]()
  return {
    async ask(question: string, check: (answer: string) => string | undefined) {
      for (;;) {
        rl.setPrompt(question)
        rl.prompt()
        const { value, done } = await lines.next()
        if (done) stop()
        const answer = String(value).trim()
        const problem = check(answer)
        if (!problem) return answer
        console.error(problem)
      }
    },
    close: () => rl.close(),
  }
}

// Ctrl+C, or the end of the input, while it asks
function stop(): never {
  console.error('\nStopped. Nothing was made.')
  process.exit(130)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
