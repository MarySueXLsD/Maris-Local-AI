// The one door to every language model. The agent, the router and the background helpers call
// llm.chat with a model name; this decides where that model runs (Ollama here, Claude, an
// OpenAI-compatible service) and shapes the request to what the model can do:
//   - no tool calling of its own  → the tools are described in text and read back out of the answer
//   - cannot see pictures         → they are left out, with a note in their place
//   - cannot think on request     → the option is not sent
// What a model can do comes from the engine (Ollama's model details, a service's model list) or is
// learned from the service's own error reply and remembered. No model is known by name.
import { isRemoteModel, parseRemoteModel } from '@shared/providers'
import { historyAsText, TEXT_TOOL_STOPS, TextToolStream, toolsAsText } from '@shared/textTools'
import { log } from '../util'
import { anthropicChat } from './anthropic'
import { ollama } from './ollama'
import { openaiChat } from './openaiCompat'
import { providers } from './providers'
import { CapabilityError, type LlmChunk, type LlmMessage, type LlmRequest, type LlmResult, type LlmToolCall, type ModelTraits } from './types'

const NO_PICTURE = '[A picture was attached here, but this model cannot see pictures.]'

function withoutImages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => (m.images?.length ? { ...m, images: undefined, content: [m.content, NO_PICTURE].filter(Boolean).join('\n') } : m))
}

/** Engines that take no JSON schema of their own are told about it in the instructions. */
function withJsonInstruction(req: LlmRequest): LlmRequest {
  if (!req.format) return req
  const rule =
    req.format === 'json'
      ? 'Reply with one JSON object and nothing else: no explanation, no code fence.'
      : `Reply with one JSON object and nothing else: no explanation, no code fence. It must follow this JSON schema:\n${JSON.stringify(req.format)}`
  const messages = req.messages.slice()
  const at = messages.findIndex((m) => m.role === 'system')
  if (at >= 0) messages[at] = { ...messages[at]!, content: `${messages[at]!.content}\n\n${rule}` }
  else messages.unshift({ role: 'system', content: rule })
  return { ...req, messages }
}

class Llm {
  /** True for a model of a service the person added (its name starts with "@"). */
  isRemote(model: string | undefined): boolean {
    return isRemoteModel(model)
  }

  /** What a model can do, as far as is known before asking it. */
  async traits(model: string): Promise<ModelTraits> {
    const q = providers.quirks(model)
    if (isRemoteModel(model)) {
      const info = providers.model(model)
      return { tools: info?.tools !== false && !q.noTools, vision: info?.vision !== false && !q.noVision, thinking: Boolean(info?.thinking) && !q.noThink }
    }
    try {
      const caps = (await ollama.show(model)).capabilities ?? []
      return { tools: caps.includes('tools') && !q.noTools, vision: caps.includes('vision') && !q.noVision, thinking: caps.includes('thinking') && !q.noThink }
    } catch {
      // Not installed, or Ollama is not answering: the request itself will say so.
      return { tools: !q.noTools, vision: false, thinking: false }
    }
  }

  /** The engine a model runs in, with the request as that engine wants it. */
  private native(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    const remote = parseRemoteModel(req.model)
    if (!remote) return ollama.chat(req, signal)
    const conn = providers.connection(remote.provider)
    const kind = providers.get(remote.provider)!.kind
    const shaped = withJsonInstruction(req)
    if (kind === 'anthropic') return anthropicChat(conn, remote.model, providers.model(req.model), { ...shaped, format: undefined }, signal)
    return openaiChat(conn, remote.model, shaped, { quirks: () => providers.quirks(req.model), learn: (q) => providers.learn(req.model, q) }, signal)
  }

  /**
   * A model with tool calling of its own, watched for one habit: now and then such a model writes a
   * call as text ("<tool_call>{…}") instead of making it. That text is turned into the call it meant.
   */
  private async *withRescue(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    if (!req.tools?.length) {
      yield* this.native(req, signal)
      return
    }
    const known = req.tools.map((t) => t.function.name)
    let reader = new TextToolStream(known, { tagsOnly: true })
    for await (const chunk of this.native(req, signal)) {
      if (chunk.restart) reader = new TextToolStream(known, { tagsOnly: true })
      let c = chunk
      if (c.message?.content) c = { ...c, message: { ...c.message, content: reader.push(c.message.content) } }
      if (!c.done) {
        yield c
        continue
      }
      const end = reader.finish()
      const made = c.message?.tool_calls ?? []
      if (!made.length && end.call && known.some((k) => k.toLowerCase() === end.call!.name.toLowerCase())) {
        log.info('llm', `${req.model} wrote a tool call as text; running it as ${end.call.name}`)
        yield { ...c, message: { role: 'assistant', tool_calls: [{ function: { name: end.call.name, arguments: end.call.arguments } }] }, done_reason: 'tool_calls' }
        return
      }
      if (end.held) yield { message: { role: 'assistant', content: end.held } }
      yield c
    }
  }

  /** Tool calling for a model without any: tools described in the instructions, calls read from the text. */
  private async *textTools(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    const tools = req.tools ?? []
    const known = tools.map((t) => t.function.name)
    // In a small window every tool gets one line; a roomy one can afford the full descriptions.
    const brief = Number(req.options?.num_ctx ?? 0) > 0 && Number(req.options?.num_ctx) <= 8192
    const guide = toolsAsText(
      tools.map((t) => t.function),
      { brief }
    )
    const messages = historyAsText(req.messages) as LlmMessage[]
    const at = messages.findIndex((m) => m.role === 'system')
    if (at >= 0) messages[at] = { ...messages[at]!, content: `${messages[at]!.content}\n\n${guide}` }
    else messages.unshift({ role: 'system', content: guide })
    const stop = [...(Array.isArray(req.options?.stop) ? (req.options!.stop as string[]) : []), ...TEXT_TOOL_STOPS]
    const inner: LlmRequest = { ...req, tools: undefined, messages, options: { ...req.options, stop } }

    const ctrl = new AbortController()
    const onAbort = (): void => ctrl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let reader = new TextToolStream(known)
    const finish = function* (done: LlmChunk): Generator<LlmChunk> {
      const end = reader.finish()
      let calls: LlmToolCall[] | undefined
      if (end.call) calls = [{ function: { name: end.call.name, arguments: end.call.arguments } }]
      else if (end.broken !== undefined) calls = [{ function: { name: 'tool_call', arguments: {} }, invalid: end.broken }]
      if (calls) {
        yield { ...done, message: { role: 'assistant', tool_calls: calls }, done: true, done_reason: 'tool_calls' }
        return
      }
      if (end.held) yield { message: { role: 'assistant', content: end.held } }
      yield done
    }
    try {
      for await (const chunk of this.native(inner, ctrl.signal)) {
        if (chunk.restart) reader = new TextToolStream(known)
        let c = chunk
        if (c.message?.content) c = { ...c, message: { ...c.message, content: reader.push(c.message.content) } }
        if (c.done) {
          yield* finish(c)
          return
        }
        yield c
        // The call is complete: stop the model before it goes on to invent the result.
        if (reader.complete) {
          ctrl.abort()
          yield* finish({ model: req.model, done: true })
          return
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Streaming chat with any model. Yields Ollama-shaped chunks; the last one has `done: true`. When a
   * model turns out not to support something the request used, the request is shaped again and sent
   * once more (that happens before any answer text, so nothing is shown twice).
   */
  async *chat(req: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmChunk> {
    const traits = await this.traits(req.model)
    let r: LlmRequest = { ...req }
    if (!traits.thinking) r.think = undefined
    if (!traits.vision && r.messages.some((m) => m.images?.length)) r.messages = withoutImages(r.messages)
    let asText = Boolean(r.tools?.length) && !traits.tools
    for (let attempt = 0; ; attempt++) {
      try {
        yield* asText ? this.textTools(r, signal) : this.withRescue(r, signal)
        return
      } catch (e) {
        if (!(e instanceof CapabilityError) || signal?.aborted || attempt >= 4) throw e instanceof CapabilityError ? new Error(e.message) : e
        if (e.what === 'tools' && r.tools?.length && !asText) {
          providers.learn(req.model, { noTools: true })
          asText = true
        } else if (e.what === 'vision' && r.messages.some((m) => m.images?.length)) {
          providers.learn(req.model, { noVision: true })
          r = { ...r, messages: withoutImages(r.messages) }
        } else if (e.what === 'thinking' && r.think !== undefined) {
          providers.learn(req.model, { noThink: true })
          r = { ...r, think: undefined }
        } else if (e.what === 'system' && !providers.quirks(req.model).noSystem) {
          providers.learn(req.model, { noSystem: true })
        } else throw new Error(e.message)
      }
    }
  }

  /** Non-streaming convenience call that returns the merged final message. */
  async chatOnce(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    let content = ''
    let thinking = ''
    let toolCalls: LlmToolCall[] = []
    let final: LlmChunk | undefined
    for await (const c of this.chat(req, signal)) {
      if (c.restart) {
        content = ''
        thinking = ''
        toolCalls = []
      }
      if (c.message?.content) content += c.message.content
      if (c.message?.thinking) thinking += c.message.thinking
      if (c.message?.tool_calls) toolCalls.push(...c.message.tool_calls)
      if (c.done) final = c
    }
    return { content, thinking, toolCalls, final }
  }
}

export const llm = new Llm()
