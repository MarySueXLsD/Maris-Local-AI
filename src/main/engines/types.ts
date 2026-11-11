// One request and answer format for every place a language model can run: Ollama on this computer,
// a Claude key, or any service that speaks the OpenAI chat format. The agent talks only to this
// shape (through ./llm.ts); each engine translates it to its own wire format.

export interface LlmToolCall {
  /** The service's id for the call, when it has one (needed to pair results with calls there). */
  id?: string
  function: { index?: number; name: string; arguments: Record<string, unknown> | string }
  /**
   * The model wrote arguments that are not valid JSON (cut off, or badly quoted): this is what it
   * wrote. Such a call is never run; the model is told and writes it again.
   */
  invalid?: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Pictures as base64 (no data: prefix). */
  images?: string[]
  thinking?: string
  tool_calls?: LlmToolCall[]
  /** For role "tool": the tool that produced this result. */
  tool_name?: string
  /** For role "tool": the call it answers, when the service gave calls an id. */
  tool_call_id?: string
  /** For role "tool": the call failed. */
  is_error?: boolean
  /**
   * The engine's own copy of an assistant turn, replayed unchanged while a task is still going
   * (Claude's thinking blocks must come back exactly as they were sent). Never saved.
   */
  raw?: unknown
}

export interface LlmTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  think?: boolean
  /** Ask for JSON: "json" for any object, or a JSON schema the answer must follow. */
  format?: 'json' | Record<string, unknown>
  /**
   * Ollama's option names, which the other engines translate: num_ctx, num_predict (longest answer),
   * temperature, top_p, top_k, repeat_penalty, num_gpu, num_thread.
   */
  options?: Record<string, unknown>
  keep_alive?: string | number
  /** Longer waits for a slow computer: seconds until the first word, and between words. */
  timeouts?: { firstSec?: number; idleSec?: number }
}

export interface LlmChunk {
  model?: string
  message?: { role: string; content?: string; thinking?: string; tool_calls?: LlmToolCall[] }
  done?: boolean
  /** Why the answer ended: stop, length (cut at the limit), refusal (the service declined), tool_calls. */
  done_reason?: string
  /** A sentence for the person about how the answer ended (a refusal's explanation, say). */
  done_note?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  error?: string
  /** See LlmMessage.raw. */
  raw?: unknown
  /** The step starts over (the request had to be sent again): drop what it produced so far. */
  restart?: boolean
}

export interface LlmResult {
  content: string
  thinking: string
  toolCalls: LlmToolCall[]
  final?: LlmChunk
}

/** What the engines need to know about a model before they build a request. */
export interface ModelTraits {
  tools: boolean
  thinking: boolean
  vision: boolean
}

/** A model cannot do what the request needs (tools, pictures, thinking, a system message). */
export class CapabilityError extends Error {
  constructor(
    readonly what: 'tools' | 'vision' | 'thinking' | 'system',
    message: string
  ) {
    super(message)
  }
}
