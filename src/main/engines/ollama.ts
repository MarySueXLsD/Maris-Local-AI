import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import type { LoadedModel, ModelInfo, PullProgress } from '@shared/types'
import { settings } from '../settings'
import { log, sleep } from '../util'
import { isRunnerCrash } from './errors'

export interface OllamaToolCall {
  id?: string
  function: { index?: number; name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  thinking?: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  think?: boolean
  format?: 'json' | Record<string, unknown>
  options?: Record<string, unknown>
  keep_alive?: string | number
}

export interface ChatChunk {
  model?: string
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }
  done?: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  error?: string
}

/** POST a JSON body and resolve with the streaming response (no connection reuse). */
function postStream(url: string, body: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    let response: IncomingMessage | undefined
    const onAbort = (): void => {
      // Tear down the socket; a reader waiting on the response then ends with an error.
      req.destroy(new Error('aborted'))
      response?.destroy(new Error('aborted'))
    }
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' }
      },
      (res) => {
        response = res
        // Keep the abort hook until the response is finished, not just until the request is sent.
        res.on('close', () => signal.removeEventListener('abort', onAbort))
        resolve(res)
      }
    )
    if (signal.aborted) return reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e) => {
      if (!response) signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    req.end(body)
  })
}

async function readAll(res: IncomingMessage): Promise<string> {
  let s = ''
  res.setEncoding('utf8')
  for await (const c of res) s += c
  return s
}

async function* ndjsonStream<T>(res: IncomingMessage): AsyncGenerator<T> {
  res.setEncoding('utf8')
  let buf = ''
  for await (const chunk of res as AsyncIterable<string>) {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line) as T
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim()) as T
}

interface ShowResponse {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
  model_info?: Record<string, unknown>
  license?: string
  parameters?: string
  modified_at?: string
}

class OllamaClient {
  private showCache = new Map<string, ShowResponse>()
  private active = 0
  /** Options a model was last loaded with, so utility calls can reuse them and avoid reloads. */
  readonly loadedWith = new Map<string, { num_ctx: number; num_gpu?: number }>()

  get base(): string {
    return settings.get().ollamaUrl.replace(/\/+$/, '')
  }

  /** When the last model call finished (GPU readings lag a little behind). */
  lastActiveAt = 0

  /** How long a model stays loaded after use (Settings → Engine). 0 unloads right away. */
  keepAlive(): string {
    return `${Math.max(0, Math.round(settings.get().engine.keepAliveMin))}m`
  }

  get activeCalls(): number {
    return this.active
  }

  private async req(path: string, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal
    try {
      return await fetch(`${this.base}${path}`, { ...init, signal })
    } finally {
      clearTimeout(t)
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const r = await this.req('/api/version', undefined, 2500)
      if (!r.ok) return undefined
      return ((await r.json()) as { version: string }).version
    } catch {
      return undefined
    }
  }

  async show(model: string): Promise<ShowResponse> {
    const hit = this.showCache.get(model)
    if (hit) return hit
    const r = await this.req('/api/show', { method: 'POST', body: JSON.stringify({ model }) })
    if (!r.ok) throw new Error(`show ${model}: HTTP ${r.status}`)
    const j = (await r.json()) as ShowResponse
    this.showCache.set(model, j)
    return j
  }

  async list(): Promise<ModelInfo[]> {
    const r = await this.req('/api/tags')
    if (!r.ok) throw new Error(`tags: HTTP ${r.status}`)
    const j = (await r.json()) as {
      models: { name: string; size: number; modified_at: string; details?: ShowResponse['details'] }[]
    }
    const out = await Promise.all(
      j.models.map(async (m) => {
        let caps: string[] = []
        let ctx: number | undefined
        try {
          const s = await this.show(m.name)
          caps = s.capabilities ?? []
          const info = s.model_info ?? {}
          const key = Object.keys(info).find((k) => k.endsWith('.context_length'))
          ctx = key ? Number(info[key]) : undefined
        } catch (e) {
          log.warn('ollama', 'show failed', m.name, e)
        }
        return {
          name: m.name,
          sizeBytes: m.size,
          family: m.details?.family,
          parameterSize: m.details?.parameter_size,
          quantization: m.details?.quantization_level,
          capabilities: caps,
          contextLength: ctx,
          modifiedAt: m.modified_at
        } satisfies ModelInfo
      })
    )
    return out.sort((a, b) => a.sizeBytes - b.sizeBytes)
  }

  async ps(): Promise<LoadedModel[]> {
    try {
      const r = await this.req('/api/ps', undefined, 2500)
      if (!r.ok) return []
      const j = (await r.json()) as {
        models: { name: string; size: number; size_vram: number; expires_at?: string; context_length?: number }[]
      }
      return (j.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        vramBytes: m.size_vram,
        expiresAt: m.expires_at,
        contextLength: m.context_length
      }))
    } catch {
      return []
    }
  }

  /**
   * Streaming chat. Yields raw Ollama chunks. A watchdog aborts requests that never start
   * (retried once) or that go silent mid-stream, so a stuck call can never freeze a task.
   */
  async *chat(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
    const eng = settings.get().engine
    const IDLE_MS = Math.max(30, eng.idleTimeoutSec) * 1000
    const firstMs = Math.max(30, eng.firstTokenTimeoutSec) * 1000
    for (let attempt = 0; attempt < 2; attempt++) {
      // A loaded model starts streaming within seconds; a cold load of a big model can take minutes.
      const loaded = (await this.ps()).some((m) => m.name === body.model)
      const FIRST_CHUNK_MS = loaded ? Math.min(90_000, firstMs) : firstMs
      const ctrl = new AbortController()
      const onAbort = (): void => ctrl.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      let timer = setTimeout(() => ctrl.abort(), FIRST_CHUNK_MS)
      let gotChunk = false
      const t0 = Date.now()
      this.active++
      let res: IncomingMessage | undefined
      try {
        // Plain node:http with one connection per request: fetch's pooled connections could
        // stall after several back-to-back streamed requests within one agent turn.
        res = await postStream(`${this.base}/api/chat`, JSON.stringify({ ...body, stream: true, keep_alive: body.keep_alive ?? this.keepAlive() }), ctrl.signal)
        if (res.statusCode !== 200) {
          const text = await readAll(res).catch(() => '')
          // Ollama's model process dropped the request: the next request starts it again.
          if ((res.statusCode ?? 0) >= 500 && isRunnerCrash(text) && attempt === 0) {
            log.warn('ollama', `${body.model}: model process stopped (${text.slice(0, 160)}), retrying once`)
            await sleep(1500)
            continue
          }
          throw new Error(this.explainError(res.statusCode ?? 0, text, body.model))
        }
        const o = body.options ?? {}
        this.loadedWith.set(body.model, { num_ctx: Number(o.num_ctx ?? 4096), num_gpu: o.num_gpu as number | undefined })
        for await (const chunk of ndjsonStream<ChatChunk>(res)) {
          if (chunk.error) throw new Error(chunk.error)
          if (!gotChunk) log.debug('ollama', `${body.model}: first chunk after ${Date.now() - t0} ms`)
          gotChunk = true
          clearTimeout(timer)
          timer = setTimeout(() => ctrl.abort(), IDLE_MS)
          yield chunk
          if (chunk.done) break // the answer is complete; don't wait for the socket to close
        }
        return
      } catch (e) {
        if (signal?.aborted) throw e
        // The connection to Ollama dropped before anything arrived: try once more.
        if (!ctrl.signal.aborted && !gotChunk && attempt === 0 && isRunnerCrash(String((e as Error)?.message ?? e))) {
          log.warn('ollama', `${body.model}: connection dropped before the answer started, retrying once`)
          await sleep(1500)
          continue
        }
        if (ctrl.signal.aborted) {
          if (!gotChunk && attempt === 0) {
            log.warn('ollama', `${body.model} did not start answering in ${FIRST_CHUNK_MS / 1000}s, retrying once`)
            continue
          }
          const mins = (ms: number): string => (ms >= 120_000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`)
          throw new Error(
            gotChunk
              ? `The model stopped responding (no output for ${mins(IDLE_MS)}). Try again, or pick a smaller model.`
              : `The model did not start answering within ${mins(FIRST_CHUNK_MS)}. It may still be loading or the GPU may be full; try again (Settings → Engine has the time limits).`
          )
        }
        throw e
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        res?.destroy()
        this.active--
        this.lastActiveAt = Date.now()
      }
    }
  }

  /** Non-streaming convenience call that returns the merged final message. */
  async chatOnce(
    body: ChatRequest,
    signal?: AbortSignal
  ): Promise<{ content: string; thinking: string; toolCalls: OllamaToolCall[]; final?: ChatChunk }> {
    let content = ''
    let thinking = ''
    const toolCalls: OllamaToolCall[] = []
    let final: ChatChunk | undefined
    for await (const c of this.chat(body, signal)) {
      if (c.message?.content) content += c.message.content
      if (c.message?.thinking) thinking += c.message.thinking
      if (c.message?.tool_calls) toolCalls.push(...c.message.tool_calls)
      if (c.done) final = c
    }
    return { content, thinking, toolCalls, final }
  }

  async embed(model: string, input: string[], cpuOnly = true): Promise<Float32Array[]> {
    this.active++
    try {
      const r = await this.req(
        '/api/embed',
        {
          method: 'POST',
          body: JSON.stringify({
            model,
            input,
            truncate: true,
            keep_alive: this.keepAlive(),
            options: cpuOnly ? { num_gpu: 0 } : {}
          })
        },
        120000
      )
      if (!r.ok) throw new Error(`embed: HTTP ${r.status} ${await r.text().catch(() => '')}`)
      const j = (await r.json()) as { embeddings: number[][] }
      return j.embeddings.map((e) => Float32Array.from(e))
    } finally {
      this.active--
      this.lastActiveAt = Date.now()
    }
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await postStream(`${this.base}/api/pull`, JSON.stringify({ model, stream: true }), signal ?? new AbortController().signal)
    try {
      if (res.statusCode !== 200) throw new Error(`pull ${model}: HTTP ${res.statusCode} ${await readAll(res).catch(() => '')}`)
      for await (const p of ndjsonStream<{ status?: string; total?: number; completed?: number; error?: string }>(res)) {
        if (p.error) throw new Error(p.error)
        onProgress({ model, status: p.status ?? '', total: p.total, completed: p.completed })
        if (p.status === 'success') break
      }
    } finally {
      res.destroy()
    }
    this.showCache.delete(model)
    onProgress({ model, status: 'success', done: true })
  }

  async remove(model: string): Promise<void> {
    const r = await this.req('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) })
    if (!r.ok) throw new Error(`delete ${model}: HTTP ${r.status}`)
    this.showCache.delete(model)
  }

  /** Ask Ollama to unload a model from memory right away. */
  async unload(model: string): Promise<void> {
    try {
      await this.req('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }, 15000)
      this.loadedWith.delete(model)
    } catch (e) {
      log.warn('ollama', 'unload failed', model, e)
    }
  }

  async unloadAll(): Promise<string[]> {
    const loaded = await this.ps()
    await Promise.all(loaded.map((m) => this.unload(m.name)))
    return loaded.map((m) => m.name)
  }

  private explainError(status: number, text: string, model: string): string {
    if (status === 404) return `Model "${model}" is not installed. Open Models to download it.`
    let msg = text
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      /* raw text */
    }
    if (/memory|out of memory|cuda/i.test(msg)) return `Not enough GPU/RAM to load ${model}: ${msg}`
    if (status >= 500 && isRunnerCrash(msg)) {
      return `The model's process stopped unexpectedly, and starting it again did not help. This happens when the graphics card runs out of memory or another program closes it. Try again, or pick a smaller model. (Ollama error ${status}: ${msg})`
    }
    return `Ollama error ${status}: ${msg}`
  }

  /** [the app that runs the server in the tray/menu bar (Windows, macOS), the command-line program]. */
  executablePaths(): string[] {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA ?? ''
      return [join(local, 'Programs', 'Ollama', 'ollama app.exe'), join(local, 'Programs', 'Ollama', 'ollama.exe')]
    }
    if (process.platform === 'darwin') {
      const app = [join(homedir(), 'Applications', 'Ollama.app'), '/Applications/Ollama.app'].find((p) => existsSync(p)) ?? '/Applications/Ollama.app'
      return [app, join(app, 'Contents', 'Resources', 'ollama'), '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
    }
    // Linux: the official install script puts it in /usr/local/bin (or /usr/bin) and adds a system service.
    return ['', '/usr/local/bin/ollama', '/usr/bin/ollama', join(homedir(), '.local', 'bin', 'ollama')]
  }

  /** The command-line program, if installed. */
  cliPath(): string | undefined {
    return this.executablePaths()
      .slice(1)
      .find((p) => p && existsSync(p))
  }

  isInstalled(): boolean {
    return this.executablePaths().some((p) => p && existsSync(p))
  }

  /** Where Ollama keeps its models (the Linux system service uses its own account's home). */
  modelsDir(): string {
    if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS
    const service = '/usr/share/ollama/.ollama/models'
    if (process.platform === 'linux' && existsSync(service)) return service
    return join(homedir(), '.ollama', 'models')
  }

  /** Make sure the Ollama server answers; start it if it is installed but not running. */
  async ensureRunning(): Promise<boolean> {
    if (await this.version()) return true
    const [appPath] = this.executablePaths()
    const cli = this.cliPath()
    try {
      if (process.platform === 'darwin' && existsSync(appPath)) {
        spawn('open', ['-g', '-a', appPath], { detached: true, stdio: 'ignore' }).unref()
      } else if (process.platform === 'win32' && existsSync(appPath)) {
        spawn(appPath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else if (cli) {
        spawn(cli, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } else {
        return false
      }
    } catch (e) {
      log.warn('ollama', 'failed to start', e)
      return false
    }
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      if (await this.version()) return true
    }
    return false
  }
}

export const ollama = new OllamaClient()

export { isRunnerCrash } from './errors'
