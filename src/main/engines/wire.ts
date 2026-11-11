// How Maris's messages are written for each kind of service, and how a service's replies are read.
// Pure (type-only imports), so tests/wire.test.ts checks it without a network or an app.
import type Anthropic from '@anthropic-ai/sdk'
import type { ProviderModel } from '@shared/providers'
import type { Quirks } from './providers'
import type { CapabilityError, LlmMessage } from './types'

/** The kind of picture a base64 string holds, from its first bytes (JPEG when unsure). */
export function imageMime(b64: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('R0lG')) return 'image/gif'
  if (b64.startsWith('UklG')) return 'image/webp'
  return 'image/jpeg'
}

// ------------------------------------------------------------------ OpenAI-compatible services

/** The message of an error reply, whatever shape the service wraps it in. */
export function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown } | unknown[]
    const root = Array.isArray(j) ? (j[0] as { error?: unknown }) : j
    const e = (root as { error?: unknown }).error ?? root
    if (typeof e === 'string') return e
    const o = e as { message?: unknown; detail?: unknown; metadata?: { raw?: unknown } }
    const raw = typeof o.metadata?.raw === 'string' ? ` (${o.metadata.raw.slice(0, 300)})` : ''
    if (typeof o.message === 'string') return `${o.message}${raw}`
    if (typeof o.detail === 'string') return o.detail
    return body.slice(0, 500)
  } catch {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
  }
}

type RawModel = Record<string, unknown> & { id?: unknown }

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = Number(v)
    if (v !== undefined && v !== null && Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

/** One entry of a /models reply, from any of the shapes services use. */
export function readModel(m: RawModel): ProviderModel | undefined {
  const id = typeof m.id === 'string' ? m.id.replace(/^models\//, '') : typeof m.name === 'string' ? (m.name as string).replace(/^models\//, '') : undefined
  if (!id) return undefined
  if (m.active === false || m.archived === true) return undefined
  if (typeof m.type === 'string' && !/chat|language|text|llm|model/i.test(m.type)) return undefined
  const arch = (m.architecture ?? {}) as { input_modalities?: unknown; modality?: unknown }
  const caps = (m.capabilities ?? {}) as Record<string, unknown>
  const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : undefined
  const top = (m.top_provider ?? {}) as Record<string, unknown>
  const meta = (m.meta ?? {}) as Record<string, unknown>
  if (caps.completion_chat === false) return undefined
  const inputs = Array.isArray(arch.input_modalities) ? (arch.input_modalities as string[]) : typeof arch.modality === 'string' ? arch.modality.split('->')[0]!.split('+') : undefined
  const vision = inputs ? inputs.includes('image') : typeof caps.vision === 'boolean' ? caps.vision : undefined
  const tools = params ? params.includes('tools') : typeof caps.function_calling === 'boolean' ? caps.function_calling : typeof caps.tools === 'boolean' ? caps.tools : undefined
  const thinking = params ? params.includes('reasoning') || params.includes('include_reasoning') : typeof caps.reasoning === 'boolean' ? caps.reasoning : undefined
  const created = num(m.created, m.created_at)
  const label = typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' && m.name !== m.id && !/^models\//.test(m.name) ? m.name : undefined
  return {
    id,
    label,
    contextLength: num(m.context_length, m.context_window, m.max_context_length, top.context_length, meta.n_ctx_train, m.max_input_tokens, m.inputTokenLimit, m.max_model_len),
    maxOutput: num(m.max_completion_tokens, top.max_completion_tokens, m.max_output_tokens, m.outputTokenLimit),
    vision,
    tools,
    thinking,
    // Seconds since 1970 in most services, milliseconds in a few.
    created: created ? (created < 1e11 ? created * 1000 : created) : undefined
  }
}

/** The models in a /models reply: `{ data: [...] }`, `{ models: [...] }` or a bare list. */
export function readModelList(reply: unknown): ProviderModel[] {
  const list = Array.isArray(reply)
    ? reply
    : Array.isArray((reply as { data?: unknown })?.data)
      ? (reply as { data: unknown[] }).data
      : Array.isArray((reply as { models?: unknown })?.models)
        ? (reply as { models: unknown[] }).models
        : []
  return (list as RawModel[]).map((m) => (m && typeof m === 'object' ? readModel(m) : undefined)).filter((m): m is ProviderModel => Boolean(m))
}

export interface OpenAiMessage {
  role: string
  content: unknown
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Maris's messages in the OpenAI wire format, with ids made up where a call has none. */
export function toOpenAi(messages: LlmMessage[], opts: { noSystem?: boolean } = {}): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  const pending: string[] = []
  let n = 0
  let system = ''
  for (const m of messages) {
    if (m.role === 'system') {
      if (opts.noSystem) system += `${system ? '\n\n' : ''}${m.content}`
      else out.push({ role: 'system', content: m.content })
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => {
        const id = c.id ?? `call_${++n}`
        pending.push(id)
        return { id, type: 'function' as const, function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) } }
      })
      if (!m.content && !calls.length) continue
      out.push({ role: 'assistant', content: m.content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) })
    } else if (m.role === 'tool') {
      const id = m.tool_call_id && pending.includes(m.tool_call_id) ? m.tool_call_id : pending[0]
      // A result whose call was cut from the history has nothing to answer: pass it on as text.
      if (!id) out.push({ role: 'user', content: `[Result of ${m.tool_name ?? 'a tool'}]\n${m.content}` })
      else {
        pending.splice(pending.indexOf(id), 1)
        out.push({ role: 'tool', tool_call_id: id, content: m.content || '(no output)' })
      }
    } else {
      let text = m.content
      if (system) {
        text = `${system}\n\n---\n\n${text}`
        system = ''
      }
      out.push({
        role: 'user',
        content: m.images?.length ? [...(text ? [{ type: 'text', text }] : []), ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:${imageMime(b64)};base64,${b64}` } }))] : text || '(no text)'
      })
    }
  }
  if (system) out.push({ role: 'user', content: system })
  // Every call needs an answer before anything else is said: one left open (the history was cut there)
  // makes the service refuse the whole request.
  const settled: OpenAiMessage[] = []
  let open: string[] = []
  const close = (): void => {
    for (const id of open) settled.push({ role: 'tool', tool_call_id: id, content: '(no result was recorded)' })
    open = []
  }
  for (const m of out) {
    if (m.role === 'tool' && m.tool_call_id) open = open.filter((id) => id !== m.tool_call_id)
    else close()
    settled.push(m)
    if (m.role === 'assistant' && m.tool_calls) open = m.tool_calls.map((c) => c.id)
  }
  close()
  // Some services insist that the conversation opens with the person.
  const first = settled.findIndex((m) => m.role !== 'system')
  if (first >= 0 && settled[first]!.role !== 'user') settled.splice(first, 0, { role: 'user', content: '(Earlier messages are not shown.)' })
  return settled
}

/** Options Maris may send beyond the model and messages, and so may have to take back. */
const OPTIONAL = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repeat_penalty', 'stop', 'stream_options', 'response_format', 'max_tokens', 'max_completion_tokens', 'seed', 'parallel_tool_calls'] as const

/**
 * What to change after a refusal, read from the service's own words. Returns undefined when the
 * reply names nothing Maris sent (then it is a real error for the person).
 */
export function negotiate(status: number, message: string, body: Record<string, unknown>, hasImages: boolean): { quirk?: Quirks; capability?: CapabilityError['what'] } | undefined {
  if (status !== 400 && status !== 404 && status !== 422 && status !== 501) return undefined
  const m = message.toLowerCase()
  const refuses =
    /not support|unsupported|unrecognized|unknown (parameter|field|argument|name)|not allowed|not permitted|invalid (parameter|field)|unexpected|extra (fields|inputs)|is not available|does not exist|no endpoints found that support|only the default|not enabled|cannot be used|not compatible|deprecated|extra_forbidden/.test(
      m
    )
  if (!refuses) return undefined
  // "max_tokens is not supported with this model, use max_completion_tokens instead".
  if (body.max_tokens !== undefined && /max_completion_tokens/.test(m)) return { quirk: { maxTokensKey: 'max_completion_tokens' } }
  for (const key of OPTIONAL) {
    if (body[key] !== undefined && new RegExp(`\\b${key}\\b`).test(m)) return { quirk: { drop: [key] } }
  }
  if (body.tools !== undefined && /\btools?\b|tool_choice|tool use|function[_ ]call|functions\b/.test(m)) return { capability: 'tools' }
  if (hasImages && /image|vision|multimodal|image_url|modalit/.test(m)) return { capability: 'vision' }
  if (/system (role|message|prompt|instruction)|developer instruction|role ['"`]?system/.test(m)) return { capability: 'system' }
  return undefined
}

/** Splits <think>…</think> that some local servers leave inside the answer text. */
export class ThinkTags {
  private buf = ''
  private inside = false
  push(text: string): { content: string; thinking: string } {
    this.buf += text
    let content = ''
    let thinking = ''
    for (;;) {
      const tag = this.inside ? '</think>' : '<think>'
      const at = this.buf.indexOf(tag)
      if (at >= 0) {
        if (this.inside) thinking += this.buf.slice(0, at)
        else content += this.buf.slice(0, at)
        this.buf = this.buf.slice(at + tag.length)
        this.inside = !this.inside
        continue
      }
      // Keep back a tail that may be the start of a tag.
      let keep = 0
      for (let n = Math.min(tag.length - 1, this.buf.length); n > 0; n--) {
        if (tag.startsWith(this.buf.slice(-n))) {
          keep = n
          break
        }
      }
      const out = this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
      if (this.inside) thinking += out
      else content += out
      return { content, thinking }
    }
  }
  flush(): { content: string; thinking: string } {
    const rest = this.buf
    this.buf = ''
    return this.inside ? { content: '', thinking: rest } : { content: rest, thinking: '' }
  }
}

// ------------------------------------------------------------------ Claude

/**
 * Roughly how many tokens a Claude request holds. A picture counts as a picture (about 1,600 tokens),
 * not as the text of its data, which would make one photo look like a whole library.
 */
export function anthropicInputSize(system: string, messages: Anthropic.MessageParam[], tools: unknown, estimate: (text: string) => number): number {
  let n = estimate(system) + (tools ? estimate(JSON.stringify(tools)) : 0) + messages.length * 4
  for (const m of messages) {
    if (typeof m.content === 'string') {
      n += estimate(m.content)
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text') n += estimate(b.text)
      else if (b.type === 'image') n += 1600
      else if (b.type === 'tool_use') n += estimate(JSON.stringify(b.input ?? {})) + 24
      else if (b.type === 'tool_result') n += estimate(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')) + 12
      else n += estimate(JSON.stringify(b))
    }
  }
  return n
}

const idOk = (id?: string): id is string => Boolean(id && /^[A-Za-z0-9_-]{1,64}$/.test(id))

/**
 * Maris's messages in Claude's format: the instructions apart, every tool result in the user turn right
 * after its call (all of one step together, before any other text), and an assistant turn Claude itself
 * wrote earlier in this task passed back exactly as it was.
 */
export function toAnthropic(messages: LlmMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = []
  const out: Anthropic.MessageParam[] = []
  const pending: string[] = []
  let n = 0
  const pushUser = (blocks: Anthropic.ContentBlockParam[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks)
    else out.push({ role: 'user', content: blocks })
  }
  /** A call that never got a result (the history was cut there) still has to be answered. */
  const settle = (): void => {
    if (!pending.length) return
    pushUser(pending.splice(0).map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: '(no result was recorded)' })))
  }
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content.trim()) system.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id && pending.includes(m.tool_call_id) ? m.tool_call_id : pending[0]
      if (!id) {
        pushUser([{ type: 'text', text: `[Result of ${m.tool_name ?? 'a tool'}]\n${m.content}` }])
        continue
      }
      pending.splice(pending.indexOf(id), 1)
      pushUser([{ type: 'tool_result', tool_use_id: id, content: m.content || '(no output)', ...(m.is_error ? { is_error: true } : {}) }])
      continue
    }
    settle()
    if (m.role === 'assistant') {
      if (Array.isArray(m.raw) && m.raw.length) {
        const blocks = m.raw as Anthropic.ContentBlockParam[]
        out.push({ role: 'assistant', content: blocks })
        for (const b of blocks) if (b.type === 'tool_use') pending.push(b.id)
        continue
      }
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
      for (const c of m.tool_calls ?? []) {
        const id = idOk(c.id) ? c.id : `toolu_maris_${++n}`
        pending.push(id)
        let input: unknown = c.function.arguments
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            input = { input }
          }
        }
        blocks.push({ type: 'tool_use', id, name: c.function.name, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {} })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks: Anthropic.ContentBlockParam[] = (m.images ?? []).map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: imageMime(data), data } }))
    if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
    pushUser(blocks.length ? blocks : [{ type: 'text', text: '(no text)' }])
  }
  settle()
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(Earlier messages are not shown.)' }] })
  // Claude answers a user turn; an assistant turn at the end would be read as text to continue, which newer models refuse.
  if (out[out.length - 1]!.role === 'assistant') out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  return { system: system.join('\n\n'), messages: out }
}
