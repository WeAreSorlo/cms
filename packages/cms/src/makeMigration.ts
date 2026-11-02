import { sharedDepth } from './content'
import { mapFields } from './fields'
import type { ContentType } from './types'
import type { FieldSchema } from 'iight'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// iight make:migration compares schema/types with migrations/.snapshot.json, the types as the last migration left them,
// and writes a content migration for the difference (PLAN.md section 6). Types, fields and layouts are matched by id,
// so a renamed field isn't taken for one removed and another added.

interface Node {
  id: string
  kind: 'field' | 'layout'
  name: string
  // The field or layout it sits in, by id, or '' at the top
  parent: string
  schema: Record<string, any>
}

type Tree = Map<string, Node>

// What one change adds to up and to down. Flags and TODOs also come with a note for the terminal.
interface Change {
  up: Array<string>
  down: Array<string>
  note?: string
}

// Options that change how a field looks, not which values pass
const presentation = ['placeholder', 'rows', 'message', 'direction', 'source', 'content']

// Every field and layout in a schema by id, parents before children
function treeOf(fields: Array<FieldSchema>) {
  const tree: Tree = new Map()
  const add = (list: Array<any> = [], kind: Node['kind'], parent: string) => {
    for (const schema of list) {
      tree.set(schema.id, { id: schema.id, kind, name: schema.name, parent, schema })
      if (kind === 'layout') {
        add(schema.fields, 'field', schema.id)
      } else {
        add(schema.options?.fields, 'field', schema.id)
        add(schema.options?.layouts, 'layout', schema.id)
      }
    }
  }
  add(fields, 'field', '')
  return tree
}

const pathOf = (tree: Tree, id: string): string => {
  const node = tree.get(id)!
  return node.parent ? `${pathOf(tree, node.parent)}.${node.name}` : node.name
}

// The fields and layouts that hold a node's parent and the parent itself, outermost first
const containersOf = (tree: Tree, parent: string): Array<Node> =>
  parent ? [...containersOf(tree, tree.get(parent)!.parent), tree.get(parent)!] : []

// Every field and layout inside a node, by its path from there, such as og.title
function inside(tree: Tree, id: string, path = '', found = new Map<string, Node>()) {
  for (const node of tree.values()) {
    if (node.parent !== id) continue
    const at = path ? `${path}.${node.name}` : node.name
    found.set(at, node)
    inside(tree, node.id, at, found)
  }
  return found
}

// The old fields with new ids wherever a group's fields came from somewhere else, such as a type's own SEO group swapped
// for a use of a shared one, which gives the fields inside new ids (PLAN.md section 19). Those are matched by name, so
// each keeps its values where the name matches, and the ones that don't match are removed and flagged.
// shortcut: a swap that changes no values writes no migration, so iight migrate doesn't rebuild entry_relations, whose
// rows keep the copy's field ids until each entry saves. Nothing reads field_id yet; rebuild them here once something does.
function matchSwaps(before: Array<FieldSchema>, after: Array<FieldSchema>) {
  const old = treeOf(before)
  const now = treeOf(after)
  const ids = new Map<string, string>()
  for (const node of now.values()) {
    const was = old.get(node.id)
    const swapped =
      was?.schema.type === 'group' &&
      node.schema.type === 'group' &&
      was.schema.options?.group !== node.schema.options?.group
    if (!swapped) continue

    const matches = inside(now, node.id)
    for (const [path, child] of inside(old, was.id)) {
      const match = matches.get(path)
      if (match?.kind === child.kind) ids.set(child.id, match.id)
      else {
        // An id no field has now, so it's removed rather than taken for the new field that has it
        let unused = `${child.id}~`
        while (now.has(unused) || old.has(unused) || [...ids.values()].includes(unused)) unused += '~'
        ids.set(child.id, unused)
      }
    }
  }
  if (!ids.size) return before
  const rename = <T extends { id?: string }>(node: T) => (ids.has(node.id!) ? { ...node, id: ids.get(node.id!) } : node)
  return mapFields(before, rename, rename)
}

const choicesOf = (schema: Record<string, any>): Array<unknown> =>
  (schema.options?.choices ?? [])
    .flatMap((choice: any) => (choice?.choices?.length > 0 ? choice.choices : [choice]))
    .map((choice: any) => choice?.value)

// A value as Prettier writes it in TypeScript
function literal(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes("'") ? JSON.stringify(value) : `'${JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"')}'`
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.entries(value).map(
      ([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)}: ${literal(item)}`,
    )
    return keys.length ? `{ ${keys.join(', ')} }` : '{}'
  }
  return JSON.stringify(value)
}

// A line comment, kept on one line, since a note can quote a type file's choice values and option keys, and a line
// break in one would end the comment and run the rest
const comment = (text: string) => `// ${text.replace(/\s+/g, ' ')}`

// The flags and TODOs in a migration's text, as comment lines of their own like those make:migration writes, with
// their line numbers. A developer deletes a TODO's line once its conversion is written.
export const notesOf = (text: string) =>
  text.split(/\r?\n/).flatMap((line, index) => {
    const found = /^\s*\/\/ (Flagged|TODO): (.*)$/.exec(line)
    return found
      ? [{ kind: found[1] === 'TODO' ? ('todo' as const) : ('flag' as const), line: index + 1, text: found[2] }]
      : []
  })

// A call to one of the entries helpers, broken over lines as Prettier breaks one longer than 120 columns inside up
function call(method: string, ...args: Array<string>) {
  const line = `entries.${method}(${args.join(', ')})`
  return line.length + 2 <= 120 ? [line] : [`entries.${method}(`, ...args.map((arg) => `  ${arg},`), ')']
}

// The changes that turn one type's values from its old fields into its new ones, in an order where none overwrites
// another's values
function fieldChanges(type: string, before: Array<FieldSchema>, after: Array<FieldSchema>) {
  const old = treeOf(matchSwaps(before, after))
  const now = treeOf(after)
  // Where each old field and layout is, as the changes so far leave it
  const current: Tree = new Map([...old].map(([id, node]) => [id, { ...node }]))
  const changes: Array<Change> = []
  const name = literal(type)

  const remove = (id: string) => {
    const node = current.get(id)!
    const what = node.kind === 'field' ? `the values of ${pathOf(old, id)}` : `every ${pathOf(old, id)} block`
    const note = `Flagged: deletes ${what}, which down can't bring back. Old versions keep them`
    const method = node.kind === 'field' ? 'removeField' : 'removeLayout'
    const up = [comment(note), ...call(method, name, literal(pathOf(current, id)))]
    changes.push({ up, down: [comment(`${what[0].toUpperCase()}${what.slice(1)} can't come back`)], note })

    const drop = (id: string) => {
      current.delete(id)
      for (const child of [...current.values()]) if (child.parent === id) drop(child.id)
    }
    drop(id)
  }

  // Move an old field or layout to a name in a parent, whose path comes from the given tree
  const relocate = (id: string, to: string, parent: string, tree: Tree) => {
    const node = current.get(id)!
    const from = pathOf(current, id)
    const path = parent ? `${pathOf(tree, parent)}.${to}` : to

    // renameField steps through the containers both paths share, then moves the value along keys, so the containers
    // after those must be groups. A layout can only be renamed within its flexible field.
    const shared = sharedDepth(from.split('.'), path.split('.'))
    const between = [...containersOf(current, node.parent).slice(shared), ...containersOf(tree, parent).slice(shared)]
    const renames =
      node.kind === 'layout'
        ? node.parent === parent
        : between.every((container) => container.kind === 'field' && container.schema.type === 'group')

    if (renames) {
      const method = node.kind === 'field' ? 'renameField' : 'renameLayout'
      changes.push({
        up: call(method, name, literal(from), literal(path)),
        down: call(method, name, literal(path), literal(from)),
      })
    } else {
      const note = `TODO: ${from} moved to ${path}, which a rename can't do across lists or layouts. Move it here, and back in down`
      const stub = call('update', name, '(values) => values')
      changes.push({
        up: [comment(note), ...stub],
        down: [comment(`TODO: move ${path} back to ${from}`), ...stub],
        note,
      })
    }
    Object.assign(node, { name: to, parent })
  }

  // Parents before children, put each field and layout in its new place. Whatever is there steps aside to a temporary
  // name if it moves later, or still holds something that does, and is removed otherwise. New ones join the tree, so
  // others can move into them.
  for (const node of now.values()) {
    const path = pathOf(now, node.id)
    const holder = [...current.values()].find((other) => other.id !== node.id && pathOf(current, other.id) === path)
    const holds = (id: string) =>
      [...current.values()].some(
        (other) => now.has(other.id) && containersOf(current, other.parent).some((c) => c.id === id),
      )
    if (holder && (now.has(holder.id) || holds(holder.id))) relocate(holder.id, `_${holder.id}`, holder.parent, current)
    else if (holder) remove(holder.id)

    if (!current.has(node.id)) current.set(node.id, { ...node })
    else if (pathOf(current, node.id) !== path) relocate(node.id, node.name, node.parent, now)
  }

  for (const node of [...current.values()]) if (current.has(node.id) && !now.has(node.id)) remove(node.id)

  for (const node of now.values()) {
    const was = old.get(node.id)
    const path = pathOf(now, node.id)
    if (node.kind === 'layout') continue

    if (was && was.schema.type !== node.schema.type) {
      const note = `TODO: ${path} changed from ${was.schema.type} to ${node.schema.type}. Convert its values here, and back in down`
      const stub = call('mapField', name, literal(path), '(value) => value')
      changes.push({
        up: [comment(note), ...stub],
        down: [comment(`TODO: convert ${path} back to ${was.schema.type}`), ...stub],
        note,
      })
    } else if (was) {
      // Settings that could fail values which passed before, for migrate --check to look for
      const lost = choicesOf(was.schema).filter(
        (value) => !choicesOf(node.schema).some((v) => isDeepStrictEqual(v, value)),
      )
      const options = [
        ...new Set([...Object.keys(was.schema.options ?? {}), ...Object.keys(node.schema.options ?? {})]),
      ]
      // A group's options.group names the shared group its fields come from, and a swap changes the fields, not values
      const changed = options.filter(
        (key) =>
          !['fields', 'layouts', 'choices', 'group', ...presentation].includes(key) &&
          !isDeepStrictEqual(was.schema.options?.[key], node.schema.options?.[key]),
      )
      const reasons = [
        ...(node.schema.required && !was.schema.required ? ['is now required'] : []),
        ...(lost.length ? [`lost the choice${lost.length > 1 ? 's' : ''} ${lost.join(', ')}`] : []),
        ...(changed.length ? [`has a new ${changed.join(', ')}`] : []),
      ]
      if (reasons.length) {
        const note = `Flagged: ${path} ${reasons.join(' and ')}, so some entries may not pass. Run iight migrate --check`
        changes.push({ up: [comment(note)], down: [], note })
      }
    } else if (!node.parent || old.has(node.parent)) {
      // A new field in a container that's new too has no values to fill
      if (node.schema.defaultValue !== undefined) {
        const value = literal(node.schema.defaultValue)
        changes.push({
          up: call('addField', name, literal(path), value),
          down: call('removeField', name, literal(path)),
        })
      } else if (node.schema.required) {
        const note = `Flagged: ${path} is new and required, so entries saved before it have no value. Run iight migrate --check`
        changes.push({ up: [comment(note)], down: [], note })
      }
    }
  }

  return changes
}

// The changes from the snapshot's types to the current ones, in the order up makes them, and the types they touch
export function diffTypes(snapshot: Record<string, ContentType>, types: Map<string, ContentType>) {
  const before = new Map(Object.values(snapshot).map((type) => [type.id, type]))
  const after = [...types.values()].sort((a, b) => a.name.localeCompare(b.name))
  const kept = new Set(after.map((type) => type.id))
  // Each old type's name, as the renames so far leave it
  const names = new Map([...before].map(([id, type]) => [id, type.name]))
  const changes: Array<Change> = []
  const touched = new Set<string>()

  const rename = (id: string, to: string) => {
    const [from, into] = [literal(names.get(id)), literal(to)]
    changes.push({ up: call('renameType', from, into), down: call('renameType', into, from) })
    names.set(id, to)
  }

  // Type renames come first, so the field changes can name types as they are now. A name another renamed type still
  // holds is freed first.
  for (const type of after) {
    if (!before.has(type.id) || names.get(type.id) === type.name) continue
    const holder = [...names].find(([id, name]) => id !== type.id && name === type.name)?.[0]
    if (holder && kept.has(holder)) rename(holder, `_${holder}`)
    else if (holder) {
      const note = `Flagged: ${type.name} was the name of a type that's gone. Delete its entries first, or the rename stops`
      changes.push({ up: [comment(note)], down: [], note })
    }
    rename(type.id, type.name)
    touched.add(type.name)
  }

  for (const type of after) {
    const fields = before.has(type.id) ? fieldChanges(type.name, before.get(type.id)!.fields, type.fields) : []
    if (fields.length) touched.add(type.name)
    changes.push(...fields)
  }

  for (const [id, type] of before) {
    if (kept.has(id)) continue
    const note = `Flagged: the type ${type.name} is gone, but its entries stay until you delete them. iight migrate --check lists them`
    changes.push({ up: [comment(note)], down: [], note })
    touched.add(type.name)
  }

  return { changes, touched: [...touched].sort() }
}

// A migration file, whose down undoes up's changes in reverse
function source(changes: Array<Change>) {
  const body = (lines: Array<string>) => (lines.length ? lines : ['// Nothing to undo']).map((line) => `  ${line}`)
  return [
    "// Made by iight make:migration. Content migrations only change entries' values, so old versions can run them too",
    "import type { ContentMigration } from '@iight/cms'",
    '',
    'export const up: ContentMigration = ({ entries }) => {',
    ...body(changes.flatMap((change) => change.up)),
    '}',
    '',
    'export const down: ContentMigration = ({ entries }) => {',
    ...body([...changes].reverse().flatMap((change) => change.down)),
    '}',
    '',
  ].join('\n')
}

// Write a migration for what changed since the snapshot, if anything needs one, then bring the snapshot up to date
export async function makeMigration(dir: string, types: Map<string, ContentType>, name?: string) {
  if (name !== undefined && !/^\w+$/.test(name))
    throw new Error('A migration name can only have letters, digits and underscores.')

  const snapshotFile = join(dir, '.snapshot.json')
  const snapshot = existsSync(snapshotFile) ? JSON.parse(await readFile(snapshotFile, 'utf8')) : undefined
  const { changes, touched } = diffTypes(snapshot ?? {}, types)
  await mkdir(dir, { recursive: true })

  let file: string | undefined
  if (changes.length) {
    // Named for the time, so migrations sort in the order they were made, even two in the same second
    const made = (await readdir(dir)).filter((file) => /^\d{4}_\d\d_\d\d_\d{6}_/.test(file))
    let time = Math.floor(Date.now() / 1000)
    const stamp = () =>
      new Date(time * 1000).toISOString().replace(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+).*/, '$1_$2_$3_$4$5$6')
    while (made.some((file) => file.slice(0, 17) >= stamp())) time++
    file = `${stamp()}_${name ?? touched.join('_')}.ts`
    await writeFile(join(dir, file), source(changes))
  }

  const current = Object.fromEntries(types)
  const updated = !isDeepStrictEqual(snapshot, current)
  if (updated) await writeFile(snapshotFile, `${JSON.stringify(current, null, 2)}\n`)

  return { file, notes: changes.flatMap((change) => change.note ?? []), created: snapshot === undefined, updated }
}
