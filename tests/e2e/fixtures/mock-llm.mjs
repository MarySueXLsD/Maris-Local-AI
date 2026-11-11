// A stand-in for every model engine Maris talks to, so tests never call a real service, need a key
// or load a model into the graphics card:
//   <url>/v1          the OpenAI chat format (OpenAI, Gemini, OpenRouter, LM Studio, llama.cpp …)
//   <url>/anthropic   Claude's Messages API, with the checks the real one makes
//   <url>             Ollama's own API (set ollamaUrl to it)
//   <url>/comfy       nothing (ComfyUI is "not running"); calls are counted
// The pretend models answer by simple rules (see `plan`), and a few of them refuse something on
// purpose, the way real services do, so the app's way of finding that out is exercised.
import http from 'node:http'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The OpenAI-format models, and what each is there to exercise. */
const OPENAI_MODELS = [
  // Does everything: tools, usage numbers, and its own prices (per token, the way OpenRouter lists them).
  { id: 'mock-large', created: 1790000000, context_length: 128000, pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' } },
  // Thinks first (reasoning_content), then answers.
  { id: 'mock-reasoner', created: 1789000000, context_length: 64000 },
  // Refuses tool definitions: Maris has to describe the tools in text instead.
  { id: 'mock-plain', created: 1788000000, context_length: 8192 },
  // Refuses request options one at a time, and wants max_completion_tokens.
  { id: 'mock-picky', created: 1787000000 },
  // Refuses a system message.
  { id: 'mock-nosys', created: 1786000000 },
  // Writes slowly for minutes: something to interrupt.
  { id: 'mock-slow', created: 1785000000 },
  // Not chat models: must never be listed.
  { id: 'text-embedding-mock', created: 1784000000 },
  { id: 'mock-tts-1', created: 1783000000 }
]

const EFFORT = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }
const NO_EFFORT = { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: null, max: { supported: false } }
const thinks = (adaptive, enabled, disabled) => ({ supported: adaptive || enabled, types: { adaptive: { supported: adaptive }, enabled: { supported: enabled }, disabled: { supported: disabled }, between_tools: { supported: false } } })

const CLAUDE_MODELS = [
  // The newest kind: thinks by itself unless told not to, shows its thinking only when asked to.
  {
    type: 'model',
    id: 'claude-mock-5',
    display_name: 'Claude Mock 5',
    created_at: '2026-09-01T00:00:00Z',
    max_input_tokens: 1000000,
    max_tokens: 64000,
    thinksByDefault: true,
    capabilities: { image_input: { supported: true }, thinking: thinks(true, false, true), effort: EFFORT }
  },
  // Thinking that cannot be turned off.
  {
    type: 'model',
    id: 'claude-mock-always',
    display_name: 'Claude Mock Always',
    created_at: '2026-10-01T00:00:00Z',
    max_input_tokens: 1000000,
    max_tokens: 64000,
    thinksByDefault: true,
    capabilities: { image_input: { supported: true }, thinking: thinks(true, false, false), effort: EFFORT }
  },
  // An older kind: thinking by budget, only when asked, no effort setting, no pictures.
  {
    type: 'model',
    id: 'claude-mock-old',
    display_name: 'Claude Mock Old',
    created_at: '2025-02-01T00:00:00Z',
    max_input_tokens: 200000,
    max_tokens: 8192,
    capabilities: { image_input: { supported: false }, thinking: thinks(false, true, true), effort: NO_EFFORT }
  },
  // A small window: the conversation and the room asked for the answer have to fit in it together.
  {
    type: 'model',
    id: 'claude-mock-small',
    display_name: 'Claude Mock Small',
    created_at: '2024-06-01T00:00:00Z',
    max_input_tokens: 22000,
    max_tokens: 16000,
    capabilities: { image_input: { supported: true }, thinking: thinks(false, false, true), effort: NO_EFFORT }
  }
]

/** A value that fits a JSON schema, for requests that ask for structured output. */
function fromSchema(s) {
  if (!s || typeof s !== 'object') return 'mock'
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  const t = Array.isArray(s.type) ? s.type[0] : s.type
  if (t === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fromSchema(v)]))
  if (t === 'array') return []
  if (t === 'integer' || t === 'number') return 0
  if (t === 'boolean') return false
  return 'Mock'
}

/**
 * What the pretend model does next.
 *   task     the person's latest message
 *   result   the latest tool result that came after it, if a tool has been used for it
 *   tools    names of the tools offered (natively or described in text)
 *   images   a picture came with the conversation
 */
function plan({ model, task, result, tools, images = false }) {
  const last = task ?? ''
  const all = last
  if (/REFUSE-TEST/.test(last)) return { kind: 'refuse' }
  if (/slow/.test(model) || /SLOW-TEST|Write a detailed essay/.test(last)) return { kind: 'slow' }
  if (/17 × 23/.test(last)) return { kind: 'text', text: '391' }
  if (/What colour fills this picture/.test(last)) return { kind: 'text', text: images ? 'Red' : 'I was given no picture.' }
  const read = /Read the file (.+?) and reply/.exec(all)
  if (read && tools.includes('read_file')) {
    if (result === undefined) return { kind: 'tool', name: 'read_file', args: { path: read[1].trim() } }
    return { kind: 'text', text: `It says: ${result.replace(/\s+/g, ' ').slice(0, 300)}` }
  }
  const list = /List the files in this folder[^:\n]*:\s*(.+)/.exec(all)
  if (list && tools.includes('list_dir')) {
    if (result === undefined) return { kind: 'tool', say: 'I will look at the folder.', name: 'list_dir', args: { path: list[1].trim() } }
    return { kind: 'text', text: `The folder holds: ${result.replace(/\s+/g, ' ').slice(0, 400)}` }
  }
  const write = /Create a text file at (.+?) containing exactly this text:\s*(.+)/.exec(all)
  if (write && tools.includes('write_file')) {
    if (result === undefined) return { kind: 'tool', name: 'write_file', args: { path: write[1].trim(), content: write[2].trim() } }
    return { kind: 'text', text: /denied|not approved|declin/i.test(result) ? 'You did not approve it, so nothing was written.' : 'Done: the file is written.' }
  }
  const edit = /In the file (.+?) replace "(.+?)" with "(.+?)"/.exec(all)
  if (edit && tools.includes('edit_file')) {
    if (result === undefined) return { kind: 'tool', name: 'edit_file', args: { path: edit[1].trim(), old_text: edit[2], new_text: edit[3] } }
    return { kind: 'text', text: /denied|not approved|declin/i.test(result) ? 'You did not approve it, so the file is unchanged.' : 'Done: the file is changed.' }
  }
  const run = /Run this command:\s*(.+)/.exec(all)
  if (run && tools.includes('run_command')) {
    if (result === undefined) return { kind: 'tool', name: 'run_command', args: { command: run[1].trim() } }
    return { kind: 'text', text: `The command printed: ${result.replace(/\s+/g, ' ').slice(0, 300)}` }
  }
  // A question about Maris itself: looked up in the app's help, as the instructions ask of a real model.
  const help = /Ask the Maris help: ([^\n]+)/.exec(all)
  if (help && tools.includes('maris_help')) {
    if (result === undefined) return { kind: 'tool', name: 'maris_help', args: { topic: help[1].trim() } }
    const title = /^# (.+)/m.exec(result)?.[1] ?? '(no article)'
    const where = /^Where in the app: (.+)$/m.exec(result)?.[1] ?? ''
    const now = /Right now in this copy of Maris:\n((?:- .+\n?)+)/.exec(result)?.[1] ?? ''
    return { kind: 'text', text: `The help article is "${title}". Open ${where}\n\n${now}` }
  }
  if (/What is set up in Maris\?/.test(all) && tools.includes('maris_status')) {
    if (result === undefined) return { kind: 'tool', name: 'maris_status', args: {} }
    return { kind: 'text', text: result.slice(0, 3000) }
  }
  if (/BROKEN-CALL-TEST/.test(all) && tools.includes('list_dir')) {
    if (result === undefined) return { kind: 'tool', name: 'list_dir', args: {}, broken: '{"path": "C:\\\\' }
    return { kind: 'text', text: 'The first attempt was not readable JSON; nothing was run on a guess.' }
  }
  return { kind: 'text', text: `Hello from ${model}. You wrote: ${last.replace(/\s+/g, ' ').trim().slice(-120)}` }
}

const RESULT_BLOCK = /<tool_result[^>]*>\n?([\s\S]*?)\n?<\/tool_result>/g

/**
 * From a conversation in system/user/assistant/tool roles: the person's latest message and the tool
 * result that came after it (results may also arrive as text inside user messages).
 */
function latest(msgs, textOf) {
  let task = ''
  let result
  for (const m of msgs) {
    if (m.role === 'tool') result = textOf(m.content)
    else if (m.role === 'user') {
      const t = textOf(m.content)
      const inner = [...t.matchAll(RESULT_BLOCK)].map((x) => x[1])
      const rest = t.replace(RESULT_BLOCK, '').trim()
      if (rest) {
        task = rest
        result = undefined
      } else if (inner.length) result = inner[inner.length - 1]
    }
  }
  return { task, result }
}

export async function startMockLlm({ key = 'test-key', host = '127.0.0.1', port: wantPort = 0 } = {}) {
  /** Every request received, oldest first: { api, path, model, body, headers }. */
  const requests = []
  const counts = { slowStarted: 0, slowAborted: 0, comfy: 0, unloads: [], priceLookups: 0 }
  const tooLongSaid = new Set()
  /** Ollama's side: installed models, and which are loaded right now. */
  const local = new Map()
  const loaded = new Map()

  const send = (res, status, body, type = 'application/json') => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length })
    res.end(data)
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          resolve({})
        }
      })
    })
  const words = (text) => text.match(/\S+\s*|\s+/g) ?? []

  // ------------------------------------------------------------------ OpenAI format

  const oaText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '')

  async function openaiChat(req, res, body) {
    const model = String(body.model ?? '')
    const bad = (message, status = 400) => send(res, status, { error: { message, type: 'invalid_request_error' } })
    if (!OPENAI_MODELS.some((m) => m.id === model)) return bad(`The model \`${model}\` does not exist`, 404)
    if (model === 'mock-plain' && body.tools) return bad(`${model} does not support tools`)
    if (model === 'mock-picky') {
      if (body.stream_options) return bad('Unrecognized request argument supplied: stream_options')
      if (body.temperature !== undefined) return bad("Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.")
      if (body.max_tokens !== undefined) return bad("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
    }
    if (model === 'mock-nosys' && body.messages?.some((m) => m.role === 'system')) return bad('Developer instruction is not enabled for models/mock-nosys')
    // A service that does not list how much its models take says so the hard way, once.
    if (/TOO-LONG-TEST/.test(JSON.stringify(body.messages ?? [])) && !tooLongSaid.has(model)) {
      tooLongSaid.add(model)
      return bad("This model's maximum context length is 60000 tokens. However, your messages resulted in 61234 tokens. Please reduce the length of the messages.")
    }
    // The format's own rules, as real services enforce them.
    const msgs = body.messages ?? []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const ids = m.tool_calls.map((c) => c.id)
        const answered = []
        for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) answered.push(msgs[j].tool_call_id)
        const missing = ids.filter((id) => !answered.includes(id))
        if (missing.length) return bad(`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. Missing: ${missing.join(', ')}`)
      }
    }

    const system = msgs.filter((m) => m.role === 'system').map((m) => oaText(m.content)).join('\n')
    const userTexts = msgs.filter((m) => m.role === 'user').map((m) => oaText(m.content))
    // Tools described in text (for a model without tool calling): results come back inside user messages.
    const asText = !body.tools && /<tool_call>/.test(system + userTexts.join('\n'))
    const { task, result } = latest(msgs, oaText)
    const offered = body.tools ? body.tools.map((t) => t.function?.name) : asText ? [...(system + userTexts.join('\n')).matchAll(/^- ([\w.-]+)\(/gm)].map((m) => m[1]) : []
    const step = body.response_format ? { kind: 'text', text: JSON.stringify(fromSchema(body.response_format.json_schema?.schema ?? { type: 'object', properties: { title: { type: 'string' } } })) } : plan({ model, task, result, tools: offered, images: msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')) })

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    let n = 0
    const chunk = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    const end = (finish) => {
      chunk({}, finish)
      if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [], usage: { prompt_tokens: Math.ceil(JSON.stringify(msgs).length / 4), completion_tokens: n, total_tokens: 0 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    chunk({ role: 'assistant', content: '' })
    if (step.kind === 'refuse') return end('content_filter')
    if (step.kind === 'slow') {
      counts.slowStarted++
      let open = true
      res.on('close', () => {
        if (open) counts.slowAborted++
        open = false
      })
      for (let i = 0; i < 600 && open; i++) {
        chunk({ content: `word${i} ` })
        n++
        await sleep(250)
      }
      if (open) {
        open = false
        end('stop')
      }
      return
    }
    if (model === 'mock-reasoner') {
      for (const w of words('The person greets me. I will answer in a friendly way and keep it short.')) {
        chunk({ reasoning_content: w })
        await sleep(15)
      }
    }
    if (step.kind === 'tool' && asText) {
      // A model without tool calling writes the call as text, and would go on to invent the result if
      // nothing stopped it. Maris must cut it off at the end of the call.
      const call = step.broken ? `<tool_call>\n{"name": "${step.name}", "arguments": ${step.broken}\n</tool_call>` : `<tool_call>\n${JSON.stringify({ name: step.name, arguments: step.args })}\n</tool_call>`
      const invented = '\n<tool_result>\nINVENTED-RESULT-MUST-NOT-SHOW\n</tool_result>\nThe folder holds INVENTED things.'
      const stops = Array.isArray(body.stop) ? body.stop : []
      let text = `${step.say ?? 'One moment.'}\n${call}${invented}`
      // Like a real server: generation ends at the first stop sequence, which is not part of the output.
      const cut = stops.map((s) => text.indexOf(s)).filter((i) => i >= 0)
      if (cut.length) text = text.slice(0, Math.min(...cut))
      for (const w of words(text)) {
        if (res.destroyed) return
        chunk({ content: w })
        n++
        await sleep(8)
      }
      return end('stop')
    }
    if (step.kind === 'tool') {
      if (step.say) for (const w of words(step.say)) chunk({ content: w })
      const args = step.broken ?? JSON.stringify(step.args)
      chunk({ tool_calls: [{ index: 0, id: `call_mock_${requests.length}`, type: 'function', function: { name: step.name, arguments: '' } }] })
      // Arguments arrive in pieces, like the real thing.
      for (let i = 0; i < args.length; i += 9) {
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] })
        await sleep(5)
      }
      return end('tool_calls')
    }
    for (const w of words(step.text)) {
      if (res.destroyed) return
      chunk({ content: w })
      n++
      await sleep(12)
    }
    end('stop')
  }

  // ------------------------------------------------------------------ Claude's Messages API

  async function claudeMessages(req, res, body) {
    const err = (type, message, status = 400) => send(res, status, { type: 'error', error: { type, message } })
    const info = CLAUDE_MODELS.find((m) => m.id === body.model)
    if (!info) return err('not_found_error', `model: ${body.model}`, 404)
    // The checks the real API makes on a request.
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return err('invalid_request_error', 'max_tokens: Field required')
    if (body.max_tokens > info.max_tokens) return err('invalid_request_error', `max_tokens: ${body.max_tokens} > ${info.max_tokens}, which is the maximum allowed number of output tokens for ${info.id}`)
    for (const k of ['temperature', 'top_p', 'top_k']) if (body[k] !== undefined) return err('invalid_request_error', `${k}: Extra inputs are not permitted for this model`)
    if (body.output_config?.effort !== undefined) {
      const level = info.capabilities.effort[body.output_config.effort]
      if (!info.capabilities.effort.supported || !level?.supported) return err('invalid_request_error', `output_config.effort: this model does not support effort "${body.output_config.effort}"`)
    }
    if (body.thinking) {
      const types = info.capabilities.thinking.types
      if (body.thinking.type === 'disabled' && !types.disabled.supported) return err('invalid_request_error', 'thinking.type.disabled is not supported for this model: its thinking cannot be turned off')
      if (body.thinking.type === 'adaptive' && !types.adaptive.supported) return err('invalid_request_error', 'thinking.type: adaptive thinking is not supported on this model')
      if (body.thinking.type === 'enabled' && !types.enabled.supported) return err('invalid_request_error', 'thinking.type.enabled is not supported for this model. Use thinking.type.adaptive')
      if (body.thinking.type === 'enabled' && !(body.thinking.budget_tokens >= 1024 && body.thinking.budget_tokens < body.max_tokens)) return err('invalid_request_error', 'thinking.budget_tokens: must be at least 1024 and less than max_tokens')
    }
    if (body.tool_choice && body.tool_choice.type !== 'auto' && body.thinking) return err('invalid_request_error', 'Thinking may not be enabled when tool_choice forces tool use.')
    const msgs = body.messages ?? []
    if (!msgs.length || msgs[0].role !== 'user') return err('invalid_request_error', 'messages: first message must use the "user" role')
    if (msgs[msgs.length - 1].role !== 'user') return err('invalid_request_error', 'This model does not support assistant message prefill. The conversation must end with a user message.')
    const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []))
    for (let i = 0; i < msgs.length; i++) {
      if (i > 0 && msgs[i].role === msgs[i - 1].role) return err('invalid_request_error', `messages: roles must alternate between "user" and "assistant", but found multiple "${msgs[i].role}" roles in a row`)
      const blocks = blocksOf(msgs[i])
      if (!blocks.length) return err('invalid_request_error', `messages.${i}: all messages must have non-empty content`)
      for (const b of blocks) if (b.type === 'text' && !String(b.text ?? '').trim()) return err('invalid_request_error', `messages.${i}: text content blocks must contain non-whitespace text`)
      if (msgs[i].role === 'assistant') {
        const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)
        if (!ids.length) continue
        const next = blocksOf(msgs[i + 1] ?? { content: [] })
        const lead = []
        for (const b of next) {
          if (b.type !== 'tool_result') break
          lead.push(b.tool_use_id)
        }
        const missing = ids.filter((id) => !lead.includes(id))
        if (missing.length) return err('invalid_request_error', `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`)
        // A thinking block passed back must be exactly the one that was sent.
        for (const b of blocks) if (b.type === 'thinking' && b.signature !== 'mock-signature') return err('invalid_request_error', `messages.${i}: thinking blocks cannot be modified. These blocks must remain as they were in the original response.`)
      }
    }
    for (const t of body.tools ?? []) if (!t.name || !t.input_schema || t.input_schema.type !== 'object') return err('invalid_request_error', `tools: ${t.name ?? '?'}: input_schema must be an object schema`)
    // The conversation and the answer share the window (pictures count as pictures, not as their data).
    const chars = JSON.stringify(msgs).replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":"picture"').length + JSON.stringify(body.system ?? '').length + JSON.stringify(body.tools ?? []).length
    const sent = Math.ceil(chars / 4)
    if (sent > info.max_input_tokens) return err('invalid_request_error', `prompt is too long: ${sent} tokens > ${info.max_input_tokens} maximum`)
    if (sent + body.max_tokens > info.max_input_tokens) return err('invalid_request_error', `input length and \`max_tokens\` exceed context limit: ${sent} + ${body.max_tokens} > ${info.max_input_tokens}, decrease input length or \`max_tokens\` and try again`)

    let task = ''
    let result
    for (const m of msgs) {
      if (m.role !== 'user') continue
      for (const b of blocksOf(m)) {
        if (b.type === 'tool_result') result = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('')
        else if (b.type === 'text' && b.text.trim() && b.text !== 'Continue.') {
          task = b.text
          result = undefined
        }
      }
    }
    const images = msgs.some((m) => blocksOf(m).some((b) => b.type === 'image'))
    if (images && !info.capabilities.image_input.supported) return err('invalid_request_error', `${info.id} does not support image input`)
    const step = plan({ model: info.id, task, result, tools: (body.tools ?? []).map((t) => t.name), images })

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    let out = 0
    let index = 0
    ev('message_start', { message: { id: `msg_mock_${requests.length}`, type: 'message', role: 'assistant', model: info.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Math.ceil(JSON.stringify(msgs).length / 4), output_tokens: 1 } } })
    const finish = (stop, extra = {}) => {
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: out } })
      ev('message_stop', {})
      res.end()
    }
    const textBlock = async (text) => {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (const w of words(text)) {
        if (res.destroyed) return
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: w } })
        out++
        await sleep(12)
      }
      ev('content_block_stop', { index })
      index++
    }
    if (step.kind === 'refuse') return finish('refusal', { stop_details: { type: 'refusal', category: 'other', explanation: 'This is the mock declining on purpose.' } })
    // Asked to think, or a model that thinks unless told not to. Its text only comes when it was asked
    // for (older models always show it); the block and its signature come either way.
    const thinking = body.thinking ? body.thinking.type !== 'disabled' : Boolean(info.thinksByDefault)
    const shown = body.thinking?.display === 'summarized' || body.thinking?.type === 'enabled'
    if (thinking) {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (shown) {
        for (const w of words('The person wants something simple. I will do exactly that.')) {
          ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: w } })
          await sleep(10)
        }
      }
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock-signature' } })
      ev('content_block_stop', { index })
      index++
    }
    if (step.kind === 'slow') {
      counts.slowStarted++
      let open = true
      res.on('close', () => {
        if (open) counts.slowAborted++
        open = false
      })
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (let i = 0; i < 600 && open; i++) {
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: `word${i} ` } })
        await sleep(250)
      }
      if (open) {
        open = false
        ev('content_block_stop', { index })
        finish('end_turn')
      }
      return
    }
    if (step.kind === 'tool') {
      if (step.say) await textBlock(step.say)
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_mock_${requests.length}`, name: step.name, input: {} } })
      const args = JSON.stringify(step.args)
      for (let i = 0; i < args.length; i += 11) {
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(i, i + 11) } })
        await sleep(5)
      }
      ev('content_block_stop', { index })
      return finish('tool_use')
    }
    await textBlock(step.text)
    finish('end_turn')
  }

  // ------------------------------------------------------------------ Ollama

  async function ollamaChat(req, res, body) {
    const model = String(body.model ?? '')
    const m = local.get(model)
    if (!m) return send(res, 404, { error: `model '${model}' not found` })
    if (body.tools?.length && !m.caps.includes('tools')) return send(res, 400, { error: `registry.ollama.ai/library/${model} does not support tools` })
    if (body.think !== undefined && body.think !== false && !m.caps.includes('thinking')) return send(res, 400, { error: `"${model}" does not support thinking` })
    if (body.messages?.some((x) => x.images?.length) && !m.caps.includes('vision')) return send(res, 400, { error: `"${model}" does not support images` })
    const msgs = body.messages ?? []
    const system = msgs.filter((x) => x.role === 'system').map((x) => x.content).join('\n')
    const userTexts = msgs.filter((x) => x.role === 'user').map((x) => String(x.content ?? ''))
    const asText = !body.tools && /<tool_call>/.test(system)
    const { task, result } = latest(msgs, (c) => String(c ?? ''))
    const offered = body.tools ? body.tools.map((t) => t.function?.name) : asText ? [...system.matchAll(/^- ([\w.-]+)\(/gm)].map((x) => x[1]) : []
    const step = body.format ? { kind: 'text', text: JSON.stringify(body.format === 'json' ? { title: 'Mock' } : fromSchema(body.format)) } : plan({ model, task, result, tools: offered, images: msgs.some((x) => x.images?.length) })

    loaded.set(model, { num_ctx: body.options?.num_ctx ?? 4096 })
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    const line = (o) => res.write(`${JSON.stringify({ model, created_at: new Date().toISOString(), ...o })}\n`)
    let n = 0
    const done = (reason = 'stop') => {
      line({ message: { role: 'assistant', content: '' }, done: true, done_reason: reason, prompt_eval_count: Math.ceil(JSON.stringify(msgs).length / 4), eval_count: n, eval_duration: 5e8, load_duration: 1e8, total_duration: 9e8 })
      res.end()
    }
    if (step.kind === 'slow') {
      counts.slowStarted++
      let open = true
      res.on('close', () => {
        if (open) counts.slowAborted++
        open = false
      })
      for (let i = 0; i < 600 && open; i++) {
        line({ message: { role: 'assistant', content: `word${i} ` }, done: false })
        await sleep(250)
      }
      if (open) {
        open = false
        done()
      }
      return
    }
    if (step.kind === 'refuse') step.text = 'I would rather not.'
    if (body.think && m.caps.includes('thinking')) {
      for (const w of words('Simple request. I will answer directly.')) {
        line({ message: { role: 'assistant', content: '', thinking: w }, done: false })
        await sleep(10)
      }
    }
    if (step.kind === 'tool' && asText) {
      const stops = Array.isArray(body.options?.stop) ? body.options.stop : []
      let text = `${step.say ?? 'One moment.'}\n<tool_call>\n${JSON.stringify({ name: step.name, arguments: step.args })}\n</tool_call>\n<tool_result>\nINVENTED-RESULT-MUST-NOT-SHOW\n</tool_result>`
      const cut = stops.map((s) => text.indexOf(s)).filter((i) => i >= 0)
      if (cut.length) text = text.slice(0, Math.min(...cut))
      for (const w of words(text)) {
        if (res.destroyed) return
        line({ message: { role: 'assistant', content: w }, done: false })
        n++
        await sleep(8)
      }
      return done()
    }
    if (step.kind === 'tool') {
      if (step.say) line({ message: { role: 'assistant', content: step.say }, done: false })
      line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: step.name, arguments: step.args } }] }, done: false })
      return done()
    }
    for (const w of words(step.text)) {
      if (res.destroyed) return
      line({ message: { role: 'assistant', content: w }, done: false })
      n++
      await sleep(12)
    }
    done()
  }

  // ------------------------------------------------------------------ routing

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    try {
      // ---- The public price list (MARIS_PRICE_LIST_URL points here in tests).
      if (p === '/prices') {
        counts.priceLookups++
        const filler = Array.from({ length: 24 }, (_, i) => ({ id: `openai/mock-filler-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } }))
        return send(res, 200, { data: [{ id: 'anthropic/claude-mock-5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' } }, { id: 'anthropic/claude-mock-old:extended', pricing: { prompt: '0.00009', completion: '0.00009' } }, ...filler] })
      }
      // ---- ComfyUI: not there.
      if (p.startsWith('/comfy')) {
        counts.comfy++
        return send(res, 404, 'Not found', 'text/plain')
      }
      // ---- OpenAI format
      if (p.startsWith('/v1/')) {
        if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } })
        if (p === '/v1/models' && req.method === 'GET') return send(res, 200, { object: 'list', data: OPENAI_MODELS.map((m) => ({ object: 'model', owned_by: 'mock', ...m })) })
        if (p === '/v1/chat/completions' && req.method === 'POST') {
          const body = await readBody(req)
          requests.push({ api: 'openai', path: p, model: body.model, body, headers: req.headers })
          return await openaiChat(req, res, body)
        }
        return send(res, 404, { error: { message: `Unknown path ${p}` } })
      }
      // ---- Claude
      if (p.startsWith('/anthropic/')) {
        // The SDK sends the key as a bearer token since API version 2026-10-21; older clients as X-Api-Key.
        if (req.headers.authorization !== `Bearer ${key}` && req.headers['x-api-key'] !== key) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
        if (!req.headers['anthropic-version']) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version: header is required' } })
        if (p === '/anthropic/v1/models' && req.method === 'GET') return send(res, 200, { data: CLAUDE_MODELS.map(({ thinksByDefault, ...m }) => m), has_more: false, first_id: CLAUDE_MODELS[0].id, last_id: CLAUDE_MODELS[CLAUDE_MODELS.length - 1].id })
        if (p === '/anthropic/v1/messages' && req.method === 'POST') {
          const body = await readBody(req)
          requests.push({ api: 'anthropic', path: p, model: body.model, body, headers: req.headers })
          if (!body.stream) return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'The mock only streams.' } })
          return await claudeMessages(req, res, body)
        }
        return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: p } })
      }
      // ---- Ollama
      if (p === '/api/version') return send(res, 200, { version: '0.12.9-mock' })
      if (p === '/api/tags') {
        return send(res, 200, {
          models: [...local.entries()].map(([name, m]) => ({ name, model: name, size: m.sizeBytes, modified_at: '2026-10-01T10:00:00Z', details: { family: m.family, parameter_size: m.params, quantization_level: 'Q4_K_M' } }))
        })
      }
      if (p === '/api/ps') {
        return send(res, 200, {
          models: [...loaded.entries()].map(([name, l]) => ({ name, model: name, size: local.get(name)?.sizeBytes ?? 0, size_vram: 0, expires_at: new Date(Date.now() + 1800_000).toISOString(), context_length: l.num_ctx }))
        })
      }
      if (p === '/api/show') {
        const body = await readBody(req)
        const m = local.get(body.model)
        if (!m) return send(res, 404, { error: `model '${body.model}' not found` })
        return send(res, 200, { capabilities: m.caps, details: { family: m.family, parameter_size: m.params, quantization_level: 'Q4_K_M' }, model_info: { [`${m.family}.context_length`]: m.ctx } })
      }
      if (p === '/api/chat') {
        const body = await readBody(req)
        requests.push({ api: 'ollama', path: p, model: body.model, body, headers: req.headers })
        return await ollamaChat(req, res, body)
      }
      if (p === '/api/generate') {
        const body = await readBody(req)
        if (body.keep_alive === 0) {
          loaded.delete(body.model)
          counts.unloads.push(body.model)
        }
        return send(res, 200, { model: body.model, response: '', done: true, done_reason: 'unload' })
      }
      if (p === '/api/embed') {
        const body = await readBody(req)
        const input = Array.isArray(body.input) ? body.input : [body.input]
        return send(res, 200, { model: body.model, embeddings: input.map((t) => Array.from({ length: 16 }, (_, i) => ((String(t).charCodeAt(i % Math.max(1, String(t).length)) || 1) % 17) / 17)) })
      }
      if (p === '/api/pull') {
        const body = await readBody(req)
        requests.push({ api: 'ollama', path: p, model: body.model, body, headers: req.headers })
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        let open = true
        res.on('close', () => (open = false))
        const total = 400_000_000
        // Slow enough to be caught in the act (about half a minute), and it stops when the app lets go.
        for (let done = 0; done < total && open; done += 4_000_000) {
          res.write(`${JSON.stringify({ status: 'pulling mock-layer', digest: 'sha256:mock', total, completed: done })}\n`)
          await sleep(300)
        }
        if (open) {
          res.write(`${JSON.stringify({ status: 'success' })}\n`)
          res.end()
        }
        return
      }
      send(res, 404, { error: `Unknown path ${p}` })
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: { message: String(e?.message ?? e) } })
      else res.end()
    }
  })
  await new Promise((resolve) => server.listen(wantPort, host, resolve))
  const port = server.address().port
  const url = `http://${host}:${port}`
  return {
    url,
    port,
    key,
    requests,
    counts,
    /** The requests one model got, oldest first. */
    of: (model) => requests.filter((r) => r.model === model),
    /** Install a pretend model in the pretend Ollama. caps: completion, tools, thinking, vision, embedding. */
    addLocalModel: (name, { sizeGB = 1, caps = ['completion', 'tools'], ctx = 32768, family = 'mock', params = '1B' } = {}) => local.set(name, { sizeBytes: Math.round(sizeGB * 2 ** 30), caps, ctx, family, params }),
    loadedModels: () => [...loaded.keys()],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

// Run by itself, it serves on a fixed port so the API tab can be tried by hand:
//   node tests/e2e/fixtures/mock-llm.mjs        → address http://127.0.0.1:8765/v1, key test-key
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const m = await startMockLlm({ port: Number(process.argv[2]) || 8765 })
  m.addLocalModel('mock-local:1b')
  console.log(`Mock model services at ${m.url}\n  OpenAI format: ${m.url}/v1   key: ${m.key}\n  Ollama format: ${m.url}`)
}
