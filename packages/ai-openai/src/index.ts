import type { AiContent, AiMessage, AiPart, AiProvider, AiReply } from '@sorlo/cms'
import OpenAI, { type APIError } from 'openai'
import type { Responses } from 'openai/resources/responses/responses'

export interface OpenAIOptions {
  // gpt-6-astra if not given
  model?: string
  // Only ever read on the server. Without it, the SDK reads OPENAI_API_KEY.
  apiKey?: string
  // How much the model reasons before it answers, which is most of what a reply costs and how long it takes. Each model
  // takes its own set of values. medium if not given.
  effort?: OpenAI.ReasoningEffort
}

// The CMS shows the message of an error with this name in the chat
class AiError extends Error {
  override name = 'AiError'
}

const name = 'openai'

const stops: Record<string, AiReply['stop']> = { max_output_tokens: 'length', content_filter: 'refused' }

// OpenAI's Responses API, through its official SDK, for the CMS's ai setting. Tests pass a client of their own.
export function openai(options: OpenAIOptions = {}, client = new OpenAI({ apiKey: options.apiKey })): AiProvider {
  const { model = 'gpt-6-astra', effort = 'medium' } = options

  return {
    name,
    async reply({ system, tools, messages }, on, signal) {
      const params: Responses.ResponseCreateParamsStreaming = {
        model,
        stream: true,
        // The CMS keeps the chat and sends it whole each time, so OpenAI keeps nothing
        store: false,
        reasoning: { effort },
        instructions: system,
        tools: tools.map(({ name, description, inputSchema }) => ({
          type: 'function' as const,
          name,
          description,
          parameters: inputSchema,
          // Strict mode would rewrite the schemas, making optional inputs required, and the CMS checks each input itself
          strict: false,
        })),
        input: messages.flatMap(echo),
      }

      for (let attempt = 1; ; attempt++) {
        let written = ''
        try {
          // The raw events rather than the SDK's accumulated response, which adds fields the API refuses back
          let response: Responses.Response | undefined
          for await (const event of await client.responses.create(params, { signal })) {
            if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
              written += event.delta
              on.text(event.delta)
            } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
              response = (event as Responses.ResponseCompletedEvent).response
            }
          }
          if (!response) throw new AiError("OpenAI's reply ended before it was finished. Try again in a moment.")
          return toReply(response)
        } catch (error) {
          if (signal.aborted) return stopped(written, model)
          // A tool call whose arguments aren't JSON, or an event the SDK couldn't read
          if (!(error instanceof SyntaxError) || attempt === 3) throw aiError(error, model)
          on.restart()
        }
      }
    },
  }
}

// The API's output as the CMS's parts. Each item is kept whole as this provider's own, since a message's phase and a
// call's arguments go back exactly as they came, and after it come the parts the CMS reads: the message's text, or the
// call to run.
function toParts(output: Array<Responses.ResponseOutputItem>): Array<AiPart> {
  return output.flatMap((item): Array<AiPart> => {
    const own = { type: 'opaque' as const, provider: name, data: item }
    if (item.type === 'message') {
      return [
        own,
        ...item.content.map((part) => ({ type: 'text' as const, text: 'text' in part ? part.text : part.refusal })),
      ]
    }
    if (item.type === 'function_call') {
      return [own, { type: 'toolCall', id: item.call_id, name: item.name, input: JSON.parse(item.arguments) }]
    }
    return [own]
  })
}

const image = ({ data, mimeType }: { data: string; mimeType: string }) => ({
  type: 'input_image' as const,
  image_url: `data:${mimeType};base64,${data}`,
  detail: 'auto' as const,
})

const input = (content: AiContent) =>
  content.type === 'image' ? image(content) : { type: 'input_text' as const, text: content.text }

// An earlier message as the API takes it back. A reply of this provider's goes back as the items it came as, and one
// without them, such as a stopped reply's text or another provider's reply, as its text and calls. The CMS sends only
// this provider's opaque parts.
function echo({ role, content }: AiMessage): Array<Responses.ResponseInputItem> {
  if (role === 'assistant') {
    const items = content.flatMap((part) => (part.type === 'opaque' ? [part.data as Responses.ResponseInputItem] : []))
    if (items.length) return items
    return content.flatMap((part): Array<Responses.ResponseInputItem> => {
      if (part.type === 'text') return [{ role: 'assistant', content: part.text }]
      if (part.type !== 'toolCall') return []
      return [{ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input) }]
    })
  }
  // The API has no flag for a call that failed, whose text says what went wrong
  const results = content.flatMap((part): Array<Responses.ResponseInputItem> =>
    part.type === 'toolResult'
      ? [{ type: 'function_call_output', call_id: part.id, output: part.content.map(input) }]
      : [],
  )
  const rest = content.flatMap((part) => (part.type === 'text' || part.type === 'image' ? [input(part)] : []))
  // A system message partway through the chat, such as the page, is a developer message to the Responses API
  const message = { type: 'message' as const, role: role === 'system' ? ('developer' as const) : role, content: rest }
  return [...results, ...(rest.length ? [message] : [])]
}

function toReply(response: Responses.Response): AiReply {
  if (response.status === 'failed') {
    throw new AiError(`OpenAI couldn't write the reply: ${response.error?.message ?? 'it gave no reason'}`)
  }
  const content = toParts(response.output)
  const refused = response.output.some(
    (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
  )
  return {
    content,
    stop:
      response.status === 'incomplete'
        ? (stops[response.incomplete_details?.reason ?? ''] ?? 'end')
        : refused
          ? 'refused'
          : content.some((part) => part.type === 'toolCall')
            ? 'tools'
            : 'end',
    model: response.model,
    usage: (response.usage as unknown as AiReply['usage']) ?? null,
  }
}

// What a stopped reply had written: its text, since its unfinished reasoning and tool calls can't be sent back
const stopped = (text: string, model: string): AiReply => ({
  content: text ? [{ type: 'text', text }] : [],
  stop: 'stopped',
  model,
  usage: null,
})

// The SDK's failures as the person in the chat reads them, most specific first
function aiError(error: unknown, model: string) {
  if (error instanceof AiError) return error
  const detail = (error: APIError) => (error.error as { message?: string } | undefined)?.message ?? error.message
  if (error instanceof OpenAI.RateLimitError && error.code === 'insufficient_quota') {
    return new AiError("The site's OpenAI account has run out of credit. Whoever runs the site can add more.")
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new AiError('OpenAI is limiting how often this site can ask right now. Try again in a minute.')
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return new AiError("OpenAI didn't accept the site's API key. Whoever runs the site can check it.")
  }
  if (error instanceof OpenAI.PermissionDeniedError) return new AiError(`The site's API key can't use ${model}.`)
  if (error instanceof OpenAI.NotFoundError) {
    return new AiError(`OpenAI has no model called ${model}. Whoever runs the site can check the model it asks for.`)
  }
  if (error instanceof OpenAI.BadRequestError) return new AiError(`OpenAI turned the request down: ${detail(error)}`)
  if (error instanceof OpenAI.APIConnectionError) return new AiError("Couldn't reach OpenAI. Try again in a moment.")
  if (error instanceof OpenAI.InternalServerError) {
    return new AiError('OpenAI is overloaded or having trouble. Try again in a moment.')
  }
  if (error instanceof OpenAI.APIError) return new AiError(`OpenAI replied with an error: ${detail(error)}`)
  return new AiError(`Couldn't ask OpenAI: ${error instanceof Error ? error.message : String(error)}`)
}
