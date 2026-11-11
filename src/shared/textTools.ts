// Tool calling for models that have no tool calling of their own (older and very small models, and
// services that turn it off): the tools are described in plain text and the model asks for one by
// writing a small tagged JSON block, which is read back out of its answer. Any model that can follow
// an instruction can work this way, so no model needs support added for it.
// Pure (no imports), so tests/text-tools.test.ts checks it directly.

export interface TextToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TextToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface PlainMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[]
  tool_name?: string
}

/** Generation stops at these, so a model cannot go on to invent the tool's result. */
export const TEXT_TOOL_STOPS = ['</tool_call>', '<tool_result']

type Schema = { type?: unknown; enum?: unknown; items?: unknown; properties?: unknown; required?: unknown; description?: unknown }

/** "string" is the default and left out: path, depth: int, files: [{path, content}]. */
function typeHint(s: Schema | undefined, depth = 0): string {
  if (!s || typeof s !== 'object') return ''
  if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 8) return s.enum.map((v) => JSON.stringify(v)).join('|')
  const t = Array.isArray(s.type) ? s.type[0] : s.type
  if (t === 'integer' || t === 'number') return t === 'integer' ? 'int' : 'number'
  if (t === 'boolean') return 'bool'
  if (t === 'array') {
    const inner = typeHint(s.items as Schema, depth + 1)
    return `[${inner || 'string'}]`
  }
  if (t === 'object' && depth < 2 && s.properties && typeof s.properties === 'object') {
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
    const keys = Object.entries(s.properties as Record<string, Schema>).map(([k, v]) => {
      const h = typeHint(v, depth + 1)
      return `${k}${req.has(k) ? '' : '?'}${h ? `: ${h}` : ''}`
    })
    return `{${keys.join(', ')}}`
  }
  return t === 'object' ? 'object' : ''
}

/** One line per tool: name(arg, other?: int): what it does. */
export function describeTool(t: TextToolSpec, brief = false): string {
  const p = (t.parameters ?? {}) as Schema
  const props = (p.properties && typeof p.properties === 'object' ? p.properties : {}) as Record<string, Schema>
  const req = new Set(Array.isArray(p.required) ? (p.required as string[]) : [])
  const names = Object.keys(props).sort((a, b) => Number(req.has(b)) - Number(req.has(a)))
  const args = names.map((k) => {
    const h = typeHint(props[k])
    return `${k}${req.has(k) ? '' : '?'}${h ? `: ${h}` : ''}`
  })
  let text = t.description.replace(/\s+/g, ' ').trim()
  if (brief) {
    // The first sentence says what the tool is for; the rest is detail a small window cannot afford.
    const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
    text = first.length > 160 ? `${first.slice(0, 157)}…` : first
  }
  return `- ${t.name}(${args.join(', ')}): ${text}`
}

/** The part of the instructions that teaches a model the tool-call block and lists the tools. */
export function toolsAsText(tools: TextToolSpec[], opts: { brief?: boolean } = {}): string {
  if (!tools.length) return ''
  return [
    '## Tools',
    'You can use the tools listed below. To use one, write exactly this and then stop writing:',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"argument": "value"}}',
    '</tool_call>',
    'Rules: one tool call per message, as valid JSON with double quotes. The result comes back in the next message inside <tool_result>; read it, then go on (call another tool or answer). Never write a <tool_result> yourself and never make up what a tool returned. When no tool is needed, just answer.',
    '',
    'Tools:',
    ...tools.map((t) => describeTool(t, opts.brief))
  ].join('\n')
}

export function callAsText(name: string, args: Record<string, unknown> | string): string {
  let a: unknown = args
  if (typeof args === 'string') {
    try {
      a = JSON.parse(args)
    } catch {
      a = { input: args }
    }
  }
  return `<tool_call>\n${JSON.stringify({ name, arguments: a ?? {} })}\n</tool_call>`
}

export function resultAsText(name: string | undefined, content: string): string {
  return `<tool_result${name ? ` name="${name}"` : ''}>\n${content}\n</tool_result>`
}

/**
 * A conversation with tool calls and results rewritten as plain text, for a model that only knows
 * system, user and assistant messages. Neighbouring messages of one role are joined, because some
 * older chat templates refuse two user messages in a row.
 */
export function historyAsText<T extends PlainMessage>(messages: T[]): PlainMessage[] {
  const out: PlainMessage[] = []
  const add = (m: PlainMessage): void => {
    const last = out[out.length - 1]
    if (last && last.role === m.role && m.role !== 'system') {
      last.content = [last.content, m.content].filter(Boolean).join('\n\n')
      if (m.images?.length) last.images = [...(last.images ?? []), ...m.images]
      return
    }
    out.push({ role: m.role, content: m.content, ...(m.images?.length ? { images: [...m.images] } : {}) })
  }
  for (const m of messages) {
    if (m.role === 'tool') add({ role: 'user', content: resultAsText(m.tool_name, m.content) })
    else if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => callAsText(c.function.name, c.function.arguments)).join('\n')
      add({ role: 'assistant', content: [m.content.trim(), calls].filter(Boolean).join('\n') })
    } else add({ role: m.role, content: m.content, images: m.images })
  }
  return out
}

// ------------------------------------------------------------------ reading calls back

/**
 * JSON as small models write it: raw line breaks inside strings, a trailing comma, a missing closing
 * brace, a ```json fence around it. Returns undefined when it cannot be made into a value.
 */
export function looseJson(input: string): unknown {
  let text = input.trim()
  text = text.replace(/^```[a-zA-Z_]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown
    } catch {
      return undefined
    }
  }
  const direct = tryParse(text)
  if (direct !== undefined) return direct
  const start = text.search(/[{[]/)
  if (start < 0) return undefined
  // Walk the text once: escape control characters inside strings, note where the value ends, and
  // remember which brackets are still open.
  let out = ''
  const open: string[] = []
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
      } else if (ch === '\\') {
        escaped = true
        out += ch
      } else if (ch === '"') {
        inString = false
        out += ch
      } else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '{' || ch === '[') {
      open.push(ch === '{' ? '}' : ']')
      out += ch
    } else if (ch === '}' || ch === ']') {
      if (open[open.length - 1] === ch) open.pop()
      out += ch
      if (!open.length) {
        end = i
        break
      }
    } else out += ch
  }
  if (end < 0) {
    // Cut off before it was closed: end the string, drop a dangling comma or key, close what is open.
    if (inString) out += escaped ? '\\"' : '"'
    out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/:\s*$/, ': null')
    out += open.reverse().join('')
  }
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return tryParse(out)
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function', 'function_name', 'action']
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input', 'tool_input', 'action_input', 'kwargs']

/** A tool call from a parsed JSON value in any of the shapes models use, or undefined. */
export function callFromJson(value: unknown): TextToolCall | undefined {
  if (Array.isArray(value)) return callFromJson(value[0])
  if (!value || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  // OpenAI's shape: { function: { name, arguments } } or { type: "function", function: {...} }.
  if (o.function && typeof o.function === 'object') return callFromJson(o.function)
  if (o.tool_call && typeof o.tool_call === 'object') return callFromJson(o.tool_call)
  let name: string | undefined
  for (const k of NAME_KEYS) {
    if (typeof o[k] === 'string' && (o[k] as string).trim()) {
      name = (o[k] as string).trim()
      break
    }
  }
  if (!name || /\s/.test(name) || name.length > 80) return undefined
  let args: unknown
  for (const k of ARG_KEYS) {
    if (o[k] !== undefined) {
      args = o[k]
      break
    }
  }
  if (typeof args === 'string') args = looseJson(args) ?? { input: args }
  if (args === undefined) {
    // Arguments written next to the name: {"name": "read_file", "path": "a.txt"}.
    const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !NAME_KEYS.includes(k) && k !== 'type' && k !== 'id'))
    args = rest
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  return { name, arguments: args as Record<string, unknown> }
}

/** Where a tool call may begin in an answer, and what closes it. */
const OPENERS: { open: RegExp; close?: RegExp; attrName?: boolean }[] = [
  { open: /<tool_call>/i, close: /<\/tool_call>/i },
  { open: /<\|tool_call\|>/i, close: /<\|\/?tool_call(_end)?\|>/i },
  { open: /<function_call>/i, close: /<\/function_call>/i },
  { open: /<tool_use>/i, close: /<\/tool_use>/i },
  // Llama 3 style: <function=read_file>{"path": "a"}</function>
  { open: /<function=([\w.-]+)>/i, close: /<\/function>/i, attrName: true },
  { open: /\[TOOL_CALLS\]/, close: undefined },
  { open: /```(?:tool_call|tool_code|tool)\b[^\n]*\n/i, close: /```/ }
]
/** The shortest text every opener starts with, to notice one that is still arriving. */
const OPENER_STARTS = ['<tool_call>', '<|tool_call|>', '<function_call>', '<tool_use>', '<function=', '[TOOL_CALLS]', '```tool']

function partialOpenerAt(text: string): number {
  // The longest tail of the text that could still grow into an opener ("<tool_c").
  const max = Math.min(text.length, 16)
  for (let n = max; n > 0; n--) {
    const tail = text.slice(-n).toLowerCase()
    if (OPENER_STARTS.some((o) => o.toLowerCase().startsWith(tail))) return text.length - n
  }
  return -1
}

export interface ParsedAnswer {
  /** What the model wrote for the person, with the tool call taken out. */
  text: string
  call?: TextToolCall
  /** A tool-call block was started but its JSON could not be read. */
  broken?: string
}

/**
 * Find a tool call in a finished answer. `known` are the tool names of this chat: a bare JSON object
 * (no tags) only counts as a call when it names one of them.
 */
export function parseAnswer(answer: string, known: string[] = [], opts: { tagsOnly?: boolean } = {}): ParsedAnswer {
  let best: { at: number; len: number; body: string; name?: string } | undefined
  for (const o of OPENERS) {
    const m = o.open.exec(answer)
    if (!m || (best && m.index >= best.at)) continue
    const from = m.index + m[0].length
    const rest = answer.slice(from)
    const c = o.close ? o.close.exec(rest) : undefined
    best = { at: m.index, len: c ? from + c.index + c[0].length - m.index : answer.length - m.index, body: c ? rest.slice(0, c.index) : rest, name: o.attrName ? m[1] : undefined }
  }
  if (best) {
    const text = (answer.slice(0, best.at) + answer.slice(best.at + best.len)).trim()
    const value = looseJson(best.body)
    const call = best.name ? { name: best.name, arguments: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {} } : callFromJson(value)
    return call ? { text: answer.slice(0, best.at).trim(), call } : { text, broken: best.body.trim().slice(0, 2000) }
  }
  if (opts.tagsOnly) return { text: answer }
  // No tags. A ```json block, or a whole answer, that is exactly a call to a known tool.
  const lower = new Set(known.map((k) => k.toLowerCase()))
  const candidates: { at: number; len: number; body: string }[] = []
  for (const m of answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) candidates.push({ at: m.index ?? 0, len: m[0].length, body: m[1] ?? '' })
  const trimmed = answer.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[{')) candidates.push({ at: answer.indexOf(trimmed), len: trimmed.length, body: trimmed })
  // ReAct style: "Action: read_file" then "Action Input: {...}".
  const react = /(?:^|\n)\s*Action\s*:\s*([\w.-]+)\s*\n\s*Action Input\s*:\s*([\s\S]+)$/i.exec(answer)
  if (react && lower.has(react[1]!.toLowerCase())) {
    const value = looseJson(react[2]!)
    return { text: answer.slice(0, react.index).trim(), call: { name: react[1]!, arguments: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { input: react[2]!.trim() } } }
  }
  for (const c of candidates) {
    const call = callFromJson(looseJson(c.body))
    if (call && lower.has(call.name.toLowerCase())) return { text: (answer.slice(0, c.at) + answer.slice(c.at + c.len)).trim(), call }
  }
  return { text: answer }
}

/**
 * Reads an answer as it streams. Text for the person is passed on at once; from the point where a
 * tool call starts (or might be starting) the rest is held back, so the block never shows in the chat.
 */
export class TextToolStream {
  private buf = ''
  private shown = 0
  private held = false
  private known: string[]
  private opts: { tagsOnly?: boolean }
  /**
   * `known`: the tool names of this chat. `tagsOnly`: only tagged blocks count (for models that have
   * tool calling of their own and merely slip into writing a call as text now and then).
   */
  constructor(known: string[] = [], opts: { tagsOnly?: boolean } = {}) {
    this.known = known
    this.opts = opts
  }

  /** Add streamed text; returns what can be shown now. */
  push(chunk: string): string {
    this.buf += chunk
    if (this.held) return ''
    let cut = this.buf.length
    for (const o of OPENERS) {
      const m = o.open.exec(this.buf)
      if (m && m.index < cut) {
        cut = m.index
        this.held = true
      }
    }
    if (!this.held) {
      const partial = partialOpenerAt(this.buf)
      if (partial >= 0) cut = Math.min(cut, partial)
      if (!this.opts.tagsOnly) {
        // An answer that opens with a brace may be a bare JSON call: wait for it to finish.
        const lead = this.buf.trimStart()
        if (lead.startsWith('{') || lead.startsWith('[{') || /^```(json)?\s*[{[]/.test(lead)) cut = Math.min(cut, this.buf.length - lead.length)
      }
    }
    if (cut <= this.shown) return ''
    const out = this.buf.slice(this.shown, cut)
    this.shown = cut
    return out
  }

  /** True once a complete tagged call has arrived: generation can stop here. */
  get complete(): boolean {
    if (!this.held) return false
    return OPENERS.some((o) => {
      const m = o.open.exec(this.buf)
      return Boolean(m && o.close && o.close.test(this.buf.slice(m.index + m[0].length)))
    })
  }

  /**
   * The stream ended. `call`: the tool call that was found; `broken`: a call block whose JSON could not
   * be read; `held`: text that was kept back and not shown (the call block itself, or ordinary text that
   * only looked like the start of one and should be shown after all).
   */
  finish(): { call?: TextToolCall; broken?: string; held: string } {
    const parsed = parseAnswer(this.buf, this.known, this.opts)
    return { call: parsed.call, broken: parsed.broken, held: this.buf.slice(this.shown) }
  }
}
