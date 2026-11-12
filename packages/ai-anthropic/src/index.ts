import Anthropic, { type APIError } from '@anthropic-ai/sdk'
import type { AiMessage, AiPart, AiProvider, AiReply } from '@sorlo/cms'

export interface AnthropicOptions {
  // claude-opus-5-5 if not given
  model?: string
  // Only ever read on the server. Without it, the SDK reads ANTHROPIC_API_KEY, or its other credentials.
  apiKey?: string
  // How much the model thinks before it answers, which is most of what a reply costs and how long it takes. medium if
  // not given.
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  // Whether a request Anthropic's safety classifiers decline is tried again on the model Anthropic recommends for that
  // kind of decline. On if not given.
  fallback?: boolean
}

// The CMS shows the message of an error with this name in the chat
class AiError extends Error {
  override name = 'AiError'
}

const name = 'anthropic'

const stops: Record<string, AiReply['stop']> = {
  tool_use: 'tools',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'refused',
}

// Anthropic's API, through its official SDK, for the CMS's ai setting. Tests pass a client of their own.
export function anthropic(
  options: AnthropicOptions = {},
  client = new Anthropic({ apiKey: options.apiKey }),
): AiProvider {
  const { model = 'claude-opus-5-5', effort = 'medium', fallback = true } = options

  return {
    name,
    async reply({ system, tools, messages }, on, signal) {
      const params: Parameters<typeof client.beta.messages.stream>[0] = {
        model,
        max_tokens: 64_000,
        betas: [...(fallback ? ['server-side-fallback-2026-07-01'] : []), 'thinking-binding-controls-2026-08-01'],
        ...(fallback && { fallbacks: 'default' as const }),
        // The system prompt changes with the content types, after which the thinking in earlier replies no longer
        // matches the chat. Newer accounts get a 400 for that, so the API drops that thinking instead.
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        output_config: { effort },
        // One breakpoint after the system prompt, which caches with the tools, and one that follows the chat's end
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          input_schema: inputSchema as Anthropic.Beta.BetaTool.InputSchema,
          // Inputs arrive as they're written, unchecked, so the CMS checks each against its tool's schema
          eager_input_streaming: true,
        })),
        messages: messages.map(echo),
      }

      for (let attempt = 1; ; attempt++) {
        const stream = client.beta.messages.stream(params, { signal })
        stream.on('text', (text) => on.text(text))
        try {
          return toReply(await stream.finalMessage())
        } catch (error) {
          if (signal.aborted) return stopped(stream.currentMessage, model)
          // A tool input whose JSON the SDK couldn't read, which eager input streaming leaves to it. The SDK's own
          // failures are AnthropicErrors, and the API's are APIErrors.
          const unreadable = error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)
          if (!unreadable || attempt === 3) throw aiError(error, model)
          on.restart()
        }
      }
    },
  }
}

type Block = Anthropic.Beta.BetaContentBlock | Anthropic.Beta.BetaContentBlockParam

// Where the last model a reply fell back to took over, or -1
const lastHandoff = (blocks: Array<{ type: string }>) => blocks.map((block) => block.type).lastIndexOf('fallback')

// The API's blocks as the CMS's parts. Calls before the last handoff are the declining model's, which never ran, so
// they stay this provider's own, with everything else the CMS doesn't read.
function toParts(blocks: Array<Block>): Array<AiPart> {
  const handoff = lastHandoff(blocks)
  return blocks.map((block, index): AiPart => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'tool_use' && index > handoff) {
      return { type: 'toolCall', id: block.id, name: block.name, input: block.input }
    }
    return { type: 'opaque', provider: name, data: block }
  })
}

const image = ({ data, mimeType }: { data: string; mimeType: string }) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: mimeType as 'image/png', data },
})

// A part as the API takes it back. The CMS sends only this provider's opaque parts.
function toBlock(part: AiPart): Anthropic.Beta.BetaContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return image(part)
    case 'toolCall':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.input }
    case 'toolResult':
      return {
        type: 'tool_result',
        tool_use_id: part.id,
        content: part.content.map((content) => (content.type === 'image' ? image(content) : content)),
        ...(part.isError && { is_error: true }),
      }
    case 'opaque':
      return part.data as Anthropic.Beta.BetaContentBlockParam
  }
}

// An earlier message as the API takes it back. A reply that fell back to another model keeps all it has after the last
// handoff, and before it only its text and the handoffs, as the API asks.
function echo({ role, content }: AiMessage): Anthropic.Beta.BetaMessageParam {
  const blocks = content.map(toBlock)
  const handoff = role === 'assistant' ? lastHandoff(blocks) : -1
  const kept = blocks.filter((block, index) => index >= handoff || block.type === 'text' || block.type === 'fallback')
  return { role, content: kept } as Anthropic.Beta.BetaMessageParam
}

const toReply = (message: Anthropic.Beta.BetaMessage): AiReply => ({
  content: toParts(message.content),
  stop: stops[message.stop_reason ?? ''] ?? 'end',
  model: message.model,
  usage: message.usage as unknown as AiReply['usage'],
})

// What a stopped reply had written: its text, since its unfinished thinking and tool calls can't be sent back
const stopped = (message: Anthropic.Beta.BetaMessage | undefined, model: string): AiReply => ({
  content: toParts((message?.content ?? []).filter((block) => block.type === 'text' && block.text)),
  stop: 'stopped',
  model: message?.model ?? model,
  usage: (message?.usage as unknown as AiReply['usage']) ?? null,
})

// The SDK's failures as the person in the chat reads them, most specific first
function aiError(error: unknown, model: string) {
  const detail = (error: APIError) =>
    (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError('Anthropic is limiting how often this site can ask right now. Try again in a minute.')
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiError("Anthropic didn't accept the site's API key. Whoever runs the site can check it.")
  }
  if (error instanceof Anthropic.PermissionDeniedError) return new AiError(`The site's API key can't use ${model}.`)
  if (error instanceof Anthropic.NotFoundError) {
    return new AiError(`Anthropic has no model called ${model}. Whoever runs the site can check the model it asks for.`)
  }
  if (error instanceof Anthropic.BadRequestError)
    return new AiError(`Anthropic turned the request down: ${detail(error)}`)
  if (error instanceof Anthropic.APIConnectionError)
    return new AiError("Couldn't reach Anthropic. Try again in a moment.")
  if (error instanceof Anthropic.InternalServerError) {
    return new AiError('Anthropic is overloaded or having trouble. Try again in a moment.')
  }
  if (error instanceof Anthropic.APIError) return new AiError(`Anthropic replied with an error: ${detail(error)}`)
  return new AiError(`Couldn't ask Anthropic: ${error instanceof Error ? error.message : String(error)}`)
}
