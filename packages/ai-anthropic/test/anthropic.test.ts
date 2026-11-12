import { anthropic } from '../src'
import Anthropic from '@anthropic-ai/sdk'
import type { AiRequest } from '@sorlo/cms'
import { expect, test } from 'vitest'

// The Anthropic provider, through the official SDK with a fetch of its own, so what it sends and how it reads the
// stream are checked without calling the API

// The server-sent events of a streamed message with these blocks
function events(content: Array<Record<string, any>>, stop_reason = 'end_turn', model = 'claude-opus-5-5') {
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null }
  const list: Array<Record<string, any>> = [
    { type: 'message_start', message: { ...message, usage: { input_tokens: 20, output_tokens: 1 } } },
  ]
  content.forEach((block, index) => {
    if (block.type === 'text') {
      list.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      list.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else if (block.type === 'tool_use') {
      list.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
      list.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json } })
    } else list.push({ type: 'content_block_start', index, content_block: block })
    list.push({ type: 'content_block_stop', index })
  })
  list.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 9 } })
  list.push({ type: 'message_stop' })
  return list.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

// A client whose fetch answers each request with the next of these replies, and keeps the requests
function client(...replies: Array<(init: RequestInit) => Response>) {
  const requests: Array<{ body: any; headers: Headers }> = []
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init!.body)), headers: new Headers(init!.headers) })
    return replies.shift()!(init!)
  }
  return { requests, sdk: new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }) }
}

const stream = (body: string | ReadableStream) => () =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } })

const toolSpecs: AiRequest['tools'] = [
  { name: 'list_forms', description: 'Lists the forms', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'search_entries',
    description: 'Searches entries',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
]

const request: AiRequest = {
  system: 'The instructions',
  tools: toolSpecs,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'system', content: [{ type: 'text', text: "It's 2026-11-02 12:00 UTC." }] },
  ],
}

const none = { text() {}, restart() {} }

test('a request asks for the model, effort and fallbacks, caches its start, and streams its tools', async () => {
  const { requests, sdk } = client(stream(events([{ type: 'text', text: 'Hi' }])))
  const texts: Array<string> = []
  const reply = await anthropic({}, sdk).reply(
    request,
    { ...none, text: (text) => texts.push(text) },
    new AbortController().signal,
  )

  expect(texts).toEqual(['Hi'])
  expect(reply).toEqual({
    content: [{ type: 'text', text: 'Hi' }],
    stop: 'end',
    model: 'claude-opus-5-5',
    usage: expect.objectContaining({ input_tokens: 20, output_tokens: 9 }),
  })

  const [{ body, headers }] = requests
  expect(headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01')
  expect(body).toMatchObject({
    model: 'claude-opus-5-5',
    max_tokens: 64_000,
    stream: true,
    fallbacks: 'default',
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort: 'medium' },
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: 'The instructions', cache_control: { type: 'ephemeral' } }],
    messages: request.messages,
  })
  expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(toolSpecs.map((spec) => spec.name))
  expect(body.tools[0]).toEqual({
    name: toolSpecs[0].name,
    description: toolSpecs[0].description,
    input_schema: toolSpecs[0].inputSchema,
    eager_input_streaming: true,
  })
})

test('the config picks the model and effort, and can leave fallbacks out', async () => {
  const { requests, sdk } = client(stream(events([{ type: 'text', text: 'Hi' }])))
  const options = { model: 'claude-sonnet-5-5', effort: 'low', fallback: false } as const
  await anthropic(options, sdk).reply(request, none, new AbortController().signal)

  const [{ body, headers }] = requests
  expect(headers.get('anthropic-beta')).toBe('thinking-binding-controls-2026-08-01')
  expect(body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' } })
  expect(body).not.toHaveProperty('fallbacks')
})

test('a reply that fell back calls only the tools after the last handoff, and goes back as the API asks', async () => {
  const handoff = {
    type: 'fallback',
    from: { model: 'claude-opus-5-5' },
    to: { model: 'claude-opus-5' },
    trigger: { type: 'refusal', category: null },
  }
  const content = [
    { type: 'thinking', thinking: '', signature: 'sig-before' },
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'toolu_before', name: 'list_forms', json: '{}' },
    handoff,
    { type: 'thinking', thinking: '', signature: 'sig-after' },
    { type: 'tool_use', id: 'toolu_after', name: 'search_entries', json: '{"query":"lamp"}' },
  ]
  const { requests, sdk } = client(stream(events(content, 'tool_use', 'claude-opus-5')), stream(events([])))
  const provider = anthropic({}, sdk)
  const reply = await provider.reply(request, none, new AbortController().signal)

  expect(reply.stop).toBe('tools')
  expect(reply.model).toBe('claude-opus-5')
  // Everything but the text and the calls after the handoff is the provider's own
  expect(reply.content.map((part) => (part.type === 'opaque' ? `${part.provider}:${part.type}` : part.type))).toEqual([
    'anthropic:opaque',
    'text',
    'anthropic:opaque',
    'anthropic:opaque',
    'anthropic:opaque',
    'toolCall',
  ])
  expect(reply.content.at(-1)).toEqual({
    type: 'toolCall',
    id: 'toolu_after',
    name: 'search_entries',
    input: { query: 'lamp' },
  })

  // Sent back, it keeps its text and the handoff from before it, and everything after
  const results = [{ type: 'toolResult' as const, id: 'toolu_after', content: [{ type: 'text' as const, text: '{}' }] }]
  const messages = [...request.messages, { role: 'assistant' as const, content: reply.content }]
  await provider.reply(
    { ...request, messages: [...messages, { role: 'user', content: results }] },
    none,
    new AbortController().signal,
  )
  expect(requests[1].body.messages[2].content.map((block: { type: string }) => block.type)).toEqual([
    'text',
    'fallback',
    'thinking',
    'tool_use',
  ])
  expect(requests[1].body.messages[2].content[2].signature).toBe('sig-after')
})

test("stop reasons become the CMS's own", async () => {
  for (const [reason, stop] of [
    ['end_turn', 'end'],
    ['tool_use', 'tools'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'refused'],
  ]) {
    const { sdk } = client(stream(events([{ type: 'text', text: 'x' }], reason)))
    const reply = await anthropic({}, sdk).reply(request, none, new AbortController().signal)
    expect(reply.stop).toBe(stop)
  }
})

test("the API's errors become messages for the person", async () => {
  const failing = (status: number, message: string) => () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'some_error', message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const cases = [
    [429, 'Anthropic is limiting how often this site can ask right now. Try again in a minute.'],
    [401, "Anthropic didn't accept the site's API key. Whoever runs the site can check it."],
    [404, 'Anthropic has no model called claude-opus-5-5. Whoever runs the site can check the model it asks for.'],
    [400, 'Anthropic turned the request down: prompt is too long'],
    [529, 'Anthropic is overloaded or having trouble. Try again in a moment.'],
  ] as const
  for (const [status, text] of cases) {
    const { sdk } = client(failing(status, 'prompt is too long'))
    const reply = anthropic({}, sdk).reply(request, none, new AbortController().signal)
    // The CMS shows an AiError's message in the chat
    await expect(reply).rejects.toMatchObject({ name: 'AiError', message: text })
  }
})

test("a tool input the SDK can't read is asked for again, dropping what that try wrote", async () => {
  const broken = [
    { type: 'text', text: 'Searching' },
    { type: 'tool_use', id: 'toolu_1', name: 'search_entries', json: '{"query":"a" "b"}' },
  ]
  const { requests, sdk } = client(stream(events(broken, 'tool_use')), stream(events([{ type: 'text', text: 'Done' }])))
  const said: Array<string> = []
  const reply = await anthropic({}, sdk).reply(
    request,
    { text: (text) => said.push(text), restart: () => said.push('restart') },
    new AbortController().signal,
  )

  expect(requests).toHaveLength(2)
  expect(said).toEqual(['Searching', 'restart', 'Done'])
  expect(reply.content).toEqual([{ type: 'text', text: 'Done' }])
})

test('a stopped reply keeps the text it had written', async () => {
  const stop = new AbortController()
  const { sdk } = client((init) => {
    const start = events([{ type: 'text', text: 'Half' }]).split('event: content_block_stop')[0]
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(start))
        init.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    })
    return stream(body)()
  })
  const reply = anthropic({}, sdk).reply(request, { ...none, text: () => stop.abort() }, stop.signal)

  expect(await reply).toEqual({
    content: [{ type: 'text', text: 'Half' }],
    stop: 'stopped',
    model: 'claude-opus-5-5',
    usage: expect.objectContaining({ input_tokens: 20 }),
  })
})

test("images and tool results go as the API takes them, and the provider's own parts go back unchanged", async () => {
  const { requests, sdk } = client(stream(events([{ type: 'text', text: 'OK' }])))
  const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' }
  await anthropic({}, sdk).reply(
    {
      ...request,
      messages: [
        { role: 'user', content: [image, { type: 'text', text: 'What is it?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'opaque', provider: 'anthropic', data: thinking },
            { type: 'toolCall', id: 'toolu_1', name: 'list_forms', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'toolResult', id: 'toolu_1', content: [image], isError: true }] },
      ],
    },
    none,
    new AbortController().signal,
  )

  const source = { type: 'base64', media_type: 'image/png', data: 'aGk=' }
  expect(requests[0].body.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'image', source },
        { type: 'text', text: 'What is it?' },
      ],
    },
    { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'list_forms', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source }], is_error: true }],
    },
  ])
})
