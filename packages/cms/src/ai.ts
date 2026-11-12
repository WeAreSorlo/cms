// What the CMS asks of an AI provider: one streamed call to a model at a time. The CMS runs everything around it, the
// tools, the chat's history, the cap on rounds and what's stored. Messages are made of the CMS's own parts, which each
// provider converts to its API's and back.

// What a tool's result holds, as MCP's tool results do
export type AiContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type AiPart =
  | AiContent
  | { type: 'toolCall'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; content: Array<AiContent>; isError?: boolean }
  // What only the provider named reads, such as a model's reasoning, which it's sent back unchanged. The CMS leaves out
  // other providers' from what it sends.
  | { type: 'opaque'; provider: string; data: unknown }

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: Array<AiPart>
}

export interface AiRequest {
  // The instructions and the site's content types, the same for every message so they cache
  system: string
  // The tools, in the same order every time, each with its input as a JSON schema
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  messages: Array<AiMessage>
}

export interface AiReply {
  // The model's message, which is stored and sent back as it is. Its toolCall parts are the tools to run.
  content: Array<AiPart>
  // Why it stopped: it finished, has tools to run, reached its length limit, declined, or the person stopped it
  stop: 'end' | 'tools' | 'length' | 'refused' | 'stopped'
  // The model that wrote it
  model: string
  // The tokens it took, as the provider counts them
  usage: Record<string, unknown> | null
}

export interface AiProvider {
  // Tags its opaque parts, such as anthropic
  name: string
  // Streams one reply, calling text with each piece as it's written, and restart when the provider has to ask again,
  // which drops what that call wrote. Once the signal aborts, it resolves with the text written so far. An error named
  // AiError, such as one made with this class, shows its message in the chat.
  reply(request: AiRequest, on: { text(text: string): void; restart(): void }, signal: AbortSignal): Promise<AiReply>
}

// A provider's failure, with a message for the person in the chat. The CMS checks its name rather than the class, so a
// provider package needs no runtime dependency on the CMS.
export class AiError extends Error {
  override name = 'AiError'
}

export const isAiError = (error: unknown): error is Error => error instanceof Error && error.name === 'AiError'
