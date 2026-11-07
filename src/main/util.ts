import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const uid = (): string => randomUUID()

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Delete a folder and everything in it. Use this, not rmSync: in Electron's Node the synchronous
 * version fails with EPERM on read-only files on Windows (git marks its pack files read-only).
 */
export async function removeTree(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

export function truncate(text: string, max: number, note = '…[truncated]'): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.75)
  const tail = max - head
  return `${text.slice(0, head)}\n${note} (${text.length - max} chars omitted)\n${text.slice(-tail)}`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Rough token estimate (Qwen tokenizer averages ~3.6 chars per token for mixed text). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6)

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`
}

type Level = 'debug' | 'info' | 'warn' | 'error'
const ring: string[] = []
let logFile: string | undefined

export const log = {
  /**
   * Echo to the console. Off in the packaged app: on Windows, writes to a stdout pipe are
   * synchronous and block the main thread for good if nobody reads the pipe.
   */
  toConsole: true,
  /** Also append log lines to a file (rotated at 5 MB). */
  setFile(path: string): void {
    logFile = path
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path) && statSync(path).size > 5 * 2 ** 20) renameSync(path, `${path}.1`)
    } catch {
      /* ignore */
    }
  },
  write(level: Level, scope: string, ...args: unknown[]): void {
    const line = `${new Date().toISOString()} [${level}] ${scope}: ${args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}`
    ring.push(line)
    if (ring.length > 500) ring.shift()
    if (logFile) {
      try {
        appendFileSync(logFile, line + '\n')
      } catch {
        /* ignore */
      }
    }
    if (!log.toConsole) return
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  },
  debug: (scope: string, ...a: unknown[]) => log.write('debug', scope, ...a),
  info: (scope: string, ...a: unknown[]) => log.write('info', scope, ...a),
  warn: (scope: string, ...a: unknown[]) => log.write('warn', scope, ...a),
  error: (scope: string, ...a: unknown[]) => log.write('error', scope, ...a),
  recent: (): string[] => [...ring]
}

/** Simple typed event emitter used by main-process services. */
export class Emitter<T> {
  private listeners = new Set<(v: T) => void>()
  on(fn: (v: T) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(v: T): void {
    for (const fn of this.listeners) {
      try {
        fn(v)
      } catch (e) {
        log.error('emitter', e)
      }
    }
  }
}

/** Parse a newline-delimited JSON stream from a fetch Response. */
export async function* ndjson<T = unknown>(res: Response, signal?: AbortSignal): AsyncGenerator<T> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) yield JSON.parse(line) as T
      }
    }
    const rest = buf.trim()
    if (rest) yield JSON.parse(rest) as T
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
