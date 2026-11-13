import i18n from './i18n'
import { anyLayout, isJson, lexical } from './logic'
import { $isEntryLinkNode, BlockNode, BlockValidityContext, EntryLinkNode, MediaNode, pickedFiles } from './nodes'
import { PickersContext } from './pickers'
import { type Block, isEmptyTree, isTree, layoutsOf, safeUrl } from './tree'
import { $createCodeNode, $isCodeNode, CodeHighlightNode, CodeNode } from '@lexical/code'
import { $isLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import { $findMatchingParent, $insertNodeToNearestRoot } from '@lexical/utils'
import { useFieldContext } from '@sorlo/forms'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type BaseSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  type ElementNode,
  FORMAT_TEXT_COMMAND,
  type NodeKey,
  REDO_COMMAND,
  type TextFormatType,
  UNDO_COMMAND,
  mergeRegister,
} from 'lexical'
import {
  Bold,
  Code,
  FileText,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Plus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Undo2,
} from 'lucide-react'
import { type KeyboardEvent, useCallback, useContext, useEffect, useRef, useState } from 'react'

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)

const nodes = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  CodeNode,
  CodeHighlightNode,
  EntryLinkNode,
  MediaNode,
  BlockNode,
]

// Class names for Lexical's elements, so the styles reach them without styling the editor's own markup
const theme = {
  paragraph: 'sorlo-lexical__paragraph',
  quote: 'sorlo-lexical__quote',
  code: 'sorlo-lexical__code',
  link: 'sorlo-lexical__link',
  list: { nested: { listitem: 'sorlo-lexical__nested' } },
  text: {
    bold: 'sorlo-lexical__bold',
    italic: 'sorlo-lexical__italic',
    underline: 'sorlo-lexical__underline',
    strikethrough: 'sorlo-lexical__strikethrough',
    underlineStrikethrough: 'sorlo-lexical__underline-strikethrough',
    code: 'sorlo-lexical__inline-code',
  },
}

// What the selection is in, for the buttons' pressed states
interface Active {
  block: string
  formats: Set<TextFormatType>
  link: boolean
  entryLink: boolean
}

const nothingActive: Active = { block: 'paragraph', formats: new Set(), link: false, entryLink: false }

function readActive(): Active {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return nothingActive
  const anchor = selection.anchor.getNode()
  const top = anchor.getKey() === 'root' ? null : anchor.getTopLevelElement()
  const list = $findMatchingParent(anchor, $isListNode)
  const block = list
    ? list.getListType()
    : $isHeadingNode(top)
      ? top.getTag()
      : $isQuoteNode(top)
        ? 'quote'
        : $isCodeNode(top)
          ? 'code'
          : 'paragraph'
  const formats = new Set(
    (['bold', 'italic', 'strikethrough', 'code'] as const).filter((format) => selection.hasFormat(format)),
  )
  return {
    block,
    formats,
    link: !!$findMatchingParent(anchor, $isLinkNode),
    entryLink: !!$findMatchingParent(anchor, $isEntryLinkNode),
  }
}

// The editor's value as stored: Lexical's state, or null once it holds nothing
const valueOf = (state: EditorState) => {
  const json = state.toJSON() as unknown
  return isTree(json, anyLayout) && isEmptyTree(json) ? null : json
}

// Keeps the editor on the field's value when it changes from outside, as when a form is reset, but not when the
// change came from the editor
function Sync({ value, emitted }: { value: unknown; emitted: { current: unknown } }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    if (value === emitted.current || JSON.stringify(value ?? null) === JSON.stringify(emitted.current ?? null)) return
    emitted.current = value
    if (isTree(value, anyLayout)) editor.setEditorState(editor.parseEditorState(value as any))
    else editor.update(() => $getRoot().clear().append($createParagraphNode()))
  }, [value])
  return null
}

// Read-only and disabled fields can't be edited
function Editable({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => editor.setEditable(editable), [editor, editable])
  return null
}

// Rich text, and for JSON, its blocks too: Lexical with one toolbar, a single stop for Tab that the arrow keys,
// Home and End move through
export default function Editor() {
  const { id, labelId, aria, schema, required, readonly, disabled, value, handleValidation, setValid } =
    useFieldContext()
  const locked = !!(readonly || disabled)
  const emitted = useRef<unknown>(value)
  // The blocks whose fields aren't valid, by their nodes' keys
  const invalid = useRef(new Set<NodeKey>())

  const change = (state: EditorState) => {
    const next = valueOf(state)
    emitted.current = next
    const result = lexical.validateValue(next, schema)
    handleValidation({ ...result, isValid: result.isValid && !invalid.current.size })
  }

  const reportBlock = useCallback(
    (key: NodeKey, valid: boolean | undefined) => {
      const had = invalid.current.size
      if (valid === false) invalid.current.add(key)
      else invalid.current.delete(key)
      if (had !== invalid.current.size)
        setValid(invalid.current.size ? false : lexical.validateValue(emitted.current, schema).isValid)
    },
    [setValid, schema],
  )

  const initialConfig = {
    namespace: `sorlo-${id}`,
    nodes,
    theme,
    editable: !locked,
    editorState: isTree(value, anyLayout) ? JSON.stringify(value) : undefined,
    onError: (error: Error) => {
      throw error
    },
  }

  return (
    <div className='sorlo-input__richtext'>
      <LexicalComposer initialConfig={initialConfig}>
        <BlockValidityContext.Provider value={reportBlock}>
          {!locked && <Toolbar id={id} blocks={isJson(schema)} />}
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                id={id}
                className='sorlo-input sorlo-lexical__content'
                ariaLabelledBy={labelId}
                ariaDescribedBy={aria['aria-describedby']}
                ariaInvalid={aria['aria-invalid']}
                ariaRequired={required}
                ariaMultiline
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin validateUrl={safeUrl} />
          <OnChangePlugin ignoreSelectionChange onChange={change} />
          <Sync value={value} emitted={emitted} />
          <Editable editable={!locked} />
        </BlockValidityContext.Provider>
      </LexicalComposer>
    </div>
  )
}

interface Button {
  key: string
  label: string
  icon: typeof Bold
  run: () => void
  pressed?: boolean
  disabled?: boolean
}

function Toolbar({ id, blocks: withBlocks }: { id: string; blocks: boolean }) {
  const [editor] = useLexicalComposerContext()
  const pickers = useContext(PickersContext)
  const { options } = useFieldContext()
  const toolbar = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(0)
  const [active, setActive] = useState(nothingActive)
  const [history, setHistory] = useState({ undo: false, redo: false })
  // The selection a link's address or a picker is for, kept while focus is in the address or the picker's dialog
  const saved = useRef<BaseSelection | null>(null)
  const [address, setAddress] = useState<string>()
  const [problem, setProblem] = useState('')

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(({ editorState }) => editorState.read(() => setActive(readActive()))),
        editor.registerCommand(
          CAN_UNDO_COMMAND,
          (undo) => (setHistory((was) => ({ ...was, undo })), false),
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          CAN_REDO_COMMAND,
          (redo) => (setHistory((was) => ({ ...was, redo })), false),
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor],
  )

  const save = () => (saved.current = editor.getEditorState().read(() => $getSelection()?.clone() ?? null))
  const restore = () => saved.current && $setSelection(saved.current.clone())

  // Turns the selected paragraphs into another kind, or back into paragraphs when they're that kind already
  const blocks = (kind: string, make: () => ElementNode) => () =>
    editor.update(() => $setBlocksType($getSelection(), active.block === kind ? $createParagraphNode : make))

  const list = (kind: 'bullet' | 'number') => () =>
    active.block === kind
      ? editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
      : editor.dispatchCommand(
          kind === 'bullet' ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
          undefined,
        )

  const format = (kind: TextFormatType) => () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, kind)

  const link = () => {
    if (active.link) return editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
    save()
    setProblem('')
    setAddress('')
  }

  const applyLink = () => {
    if (!address?.trim() || !safeUrl(address.trim())) return setProblem(t('unsafeAddress'))
    editor.update(() => {
      restore()
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, address.trim())
    })
    setAddress(undefined)
    editor.focus()
  }

  // A link to an entry around the selected text, or the entry's title where nothing is selected. Pressed, it takes the
  // link off, keeping its text.
  const entryLink = async () => {
    if (active.entryLink) {
      return editor.update(() => {
        const node = $findMatchingParent($getSelection()!.getNodes()[0], $isEntryLinkNode)
        if (!node) return
        for (const child of node.getChildren()) node.insertBefore(child)
        node.remove()
      })
    }
    save()
    const entry = await pickers.entry?.()
    if (!entry) return editor.focus()
    editor.update(() => {
      restore()
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return
      const text = selection.getTextContent() || entry.title
      selection.insertNodes([new EntryLinkNode(entry.id).append($createTextNode(text))])
    })
    editor.focus()
  }

  const media = async () => {
    save()
    const file = await pickers.media?.()
    if (!file) return editor.focus()
    pickedFiles.set(file.id, file)
    editor.update(() => {
      restore()
      $insertNodeToNearestRoot(new MediaNode(file.id))
    })
  }

  const addBlock =
    (name: string, fields: Array<{ name: string; defaultValue?: unknown }> = []) =>
    () =>
      editor.update(() => {
        // Every field seeded, as the flexible field seeds a new block, so conditions inside it resolve against the block
        const block: Block = {
          ...Object.fromEntries(fields.map((field) => [field.name, field.defaultValue])),
          _layout: name,
        }
        $insertNodeToNearestRoot(new BlockNode(block))
      })

  const buttons: Array<Button> = [
    {
      key: 'h2',
      label: t('heading'),
      icon: Heading2,
      run: blocks('h2', () => $createHeadingNode('h2')),
      pressed: active.block === 'h2',
    },
    {
      key: 'h3',
      label: t('subheading'),
      icon: Heading3,
      run: blocks('h3', () => $createHeadingNode('h3')),
      pressed: active.block === 'h3',
    },
    { key: 'bold', label: t('bold'), icon: Bold, run: format('bold'), pressed: active.formats.has('bold') },
    { key: 'italic', label: t('italic'), icon: Italic, run: format('italic'), pressed: active.formats.has('italic') },
    {
      key: 'strikethrough',
      label: t('strikethrough'),
      icon: Strikethrough,
      run: format('strikethrough'),
      pressed: active.formats.has('strikethrough'),
    },
    { key: 'code', label: t('code'), icon: Code, run: format('code'), pressed: active.formats.has('code') },
    { key: 'link', label: t('link'), icon: Link, run: link, pressed: active.link, disabled: active.entryLink },
    ...(pickers.entry
      ? [
          {
            key: 'entryLink',
            label: t('entryLink'),
            icon: FileText,
            run: entryLink,
            pressed: active.entryLink,
            disabled: active.link,
          },
        ]
      : []),
    { key: 'bullet', label: t('bulletList'), icon: List, run: list('bullet'), pressed: active.block === 'bullet' },
    {
      key: 'number',
      label: t('numberedList'),
      icon: ListOrdered,
      run: list('number'),
      pressed: active.block === 'number',
    },
    {
      key: 'quote',
      label: t('quote'),
      icon: Quote,
      run: blocks('quote', $createQuoteNode),
      pressed: active.block === 'quote',
    },
    {
      key: 'codeBlock',
      label: t('codeBlock'),
      icon: SquareCode,
      run: blocks('code', $createCodeNode),
      pressed: active.block === 'code',
    },
    ...(pickers.media ? [{ key: 'media', label: t('media'), icon: Image, run: media }] : []),
    ...(withBlocks
      ? [...layoutsOf(options).values()].map((layout) => ({
          key: `block-${layout.name}`,
          label: t('addBlock', { label: layout.label || layout.name }),
          icon: Plus,
          run: addBlock(layout.name, layout.fields),
        }))
      : []),
    {
      key: 'undo',
      label: t('undo'),
      icon: Undo2,
      run: () => editor.dispatchCommand(UNDO_COMMAND, undefined),
      disabled: !history.undo,
    },
    {
      key: 'redo',
      label: t('redo'),
      icon: Redo2,
      run: () => editor.dispatchCommand(REDO_COMMAND, undefined),
      disabled: !history.redo,
    },
  ]
  const current = Math.min(focused, buttons.length - 1)

  const move = (event: KeyboardEvent) => {
    const steps: Record<string, number> = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: -1 }
    if (!(event.key in steps)) return
    event.preventDefault()
    const index = (steps[event.key] + buttons.length) % buttons.length
    setFocused(index)
    toolbar.current?.querySelectorAll('button')[index]?.focus()
  }

  return (
    <>
      <div
        ref={toolbar}
        role='toolbar'
        aria-label={t('toolbar')}
        aria-controls={id}
        className='sorlo-lexical__toolbar'
        onKeyDown={move}
      >
        {buttons.map(({ key, label, icon: Icon, run, pressed, disabled }, index) => (
          <button
            key={key}
            type='button'
            className='sorlo-lexical__button'
            tabIndex={index === current ? 0 : -1}
            aria-label={label}
            aria-pressed={pressed}
            title={label}
            // Disabled buttons stay focusable, so the arrow keys still reach the ones after them
            aria-disabled={disabled || undefined}
            onFocus={() => setFocused(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => !disabled && run()}
          >
            <Icon aria-hidden />
          </button>
        ))}
      </div>
      {address !== undefined && (
        <LinkAddress
          id={`${id}-address`}
          address={address}
          problem={problem}
          onChange={setAddress}
          onApply={applyLink}
          onCancel={() => {
            setAddress(undefined)
            editor.focus()
          }}
        />
      )}
    </>
  )
}

// The address for a new link, where Enter applies it and Escape cancels
function LinkAddress({
  id,
  address,
  problem,
  onChange,
  onApply,
  onCancel,
}: {
  id: string
  address: string
  problem: string
  onChange: (address: string) => void
  onApply: () => void
  onCancel: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <div className='sorlo-lexical__address'>
      <label htmlFor={id}>{t('linkAddress')}</label>
      <input
        ref={input}
        id={id}
        className='sorlo-input'
        inputMode='url'
        value={address}
        aria-invalid={!!problem || undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        placeholder='https://'
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onApply()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <button type='button' className='sorlo-button sorlo-button--primary' onClick={onApply}>
        {t('apply')}
      </button>
      <button type='button' className='sorlo-button' onClick={onCancel}>
        {t('cancel')}
      </button>
      {problem && (
        <p id={`${id}-problem`} className='sorlo-lexical__problem' role='alert'>
          {problem}
        </p>
      )}
    </div>
  )
}
