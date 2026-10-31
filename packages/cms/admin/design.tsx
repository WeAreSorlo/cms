import { versionSchema } from '../src/schemas'
import { ContentType, Entry, GroupsContext, SharedGroup, Status } from './api'
import { Grid, columnsOf, useRows } from './bulk'
import { compare } from './compare'
import { contrast, pairs } from './contrast'
import './design.scss'
import { Version, Versions } from './entries'
import { iconInput, useInputs } from './fields'
import { TypeGroups } from './groups'
import { Media, MediaCard } from './media'
import {
  Badge,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Panel,
  PanelSlot,
  StatusBadge,
  ThemeSwitch,
  useConfirm,
  useToast,
} from './ui'
import { ChangeList, JsonChanges } from './versions'
import Form, { FieldSchema, FormHandle, Input, inputs } from 'iight'
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Inbox, Sheet, Trash2 } from 'lucide-react'
import { ReactNode, useEffect, useMemo, useReducer, useRef, useState } from 'react'

const colours = [
  '--cms-page',
  '--cms-surface',
  '--cms-subtle',
  '--cms-rule',
  '--cms-border',
  '--cms-text',
  '--cms-muted',
  '--cms-accent',
  '--cms-accent-hover',
  '--cms-on-accent',
  '--cms-accent-tint',
  '--cms-accent-strong',
  '--cms-danger',
  '--cms-on-danger',
  '--cms-success',
  '--cms-warning',
]
const steps = ['xs', 'sm', 'base', 'lg', 'xl']
const sizes = ['--iight-size-1', '--iight-size-2', '--iight-size-3', '--iight-size-4', '--cms-size-6', '--cms-size-8']
const radii = ['--iight-size-1', '--iight-size-2', '--cms-radius-pill']
const shadows = ['--cms-shadow-1', '--cms-shadow-2']
// A dark shape on a transparent ground, so the squares behind it show, then the same chosen, then a file that isn't
// a picture
const shape = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='3'/></svg>")}`
const sample = { size: 2048, width: 10, height: 10, caption: null, createdAt: '2026-10-28T12:00:00Z' }
const sampleFiles: Array<Media> = [
  { ...sample, id: 'shape', name: 'a-transparent-shape.svg', mime: 'image/svg+xml', alt: null, url: shape },
  { ...sample, id: 'chosen', name: 'chosen-in-a-picker.svg', mime: 'image/svg+xml', alt: 'A circle', url: shape },
  {
    ...sample,
    id: 'pdf',
    name: 'a-long-document-name-that-wraps-onto-two-lines.pdf',
    mime: 'application/pdf',
    width: null,
    height: null,
    alt: 'Terms',
    url: '',
  },
]

// Seven versions, newest first, a day apart, one of them saved by a user deleted since. Version 5, the live one in the
// changed entry's panels, is named and went live an hour after it was saved, and so did version 3, by someone since
// deleted.
const sampleVersions: Array<Version> = [7, 6, 5, 4, 3, 2, 1].map((number) => ({
  number,
  name: { 5: 'Launch copy', 3: 'Before the rebrand' }[number] ?? null,
  createdBy: number === 2 ? null : { id: 'usr_sample', name: 'Levi' },
  createdAt: `2026-10-${22 + number}T14:0${number}:00Z`,
  publishedAt: number === 5 || number === 3 ? `2026-10-${22 + number}T15:00:00Z` : null,
  publishedBy: number === 5 ? { id: 'usr_sample', name: 'Levi' } : null,
}))

// Two versions of a post for the comparison: a text and a box changed, a long text reworded, a field in a group, a
// link swapped for another, and a list with an item changed and one removed
const compareFields: Array<FieldSchema> = [
  { type: 'text', name: 'title', label: 'Title' },
  { type: 'textarea', name: 'intro', label: 'Intro' },
  { type: 'boolean', name: 'featured', label: 'Featured' },
  { type: 'group', name: 'seo', label: 'SEO', options: { fields: [{ type: 'text', name: 'title', label: 'Title' }] } },
  { type: 'relationship', name: 'author', label: 'Author', options: { maximum: 1 } },
  {
    type: 'repeater',
    name: 'links',
    label: 'Links',
    options: {
      fields: [
        { type: 'text', name: 'label', label: 'Label' },
        { type: 'url', name: 'url', label: 'URL' },
      ],
    },
  },
]
const sampleBefore = {
  title: 'Spring sale',
  intro: 'Our biggest sale of the year starts on Monday.',
  featured: false,
  seo: { title: 'Spring sale' },
  author: 'ada',
  links: [
    { label: 'Shop', url: 'https://example.com/shop' },
    { label: 'Terms', url: 'https://example.com/terms' },
  ],
}
const sampleAfter = {
  title: 'Spring sale',
  intro: 'Our biggest sale of the year starts on Friday, online and in stores.',
  featured: true,
  seo: { title: 'Spring sale: up to 50% off' },
  author: 'grace',
  links: [{ label: 'Shop now', url: 'https://example.com/shop' }],
}
const sampleChanges = compare(compareFields, sampleBefore, sampleAfter)
const sampleLinks = { ada: 'Ada Lovelace', grace: 'Grace Hopper' }

// The version page's panel for each kind of version: an old one, the current one, the live one, and an archived
// entry's, which can only be read
const versionPanels: Array<{
  label: string
  restore?: boolean
  remove?: boolean
  name?: string | null
  live?: boolean
}> = [
  { label: 'An old version', restore: true, remove: true, name: 'Before the rebrand' },
  { label: 'The current version', name: '' },
  { label: 'The live version', restore: true, name: 'Launch copy', live: true },
  { label: "An archived entry's version", name: null },
]

// One of the version page's panels, whose buttons toast what they'd do
function VersionPanel({ restore, remove, name, live }: Omit<(typeof versionPanels)[number], 'label'>) {
  const toast = useToast()
  return (
    <Panel
      label='About this version'
      actions={
        restore && (
          <button type='button' className='iight-button iight-button--primary' onClick={() => toast('Restoring')}>
            Restore
          </button>
        )
      }
      footer={
        remove && (
          <button type='button' className='iight-button iight-button--danger' onClick={() => toast('Asks first')}>
            <Trash2 /> Delete version
          </button>
        )
      }
    >
      <section>
        <h2>Saved</h2>
        <p>Levi · 27 Oct, 14:05</p>
      </section>
      {live && (
        <section>
          <h2>Last published</h2>
          <p>Levi · 27 Oct, 15:00</p>
        </section>
      )}
      {name !== null && (
        <div className='cms-version-name'>
          <Form schema={versionSchema} values={{ name }} />
          <button type='button' className='iight-button' onClick={() => toast('Named the version')}>
            Save name
          </button>
        </div>
      )}
    </Panel>
  )
}

// The entry editor's panel for each kind of entry: new, before and after a publish that can't go ahead, changed since
// its live version with the history shut and open, archived, and of a type without drafts, whose Save publishes
const panels: Array<{
  label: string
  status: 'new' | 'changed' | 'archived' | 'published'
  problem?: string
  open?: boolean
  drafts?: boolean
}> = [
  { label: 'A new entry', status: 'new' },
  {
    label: "A publish that can't go ahead",
    status: 'new',
    problem: '2 fields need fixing before this can be published.',
  },
  { label: 'Changed, with its history shut', status: 'changed' },
  { label: 'Changed, with its history open', status: 'changed', open: true },
  { label: 'Archived', status: 'archived' },
  { label: 'A type without drafts', status: 'published', drafts: false },
]

// One of the entry editor's panels, whose buttons toast what they'd do
function EntryPanel({ status, problem, open, drafts = true }: Omit<(typeof panels)[number], 'label'>) {
  const toast = useToast()
  const archived = status === 'archived'
  const entry = status !== 'new' && {
    ...sampleEntry('sample', archived ? 'draft' : status, {}),
    archivedAt: archived ? '2026-10-30T09:00:00Z' : null,
    publishedVersion: { changed: 5, published: 7, archived: null }[status],
  }
  const button = (label: string, tone?: 'primary' | 'danger', icon?: ReactNode) => (
    <button
      type='button'
      className={tone ? `iight-button iight-button--${tone}` : 'iight-button'}
      onClick={() => toast(label)}
    >
      {icon} {label}
    </button>
  )

  return (
    <Panel
      label='About this entry'
      problem={problem}
      actions={
        archived ? (
          button('Restore', 'primary', <ArchiveRestore />)
        ) : (
          <>
            {drafts && button('Save draft')}
            {button(drafts ? 'Publish' : 'Save', 'primary')}
          </>
        )
      }
      footer={
        entry &&
        (archived ? (
          button('Delete for good', 'danger', <Trash2 />)
        ) : (
          <>
            {drafts && entry.status !== 'draft' && button('Unpublish')}
            {button('Archive', undefined, <Archive />)}
          </>
        ))
      }
    >
      {entry && (
        <Versions
          versions={sampleVersions}
          entry={entry}
          drafts={drafts}
          defaultOpen={open}
          onRestore={(version) => toast(`Version ${version.number} is in the form`)}
        />
      )}
    </Panel>
  )
}

const buttons = [
  ['Secondary', 'iight-button'],
  ['Primary', 'iight-button iight-button--primary'],
  ['Danger', 'iight-button iight-button--danger'],
]

const choices = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' },
  { value: 'three', label: 'Three' },
]
const children: Array<FieldSchema> = [
  { type: 'text', name: 'title', label: 'Title', width: 50 },
  { type: 'number', name: 'count', label: 'Count', width: 50 },
]

// What each input needs before it shows anything
const options: Record<string, Record<string, any>> = {
  checkbox: { choices },
  radio: { choices },
  select: { choices },
  content: { content: 'Content shows read-only text between fields.' },
  hidden: { value: 'hidden' },
  identifier: { source: 'text' },
  range: { min: 0, max: 10 },
  group: { fields: children },
  repeater: { fields: children },
  matrix: { fields: children },
  flexible: { layouts: [{ name: 'pair', label: 'Pair', fields: children }] },
}

// Every one of core's inputs, labelled with its own name and description
const everyInput = (state: string): Array<FieldSchema> =>
  Object.entries(inputs as Record<string, Partial<Input>>).map(([type, input]) => ({
    type,
    name: type,
    label: input.name?.(),
    instructions: input.description?.(),
    required: type !== 'content' && type !== 'hidden',
    readonly: state === 'readonly',
    disabled: state === 'disabled',
    options: options[type],
  }))

const stateSchema: Array<FieldSchema> = [
  {
    type: 'radio',
    name: 'state',
    label: 'Show the inputs',
    defaultValue: 'editable',
    options: {
      choices: [
        { value: 'editable', label: 'Editable' },
        { value: 'readonly', label: 'Read-only' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
  },
]

// The CMS's pickers: entries up to a maximum, so Choose goes once it's full, any number of files, and an icon
const pickerFields = (state: string): Array<FieldSchema> =>
  [
    { type: 'relationship', name: 'entries', label: 'Entries', instructions: 'Up to two.', options: { maximum: 2 } },
    { type: 'media', name: 'files', label: 'Files', instructions: 'Any number.' },
    { type: 'icon', name: 'icon', label: 'Icon', defaultValue: 'newspaper' },
  ].map((field) => ({ ...field, readonly: state === 'readonly', disabled: state === 'disabled' }))

// A type for the bulk editing grid: a required field, a number from 0, a box whose condition shows another field, a
// field in a group with a maximum length, and a list, which opens in a dialog
const gridType: ContentType = {
  id: 'typ_sample',
  name: 'sample',
  label: 'Sample products',
  structure: 'collection',
  titleField: 'name',
  fields: [
    { id: 'fld_name', type: 'text', name: 'name', label: 'Name', required: true },
    { id: 'fld_price', type: 'number', name: 'price', label: 'Price', options: { min: 0 } },
    { id: 'fld_sale', type: 'boolean', name: 'sale', label: 'On sale' },
    {
      id: 'fld_sale_price',
      type: 'number',
      name: 'sale_price',
      label: 'Sale price',
      conditions: [{ field: 'sale', operator: 'equals', value: true }],
    },
    {
      id: 'fld_seo',
      type: 'group',
      name: 'seo',
      label: 'SEO',
      options: {
        fields: [{ id: 'fld_seo_title', type: 'text', name: 'title', label: 'Title', options: { maxLength: 30 } }],
      },
    },
    {
      id: 'fld_specs',
      type: 'repeater',
      name: 'specs',
      label: 'Specs',
      options: { fields: [{ id: 'fld_spec', type: 'text', name: 'label', label: 'Label', required: true }] },
    },
  ],
}
const gridColumns = columnsOf(gridType.fields)

const sampleEntry = (id: string, status: Status, values: Record<string, any>): Entry => ({
  id,
  type: 'sample',
  slug: null,
  uri: null,
  parentId: null,
  position: null,
  values,
  createdAt: '2026-10-29T12:00:00Z',
  updatedAt: '2026-10-29T12:00:00Z',
  publishedAt: status === 'draft' ? null : '2026-10-29T12:00:00Z',
  archivedAt: null,
  createdBy: null,
  updatedBy: null,
  status,
  publishedVersion: status === 'draft' ? null : 1,
})

// One of each: as saved, with values its checks refuse, and an unfinished draft, which Save takes but Publish doesn't
const gridEntries = [
  sampleEntry('lamp', 'published', {
    name: 'Desk lamp',
    price: 40,
    sale: true,
    sale_price: 32,
    seo: { title: 'A brass desk lamp' },
    specs: [{ label: 'Brass' }, { label: 'LED' }],
  }),
  sampleEntry('chair', 'changed', {
    name: 'Armchair',
    price: -5,
    sale: false,
    seo: { title: 'An armchair, far too long for a title' },
  }),
  sampleEntry('shelf', 'draft', { name: '', price: 120, sale: false }),
]

// A type's own groups, one inside a layout, and a use of a shared group, as the type editor lists them. Each state's
// copy has ids of its own, since buttons are named through them.
const sampleGroups = new Map<string, SharedGroup>([
  ['seo', { id: 'grp_sample', name: 'seo', label: 'SEO', fields: [] }],
])
const groupFields = (state: string): Array<FieldSchema> => [
  { id: `fld_address_${state}`, type: 'group', name: 'address', label: 'Address', options: { fields: [] } },
  {
    id: `fld_blocks_${state}`,
    type: 'flexible',
    name: 'blocks',
    label: 'Blocks',
    options: {
      layouts: [
        {
          id: `lay_cta_${state}`,
          name: 'cta',
          label: 'Call to action',
          fields: [
            { id: `fld_button_${state}`, type: 'group', name: 'button', label: 'Button', options: { fields: [] } },
          ],
        },
      ],
    },
  },
  {
    id: `fld_seo_${state}`,
    type: 'shared',
    name: 'seo',
    label: 'Search and sharing',
    options: { group: 'grp_sample' },
  },
]

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// The design system's tokens and components in the current theme, for checking changes to them. iight dev serves it at
// #/design, and the built admin leaves it out.
export default function Design() {
  // Reads the tokens again whenever the theme changes, from the switch or from the OS
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    const os = matchMedia('(prefers-color-scheme: dark)')
    const update = () => rerender()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    os.addEventListener('change', update)
    return () => {
      observer.disconnect()
      os.removeEventListener('change', update)
    }
  }, [])

  const [state, setState] = useState('editable')
  const schema = useMemo(() => everyInput(state), [state])
  const cmsInputs = useInputs()
  const pickerInputs = useMemo(() => ({ ...cmsInputs, icon: iconInput }), [cmsInputs])
  const pickerSchema = useMemo(() => pickerFields(state), [state])
  const form = useRef<FormHandle>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const [page, setPage] = useState(2)
  const grid = useRows(gridType)
  useEffect(() => grid.setRows(gridEntries.map((entry) => grid.check({ entry, values: entry.values }))), [])

  // What a row looks like once the server refuses it
  const refuse = () =>
    grid.setRows((rows) =>
      rows?.map((row, index) =>
        index === 0
          ? grid.check({
              ...row,
              failed: { publish: false, messages: { name: ['Another product here already uses this name.'] } },
            })
          : row,
      ),
    )

  return (
    <div className='cms-design'>
      <PageHeader title='Design system' />
      <p>
        The admin's tokens and components in the current theme. Only <code>iight dev</code> shows this page, and{' '}
        <code>DESIGN.md</code> has the plan.
      </p>
      <ThemeSwitch />

      <h2>Colour</h2>
      <ul className='cms-design__swatches'>
        {colours.map((name) => (
          <li key={name}>
            <span className='cms-design__swatch' style={{ background: `var(${name})` }} />
            <code>{name}</code>
            {token(name)}
          </li>
        ))}
      </ul>

      <h2>Contrast</h2>
      <table className='cms-table'>
        <thead>
          <tr>
            <th>Sample</th>
            <th>Pair</th>
            <th>Ratio</th>
            <th>Needs</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(([foreground, background, minimum]) => {
            const ratio = contrast(token(foreground), token(background))
            return (
              <tr key={`${foreground} ${background}`}>
                <td>
                  <span
                    className='cms-design__sample'
                    style={{
                      color: `var(${foreground})`,
                      background: `var(${background})`,
                      // The 3:1 pairs are edges, so they show as one
                      borderColor: minimum < 4.5 ? `var(${foreground})` : 'transparent',
                    }}
                  >
                    Aa
                  </span>
                </td>
                <td>
                  <code>{foreground}</code> on <code>{background}</code>
                </td>
                <td>{ratio.toFixed(2)}:1</td>
                <td className={ratio < minimum ? 'cms-design__fails' : undefined}>
                  {minimum}:1, {ratio < minimum ? 'fails' : 'passes'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <h2>Type</h2>
      {steps.map((step) => (
        <p key={step} style={{ fontSize: `var(--cms-text-${step})`, lineHeight: `var(--cms-leading-${step})` }}>
          <code>--cms-text-{step}</code>, {token(`--cms-text-${step}`)} on {token(`--cms-leading-${step}`)}: Archive the
          blog post, then restore it.
        </p>
      ))}

      <h2>Spacing</h2>
      <ul className='cms-design__scale'>
        {sizes.map((name) => (
          <li key={name}>
            <span className='cms-design__bar' style={{ width: `var(${name})` }} />
            <code>{name}</code>
            {token(name)}
          </li>
        ))}
      </ul>

      <h2>Radius and elevation</h2>
      <ul className='cms-design__boxes'>
        {radii.map((name) => (
          <li key={name} style={{ borderRadius: `var(${name})` }}>
            <code>{name}</code>
          </li>
        ))}
        {shadows.map((name) => (
          <li key={name} style={{ boxShadow: `var(${name})` }}>
            <code>{name}</code>
          </li>
        ))}
      </ul>

      <h2>Buttons</h2>
      <p>Hover over them or tab to them for their other states.</p>
      {[false, true].map((disabled) => (
        <div key={String(disabled)} className='actions'>
          {buttons.map(([label, className]) => (
            <button key={label} type='button' className={className} disabled={disabled}>
              {disabled ? `${label}, disabled` : label}
            </button>
          ))}
        </div>
      ))}
      <div className='actions'>
        <IconButton label='Move up' onClick={() => toast('Moved up')}>
          <ArrowUp />
        </IconButton>
        <IconButton label='Move down' disabled onClick={() => {}}>
          <ArrowDown />
        </IconButton>
        <button type='button' className='iight-button' onClick={() => toast('Saved')}>
          Show a toast
        </button>
        <button
          type='button'
          className='iight-button'
          onClick={async () => {
            const sure = await confirm({
              title: 'Delete the sample for good?',
              body: 'This only shows the dialog. Nothing is deleted.',
              action: 'Delete for good',
              danger: true,
            })
            toast(sure ? 'Went ahead' : 'Cancelled')
          }}
        >
          Ask to confirm
        </button>
      </div>

      <h2>Notices and badges</h2>
      {(['info', 'success', 'warning', 'danger'] as const).map((tone) => (
        <Notice key={tone} tone={tone}>
          The {tone} tone.
        </Notice>
      ))}
      <div className='actions'>
        {(['neutral', 'accent', 'success', 'warning', 'danger'] as const).map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>

      <h2>Publishing</h2>
      <p>
        An entry's status shows in its editor's header and in its list. The editor's panel has Save draft and Publish at
        the top, which saves the form and makes it the live copy, and Unpublish at the bottom once there's a live copy.
        Its versions show the current one and the live one until all of them are asked for. Other editors' panels have
        Save at the top and Delete at the bottom. Below 64rem the top is a bar fixed to the bottom of the window, and
        the rest follows the form, but here the panels stay as they are.
      </p>
      <div className='actions'>
        {(['draft', 'published', 'changed'] as const).map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </div>
      <PanelSlot.Provider value={null}>
        <ul className='cms-design__panels'>
          {panels.map(({ label, ...panel }) => (
            <li key={label}>
              <h3>{label}</h3>
              <EntryPanel {...panel} />
            </li>
          ))}
        </ul>
      </PanelSlot.Provider>

      <h2>Versions</h2>
      <p>
        Each version in an entry's history links to its page, where its name goes first, with its number under it, and a
        version that went live says who published it last. The page compares the version with the one before it, or with
        another picked, such as the live one, from the older to the newer. It shows each changed field by its path of
        labels, a long text's words added and removed, a list's items matched by position, and entries' titles and
        files' names for links. As JSON, it shows both versions' values a line at a time, keys in order, with the lines
        added and removed.
      </p>
      <Form
        schema={[
          {
            name: 'against',
            label: 'Compare with',
            type: 'select',
            options: {
              placeholder: 'Nothing, so every field counts as added',
              choices: [
                { value: '6', label: 'Version 6' },
                { value: '5', label: 'Launch copy (version 5, live)' },
              ],
            },
          },
          {
            name: 'view',
            label: 'Show changes',
            type: 'radio',
            options: {
              choices: [
                { value: 'fields', label: 'By field' },
                { value: 'json', label: 'As JSON' },
              ],
            },
          },
        ]}
        values={{ against: '6', view: 'json' }}
      />
      <dl className='cms-pairs'>
        <div>
          <dt>Before</dt>
          <dd>Version 6 · Levi · 28 Oct, 14:06</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>Version 7 (current) · Levi · 29 Oct, 14:07</dd>
        </div>
      </dl>
      <ChangeList changes={sampleChanges} links={sampleLinks} />
      <h3>As JSON</h3>
      <JsonChanges before={sampleBefore} after={sampleAfter} />
      <PanelSlot.Provider value={null}>
        <ul className='cms-design__panels'>
          {versionPanels.map(({ label, ...panel }) => (
            <li key={label}>
              <h3>{label}</h3>
              <VersionPanel {...panel} />
            </li>
          ))}
        </ul>
      </PanelSlot.Provider>

      <h2>Bulk editing</h2>
      <p>
        Ticking entries in a list, and the grid that Bulk edit opens them in. Its cells show their values as the list
        does. An edited cell is tinted, a refused one is outlined with its messages, and a field its conditions hide
        says so. Specs opens in a dialog.
      </p>
      <div className='cms-header__actions'>
        <span className='cms-muted'>1 selected</span>
        <button type='button' className='iight-button' onClick={() => toast('Opened the grid')}>
          <Sheet /> Bulk edit
        </button>
      </div>
      <table className='cms-table'>
        <thead>
          <tr>
            <th className='cms-table__tick'>
              <label>
                <input
                  type='checkbox'
                  aria-label='Select every entry on this page'
                  ref={(box) => {
                    if (box) box.indeterminate = true
                  }}
                />
              </label>
            </th>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          {gridEntries.map(({ id, values }, index) => (
            <tr key={id} className={index === 0 ? 'cms-table__selected' : undefined}>
              <td className='cms-table__tick'>
                <label>
                  <input
                    type='checkbox'
                    aria-label={`Select ${values.name || 'Untitled'}`}
                    defaultChecked={index === 0}
                  />
                </label>
              </td>
              <td>{values.name || 'Untitled'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {grid.rows && <Grid type={gridType} columns={gridColumns} rows={grid.rows} onChange={grid.change} />}
      <div className='actions'>
        <button type='button' className='iight-button' onClick={refuse}>
          Refuse the first row
        </button>
      </div>

      <h2>Shared groups</h2>
      <p>
        The type editor lists a type's groups beside its form, at any depth. Its own can become a shared group or give
        way to one, each through a dialog, and a use links to the shared group its fields come from.
      </p>
      <GroupsContext.Provider value={sampleGroups}>
        <PanelSlot.Provider value={null}>
          <ul className='cms-design__panels'>
            {['editable', 'read-only'].map((state) => (
              <li key={state}>
                <h3>{state === 'editable' ? 'In iight dev' : 'Read-only'}</h3>
                <Panel label='Details'>
                  <TypeGroups
                    fields={groupFields(state)}
                    editable={state === 'editable'}
                    onMakeShared={(field) => toast(`Opens Make ${field.label} shared`)}
                    onUseShared={(field) => toast(`Opens Use a shared group for ${field.label}`)}
                  />
                </Panel>
              </li>
            ))}
          </ul>
        </PanelSlot.Provider>
      </GroupsContext.Provider>

      <h2>Media cards</h2>
      <ul className='cms-media-grid'>
        {sampleFiles.map((media, index) => (
          <li key={media.id}>
            <MediaCard media={media} chosen={index === 1} onClick={() => toast(`Picked ${media.name}`)} />
          </li>
        ))}
      </ul>

      <h2>Empty, loading and pages</h2>
      <EmptyState
        icon={<Inbox />}
        action={
          <button type='button' className='iight-button iight-button--primary' onClick={() => toast('Made one')}>
            Make one
          </button>
        }
      >
        Nothing here yet.
      </EmptyState>
      <Loading />
      <Pages pagination={{ page, perPage: 15, total: 34, lastPage: 3 }} onPage={setPage} />

      <h2>Core's inputs</h2>
      <Form schema={stateSchema} onValuesChange={(values) => setState(values.state)} />
      <div className='actions'>
        <button type='button' className='iight-button' onClick={() => form.current?.validate()}>
          Check every input
        </button>
      </div>
      <Form key={state} ref={form} schema={schema} />

      <h2>Pickers</h2>
      <Form key={`pickers ${state}`} schema={pickerSchema} inputs={pickerInputs} />
    </div>
  )
}
