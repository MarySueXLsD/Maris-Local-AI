import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { monitor } from '../system/monitor'
import { log } from '../util'

/**
 * Pick a model for background work (titles, memory extraction) without evicting what the
 * user is chatting with: reuse an idle loaded model with the options it was loaded with,
 * otherwise use the tiny model on the CPU.
 */
export function pickUtilityModel(): { model: string; options: Record<string, unknown> } | undefined {
  const cfg = settings.get()
  const loaded = new Set(monitor.snapshot().ollama.loaded.map((m) => m.name))
  for (const name of [cfg.tiers.fast, cfg.tiers.balanced, cfg.tiers.max]) {
    if (name && loaded.has(name)) {
      const w = ollama.loadedWith.get(name)
      if (w) return { model: name, options: { num_ctx: w.num_ctx, ...(w.num_gpu !== undefined ? { num_gpu: w.num_gpu } : {}) } }
    }
  }
  if (cfg.tiers.tiny) return { model: cfg.tiers.tiny, options: { num_gpu: 0, num_ctx: 8192 } }
  return undefined
}

export async function quickJson<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  opts: { timeoutMs?: number; maxTokens?: number } = {}
): Promise<T | undefined> {
  const pick = pickUtilityModel()
  if (!pick) return undefined
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90000)
  try {
    const r = await ollama.chatOnce(
      {
        model: pick.model,
        think: false,
        format: schema,
        keep_alive: '60m',
        options: { ...pick.options, temperature: 0.2, num_predict: opts.maxTokens ?? 600 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      },
      ctrl.signal
    )
    return JSON.parse(r.content) as T
  } catch (e) {
    log.warn('utility', 'quickJson failed', pick.model, e)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
