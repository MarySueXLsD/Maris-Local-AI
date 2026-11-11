// Any service that speaks the OpenAI chat-completions format: OpenAI itself, Gemini, OpenRouter, Groq,
// Mistral, DeepSeek, xAI, LM Studio, llama.cpp's server and many more. Nothing in here knows a
// model by name. A request starts out plain; when a service refuses an option or a feature, its error
// reply says which, and that is dropped, remembered (Quirks) and the request sent again.
import type { ProviderModel } from '@shared/providers'
import { looseJson } from '@shared/textTools'
import { log } from '../util'
import type { Connection, Quirks } from './providers'
import { CapabilityError, type LlmChunk, type LlmRequest, type LlmToolCall } from './types'
import { errorText, negotiate, readModelList, ThinkTags, toOpenAi } from './wire'

function headers(conn: Connection): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (conn.key) h.Authorization = `Bearer ${conn.key}`
  return h
}

/** What went wrong, in words a person can act on. */
export function explainHttp(conn: Connection, status: number, text: string, model: string): string {
  const msg = errorText(text)
  if (status === 401) return `${conn.name} refused the key: it is wrong, expired or was revoked. Check it in Models → API. (${msg.slice(0, 160)})`
  if (status === 403) return `${conn.name} does not allow this for your account or key (${msg.slice(0, 200)}).`
  if (status === 404) return model ? `${conn.name} has no model "${model}" (any more). Refresh its models in Models → API and pick another. (${msg.slice(0, 120)})` : `${conn.name} has nothing at that address. It usually ends in /v1. (${msg.slice(0, 120)})`
  if (status === 402 || /insufficient|quota|billing|credit|balance/i.test(msg)) return `${conn.name} says the account is out of credit or over its quota: ${msg.slice(0, 240)}`
  if (status === 429) return `${conn.name} is limiting requests right now (too many, or too fast). Wait a moment and try again. (${msg.slice(0, 160)})`
  if (status === 413 || /context length|context window|too many tokens|maximum context|too long|token limit/i.test(msg)) return `The conversation is too long for this model: ${msg.slice(0, 240)}`
  if (status >= 500) return `${conn.name} had a problem on its side (error ${status}). Try again in a moment. ${msg.slice(0, 160)}`
  return `${conn.name} error ${status}: ${msg.slice(0, 300)}`
}

export function explainNetwork(conn: Connection, e: unknown): string {
  const m = String((e as { cause?: { code?: string; message?: string } })?.cause?.code ?? (e as Error)?.message ?? e)
  if (conn.local) return `Could not reach ${conn.name} at ${conn.baseUrl}. Is its server running? (${m})`
  return `Could not reach ${conn.name}. Check the internet connection. (${m})`
}

/** The service's models, as it lists them. */
export async function openaiModels(conn: Connection): Promise<ProviderModel[]> {
  let res: Response
  try {
    res = await fetch(`${conn.baseUrl}/models`, { headers: headers(conn), signal: AbortSignal.timeout(20000) })
  } catch (e) {
    throw new Error(explainNetwork(conn, e))
  }
  const text = await res.text()
  if (!res.ok) throw new Error(explainHttp(conn, res.status, text, ''))
  let reply: unknown
  try {
    reply = JSON.parse(text)
  } catch {
    throw new Error(`${conn.name} did not answer with a list of models. Is the address right? It usually ends in /v1.`)
  }
  return readModelList(reply)
}

/** Server-sent events: yields the JSON of each "data:" line until [DONE]. */
async function* sse(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as Record<string, unknown>
        } catch {
          /* a keep-alive comment or a partial line: skip */
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
}

export interface OpenAiHooks {
  quirks: () => Quirks
  learn: (q: Quirks) => void
}

/** Streaming chat with an OpenAI-compatible service. Yields the same chunks as the Ollama engine. */
export async function* openaiChat(conn: Connection, model: string, req: LlmRequest, hooks: OpenAiHooks, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
  const o = req.options ?? {}
  const hasImages = req.messages.some((m) => m.images?.length)
  const build = (): Record<string, unknown> => {
    const q = hooks.quirks()
    const body: Record<string, unknown> = { model, messages: toOpenAi(req.messages, { noSystem: q.noSystem }), stream: true, stream_options: { include_usage: true } }
    if (req.tools?.length) body.tools = req.tools
    if (o.temperature !== undefined) body.temperature = o.temperature
    if (o.top_p !== undefined) body.top_p = o.top_p
    if (o.num_predict) body[q.maxTokensKey ?? 'max_tokens'] = o.num_predict
    if (Array.isArray(o.stop) && o.stop.length) body.stop = (o.stop as string[]).slice(0, 4)
    if (req.format === 'json') body.response_format = { type: 'json_object' }
    else if (req.format) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: req.format } }
    for (const k of q.drop ?? []) delete body[k]
    return body
  }

  // A server on this computer may still be loading its model, and reads slowly on a processor.
  const firstMs = (req.timeouts?.firstSec ?? (conn.local ? 900 : 180)) * 1000
  const idleMs = (req.timeouts?.idleSec ?? (conn.local ? 300 : 180)) * 1000
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer = setTimeout(() => ctrl.abort(), firstMs)
  let started = false
  const t0 = Date.now()
  let firstAt = 0
  try {
    let res: Response | undefined
    for (let attempt = 0; attempt < 6; attempt++) {
      const body = build()
      try {
        res = await fetch(`${conn.baseUrl}/chat/completions`, { method: 'POST', headers: headers(conn), body: JSON.stringify(body), signal: ctrl.signal })
      } catch (e) {
        if (signal?.aborted) throw e
        if (ctrl.signal.aborted) throw new Error(`${conn.name} did not start answering within ${Math.round(firstMs / 1000)} seconds.`)
        throw new Error(explainNetwork(conn, e))
      }
      if (res.ok) break
      const text = await res.text().catch(() => '')
      const fix = negotiate(res.status, errorText(text), body, hasImages)
      if (fix?.capability) throw new CapabilityError(fix.capability, errorText(text))
      if (fix?.quirk && attempt < 5) {
        log.info('openai', `${conn.name}/${model}: ${errorText(text).slice(0, 160)} → adjusting the request`)
        hooks.learn(fix.quirk)
        res = undefined
        continue
      }
      throw new Error(explainHttp(conn, res.status, text, model))
    }
    if (!res?.ok) throw new Error(`${conn.name} kept refusing the request.`)

    const calls = new Map<number, { id?: string; name: string; args: string }>()
    const tags = new ThinkTags()
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
    let finish: string | undefined
    let outChars = 0
    for await (const ev of sse(res)) {
      started = true
      clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(), idleMs)
      const err = ev.error as { message?: string } | string | undefined
      if (err) throw new Error(`${conn.name}: ${typeof err === 'string' ? err : (err.message ?? JSON.stringify(err)).slice(0, 400)}`)
      if (ev.usage && typeof ev.usage === 'object') usage = ev.usage as typeof usage
      const choice = (Array.isArray(ev.choices) ? ev.choices[0] : undefined) as { delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: string | null } | undefined
      if (!choice) continue
      const d = (choice.delta ?? choice.message ?? {}) as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }
      const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : ''
      let content = ''
      if (typeof d.content === 'string') content = d.content
      else if (Array.isArray(d.content)) content = (d.content as { type?: string; text?: string }[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
      const split = content ? tags.push(content) : { content: '', thinking: '' }
      const thinking = reasoning + split.thinking
      if (thinking || split.content) {
        if (!firstAt) firstAt = Date.now()
        outChars += thinking.length + split.content.length
        yield { message: { role: 'assistant', ...(split.content ? { content: split.content } : {}), ...(thinking ? { thinking } : {}) } }
      }
      if (Array.isArray(d.tool_calls)) {
        if (!firstAt) firstAt = Date.now()
        for (const tc of d.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }[]) {
          // Calls arrive in pieces, keyed by index. Some services leave the index out, and some reuse
          // index 0 for every call: a new id (or a name without an index) starts a new call.
          const next = calls.size ? Math.max(...calls.keys()) + 1 : 0
          let idx: number
          if (typeof tc.index === 'number') {
            const at = calls.get(tc.index)
            idx = at && tc.id && at.id && tc.id !== at.id ? next : tc.index
          } else {
            const same = tc.id ? [...calls.entries()].find(([, c]) => c.id === tc.id)?.[0] : undefined
            idx = same ?? (tc.id || tc.function?.name ? next : Math.max(0, next - 1))
          }
          const cur = calls.get(idx) ?? { name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          const a = tc.function?.arguments
          if (typeof a === 'string') cur.args += a
          else if (a && typeof a === 'object') cur.args = JSON.stringify(a)
          calls.set(idx, cur)
        }
        // Nothing to show, but the answer is alive.
        yield { message: { role: 'assistant' } }
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
    const tail = tags.flush()
    if (tail.content || tail.thinking) yield { message: { role: 'assistant', ...(tail.content ? { content: tail.content } : {}), ...(tail.thinking ? { thinking: tail.thinking } : {}) } }
    if (!started && !signal?.aborted) throw new Error(`${conn.name} closed the connection without an answer.`)

    const cut = finish === 'length'
    const refused = finish === 'content_filter'
    const toolCalls: LlmToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([, c]) => {
        let args: Record<string, unknown> = {}
        // Cut off at the length limit: the arguments are incomplete even where they happen to parse.
        if (cut) return { id: c.id, function: { name: c.name, arguments: {} }, invalid: c.args.slice(0, 4000) }
        if (c.args.trim()) {
          try {
            const parsed = JSON.parse(c.args) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
          } catch {
            // Cut off at the length limit, or simply not JSON. A near miss (a trailing comma, a missing
            // brace) is repaired; anything else goes back to the model instead of being run on a guess.
            const loose = cut ? undefined : looseJson(c.args)
            if (loose && typeof loose === 'object' && !Array.isArray(loose)) args = loose as Record<string, unknown>
            else return { id: c.id, function: { name: c.name, arguments: {} }, invalid: c.args.slice(0, 4000) }
          }
        }
        return { id: c.id, function: { name: c.name, arguments: args } }
      })
    const evalMs = Math.max(1, Date.now() - (firstAt || t0))
    const outTokens = usage?.completion_tokens ?? Math.ceil(outChars / 3.6)
    yield {
      model,
      message: { role: 'assistant', ...(toolCalls.length && !refused ? { tool_calls: toolCalls } : {}) },
      done: true,
      done_reason: refused ? 'refusal' : cut ? 'length' : toolCalls.length ? 'tool_calls' : 'stop',
      done_note: refused ? `${conn.name} filtered this answer.` : cut ? 'The answer reached the length limit and was cut off.' : undefined,
      prompt_eval_count: usage?.prompt_tokens,
      eval_count: outTokens,
      eval_duration: evalMs * 1e6,
      total_duration: (Date.now() - t0) * 1e6
    }
  } catch (e) {
    if (signal?.aborted || e instanceof CapabilityError) throw e
    if (ctrl.signal.aborted) {
      throw new Error(started ? `${conn.name} stopped responding (no output for ${Math.round(idleMs / 1000)} seconds).` : `${conn.name} did not start answering within ${Math.round(firstMs / 1000)} seconds.`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    ctrl.abort()
  }
}
