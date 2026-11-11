import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThinkTags, anthropicInputSize, errorText, imageMime, negotiate, readModel, readModelList, toAnthropic, toOpenAi } from '../src/main/engines/wire.ts'
import { cleanBaseUrl, defaultPicks, isLocalAddress, isRemoteModel, looksLikeChatModel, parseRemoteModel, remoteModelName } from '../src/shared/providers.ts'

type Msg = Parameters<typeof toOpenAi>[0][number]

const TASK: Msg[] = [
  { role: 'system', content: 'You are Maris.' },
  { role: 'user', content: 'What is in notes.txt?' },
  { role: 'assistant', content: 'Let me look.', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }, { id: 'call_b', function: { name: 'list_dir', arguments: { path: '.' } } }] },
  { role: 'tool', tool_name: 'read_file', content: 'milk, eggs' },
  { role: 'tool', tool_name: 'list_dir', tool_call_id: 'call_b', content: 'notes.txt', is_error: true },
  { role: 'user', content: 'Screenshot', images: ['iVBORw0KGgo='] }
]

// ------------------------------------------------------------------ names and addresses

test('a service model has one name inside Maris, and Ollama names are never mistaken for one', () => {
  const name = remoteModelName('openrouter', 'meta-llama/llama-3.1-8b-instruct:free')
  assert.equal(name, '@openrouter/meta-llama/llama-3.1-8b-instruct:free')
  assert.deepEqual(parseRemoteModel(name), { provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free' })
  assert.equal(isRemoteModel(name), true)
  for (const local of ['qwen3.5:4b', 'hf.co/unsloth/Qwen3-GGUF:Q4_K_M', 'auto', '', undefined, '@', '@x', '@x/']) assert.equal(isRemoteModel(local), false, String(local))
})

test('addresses are tidied, and home addresses are told from the internet', () => {
  assert.equal(cleanBaseUrl(' https://api.openai.com/v1/ '), 'https://api.openai.com/v1')
  assert.equal(cleanBaseUrl('https://api.groq.com/openai/v1/chat/completions'), 'https://api.groq.com/openai/v1')
  assert.equal(cleanBaseUrl('localhost:1234/v1'), 'http://localhost:1234/v1')
  assert.equal(cleanBaseUrl('openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1')
  for (const u of ['http://127.0.0.1:1234/v1', 'http://localhost:8080/v1', 'http://192.168.1.20:5000/v1', 'http://10.0.0.5/v1', 'http://nas.local:8080/v1', 'http://100.101.102.103:11434/v1']) assert.equal(isLocalAddress(u), true, u)
  for (const u of ['https://api.openai.com/v1', 'https://api.anthropic.com', 'http://172.32.0.1/v1', 'not a url']) assert.equal(isLocalAddress(u), false, u)
})

test('only chat models are offered, the newest ticked first', () => {
  for (const id of ['gpt-5', 'claude-opus-5-5', 'gemini-2.5-flash', 'llama-3.3-70b-versatile', 'deepseek-reasoner']) assert.equal(looksLikeChatModel(id), true, id)
  for (const id of ['text-embedding-3-large', 'whisper-1', 'tts-1-hd', 'dall-e-3', 'omni-moderation-latest', 'gpt-image-1', 'gpt-4o-realtime-preview', 'bge-m3']) assert.equal(looksLikeChatModel(id), false, id)
  const picks = defaultPicks(
    [
      { id: 'old', created: 1 },
      { id: 'text-embedding-3-small', created: 99 },
      { id: 'newest', created: 30 },
      { id: 'newer', created: 20 }
    ],
    2
  )
  assert.deepEqual(picks, ['newest', 'newer'])
})

// ------------------------------------------------------------------ model lists

test('model lists are read in every shape services use', () => {
  // OpenAI
  assert.deepEqual(readModelList({ object: 'list', data: [{ id: 'gpt-5', object: 'model', created: 1700000000, owned_by: 'openai' }] }), [
    { id: 'gpt-5', label: undefined, contextLength: undefined, maxOutput: undefined, vision: undefined, tools: undefined, thinking: undefined, created: 1700000000000 }
  ])
  // OpenRouter: says what each model can do
  const or = readModel({
    id: 'anthropic/claude-sonnet',
    name: 'Anthropic: Claude Sonnet',
    created: 1750000000,
    context_length: 1000000,
    architecture: { input_modalities: ['text', 'image'] },
    supported_parameters: ['tools', 'reasoning', 'temperature'],
    top_provider: { max_completion_tokens: 64000 }
  })!
  assert.equal(or.label, 'Anthropic: Claude Sonnet')
  assert.equal(or.contextLength, 1000000)
  assert.equal(or.maxOutput, 64000)
  assert.deepEqual([or.vision, or.tools, or.thinking], [true, true, true])
  // Groq and Mistral
  assert.equal(readModel({ id: 'llama-3.3-70b', context_window: 131072, active: true })!.contextLength, 131072)
  assert.equal(readModel({ id: 'whisper-large', active: false }), undefined)
  assert.deepEqual([readModel({ id: 'mistral-small', capabilities: { completion_chat: true, function_calling: true, vision: false }, max_context_length: 32000 })!.tools, readModel({ id: 'm', capabilities: { vision: false } })!.vision], [true, false])
  assert.equal(readModel({ id: 'mistral-embed', capabilities: { completion_chat: false } }), undefined)
  // Gemini's ids carry a "models/" prefix; Together answers with a bare list and a type
  assert.equal(readModel({ id: 'models/gemini-2.5-flash' })!.id, 'gemini-2.5-flash')
  assert.deepEqual(
    readModelList([
      { id: 'meta/llama', type: 'chat', context_length: 8192 },
      { id: 'flux', type: 'image' }
    ]).map((m) => m.id),
    ['meta/llama']
  )
  // llama.cpp
  assert.equal(readModel({ id: 'local.gguf', meta: { n_ctx_train: 4096 } })!.contextLength, 4096)
  assert.deepEqual(readModelList({ nothing: true }), [])
})

// ------------------------------------------------------------------ OpenAI wire

test('OpenAI format: calls get ids, results answer them in order, pictures become data URLs', () => {
  const w = toOpenAi(TASK)
  assert.deepEqual(
    w.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'tool', 'user']
  )
  const calls = w[2]!.tool_calls!
  assert.equal(calls[0]!.function.arguments, '{"path":"notes.txt"}')
  assert.equal(calls[1]!.id, 'call_b')
  assert.equal(w[3]!.tool_call_id, calls[0]!.id)
  assert.equal(w[4]!.tool_call_id, 'call_b')
  const last = w[5]!.content as { type: string; image_url?: { url: string } }[]
  assert.equal(last[1]!.image_url!.url, 'data:image/png;base64,iVBORw0KGgo=')
})

test('OpenAI format: a call left without a result is answered, and a result without a call becomes text', () => {
  const open = toOpenAi([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'a', arguments: {} } }] },
    { role: 'user', content: 'never mind' }
  ])
  assert.deepEqual(
    open.map((m) => m.role),
    ['user', 'assistant', 'tool', 'user']
  )
  assert.equal(open[2]!.tool_call_id, 'c1')
  const orphan = toOpenAi([
    { role: 'tool', tool_name: 'read_file', content: 'data' },
    { role: 'user', content: 'and?' }
  ])
  assert.equal(orphan[0]!.role, 'user')
  assert.match(String(orphan[0]!.content), /Result of read_file/)
})

test('OpenAI format: a model that takes no system message gets the instructions in the first user message', () => {
  const w = toOpenAi(TASK.slice(0, 2), { noSystem: true })
  assert.deepEqual(
    w.map((m) => m.role),
    ['user']
  )
  assert.match(String(w[0]!.content), /^You are Maris\.\n\n---\n\nWhat is in notes\.txt\?$/)
  // A conversation that would open with the assistant gets a user line in front.
  assert.equal(toOpenAi([{ role: 'assistant', content: 'Hello' }])[0]!.role, 'user')
})

test('a refusal says what to change: an option to drop, another name for it, or a feature the model lacks', () => {
  const body = { model: 'm', messages: [], temperature: 0.2, max_tokens: 900, tools: [{}], stream_options: {}, response_format: {} }
  assert.deepEqual(negotiate(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", body, false), { quirk: { maxTokensKey: 'max_completion_tokens' } })
  assert.deepEqual(negotiate(400, "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", body, false), { quirk: { drop: ['temperature'] } })
  assert.deepEqual(negotiate(400, 'Unrecognized request argument supplied: stream_options', body, false), { quirk: { drop: ['stream_options'] } })
  assert.deepEqual(negotiate(422, 'response_format: Extra inputs are not permitted', body, false), { quirk: { drop: ['response_format'] } })
  assert.deepEqual(negotiate(400, 'registry.ollama.ai/library/gemma3:1b does not support tools', body, false), { capability: 'tools' })
  assert.deepEqual(negotiate(404, 'No endpoints found that support tool use.', body, false), { capability: 'tools' })
  assert.deepEqual(negotiate(400, 'This model does not support image input.', { ...body, tools: undefined }, true), { capability: 'vision' })
  assert.deepEqual(negotiate(400, 'Developer instruction is not enabled for models/gemma-3-1b-it', { model: 'm' }, false), { capability: 'system' })
  // Real errors are left for the person.
  assert.equal(negotiate(401, 'Incorrect API key provided', body, false), undefined)
  assert.equal(negotiate(400, 'max_tokens is too large: 64000. This model supports at most 4096 completion tokens.', body, false), undefined)
  assert.equal(negotiate(429, 'Rate limit: temperature of the servers is high, not supported right now', body, false), undefined)
})

test('error replies are read whatever they are wrapped in', () => {
  assert.equal(errorText('{"error":{"message":"Incorrect API key","type":"invalid_request_error"}}'), 'Incorrect API key')
  assert.equal(errorText('[{"error":{"code":400,"message":"API key not valid."}}]'), 'API key not valid.')
  assert.equal(errorText('{"error":"model not found"}'), 'model not found')
  assert.equal(errorText('{"detail":"Not authenticated"}'), 'Not authenticated')
  assert.equal(errorText('<html><body>502 Bad Gateway</body></html>'), '502 Bad Gateway')
})

test('<think> tags inside the answer are split off, also when a tag arrives in pieces', () => {
  const t = new ThinkTags()
  const got = { content: '', thinking: '' }
  for (const piece of ['<thi', 'nk>Let me see', '. Fine.</th', 'ink>The answer ', 'is 4.']) {
    const r = t.push(piece)
    got.content += r.content
    got.thinking += r.thinking
  }
  const end = t.flush()
  assert.equal(got.thinking + end.thinking, 'Let me see. Fine.')
  assert.equal(got.content + end.content, 'The answer is 4.')
  const plain = new ThinkTags()
  assert.equal(plain.push('a < b and b > a').content + plain.flush().content, 'a < b and b > a')
})

test('pictures are labelled by what they are', () => {
  assert.equal(imageMime('/9j/4AAQSk'), 'image/jpeg')
  assert.equal(imageMime('iVBORw0KGgo'), 'image/png')
  assert.equal(imageMime('R0lGODlh'), 'image/gif')
  assert.equal(imageMime('UklGRh4AAABXRUJQ'), 'image/webp')
})

// ------------------------------------------------------------------ Claude wire

test('Claude format: instructions apart, and all results of a step in one user turn before anything else', () => {
  const { system, messages } = toAnthropic(TASK)
  assert.equal(system, 'You are Maris.')
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user']
  )
  const assistant = messages[1]!.content as { type: string; id?: string; name?: string; input?: unknown }[]
  assert.deepEqual(
    assistant.map((b) => b.type),
    ['text', 'tool_use', 'tool_use']
  )
  assert.deepEqual(assistant[1]!.input, { path: 'notes.txt' })
  const results = messages[2]!.content as { type: string; tool_use_id?: string; is_error?: boolean }[]
  assert.deepEqual(
    results.map((b) => b.type),
    ['tool_result', 'tool_result', 'image', 'text']
  )
  assert.equal(results[0]!.tool_use_id, assistant[1]!.id)
  assert.equal(results[1]!.tool_use_id, 'call_b')
  assert.equal(results[1]!.is_error, true)
  assert.equal(results[0]!.is_error, undefined)
})

test('Claude format: its own earlier turn goes back unchanged, thinking included', () => {
  const raw = [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }
  ]
  const { messages } = toAnthropic([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'toolu_1', function: { name: 'read_file', arguments: { path: 'a' } } }], raw },
    { role: 'tool', tool_name: 'read_file', tool_call_id: 'toolu_1', content: 'done' }
  ])
  assert.equal(messages[1]!.content, raw)
  assert.equal((messages[2]!.content as { tool_use_id: string }[])[0]!.tool_use_id, 'toolu_1')
})

test('Claude format: open calls are closed, the chat opens with the user and never ends on the assistant', () => {
  const { messages } = toAnthropic([
    { role: 'assistant', content: 'Earlier answer', tool_calls: [{ function: { name: 'a', arguments: '{"x":1}' } }] },
    { role: 'user', content: 'stop' },
    { role: 'assistant', content: 'Stopped.' }
  ])
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user']
  )
  const closing = messages[2]!.content as { type: string; text?: string }[]
  assert.deepEqual(
    closing.map((b) => b.type),
    ['tool_result', 'text']
  )
  assert.equal((messages[1]!.content as { input?: unknown }[])[1]!.input && JSON.stringify((messages[1]!.content as { input?: unknown }[])[1]!.input), '{"x":1}')
  // An empty message never reaches the service as an empty block.
  assert.deepEqual(toAnthropic([{ role: 'user', content: '' }]).messages[0]!.content, [{ type: 'text', text: '(no text)' }])
})

test('Claude format: a picture counts as a picture when the size of a request is estimated', () => {
  const estimate = (t: string): number => Math.ceil(t.length / 4)
  const photo = 'A'.repeat(1_400_000)
  const { system, messages } = toAnthropic([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is in this photo?', images: [photo] }
  ])
  const size = anthropicInputSize(system, messages, undefined, estimate)
  assert.ok(size > 1600 && size < 2000, `about one picture, not ${size}`)
  const withTools = anthropicInputSize(system, messages, [{ name: 'read_file', description: 'x'.repeat(4000) }], estimate)
  assert.ok(withTools - size > 900, 'tool descriptions are counted')
})
