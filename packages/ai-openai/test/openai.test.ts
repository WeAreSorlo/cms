import { openai } from '../src'
import type { AiRequest } from '@sorlo/cms'
import OpenAI from 'openai'
import { expect, test } from 'vitest'

// The OpenAI provider, through the official SDK with a fetch of its own, so what it sends and how it reads the stream
// are checked without calling the API

const usage = { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 9, total_tokens: 29 }

// The server-sent events of a streamed response with these output items, each message's text streamed as it's written
function events(output: Array<Record<string, any>>, end: Record<string, any> = {}, model = 'gpt-6-astra') {
  const response = { id: 'resp_1', object: 'response', model, status: 'in_progress', output: [], usage: null }
  const list: Array<Record<string, any>> = [{ type: 'response.created', response }]
  output.forEach((item, output_index) => {
    for (const part of item.type === 'message' ? item.content : []) {
      const type = part.type === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta'
      list.push({ type, output_index, content_index: 0, delta: part.text ?? part.refusal })
    }
    list.push({ type: 'response.output_item.done', output_index, item })
  })
  const status = end.status ?? 'completed'
  const type = status === 'completed' ? 'response.completed' : `response.${status}`
  list.push({ type, response: { ...response, status, output, usage, incomplete_details: null, ...end } })
  return list
    .map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
    .join('')
}

const message = (text: string, phase = 'final_answer') => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  phase,
  content: [{ type: 'output_text', text, annotations: [] }],
})

const call = (call_id: string, name: string, args: string) => ({
  type: 'function_call',
  id: `fc_${call_id}`,
  call_id,
  name,
  arguments: args,
  status: 'completed',
})

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-secret' }

// A client whose fetch answers each request with the next of these replies, and keeps the requests
function client(...replies: Array<(init: RequestInit) => Response>) {
  const requests: Array<{ body: any }> = []
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init!.body)) })
    return replies.shift()!(init!)
  }
  return { requests, sdk: new OpenAI({ apiKey: 'test', fetch, maxRetries: 0 }) }
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

test('a request asks for the model and effort, keeps nothing at OpenAI, and sends the tools unchanged', async () => {
  const { requests, sdk } = client(stream(events([message('Hi')])))
  const texts: Array<string> = []
  const reply = await openai({}, sdk).reply(
    request,
    { ...none, text: (text) => texts.push(text) },
    new AbortController().signal,
  )

  expect(texts).toEqual(['Hi'])
  expect(reply).toEqual({
    content: [
      { type: 'opaque', provider: 'openai', data: message('Hi') },
      { type: 'text', text: 'Hi' },
    ],
    stop: 'end',
    model: 'gpt-6-astra',
    usage,
  })

  const [{ body }] = requests
  expect(body).toEqual({
    model: 'gpt-6-astra',
    stream: true,
    store: false,
    reasoning: { effort: 'medium' },
    instructions: 'The instructions',
    tools: toolSpecs.map(({ name, description, inputSchema }) => ({
      type: 'function',
      name,
      description,
      parameters: inputSchema,
      strict: false,
    })),
    // A system message partway through is a developer message
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: "It's 2026-11-02 12:00 UTC." }] },
    ],
  })
})

test('the config picks the model and effort', async () => {
  const { requests, sdk } = client(stream(events([message('Hi')])))
  await openai({ model: 'gpt-6.1-sol', effort: 'low' }, sdk).reply(request, none, new AbortController().signal)

  expect(requests[0].body).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } })
})

test('a reply with calls keeps its items whole, and goes back exactly as it came', async () => {
  const output = [
    reasoning,
    message('Let me look.', 'commentary'),
    call('call_1', 'search_entries', '{"query": "lamp"}'),
    call('call_2', 'list_forms', '{}'),
  ]
  const { requests, sdk } = client(stream(events(output)), stream(events([message('Done')])))
  const provider = openai({}, sdk)
  const reply = await provider.reply(request, none, new AbortController().signal)

  expect(reply.stop).toBe('tools')
  expect(reply.content.map((part) => (part.type === 'opaque' ? `${part.provider}:${part.type}` : part.type))).toEqual([
    'openai:opaque',
    'openai:opaque',
    'text',
    'openai:opaque',
    'toolCall',
    'openai:opaque',
    'toolCall',
  ])
  expect(reply.content[4]).toEqual({ type: 'toolCall', id: 'call_1', name: 'search_entries', input: { query: 'lamp' } })

  // Sent back, its items go as they came, reasoning, phase and arguments' spacing included, and the results after them
  const results = reply.content.flatMap((part) =>
    part.type === 'toolCall'
      ? [{ type: 'toolResult' as const, id: part.id, content: [{ type: 'text' as const, text: '[]' }] }]
      : [],
  )
  const messages = [...request.messages, { role: 'assistant' as const, content: reply.content }]
  await provider.reply(
    { ...request, messages: [...messages, { role: 'user', content: results }] },
    none,
    new AbortController().signal,
  )
  expect(requests[1].body.input.slice(2)).toEqual([
    ...output,
    { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: '[]' }] },
    { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: '[]' }] },
  ])
})

test("a reply without the provider's items, such as another provider's, goes back as its text and calls", async () => {
  const { requests, sdk } = client(stream(events([message('OK')])))
  await openai({}, sdk).reply(
    {
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'toolCall', id: 'toolu_1', name: 'search_entries', input: { query: 'lamp' } },
          ],
        },
        { role: 'user', content: [{ type: 'toolResult', id: 'toolu_1', content: [{ type: 'text', text: '[]' }] }] },
      ],
    },
    none,
    new AbortController().signal,
  )

  expect(requests[0].body.input.slice(1)).toEqual([
    { role: 'assistant', content: 'Let me look.' },
    { type: 'function_call', call_id: 'toolu_1', name: 'search_entries', arguments: '{"query":"lamp"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: [{ type: 'input_text', text: '[]' }] },
  ])
})

test("stop reasons become the CMS's own", async () => {
  const cases: Array<[Array<Record<string, any>>, Record<string, any>, string]> = [
    [[message('x')], {}, 'end'],
    [[call('call_1', 'list_forms', '{}')], {}, 'tools'],
    [[message('x')], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'length'],
    [[message('x')], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'refused'],
    [[{ ...message(''), content: [{ type: 'refusal', refusal: "I can't help with that." }] }], {}, 'refused'],
  ]
  for (const [output, end, stop] of cases) {
    const { sdk } = client(stream(events(output, end)))
    const reply = await openai({}, sdk).reply(request, none, new AbortController().signal)
    expect(reply.stop).toBe(stop)
  }
})

test('a refusal streams and shows as text', async () => {
  const refusal = { ...message(''), content: [{ type: 'refusal', refusal: "I can't help with that." }] }
  const { sdk } = client(stream(events([refusal])))
  const texts: Array<string> = []
  const reply = await openai({}, sdk).reply(
    request,
    { ...none, text: (text) => texts.push(text) },
    new AbortController().signal,
  )

  expect(texts).toEqual(["I can't help with that."])
  expect(reply.content[1]).toEqual({ type: 'text', text: "I can't help with that." })
})

test("the API's errors become messages for the person", async () => {
  const failing =
    (status: number, message: string, code: string | null = null) =>
    () =>
      new Response(JSON.stringify({ error: { message, type: 'some_error', param: null, code } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  const cases = [
    [failing(429, 'Slow down'), 'OpenAI is limiting how often this site can ask right now. Try again in a minute.'],
    [
      failing(429, 'You exceeded your current quota', 'insufficient_quota'),
      "The site's OpenAI account has run out of credit. Whoever runs the site can add more.",
    ],
    [failing(401, 'Bad key'), "OpenAI didn't accept the site's API key. Whoever runs the site can check it."],
    [
      failing(404, 'No such model'),
      'OpenAI has no model called gpt-6-astra. Whoever runs the site can check the model it asks for.',
    ],
    [
      failing(400, 'Your input exceeds the context window'),
      'OpenAI turned the request down: Your input exceeds the context window',
    ],
    [failing(500, 'Oops'), 'OpenAI is overloaded or having trouble. Try again in a moment.'],
    [
      stream(events([], { status: 'failed', error: { code: 'server_error', message: 'The model broke' } })),
      "OpenAI couldn't write the reply: The model broke",
    ],
    [
      stream('event: error\ndata: {"type":"error","code":"server_error","message":"Stream broke","param":null}\n\n'),
      'OpenAI replied with an error: Stream broke',
    ],
  ] as const
  for (const [reply, text] of cases) {
    const { sdk } = client(reply)
    // The CMS shows an AiError's message in the chat
    await expect(openai({}, sdk).reply(request, none, new AbortController().signal)).rejects.toMatchObject({
      name: 'AiError',
      message: text,
    })
  }
})

test("a tool call whose arguments aren't JSON is asked for again, dropping what that try wrote", async () => {
  const broken = [message('Searching', 'commentary'), call('call_1', 'search_entries', '{"query":"a" "b"}')]
  const { requests, sdk } = client(stream(events(broken)), stream(events([message('Done')])))
  const said: Array<string> = []
  const reply = await openai({}, sdk).reply(
    request,
    { text: (text) => said.push(text), restart: () => said.push('restart') },
    new AbortController().signal,
  )

  expect(requests).toHaveLength(2)
  expect(said).toEqual(['Searching', 'restart', 'Done'])
  expect(reply.content.at(-1)).toEqual({ type: 'text', text: 'Done' })
})

test('a stopped reply keeps the text it had written', async () => {
  const stop = new AbortController()
  const { sdk } = client((init) => {
    const start = events([message('Half')]).split('event: response.output_item.done')[0]
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(start))
        init.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    })
    return stream(body)()
  })
  const reply = openai({}, sdk).reply(request, { ...none, text: () => stop.abort() }, stop.signal)

  expect(await reply).toEqual({
    content: [{ type: 'text', text: 'Half' }],
    stop: 'stopped',
    model: 'gpt-6-astra',
    usage: null,
  })
})

test('images go as data URLs, in messages and in tool results', async () => {
  const { requests, sdk } = client(stream(events([message('OK')])))
  const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }
  await openai({}, sdk).reply(
    {
      ...request,
      messages: [
        { role: 'user', content: [image, { type: 'text', text: 'What is it?' }] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'list_forms', input: {} }] },
        { role: 'user', content: [{ type: 'toolResult', id: 'call_1', content: [image], isError: true }] },
      ],
    },
    none,
    new AbortController().signal,
  )

  const sent = { type: 'input_image', image_url: 'data:image/png;base64,aGk=', detail: 'auto' }
  expect(requests[0].body.input).toEqual([
    { type: 'message', role: 'user', content: [sent, { type: 'input_text', text: 'What is it?' }] },
    { type: 'function_call', call_id: 'call_1', name: 'list_forms', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: [sent] },
  ])
})
