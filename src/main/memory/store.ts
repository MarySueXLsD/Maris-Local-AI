import type { LearningEvent, Memory, MemoryKind } from '@shared/types'
import { repo } from '../db'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { Emitter, clamp, cosine, log, uid } from '../util'

type Stored = Memory & { embedding?: Float32Array; embedModel?: string }

export interface NewMemory {
  text: string
  kind: MemoryKind
  source: Memory['source']
  importance?: number
  pinned?: boolean
  conversationId?: string
}

const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
  )

function keywordScore(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / Math.sqrt(A.size * B.size)
}

class MemoryStore {
  private items: Stored[] = []
  readonly changed = new Emitter<void>()
  readonly events = new Emitter<LearningEvent>()

  load(): void {
    this.items = repo.listMemories()
  }

  list(): Memory[] {
    return this.items.map(({ embedding: _e, embedModel: _m, ...m }) => m)
  }

  get(id: string): Memory | undefined {
    return this.list().find((m) => m.id === id)
  }

  private embedModel(): string | undefined {
    return settings.get().tiers.embed
  }

  private async embed(text: string, query = false): Promise<Float32Array | undefined> {
    const model = this.embedModel()
    if (!model) return undefined
    const input =
      query && /qwen3-embedding/i.test(model)
        ? `Instruct: Given a user message, retrieve stored facts about the user that help answer it\nQuery: ${text}`
        : text
    try {
      const [v] = await ollama.embed(model, [input.slice(0, 4000)])
      return v
    } catch (e) {
      log.warn('memory', 'embed failed, using keyword matching', e)
      return undefined
    }
  }

  logEvent(kind: LearningEvent['kind'], text: string): void {
    const e: LearningEvent = { id: uid(), ts: Date.now(), kind, text }
    repo.addEvent(e)
    this.events.emit(e)
  }

  async add(input: NewMemory): Promise<{ memory: Memory; merged: boolean }> {
    const text = input.text.trim().replace(/\s+/g, ' ').slice(0, 600)
    if (!text) throw new Error('Memory text is empty')
    const now = Date.now()
    const emb = await this.embed(text)
    const model = this.embedModel()
    // De-duplicate: merge into a near-identical memory instead of piling up copies.
    let best: { m: Stored; s: number } | undefined
    for (const m of this.items) {
      const s =
        emb && m.embedding && m.embedModel === model ? cosine(emb, m.embedding) : keywordScore(text, m.text) * 0.95
      if (!best || s > best.s) best = { m, s }
    }
    if (best && best.s >= 0.9) {
      const m = best.m
      if (text.length > m.text.length + 10 && input.source !== 'feedback') m.text = text
      m.importance = clamp(Math.max(m.importance, input.importance ?? 0.5) + 0.05, 0, 1)
      m.updatedAt = now
      if (input.pinned) m.pinned = true
      repo.updateMemory(m, m.text === text ? emb : undefined, model)
      if (m.text === text && emb) m.embedding = emb
      this.changed.emit()
      this.logEvent('memory-merged', `Reinforced: ${m.text}`)
      return { memory: m, merged: true }
    }
    const m: Stored = {
      id: uid(),
      text,
      kind: input.kind,
      source: input.source,
      importance: clamp(input.importance ?? 0.5, 0, 1),
      pinned: input.pinned ?? false,
      uses: 0,
      createdAt: now,
      updatedAt: now,
      conversationId: input.conversationId,
      embedding: emb,
      embedModel: emb ? model : undefined
    }
    repo.insertMemory(m, emb, emb ? model : undefined)
    this.items.unshift(m)
    this.changed.emit()
    this.logEvent(input.kind === 'skill' ? 'skill-learned' : 'memory-added', `${input.source === 'user' ? 'Saved' : input.source === 'assistant' ? 'Saved by Maris' : 'Learned'}: ${text}`)
    return { memory: m, merged: false }
  }

  async update(id: string, patch: Partial<Pick<Memory, 'text' | 'kind' | 'importance' | 'pinned'>>): Promise<Memory> {
    const m = this.items.find((x) => x.id === id)
    if (!m) throw new Error('Memory not found')
    let emb: Float32Array | undefined
    if (patch.text !== undefined && patch.text.trim() !== m.text) {
      m.text = patch.text.trim()
      emb = await this.embed(m.text)
      if (emb) {
        m.embedding = emb
        m.embedModel = this.embedModel()
      }
    }
    if (patch.kind) m.kind = patch.kind
    if (patch.importance !== undefined) m.importance = clamp(patch.importance, 0, 1)
    if (patch.pinned !== undefined) m.pinned = patch.pinned
    m.updatedAt = Date.now()
    repo.updateMemory(m, emb, m.embedModel)
    this.changed.emit()
    return m
  }

  delete(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return false
    repo.deleteMemory(id)
    this.items.splice(i, 1)
    this.changed.emit()
    return true
  }

  async search(query: string, k = 8, minScore = 0.42): Promise<{ memory: Memory; score: number }[]> {
    if (!this.items.length || !query.trim()) return []
    const q = await this.embed(query, true)
    const model = this.embedModel()
    const now = Date.now()
    const scored = this.items.map((m) => {
      const base =
        q && m.embedding && m.embedModel === model ? cosine(q, m.embedding) : keywordScore(query, m.text) * 0.9
      const ageDays = (now - m.updatedAt) / 86400000
      const score = base * (0.85 + 0.15 * m.importance) + Math.max(0, 0.03 - ageDays * 0.001)
      return { m, score }
    })
    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      // Without the embedding (as list() gives them), without copying every memory for each hit.
      .map(({ m: { embedding: _e, embedModel: _m, ...memory }, score }) => ({ memory, score }))
  }

  /**
   * The memories to tell the model along with one user message: pinned ones and standing instructions,
   * then those that fit the message. `told` are memories this chat already gave the model, which are not
   * repeated (they are still in the conversation it reads).
   */
  async forPrompt(query: string, told: Set<string> = new Set()): Promise<Memory[]> {
    const cfg = settings.get().memory
    if (!cfg.enabled || !this.items.length || cfg.maxInPrompt <= 0) return []
    const chosen = new Map<string, Memory>()
    for (const m of this.items) {
      if (m.pinned || ((m.kind === 'instruction' || m.kind === 'preference') && m.importance >= 0.8)) chosen.set(m.id, m)
      if (chosen.size >= Math.ceil(cfg.maxInPrompt / 2)) break
    }
    for (const r of await this.search(query, cfg.maxInPrompt)) {
      if (chosen.size >= cfg.maxInPrompt) break
      chosen.set(r.memory.id, r.memory)
    }
    const fresh = [...chosen.values()].filter((m) => !told.has(m.id)).map(({ embedding: _e, embedModel: _m, ...m }: Stored) => m)
    if (fresh.length) repo.touchMemories(fresh.map((m) => m.id), Date.now())
    return fresh
  }

  /** Re-embed memories after the embedding model changes. */
  async reembedAll(): Promise<number> {
    const model = this.embedModel()
    if (!model) return 0
    let n = 0
    for (const m of this.items) {
      if (m.embedModel === model && m.embedding) continue
      const v = await this.embed(m.text)
      if (!v) break
      m.embedding = v
      m.embedModel = model
      repo.updateMemory(m, v, model)
      n++
    }
    return n
  }
}

export const memory = new MemoryStore()
