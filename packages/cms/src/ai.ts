import type { AiOptions } from '.'
import Anthropic, { type APIError } from '@anthropic-ai/sdk'

// What the CMS asks of an AI provider: one streamed call to a model at a time. The CMS runs everything around it, the
// tools, the chat's history, the cap on rounds and what's stored (PLAN.md section 21). Messages take the Claude API's
// shapes, which are the CMS's own, so another provider converts them to its own and back.

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  // Content blocks, exactly as they were sent, or as the provider returned them
  content: Array<Record<string, any>>
}

export interface AiRequest {
  // The instructions and the site's content types, the same for every message so they cache
  system: string
  // The tools, in the same order every time, each with its input as a JSON schema
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  messages: Array<AiMessage>
}

export interface AiReply {
  // The model's message, which is stored and sent back as it is
  content: Array<Record<string, any>>
  // Why it stopped: it finished, has tools to run, reached its length limit, declined, or the person stopped it
  stop: 'end' | 'tools' | 'length' | 'refused' | 'stopped'
  toolCalls: Array<{ id: string; name: string; input: unknown }>
  // The model that wrote it, which is a fallback when the model asked for declined
  model: string
  // The tokens it took, as the provider counts them
  usage: Record<string, any> | null
}

export interface AiProvider {
  // Streams one reply, calling text with each piece as it's written, and restart when the provider has to ask again,
  // which drops what that call wrote. Once the signal aborts, it resolves with the text written so far.
  reply(request: AiRequest, on: { text(text: string): void; restart(): void }, signal: AbortSignal): Promise<AiReply>
}

// A provider's failure, with a message for the person in the chat
export class AiError extends Error {}

const stops: Record<string, AiReply['stop']> = {
  tool_use: 'tools',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'refused',
}

// Anthropic's API, through its official SDK. Tests pass a client of their own. Without a key, the SDK reads
// ANTHROPIC_API_KEY, or its other credentials.
export function anthropic(options: AiOptions, client = new Anthropic({ apiKey: options.apiKey })): AiProvider {
  const { model = 'claude-opus-5-5', effort = 'medium', fallback = true } = options

  return {
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
          // Inputs arrive as they're written, unchecked, so callTool checks each against its tool's schema
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

// Where the last model a reply fell back to took over, or -1
export const lastHandoff = (content: Array<{ type?: unknown }>) =>
  content.map((block) => block.type).lastIndexOf('fallback')

// An earlier message as the API takes it back. A reply that fell back to another model keeps all it has after the last
// handoff, and before it only its text and the handoffs, as the API asks.
function echo({ role, content }: AiMessage) {
  const handoff = role === 'assistant' ? lastHandoff(content) : -1
  const kept = content.filter((block, index) => index >= handoff || block.type === 'text' || block.type === 'fallback')
  return { role, content: kept } as Anthropic.Beta.BetaMessageParam
}

function toReply(message: Anthropic.Beta.BetaMessage): AiReply {
  // Calls before the last handoff are the declining model's, which never finished
  const handoff = lastHandoff(message.content)
  return {
    content: message.content as AiReply['content'],
    stop: stops[message.stop_reason ?? ''] ?? 'end',
    toolCalls: message.content
      .slice(handoff + 1)
      .flatMap((block) => (block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [])),
    model: message.model,
    usage: message.usage as AiReply['usage'],
  }
}

// What a stopped reply had written: its text, since its unfinished thinking and tool calls can't be sent back
const stopped = (message: Anthropic.Beta.BetaMessage | undefined, model: string): AiReply => ({
  content: (message?.content ?? []).filter((block) => block.type === 'text' && block.text) as AiReply['content'],
  stop: 'stopped',
  toolCalls: [],
  model: message?.model ?? model,
  usage: (message?.usage as AiReply['usage']) ?? null,
})

// The SDK's failures as the person in the chat reads them, most specific first
function aiError(error: unknown, model: string) {
  const detail = (error: APIError) =>
    (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError('Anthropic is limiting how often this site can ask right now. Try again in a minute.')
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiError("Anthropic didn't accept the site's API key. Whoever runs the site can check ai.apiKey.")
  }
  if (error instanceof Anthropic.PermissionDeniedError) return new AiError(`The site's API key can't use ${model}.`)
  if (error instanceof Anthropic.NotFoundError) {
    return new AiError(`Anthropic has no model called ${model}. Whoever runs the site can check ai.model.`)
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
