import i18n from './i18n'
import { isJson } from './logic'
import { type PickedFile, PickersContext } from './pickers'
import { type Block, layoutsOf } from './tree'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { type FieldSchema, Fieldset, useFieldContext } from '@sorlo/forms'
import {
  $getNodeByKey,
  $getRoot,
  DecoratorNode,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type SerializedLexicalNode,
} from 'lexical'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { type JSX, createContext, useContext, useEffect, useMemo, useState } from 'react'

// Sorlo's nodes, which hold IDs: a link to an entry, a file from the host's media library, and a modular field's block

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)

export type SerializedEntryLink = SerializedElementNode & { entry: string }
export type SerializedMedia = SerializedLexicalNode & { media: string }
export type SerializedBlock = SerializedLexicalNode & { block: Block }

// A link to an entry, by its ID, around its text. Delivery writes out its address.
export class EntryLinkNode extends ElementNode {
  __entry: string

  static getType() {
    return 'entrylink'
  }

  static clone(node: EntryLinkNode) {
    return new EntryLinkNode(node.__entry, node.__key)
  }

  static importJSON(json: SerializedEntryLink) {
    return new EntryLinkNode(json.entry).updateFromJSON(json)
  }

  constructor(entry = '', key?: NodeKey) {
    super(key)
    this.__entry = entry
  }

  exportJSON(): SerializedEntryLink {
    return { ...super.exportJSON(), entry: this.getLatest().__entry }
  }

  createDOM() {
    const link = document.createElement('a')
    link.className = 'sorlo-lexical__entrylink'
    link.dataset.entry = this.__entry
    return link
  }

  updateDOM(previous: EntryLinkNode, link: HTMLElement) {
    if (previous.__entry !== this.__entry) link.dataset.entry = this.__entry
    return false
  }

  isInline(): true {
    return true
  }

  canBeEmpty() {
    return false
  }

  canInsertTextBefore() {
    return false
  }

  canInsertTextAfter() {
    return false
  }
}

export const $isEntryLinkNode = (node: LexicalNode | null | undefined): node is EntryLinkNode =>
  node instanceof EntryLinkNode

// Files picked in this page, so a file just inserted shows without loading it again
export const pickedFiles = new Map<string, PickedFile>()

// A file from the media library, by its ID, on a line of its own
export class MediaNode extends DecoratorNode<JSX.Element> {
  __media: string

  static getType() {
    return 'media'
  }

  static clone(node: MediaNode) {
    return new MediaNode(node.__media, node.__key)
  }

  static importJSON(json: SerializedMedia) {
    return new MediaNode(json.media).updateFromJSON(json)
  }

  constructor(media = '', key?: NodeKey) {
    super(key)
    this.__media = media
  }

  exportJSON(): SerializedMedia {
    return { ...super.exportJSON(), media: this.getLatest().__media }
  }

  createDOM() {
    const element = document.createElement('div')
    element.className = 'sorlo-lexical__node'
    return element
  }

  updateDOM() {
    return false
  }

  // On a line of its own, at the top of the tree
  isInline(): false {
    return false
  }

  decorate() {
    return <MediaView nodeKey={this.__key} id={this.__media} />
  }
}

// A modular field's block: a flexible field's block, its layout's values and _layout, edited with its layout's fields
export class BlockNode extends DecoratorNode<JSX.Element> {
  __block: Block

  static getType() {
    return 'block'
  }

  static clone(node: BlockNode) {
    return new BlockNode(node.__block, node.__key)
  }

  static importJSON(json: SerializedBlock) {
    return new BlockNode(json.block).updateFromJSON(json)
  }

  constructor(block: Block = { _layout: '' }, key?: NodeKey) {
    super(key)
    this.__block = block
  }

  exportJSON(): SerializedBlock {
    return { ...super.exportJSON(), block: this.getLatest().__block }
  }

  setBlock(block: Block) {
    this.getWritable().__block = block
  }

  createDOM() {
    const element = document.createElement('div')
    element.className = 'sorlo-lexical__node'
    return element
  }

  updateDOM() {
    return false
  }

  // On a line of its own, at the top of the tree
  isInline(): false {
    return false
  }

  decorate() {
    return <BlockView nodeKey={this.__key} block={this.__block} />
  }
}

export const $isBlockNode = (node: LexicalNode | null | undefined): node is BlockNode => node instanceof BlockNode

// How a block tells the editor whether its fields are valid, so the field is invalid while any block is
export const BlockValidityContext = createContext<(key: NodeKey, valid: boolean | undefined) => void>(() => {})

// Move up, Move down and Remove for a file or block, which have no text for the caret to select
function NodeControls({ nodeKey, label }: { nodeKey: NodeKey; label: string }) {
  const [editor] = useLexicalComposerContext()
  const { readonly, disabled } = useFieldContext()
  if (readonly || disabled) return null

  const change = (move: (node: LexicalNode) => void) =>
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if (node) move(node)
    })
  const buttons = [
    {
      name: t('moveUp', { label }),
      icon: ArrowUp,
      run: (node: LexicalNode) => node.getPreviousSibling()?.insertBefore(node),
    },
    {
      name: t('moveDown', { label }),
      icon: ArrowDown,
      run: (node: LexicalNode) => node.getNextSibling()?.insertAfter(node),
    },
    { name: t('remove', { label }), icon: X, run: (node: LexicalNode) => node.remove() },
  ]
  return (
    <div className='sorlo-lexical__controls'>
      {buttons.map(({ name, icon: Icon, run }) => (
        <button
          key={name}
          type='button'
          className='sorlo-lexical__button'
          aria-label={name}
          title={name}
          onClick={() => change(run)}
        >
          <Icon aria-hidden />
        </button>
      ))}
    </div>
  )
}

function MediaView({ nodeKey, id }: { nodeKey: NodeKey; id: string }) {
  const pickers = useContext(PickersContext)
  const [file, setFile] = useState<PickedFile | null | undefined>(pickedFiles.get(id))

  useEffect(() => {
    if (file || !pickers.files) return
    let current = true
    pickers.files([id]).then(
      (found) => current && setFile(found[id] ?? null),
      () => current && setFile(null),
    )
    return () => {
      current = false
    }
  }, [id])

  const name = file ? file.name : file === null ? t('missingFile') : pickers.files ? t('loading') : id
  return (
    <figure className='sorlo-lexical__media'>
      {file?.mime.startsWith('image/') ? <img src={file.url} alt={file.alt ?? ''} /> : null}
      <figcaption>{name}</figcaption>
      <NodeControls nodeKey={nodeKey} label={file?.name ?? t('file')} />
    </figure>
  )
}

// Where a block is among the field's blocks, which its messages are reported under, such as body.0.title
function useBlockIndex(nodeKey: NodeKey) {
  const [editor] = useLexicalComposerContext()
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const read = () =>
      editor.getEditorState().read(() => {
        const blocks = $getRoot().getChildren().filter($isBlockNode)
        setIndex(
          Math.max(
            0,
            blocks.findIndex((node) => node.getKey() === nodeKey),
          ),
        )
      })
    read()
    return editor.registerUpdateListener(read)
  }, [editor, nodeKey])
  return index
}

function BlockView({ nodeKey, block }: { nodeKey: NodeKey; block: Block }) {
  const [editor] = useLexicalComposerContext()
  const { schema: field, options } = useFieldContext()
  const report = useContext(BlockValidityContext)
  const index = useBlockIndex(nodeKey)
  // An HTML field takes no blocks, so one it holds shows as a block whose layout has gone
  const layout = useMemo(
    () => (isJson(field) ? layoutsOf(options).get(block._layout) : undefined),
    [field, options, block._layout],
  )
  const label = layout?.label || layout?.name || block._layout

  // A group named by the block's place, as the flexible field's blocks are, so messages land under body.0.title
  const schema = useMemo<Array<FieldSchema>>(
    () => [{ type: 'group', name: String(index), label, options: { fields: layout?.fields ?? [] } }],
    [index, label, layout],
  )

  // A removed block's report goes with it
  useEffect(() => () => report(nodeKey, undefined), [nodeKey])

  return (
    <div className='sorlo-lexical__block'>
      {layout ? (
        <Fieldset
          key={index}
          schema={schema}
          values={{ [index]: block }}
          onValuesChange={(_, values) =>
            editor.update(() => {
              const node = $getNodeByKey(nodeKey)
              if ($isBlockNode(node)) node.setBlock({ ...values, _layout: block._layout })
            })
          }
          onValidityChange={(_, valid) => report(nodeKey, valid)}
        />
      ) : (
        <p className='sorlo-lexical__missing'>{t('missingLayout')}</p>
      )}
      <NodeControls nodeKey={nodeKey} label={label} />
    </div>
  )
}
