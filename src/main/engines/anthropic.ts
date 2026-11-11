// Claude, through Anthropic's official SDK. What a model can do (thinking, pictures, how long an answer
// may be) is read from the service's own model list, so new Claude models work without changes here:
// the request only carries what every model accepts, plus what the list says this one supports.
import Anthropic from '@anthropic-ai/sdk'
import type { ProviderModel } from '@shared/providers'
import { estimateTokens, log } from '../util'
import type { Connection } from './providers'
import { CapabilityError, type LlmChunk, type LlmRequest, type LlmToolCall } from './types'
import { anthropicInputSize, toAnthropic } from './wire'

const OFFICIAL = 'https://api.anthropic.com'
const isOfficial = (conn: Connection): boolean => conn.baseUrl.replace(/\/+$/, '') === OFFICIAL

const clients = new Map<string, Anthropic>()

function client(conn: Connection): Anthropic {
  if (!conn.key) throw new Error(`No API key is saved for ${conn.name}. Add it in Models → API.`)
  const id = `${conn.baseUrl}|${conn.key}`
  let c = clients.get(id)
  if (!c) {
    c = new Anthropic({ apiKey: conn.key, ...(isOfficial(conn) ? {} : { baseURL: conn.baseUrl }) })
    clients.set(id, c)
    if (clients.size > 8) clients.delete(clients.keys().next().value as string)
  }
  return c
}

/** What went wrong, in words a person can act on. */
function explain(conn: Connection, e: unknown, model?: string): string {
  const detail = e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 300) : String(e)
  if (e instanceof Anthropic.AuthenticationError) return `${conn.name} refused the key: it is wrong, expired or was revoked. Check it in Models → API.`
  if (e instanceof Anthropic.PermissionDeniedError) return `${conn.name} does not allow this for your account or key (${detail}).`
  if (e instanceof Anthropic.NotFoundError) return `${conn.name} has no model "${model ?? ''}" (any more). Refresh its models in Models → API and pick another.`
  if (e instanceof Anthropic.RateLimitError) return `${conn.name} is limiting requests right now, or the account is over its limit. Wait a moment and try again. (${detail})`
  if (e instanceof Anthropic.APIConnectionTimeoutError) return `${conn.name} did not answer in time. Check the internet connection and try again.`
  if (e instanceof Anthropic.APIConnectionError) return `Could not reach ${conn.name}. Check the internet connection. (${detail})`
  if (e instanceof Anthropic.InternalServerError) return `${conn.name} had a problem on its side (${detail}). Try again in a moment.`
  if (e instanceof Anthropic.BadRequestError) return /credit balance|billing/i.test(detail) ? `${conn.name} says the account has no credit left: ${detail}` : `${conn.name} did not accept the request: ${detail}`
  if (e instanceof Anthropic.APIError) return `${conn.name} error${e.status ? ` ${e.status}` : ''}: ${detail}`
  return detail
}

/** The service's models, with what each says it can do. */
export async function anthropicModels(conn: Connection): Promise<ProviderModel[]> {
  const out: ProviderModel[] = []
  try {
    for await (const m of client(conn).models.list({ limit: 1000 })) {
      const caps = m.capabilities
      const adaptive = caps?.thinking?.types?.adaptive?.supported
      const budget = caps?.thinking?.types?.enabled?.supported
      const created = Date.parse(m.created_at)
      out.push({
        id: m.id,
        label: m.display_name || undefined,
        contextLength: m.max_input_tokens ?? undefined,
        maxOutput: m.max_tokens ?? undefined,
        vision: caps ? Boolean(caps.image_input?.supported) : undefined,
        tools: true,
        thinking: caps ? Boolean(caps.thinking?.supported) : undefined,
        thinkingMode: adaptive ? 'adaptive' : budget ? 'budget' : undefined,
        created: Number.isFinite(created) ? created : undefined
      })
    }
  } catch (e) {
    throw new Error(explain(conn, e))
  }
  return out
}

/** Streaming chat with Claude. Yields the same chunks as the other engines. */
export async function* anthropicChat(conn: Connection, model: string, info: ProviderModel | undefined, req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
  const c = client(conn)
  const official = isOfficial(conn)
  const { system, messages } = toAnthropic(req.messages)
  const o = req.options ?? {}
  // Room for a long answer by default; streaming keeps a big limit from timing out.
  let maxTokens = Math.max(256, Math.min(info?.maxOutput ?? 16000, Number(o.num_predict) || 64000))
  // The conversation and the answer share the model's window, and a request that asks for more
  // answer room than is left is refused outright: a long conversation gets what is left.
  if (info?.contextLength) {
    const sent = anthropicInputSize(system, messages, req.tools, estimateTokens)
    maxTokens = Math.max(2048, Math.min(maxTokens, info.contextLength - Math.ceil(sent * 1.1) - 1024))
  }
  const params: Anthropic.MessageStreamParams = { model, max_tokens: maxTokens, messages }
  if (system) params.system = system
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
      // Long tool inputs (a whole file) then arrive as they are written instead of after a silent wait.
      // Their JSON is checked here before anything runs (see below). Gateways may not know the field.
      ...(official ? { eager_input_streaming: true } : {})
    }))
  }
  // Thinking is only asked for in the way the model list says this model supports. Left out, each
  // model does what it does by default, which every model accepts.
  if (req.think) {
    if (info?.thinkingMode === 'adaptive') params.thinking = { type: 'adaptive', display: 'summarized' }
    else if (info?.thinkingMode === 'budget' && maxTokens >= 4096) params.thinking = { type: 'enabled', budget_tokens: Math.min(8000, maxTokens - 2048) }
  }
  // Each step of a task repeats the instructions, tools and conversation so far: cached, they cost a fraction.
  if (official) params.cache_control = { type: 'ephemeral' }

  const t0 = Date.now()
  for (let attempt = 0; ; attempt++) {
    const inputs = new Map<number, string>()
    let wrote = false
    let firstAt = 0
    try {
      const stream = c.messages.stream(params, { signal })
      for await (const ev of stream) {
        if (ev.type !== 'content_block_delta') continue
        if (!firstAt) firstAt = Date.now()
        if (ev.delta.type === 'text_delta') {
          wrote = true
          yield { message: { role: 'assistant', content: ev.delta.text } }
        } else if (ev.delta.type === 'thinking_delta') {
          wrote = true
          yield { message: { role: 'assistant', thinking: ev.delta.thinking } }
        } else if (ev.delta.type === 'input_json_delta') {
          inputs.set(ev.index, (inputs.get(ev.index) ?? '') + ev.delta.partial_json)
          // Nothing to show, but the answer is alive: keeps the "deciding on the next action" timer honest.
          yield { message: { role: 'assistant' } }
        }
      }
      const message = await stream.finalMessage()
      const stop = message.stop_reason
      const hasCalls = message.content.some((b) => b.type === 'tool_use')
      // A refusal can cut a call off mid-way, and at the length limit a call's input is incomplete even
      // when it parses: neither is ever run.
      const runnable = stop !== 'refusal' && !((stop === 'max_tokens' || stop === 'model_context_window_exceeded') && hasCalls)
      const calls: LlmToolCall[] = []
      if (runnable) {
        message.content.forEach((b, i) => {
          if (b.type !== 'tool_use') return
          // The SDK reads streamed input leniently and can hand back a quietly shortened object. Read
          // what was streamed strictly: if that fails, the model is told instead of the tool being run.
          const written = inputs.get(i)
          let invalid: string | undefined
          if (written?.trim()) {
            try {
              JSON.parse(written)
            } catch {
              invalid = written.slice(0, 4000)
            }
          }
          calls.push({ id: b.id, function: { name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> }, ...(invalid ? { invalid } : {}) })
        })
      }
      const u = message.usage
      const note =
        stop === 'refusal'
          ? `${conn.name} declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'}`
          : stop === 'max_tokens'
            ? hasCalls
              ? 'The answer reached the length limit in the middle of an action, so that action was not run.'
              : 'The answer reached the length limit and was cut off.'
            : stop === 'model_context_window_exceeded'
              ? 'The conversation filled the model’s context window.'
              : undefined
      yield {
        model: message.model,
        message: { role: 'assistant', ...(calls.length ? { tool_calls: calls } : {}) },
        done: true,
        done_reason: stop === 'refusal' ? 'refusal' : stop === 'max_tokens' || stop === 'model_context_window_exceeded' ? 'length' : calls.length ? 'tool_calls' : 'stop',
        done_note: note,
        prompt_eval_count: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        eval_count: u.output_tokens,
        eval_duration: Math.max(1, Date.now() - (firstAt || t0)) * 1e6,
        total_duration: (Date.now() - t0) * 1e6,
        // Passed back unchanged while the task goes on (thinking blocks included).
        raw: calls.length ? message.content : undefined
      }
      return
    } catch (e) {
      if (signal?.aborted) throw e
      if (e instanceof Anthropic.BadRequestError && params.thinking && /thinking/i.test(e.message)) throw new CapabilityError('thinking', e.message)
      if (e instanceof Anthropic.BadRequestError && messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')) && /image|vision/i.test(e.message)) throw new CapabilityError('vision', e.message)
      if (e instanceof Anthropic.APIError) throw new Error(explain(conn, e, model))
      // Not an API error: the SDK could not read a tool input at all. The turn never completed, so
      // there is no call to answer; ask again, a couple of times at most.
      if (attempt >= 2) throw new Error(`${conn.name} sent an action that could not be read, three times in a row. Try again, or pick another model.`)
      log.warn('anthropic', `${model}: a tool input could not be read (${(e as Error)?.message ?? e}), asking again`)
      if (wrote) yield { restart: true }
    }
  }
}
