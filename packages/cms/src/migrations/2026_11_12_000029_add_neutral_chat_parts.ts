import { Kysely, sql } from 'kysely'

// Chats' messages in the CMS's own parts, which each AI provider converts to its API's, rather than the Claude API's
// blocks, from when Anthropic was the only provider. What the CMS doesn't read, such as thinking, fallback handoffs and
// the calls a declining model made before one, becomes Anthropic's opaque parts. A proposal's tool call is call_id.

type Block = Record<string, any>

const fromContent = (block: Block): Block =>
  block.type === 'image'
    ? { type: 'image', data: block.source.data, mimeType: block.source.media_type }
    : { type: 'text', text: block.text }

const toContent = (part: Block): Block =>
  part.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
    : { type: 'text', text: part.text }

export function toParts(role: string, blocks: Array<Block>): Array<Block> {
  const handoff = role === 'assistant' ? blocks.map((block) => block.type).lastIndexOf('fallback') : -1
  return blocks.map((block, index) => {
    if (block.type === 'text' || (block.type === 'image' && block.source?.type === 'base64')) return fromContent(block)
    if (block.type === 'tool_use' && index > handoff) {
      return { type: 'toolCall', id: block.id, name: block.name, input: block.input }
    }
    if (block.type === 'tool_result') {
      return {
        type: 'toolResult',
        id: block.tool_use_id,
        content: (block.content ?? []).map(fromContent),
        ...(block.is_error && { isError: true }),
      }
    }
    return { type: 'opaque', provider: 'anthropic', data: block }
  })
}

// Other providers' opaque parts have no blocks to go back to
export function toBlocks(parts: Array<Block>): Array<Block> {
  return parts.flatMap((part) => {
    if (part.type === 'text' || part.type === 'image') return [toContent(part)]
    if (part.type === 'toolCall') return [{ type: 'tool_use', id: part.id, name: part.name, input: part.input }]
    if (part.type === 'toolResult') {
      return [
        {
          type: 'tool_result',
          tool_use_id: part.id,
          content: part.content.map(toContent),
          ...(part.isError && { is_error: true }),
        },
      ]
    }
    return part.provider === 'anthropic' ? [part.data] : []
  })
}

// Every message, a page at a time, since attached images make them large
async function convert(db: Kysely<any>, change: (role: string, content: Array<Block>) => Array<Block>) {
  let after: { chat_id: string; position: number } | undefined
  for (;;) {
    const from = after
    const rows = await db
      .selectFrom('chat_messages')
      .select(['chat_id', 'position', 'role', 'content'])
      .$if(!!from, (query) => query.where(sql`(chat_id, position)`, '>', sql`(${from!.chat_id}, ${from!.position})`))
      .orderBy('chat_id')
      .orderBy('position')
      .limit(100)
      .execute()
    if (!rows.length) return
    for (const row of rows) {
      await db
        .updateTable('chat_messages')
        .set({ content: JSON.stringify(change(row.role, row.content)) })
        .where('chat_id', '=', row.chat_id)
        .where('position', '=', row.position)
        .execute()
    }
    after = rows.at(-1)
  }
}

export async function up(db: Kysely<any>) {
  await convert(db, toParts)
  await db.schema.alterTable('proposals').renameColumn('tool_use_id', 'call_id').execute()
}

export async function down(db: Kysely<any>) {
  await db.schema.alterTable('proposals').renameColumn('call_id', 'tool_use_id').execute()
  await convert(db, (_role, content) => toBlocks(content))
}
