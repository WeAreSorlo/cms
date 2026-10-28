import { contrast, pairs } from './contrast'
import './design.scss'
import { iconInput, useInputs } from './fields'
import { Media, MediaCard } from './media'
import {
  Badge,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PageHeader,
  Pages,
  ThemeSwitch,
  useConfirm,
  useToast,
} from './ui'
import Form, { FieldSchema, FormHandle, Input, inputs } from 'iight'
import { ArrowDown, ArrowUp, Inbox } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

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
