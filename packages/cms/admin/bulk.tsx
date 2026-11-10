import { idsOf } from '../src/fields'
import { ContentType, Entry, api, count, errorMessage, formatValue, listView, titleOf, usePageView } from './api'
import { AssistantContext, useBeside } from './chat'
import { same } from './compare'
import { CellText, FieldValue } from './entries'
import { useInputs, useLinkNames } from './fields'
import { hundredOf, ticksOf } from './lists'
import {
  Badge,
  Dialog,
  EmptyState,
  Loading,
  Notice,
  PageHeader,
  Pages,
  Panel,
  StatusBadge,
  useConfirm,
  useToast,
} from './ui'
import Form, {
  FieldSchema,
  FlatValidationReport,
  ValidationReport,
  flattenValidationReport,
  inputs as coreInputs,
  validateValues,
} from '@sorlo/core'
import { Columns3, Sheet } from 'lucide-react'
import {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

// Bulk editing: the entries ticked in a list as a grid, a row for each and a column for each
// field, edited cell by cell and saved together

// A column: one of the type's fields, or a field of a group inside it, found by its path of names, such as seo.title
export interface Column {
  key: string
  path: Array<string>
  labels: Array<string>
  field: FieldSchema
}

// Fields too big for a cell, which open in a dialog
const dialogTypes = new Set(['repeater', 'matrix', 'flexible', 'relationship', 'media', 'schemabuilder', 'conditions'])

// Every column a type's grid can show. A group's fields become columns of their own, and so do those of the groups
// inside it. Content and hidden fields have nothing to edit.
export const columnsOf = (
  fields: Array<FieldSchema>,
  path: Array<string> = [],
  labels: Array<string> = [],
): Array<Column> =>
  fields.flatMap((field) => {
    const at = [...path, field.name]
    const named = [...labels, field.label ?? field.name]
    if (field.type === 'group') return columnsOf(field.options?.fields ?? [], at, named)
    if (field.type === 'content' || field.type === 'hidden') return []
    return [{ key: at.join('.'), path: at, labels: named, field }]
  })

// A column's name as a screen reader says it, since › reads badly
const spoken = (column: Column) => column.labels.join(': ')

const getIn = (values: any, path: Array<string>) => path.reduce((value, name) => value?.[name], values)

const setIn = (values: any, [name, ...rest]: Array<string>, value: unknown): Record<string, any> => ({
  ...values,
  [name]: rest.length ? setIn(values?.[name], rest, value) : value,
})

// The fields whose values differ from those saved. A group's fields are compared one by one, so it holds just those
// that changed, which the bulk route merges into what's saved.
export function changes(fields: Array<FieldSchema>, values: any, saved: any) {
  const changed: Record<string, any> = {}
  for (const field of fields) {
    const value = values?.[field.name]
    if (field.type !== 'group') {
      if (!same(value, saved?.[field.name])) changed[field.name] = value
      continue
    }
    const inner = changes(field.options?.fields ?? [], value, saved?.[field.name])
    if (Object.keys(inner).length) changed[field.name] = inner
  }
  return changed
}

// What a repeater, matrix or flexible cell shows of its value
const summaries: Record<string, (value: Array<any>) => string> = {
  repeater: (value) => count(value.length, 'item', 'items'),
  matrix: (value) => `${count(value.length, 'row', 'rows')} by ${count(value[0]?.length ?? 0, 'column', 'columns')}`,
  flexible: (value) => count(value.length, 'block', 'blocks'),
}

// A row of the grid: the entry as it was last loaded or saved, its values as they stand, and their check
export interface GridRow {
  entry: Entry
  values: Record<string, any>
  report: FlatValidationReport
  // Set when a save leaves the row out or the server refuses it, until it saves: the server's messages by field path,
  // or its message for the whole row. Once a publish has failed it, the row is checked in full.
  failed?: { publish: boolean; messages: Record<string, Array<string>>; message?: string }
}

// Core's inputs and the CMS's own, for checking values
function useAllInputs() {
  const cmsInputs = useInputs()
  return useMemo(() => ({ ...coreInputs, ...cmsInputs }), [cmsInputs])
}

// A grid's rows, each checked as it changes the way the entry editor checks its form: with allowIncomplete while the
// type has drafts, and in full for a type without them or once a publish has failed the row
export function useRows(type: ContentType) {
  const inputs = useAllInputs()
  const [rows, setRows] = useState<Array<GridRow>>()

  const check = useCallback(
    (row: Omit<GridRow, 'report'>): GridRow => {
      const allowIncomplete = type.drafts !== false && !row.failed?.publish
      const report = validateValues(type.fields, row.values, inputs, { allowIncomplete })
      return { ...row, report: flattenValidationReport(report) }
    },
    [type, inputs],
  )

  // Sets a cell's value, dropping what the server said about it
  const change = useCallback(
    (index: number, path: Array<string>, value: unknown) => {
      const key = path.join('.')
      const kept = (messages: Record<string, Array<string>>) =>
        Object.fromEntries(Object.entries(messages).filter(([at]) => at !== key && !at.startsWith(`${key}.`)))
      setRows((rows) =>
        rows?.map((row, at) =>
          at !== index
            ? row
            : check({
                ...row,
                values: setIn(row.values, path, value),
                failed: row.failed && { ...row.failed, messages: kept(row.failed.messages) },
              }),
        ),
      )
    },
    [check],
  )

  return { rows, setRows, check, change }
}

// The titles of the entries and the names of the files that link cells hold
function useLinks(rows: Array<GridRow>, columns: Array<Column>) {
  const held = (kind: string) =>
    columns
      .filter((column) => column.field.type === kind)
      .flatMap((column) => rows.flatMap((row) => idsOf(getIn(row.values, column.path))))
  return useLinkNames(held('relationship'), held('media'))
}

// What a cell shows of its value: what the list shows, a summary of a list's items, or what a link holds
function CellValue({ field, value, links }: { field: FieldSchema; value: any; links: Record<string, string | null> }) {
  if (field.type === 'relationship' || field.type === 'media') {
    const ids = idsOf(value)
    const gone = field.type === 'media' ? 'A deleted file' : 'A deleted entry'
    const loaded = ids.every((id) => links[id] !== undefined)
    return <CellText text={loaded ? ids.map((id) => links[id] ?? gone).join(', ') : formatValue(field, value)} />
  }
  if (summaries[field.type]) {
    return <CellText text={Array.isArray(value) && value.length ? summaries[field.type](value) : ''} />
  }
  return <FieldValue field={field} value={value} />
}

// Widths in rem, since a fixed layout keeps columns still while a cell's input comes and goes
const widthOf = (field: FieldSchema) =>
  ({ boolean: 6, number: 8, range: 8, color: 8, date: 9, time: 9, datetime: 12, textarea: 18 })[field.type] ?? 14
const statusWidth = 12

// Keys that move between cells, as in a spreadsheet
const moves: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
}

// What Tab moves between inside an input, such as a checkbox field's boxes
const focusable = 'input:not([type=hidden]), select, textarea, button, a[href]'

interface Editing {
  row: number
  column: number
  // What Escape puts back
  original: unknown
  // What the field's form starts from and shows, made once, since the form takes up a new one and drops what was typed
  schema: Array<FieldSchema>
  shown: Record<string, any>
  dialog: boolean
}

interface RowProps {
  type: ContentType
  columns: Array<Column>
  // Every column the type has, for naming the fields that aren't shown
  every: Array<Column>
  row: GridRow
  index: number
  // The row's cell that Tab reaches, or -1
  active: number
  // The row's cell holding an input, and the input
  editing: number
  editor: ReactNode
  links: Record<string, string | null>
}

// One entry's row. It renders again only when the row, or what's active or edited in it, changes.
const GridRowView = memo(function GridRowView({
  type,
  columns,
  every,
  row,
  index,
  active,
  editing,
  editor,
  links,
}: RowProps) {
  const { messages, validity } = row.report
  const said = row.failed?.messages ?? {}
  const edited = Object.keys(changes(type.fields, row.values, row.entry.values)).length > 0

  // What's wrong with fields that no column shows, named by their columns, or by their paths
  const covered = (key: string) => columns.some((column) => key === column.key || key.startsWith(`${column.key}.`))
  const elsewhere = Object.entries({ ...messages, ...said })
    .filter(([key]) => !covered(key))
    .map(([key, list]) => {
      const column = every.find((column) => key === column.key || key.startsWith(`${column.key}.`))
      return `${column ? column.labels.join(' › ') : key}: ${list.join(' ')}`
    })
  const problems = [...(row.failed?.message ? [row.failed.message] : []), ...elsewhere]

  return (
    <tr className={row.failed ? 'cms-grid__failed' : undefined}>
      {columns.map((column, at) => {
        const Cell = at === 0 ? 'th' : 'td'
        const value = getIn(row.values, column.path)
        const shown = column.key in validity
        const own = [...new Set([...(messages[column.key] ?? []), ...(said[column.key] ?? [])])]
        const inside = new Set(
          [...Object.keys(messages), ...Object.keys(said)].filter((key) => key.startsWith(`${column.key}.`)),
        ).size
        const changed = !same(value, getIn(row.entry.values, column.path))
        const locked = !shown || column.field.readonly || column.field.disabled
        const classes = [
          changed && 'cms-grid__changed',
          editing === at && 'cms-grid__editing',
          ['number', 'range'].includes(column.field.type) && 'cms-table__number',
        ]

        return (
          <Cell
            key={column.key}
            scope={at === 0 ? 'row' : undefined}
            data-cell={`${index} ${at}`}
            tabIndex={active === at ? 0 : -1}
            className={classes.filter(Boolean).join(' ') || undefined}
            aria-invalid={own.length + inside > 0 || undefined}
            aria-readonly={locked || undefined}
            aria-haspopup={!locked && dialogTypes.has(column.field.type) ? 'dialog' : undefined}
          >
            {editing === at ? (
              editor
            ) : shown ? (
              <span className='cms-grid__value'>
                <CellValue field={column.field} value={value} links={links} />
                {changed && <span className='cms-visually-hidden'>, edited</span>}
              </span>
            ) : (
              <span className='cms-muted'>
                Hidden<span className='cms-visually-hidden'> by its conditions</span>
              </span>
            )}
            {editing !== at && own.length + inside > 0 && (
              <ul className='cms-grid__messages'>
                {own.map((message) => (
                  <li key={message}>{message}</li>
                ))}
                {inside > 0 && (
                  <li>{inside === 1 ? 'A field in it needs fixing.' : `${inside} fields in it need fixing.`}</li>
                )}
              </ul>
            )}
          </Cell>
        )
      })}
      <td
        data-cell={`${index} ${columns.length}`}
        tabIndex={active === columns.length ? 0 : -1}
        className='cms-grid__status'
        aria-readonly
        aria-invalid={problems.length > 0 || undefined}
      >
        {type.drafts !== false && <StatusBadge status={row.entry.status} />}
        {edited && <Badge tone='accent'>Edited</Badge>}
        {row.failed && <Badge tone='danger'>Not saved</Badge>}
        {problems.length > 0 && (
          <ul className='cms-grid__messages'>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  )
})

// The grid: a cell for each of the columns' fields in each row, then each row's status. Arrow keys move between cells,
// and Tab along a row and out of the grid at its ends. Enter, F2 or a click edits a cell with its core input, the only
// input the grid holds, or opens a list or link field in a dialog. In a cell's input, Enter keeps the value and moves
// down, Tab keeps it and moves along, and Escape puts back what was there.
export function Grid({
  type,
  columns,
  rows,
  onChange,
}: {
  type: ContentType
  columns: Array<Column>
  rows: Array<GridRow>
  onChange: (index: number, path: Array<string>, value: unknown) => void
}) {
  const table = useRef<HTMLTableElement>(null)
  const inputs = useInputs()
  const links = useLinks(rows, columns)
  const every = useMemo(() => columnsOf(type.fields), [type])
  const [active, setActive] = useState<[number, number]>([0, 0])
  const [editing, setEditing] = useState<Editing>()
  const last = columns.length
  const [activeRow, activeColumn] = [Math.min(active[0], rows.length - 1), Math.min(active[1], last)]

  const cell = (row: number, column: number) =>
    table.current?.querySelector<HTMLElement>(`[data-cell="${row} ${column}"]`)
  const clamp = (row: number, column: number): [number, number] => [
    Math.max(0, Math.min(rows.length - 1, row)),
    Math.max(0, Math.min(last, column)),
  ]

  const edit = (row: number, column: number) => {
    const target = columns[column]
    if (!target || !(target.key in rows[row].report.validity) || target.field.readonly || target.field.disabled) return

    const { field, path } = target
    const values = rows[row].values
    const title = titleOf(type, { ...rows[row].entry, values })
    const dialog = dialogTypes.has(field.type)
    // The row's values, then those of the groups around the field, so an identifier's source finds its field. The
    // grid shows only the fields that the row's conditions show, so the input's own conditions go.
    const scope = path
      .slice(0, -1)
      .reduce((scope, _, depth) => ({ ...scope, ...getIn(values, path.slice(0, depth + 1)) }), values)
    const label = dialog ? field.label : `${spoken(columns[column])} for ${title}`
    setEditing({
      row,
      column,
      original: getIn(values, path),
      schema: [
        {
          ...field,
          label,
          conditions: undefined,
          instructions: dialog ? field.instructions : undefined,
          width: undefined,
        },
      ],
      shown: { ...scope, [field.name]: getIn(values, path) },
      dialog,
    })
  }

  // An input takes focus as it opens, with the caret after its text, as a spreadsheet puts it
  useEffect(() => {
    if (!editing || editing.dialog) return
    const control = cell(editing.row, editing.column)?.querySelector<HTMLElement>(focusable)
    control?.focus()
    const text = control instanceof HTMLInputElement && /^(text|email|url|tel|search)$/.test(control.type)
    if (text || control instanceof HTMLTextAreaElement)
      control.setSelectionRange(control.value.length, control.value.length)
  }, [editing])

  // Ends an edit, keeping its value or putting back the one it started from, and moves focus to a cell
  const finish = (keep: boolean, [row, column]: [number, number]) => {
    if (!editing) return
    if (!keep) onChange(editing.row, columns[editing.column].path, editing.original)
    setEditing(undefined)
    cell(row, column)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement
    const at = target.closest<HTMLElement>('[data-cell]')
    if (!at) return
    const [row, column] = at.dataset.cell!.split(' ').map(Number)
    const back = event.shiftKey

    if (target !== at) {
      // In a cell's input. Shift+Enter starts a new line in a textarea, and Tab moves between an input's own controls,
      // where a group of radios is one.
      const radios = (control: HTMLElement) =>
        control !== target &&
        control instanceof HTMLInputElement &&
        control.type === 'radio' &&
        control.name === (target as HTMLInputElement).name
      const controls = [...at.querySelectorAll<HTMLElement>(focusable)].filter((control) => !radios(control))
      const index = controls.indexOf(target)
      if (event.key === 'Escape') finish(false, [row, column])
      else if (event.key === 'Enter' && !(back && target instanceof HTMLTextAreaElement)) {
        finish(true, clamp(row + (back ? -1 : 1), column))
      } else if (event.key === 'Tab' && (back ? index <= 0 : index === controls.length - 1)) {
        finish(true, clamp(row, column + (back ? -1 : 1)))
      } else return
      return event.preventDefault()
    }

    const move = moves[event.key]
    const corner = event.ctrlKey || event.metaKey
    if (move) cell(...clamp(row + move[0], column + move[1]))?.focus()
    else if (event.key === 'Home') cell(corner ? 0 : row, 0)?.focus()
    else if (event.key === 'End') cell(corner ? rows.length - 1 : row, last)?.focus()
    else if (event.key === 'Tab') {
      // Along the row, then out of the grid at either end of it
      const next = column + (back ? -1 : 1)
      if (next < 0 || next > last) return
      cell(row, next)?.focus()
    } else if (event.key === 'Enter' || event.key === 'F2') edit(row, column)
    else return
    event.preventDefault()
  }

  const onClick = (event: MouseEvent<HTMLTableElement>) => {
    const at = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]')
    if (!at) return
    const [row, column] = at.dataset.cell!.split(' ').map(Number)
    if (editing?.row !== row || editing.column !== column) edit(row, column)
  }

  // Tab comes back to the cell that last had focus. Focus alone doesn't always bring a cell into a narrow box, as
  // beside the panel at 1024px, so it scrolls in clear of the column that stays on the left.
  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    if (event.target.matches('[data-cell]')) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const [row, column] = event.target.closest<HTMLElement>('[data-cell]')?.dataset.cell?.split(' ').map(Number) ?? []
    if (row !== undefined) setActive((now) => (now[0] === row && now[1] === column ? now : [row, column]))
  }

  // Leaving a cell's input for another cell or the rest of the page keeps its value. Focus going nowhere, as when
  // the window loses it, leaves the input open.
  const onBlur = (event: FocusEvent<HTMLTableElement>) => {
    if (!editing || editing.dialog || !event.relatedTarget) return
    if (!cell(editing.row, editing.column)?.contains(event.relatedTarget)) setEditing(undefined)
  }

  const editingColumn = editing && columns[editing.column]
  const editor = editing && !editing.dialog && (
    <Form
      schema={editing.schema}
      values={editing.shown}
      inputs={inputs}
      onValuesChange={(values) => onChange(editing.row, editingColumn!.path, values[editingColumn!.field.name])}
    />
  )

  return (
    <>
      <div
        className='cms-table-wrap cms-grid-wrap'
        // A focused cell scrolls into view clear of the column that stays on the left
        style={{ scrollPaddingLeft: columns[0] && `${widthOf(columns[0].field)}rem` }}
      >
        <table
          ref={table}
          className='cms-table cms-grid'
          role='grid'
          aria-label={type.label}
          aria-describedby='cms-grid-keys'
          style={{ width: `${columns.reduce((sum, column) => sum + widthOf(column.field), statusWidth)}rem` }}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: `${widthOf(column.field)}rem` }} />
            ))}
            <col style={{ width: `${statusWidth}rem` }} />
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope='col'
                  className={['number', 'range'].includes(column.field.type) ? 'cms-table__number' : undefined}
                  aria-label={column.labels.length > 1 ? spoken(column) : undefined}
                >
                  {column.labels.join(' › ')}
                </th>
              ))}
              <th scope='col'>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <GridRowView
                key={row.entry.id}
                type={type}
                columns={columns}
                every={every}
                row={row}
                index={index}
                active={index === activeRow ? activeColumn : -1}
                editing={editing?.row === index && !editing.dialog ? editing.column : -1}
                editor={editing?.row === index ? editor : null}
                links={links}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p id='cms-grid-keys' className='cms-grid__keys cms-muted'>
        Arrow keys move between cells. Enter or a click edits one, then Enter or Tab keeps the change and moves on, and
        Escape puts back what was there. Shift+Enter starts a new line in long text.
      </p>

      {editing?.dialog && (
        <CellDialog
          title={`${spoken(editingColumn!)} for ${titleOf(type, { ...rows[editing.row].entry, values: rows[editing.row].values })}`}
          editing={editing}
          inputs={inputs}
          onDone={(value) => onChange(editing.row, editingColumn!.path, value)}
          onClose={() => {
            setEditing(undefined)
            cell(editing.row, editing.column)?.focus()
          }}
        />
      )}
    </>
  )
}

// A whole list or link field in a dialog, kept with Done, and dropped with Cancel, Close or Escape
function CellDialog({
  title,
  editing,
  inputs,
  onDone,
  onClose,
}: {
  title: string
  editing: Editing
  inputs: Record<string, any>
  onDone: (value: unknown) => void
  onClose: () => void
}) {
  const name = editing.schema[0].name
  const [value, setValue] = useState(editing.shown[name])
  // Closing the dialog itself hands focus back to the cell
  const close = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget.closest('dialog')?.close()

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <div className='cms-dialog-actions'>
          <button type='button' className='sorlo-button' onClick={close}>
            Cancel
          </button>
          <button
            type='button'
            className='sorlo-button sorlo-button--primary'
            onClick={(event) => {
              onDone(value)
              close(event)
            }}
          >
            Done
          </button>
        </div>
      }
    >
      <Form
        schema={editing.schema}
        values={editing.shown}
        inputs={inputs}
        onValuesChange={(values) => setValue(values[name])}
      />
    </Dialog>
  )
}

// Which columns a type's grid shows, remembered in this browser. It starts with the title field and the list columns.
function useChosenColumns(type: ContentType, columns: Array<Column>) {
  const key = `sorlo-bulk-columns-${type.name}`
  const [chosen, setChosen] = useState<Array<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (Array.isArray(saved) && columns.some((column) => saved.includes(column.key))) return saved
    } catch {}
    const names = [type.titleField, ...(type.listColumns ?? [])]
    const found = columns.filter((column) => names.includes(column.path[0]))
    return (found.length ? found : columns.slice(0, 1)).map((column) => column.key)
  })

  const choose = (next: Array<string>) => {
    setChosen(next)
    // Without storage, the choice lasts until the page reloads
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {}
  }
  return [chosen, choose] as const
}

// A dialog of the fields the grid can show, which shows each one as it's ticked
function ColumnsMenu({
  columns,
  chosen,
  onChoose,
}: {
  columns: Array<Column>
  chosen: Array<string>
  onChoose: (keys: Array<string>) => void
}) {
  // What the form starts from while it's open
  const [shown, setShown] = useState<{ columns: Array<string> }>()
  const schema = useMemo<Array<FieldSchema>>(() => {
    const choices = columns.map((column) => ({ value: column.key, label: column.labels.join(' › ') }))
    return [{ type: 'checkbox', name: 'columns', label: 'Fields', required: true, options: { choices } }]
  }, [columns])

  return (
    <>
      <button type='button' className='sorlo-button' onClick={() => setShown({ columns: chosen })}>
        <Columns3 /> Columns
      </button>
      {shown && (
        <Dialog title='Columns' onClose={() => setShown(undefined)}>
          <Form
            schema={schema}
            values={shown}
            // The grid keeps at least one column, which the field asks for
            onValuesChange={(values) => values.columns?.length && onChoose(values.columns)}
          />
        </Dialog>
      )}
    </>
  )
}

// What the bulk route replies for each entry it was sent: the saved entry, core's report, or why it can't be saved
interface Result {
  id: string
  status: number
  data?: Entry
  report?: ValidationReport
  message?: string
}

// The page for the entries ticked in a type's list, up to 100 of them, with Save, and Publish while the type has
// drafts. Each sends the edited rows that pass their checks, every check for Publish. The rows that save take what
// was saved, and the rest stay highlighted with their messages, with focus on the first cell to fix. Past a hundred
// ticked, its address names one hundred of them, and its pages go through the rest, asking first before they leave
// edits unsaved.
export function BulkEditor({ type, ids }: { type: ContentType; ids: Array<string> }) {
  // The grid's rows are the entries that were ticked, which the assistant beside it takes "these" to be
  usePageView(
    listView(type, { ticked: ids, where: [], order: undefined, searched: false, filtered: false, archived: false }),
  )
  const toast = useToast()
  const confirm = useConfirm()
  const inputs = useAllInputs()
  const area = useRef<HTMLDivElement>(null)
  // The list's ticks as the grid opened, and which hundred of them it shows, while there are more
  const [ticked] = useState(() => [...ticksOf(type.name).ticked])
  const pages = hundredOf(ticked, ids)
  const { rows, setRows, check, change } = useRows(type)
  const every = useMemo(() => columnsOf(type.fields), [type])
  const [chosen, choose] = useChosenColumns(type, every)
  const columns = useMemo(() => every.filter((column) => chosen.includes(column.key)), [every, chosen])
  const [error, setError] = useState('')
  const [gone, setGone] = useState(0)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState<string>()
  // Counts the saves that left rows to fix, each moving focus to the first of them once it's shown
  const [failures, setFailures] = useState(0)
  const drafts = type.drafts !== false
  const wanted = ids.slice(0, 100)
  const assistant = useContext(AssistantContext)

  const load = async () => {
    if (!wanted.length) return setRows([])
    const where = encodeURIComponent(JSON.stringify([[{ field: 'id', op: 'in', value: wanted }]]))
    await api('GET', `/types/${type.name}/entries?perPage=100&where=${where}`)
      .then(({ body }) => {
        const found: Array<Entry> = wanted.flatMap((id) => body.data.filter((entry: Entry) => entry.id === id))
        setRows(found.map((entry) => check({ entry, values: entry.values })))
        setGone(wanted.length - found.length)
      })
      .catch((error) => setError(errorMessage(error)))
  }

  useEffect(() => void load(), [])

  // The first cell to fix, or the row's status when what's wrong isn't in a column
  useEffect(() => {
    const failed = failures ? area.current?.querySelector('.cms-grid__failed') : undefined
    failed?.querySelector<HTMLElement>('[aria-invalid="true"], .cms-grid__status')?.focus()
  }, [failures])

  const edited = (rows ?? []).filter((row) => Object.keys(changes(type.fields, row.values, row.entry.values)).length)

  // Once a proposal for one of its entries is applied, the grid loads them again, after the person has saved its edits,
  // since a save would send back what the grid showed before
  useBeside({
    shows: (proposal) =>
      (proposal.kind === 'entry' && !!rows?.some((row) => row.entry.id === proposal.targetId)) ||
      (proposal.kind === 'type' && proposal.targetId === type.id),
    touched: () => edited.length > 0,
    reload: load,
  })

  const save = async (publish: boolean) => {
    if (busy || !rows) return
    if (!edited.length) return toast('Nothing has changed yet')
    setBusy(publish ? 'publish' : 'save')
    setProblem('')

    try {
      const full = publish || !drafts
      const passing = edited.filter(
        (row) => validateValues(type.fields, row.values, inputs, { allowIncomplete: !full }).isValid,
      )
      const entries = passing.map((row) => ({
        id: row.entry.id,
        values: changes(type.fields, row.values, row.entry.values),
      }))
      const results: Array<Result> = entries.length
        ? (await api('PATCH', `/types/${type.name}/entries`, { publish, entries })).body.data
        : []

      const sent = new Map(edited.map((row) => [row.entry.id, row]))
      const replies = new Map(results.map((result) => [result.id, result]))
      setRows((rows) =>
        rows?.map((row) => {
          const before = sent.get(row.entry.id)
          if (!before) return row
          const result = replies.get(row.entry.id)
          // Edits made while it saved stay, as changes to what was saved
          if (result?.data) {
            return check({ entry: result.data, values: row.values === before.values ? result.data.values : row.values })
          }
          const messages = result?.report ? flattenValidationReport(result.report).messages : {}
          return check({ ...row, failed: { publish: full, messages, message: result?.message } })
        }),
      )

      const saved = results.filter((result) => result.data).length
      if (saved) toast(`${publish ? 'Published' : 'Saved'} ${count(saved, 'entry', 'entries')}`)
      // The assistant's proposals for these entries show their status as it is now
      if (saved) void assistant?.refresh()
      const left = edited.length - saved
      if (left) {
        const rows = left === 1 ? 'A row needs fixing before it' : `${left} rows need fixing before they`
        setProblem(`${rows} can be ${publish ? 'published' : 'saved'}.`)
        setFailures((count) => count + 1)
      }
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(undefined)
    }
  }

  // Edits are lost once another hundred opens
  const turn = async (page: number) => {
    const sure =
      !edited.length ||
      (await confirm({
        title: `Leave ${count(edited.length, 'edited row', 'edited rows')} unsaved?`,
        body: 'Their edits are lost once another hundred opens. Save first to keep them.',
        action: 'Leave unsaved',
        danger: true,
      }))
    if (sure) location.hash = `#/types/${type.name}/bulk/${ticked.slice((page - 1) * 100, page * 100).join(',')}`
  }

  const back = { href: `#/types/${type.name}`, label: type.label }
  return (
    <div ref={area} className='cms-page'>
      <PageHeader
        back={back}
        title={`${type.label}: bulk edit`}
        meta={rows && <span className='cms-muted'>{count(rows.length, 'entry', 'entries')}</span>}
      />
      <Panel
        label={`${type.label}: bulk edit`}
        problem={problem}
        actions={
          !!rows?.length && (
            <>
              <button
                type='button'
                className={drafts ? 'sorlo-button' : 'sorlo-button sorlo-button--primary'}
                aria-busy={busy === 'save'}
                onClick={() => save(false)}
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              {drafts && (
                <button
                  type='button'
                  className='sorlo-button sorlo-button--primary'
                  aria-busy={busy === 'publish'}
                  onClick={() => save(true)}
                >
                  {busy === 'publish' ? 'Publishing…' : 'Publish'}
                </button>
              )}
              <span className='cms-panel__note'>
                {edited.length ? `${count(edited.length, 'row', 'rows')} edited` : 'No changes yet'}
              </span>
            </>
          )
        }
      >
        <ColumnsMenu columns={every} chosen={chosen} onChoose={choose} />
      </Panel>

      {ids.length > wanted.length && (
        <Notice>
          Bulk editing takes up to 100 entries at a time, so {ids.length - wanted.length} of those ticked are left out.
        </Notice>
      )}
      {gone > 0 && (
        <Notice tone='warning'>
          {gone === 1 ? 'One of the ticked entries has' : `${gone} of the ticked entries have`} been archived or deleted
          since, so {gone === 1 ? "it's" : "they're"} left out.
        </Notice>
      )}
      {error && <Notice tone='danger'>{error}</Notice>}
      {!rows && !error && <Loading />}
      {rows?.length === 0 && (
        <EmptyState icon={<Sheet />} action={<a href={back.href}>Back to {type.label}</a>}>
          Tick entries in the list to edit them here.
        </EmptyState>
      )}
      {!!rows?.length && <Grid type={type} columns={columns} rows={rows} onChange={change} />}
      {pages && <Pages pagination={pages} onPage={turn} />}
    </div>
  )
}
