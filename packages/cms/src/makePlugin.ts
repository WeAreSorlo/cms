import { cmsInputs } from './relations'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// sorlo make:plugin: a field package in the site's plugins folder, built as a published one is, linked in the site's
// package.json and added to sorlo.config.ts

const cms = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// The versions the CMS itself uses, so a new package starts on what it's tested with
const versions = {
  forms: cms.dependencies['@sorlo/forms'],
  react: cms.dependencies.react,
  typesReact: cms.devDependencies['@types/react'],
  tsup: cms.devDependencies.tsup,
  typescript: cms.devDependencies.typescript,
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function files(name: string, pkg: string) {
  const label = name[0].toUpperCase() + name.slice(1)
  const entry = (file: string) => ({ types: `./dist/${file}.d.ts`, default: `./dist/${file}.js` })
  return {
    'package.json': json({
      name: pkg,
      version: '0.1.0',
      description: `A ${name} field for Sorlo Forms and the Sorlo CMS`,
      keywords: ['sorlo', 'sorlo-field'],
      type: 'module',
      exports: { '.': entry('index'), './validation': entry('validation'), './plugin': entry('plugin') },
      files: ['dist'],
      scripts: { build: 'tsup', dev: 'tsup --watch', prepack: 'npm run build' },
      peerDependencies: { '@sorlo/forms': versions.forms, react: versions.react },
      devDependencies: {
        '@sorlo/forms': versions.forms,
        '@types/react': versions.typesReact,
        react: versions.react,
        tsup: versions.tsup,
        typescript: versions.typescript,
      },
    }),
    '.gitignore': 'node_modules\ndist\n',
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['src'],
    }),
    'tsup.config.ts': `import { defineConfig } from 'tsup'

export default defineConfig({
  // The full input, the input without its component for servers, and the plugin for sorlo.config.ts
  entry: ['src/index.tsx', 'src/validation.ts', 'src/plugin.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
})
`,
    'src/validation.ts': `import { type InputValidateValue, inputs } from '@sorlo/forms'

// The ${name} field without its component, so a server checks and types values without React. It starts as Sorlo
// Forms' text field: change its checks, options and type here, and its component in index.tsx.

const validateValue: InputValidateValue = (value, schema) => inputs.text.validateValue(value, schema)

export const ${name} = {
  name: () => '${label}',
  description: () => 'A ${name} field.',
  category: () => 'Standard',
  optionFields: inputs.text.optionFields,
  validateValue,
  formatValue: inputs.text.formatValue,
  typeValue: () => 'string',
}
`,
    'src/index.tsx': `import { ${name} as checks } from './validation'
import { type Input, useFieldContext } from '@sorlo/forms'

// The field's editor, a text input in Sorlo Forms' styles to start from
function Editor() {
  const { id, aria, schema, required, readonly, disabled, options, value = '', handleValidation } = useFieldContext()
  return (
    <div className='sorlo-input__text'>
      <input
        className='sorlo-input'
        id={id}
        {...aria}
        type='text'
        value={value}
        onChange={(event) => handleValidation(checks.validateValue(event.target.value, schema))}
        required={required}
        readOnly={readonly}
        disabled={disabled}
        placeholder={options?.placeholder}
      />
    </div>
  )
}

// The full input, which Sorlo Forms users pass to a form, as <Form inputs={{ ${name} }} />, and the admin's build imports
export const ${name}: Input = { ...checks, default: Editor }
`,
    'src/plugin.ts': `import { ${name} as field } from './validation'

// For plugins in sorlo.config.ts: the field's checks, which the server takes, and this package, whose main entry the
// admin's build imports its component from
export const ${name} = () => ({ name: '${pkg}', fields: { ${name}: field }, admin: '${pkg}' })
`,
    'README.md': `# ${pkg}

A ${name} field for [Sorlo Forms](https://github.com/WeAreSorlo/forms) and the [Sorlo CMS](https://github.com/WeAreSorlo/cms), made by \`sorlo make:plugin\`. It has three entries:

- \`${pkg}\`, the full input, with its component, in \`src/index.tsx\`
- \`${pkg}/validation\`, the input without its component, for servers, in \`src/validation.ts\`
- \`${pkg}/plugin\`, \`${name}()\`, for \`plugins\` in \`sorlo.config.ts\`, in \`src/plugin.ts\`

Run \`npm run dev\` here while you change it, which builds it again on each change, beside \`npx sorlo dev\` in the site. The admin reloads as \`src/index.tsx\` changes. The server loads the checks as it starts, so start \`sorlo dev\` again after changing \`src/validation.ts\`.

A site deploying with it in its \`plugins\` folder builds it in the image first, as the CMS's [Plugins](https://github.com/WeAreSorlo/cms/blob/main/docs/plugins.md#making-one-with-makeplugin) page shows.

\`npm publish\` builds and publishes it. A site that installs it from npm adds \`plugins: [${name}()]\` with \`import { ${name} } from '${pkg}/plugin'\`, then runs \`npx sorlo build\`.
`,
  }
}

// sorlo.config.ts with the plugin imported and in its plugins, or undefined when there's nowhere clear to put it
export function withPlugin(source: string, name: string, pkg: string) {
  const call = `${name}()`
  const list = source.match(/\bplugins:\s*\[/)
  let edited: string
  if (list) {
    const at = list.index! + list[0].length
    edited = source.slice(0, at) + (/^\s*\]/.test(source.slice(at)) ? call : `${call}, `) + source.slice(at)
  } else {
    const object = source.match(/(?:\bdefineConfig\(\s*|^export default\s*)\{/m)
    if (!object) return undefined
    const at = object.index! + object[0].length
    edited = `${source.slice(0, at)}\n  plugins: [${call}],${source.slice(at)}`
  }

  // After the last import at the top of the file, as long as an import's last line ends with what it imports from
  const lines = edited.split('\n')
  let after = 0
  for (let index = 0, open = false; index < lines.length; index++) {
    const line = lines[index]
    if (open || /^import\b/.test(line)) {
      open = !/['"][^'"]+['"];?\s*$/.test(line)
      if (!open) after = index + 1
    } else if (line.trim() && !line.trim().startsWith('//')) break
  }
  lines.splice(after, 0, `import { ${name} } from '${pkg}/plugin'`)
  return lines.join('\n')
}

// Writes the package, links it in package.json and adds it to sorlo.config.ts. Returns what it did, and the npm steps
// that install and build the package, then install the site, so the link exists.
export function makePlugin(site: string, name: string) {
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    throw new Error(
      `${name} can't be a field type. Name the field with lowercase letters and digits, starting with a letter, such ` +
        'as rating, which becomes its field type.',
    )
  }
  if (Object.hasOwn(cmsInputs, name)) {
    throw new Error(`${name} is a field type already, built in or a plugin's. Choose another name.`)
  }
  const pkg = `sorlo-field-${name}`
  const folder = `plugins/${pkg}`
  const dir = join(site, folder)
  if (existsSync(dir)) throw new Error(`${folder} is there already, so nothing was made.`)

  for (const [file, text] of Object.entries(files(name, pkg))) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const done = [`Created ${folder}, a field package with the field type ${name}.`]

  const manifest = JSON.parse(readFileSync(join(site, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies, [pkg]: `file:${folder}` }
  manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(join(site, 'package.json'), json(manifest))
  done.push(`Added it to package.json as file:${folder}.`)

  const configFile = join(site, 'sorlo.config.ts')
  const config = withPlugin(readFileSync(configFile, 'utf8'), name, pkg)
  if (config) {
    writeFileSync(configFile, config)
    done.push(`Added it to sorlo.config.ts, as plugins: [${name}()].`)
  } else {
    done.push(
      `Couldn't find where plugins go in sorlo.config.ts, so add import { ${name} } from '${pkg}/plugin' to it, and ` +
        `${name}() to its plugins.`,
    )
  }

  const steps = [
    { command: `cd ${folder} && npm install`, cwd: dir, args: ['install', '--no-audit', '--no-fund'] },
    { command: `cd ${folder} && npm run build`, cwd: dir, args: ['run', 'build'] },
    { command: 'npm install', cwd: site, args: ['install', '--no-audit', '--no-fund'] },
  ]
  return { folder, done, steps }
}

// Runs one of makePlugin's steps, showing npm's output, and says whether it worked
export const runStep = ({ cwd, args }: { cwd: string; args: Array<string> }) =>
  spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0
