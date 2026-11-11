import { isRemoteModel } from '@shared/providers'
import { looseJson } from '@shared/textTools'
import { llm } from '../engines/llm'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { monitor } from '../system/monitor'
import { log } from '../util'

/**
 * The options a model on this computer should be called with for a small background job, so that
 * Ollama does not load it a second time: the ones it is loaded with now, else the ones the chat would
 * load it with (its role's context window), else the helper's own.
 */
export function localOptions(model: string): Record<string, unknown> {
  const cfg = settings.get()
  const w = ollama.loadedWith.get(model)
  if (w) return { num_ctx: w.num_ctx, ...(w.num_gpu !== undefined ? { num_gpu: w.num_gpu } : {}) }
  const cpu = cfg.engine.processing === 'cpu'
  for (const tier of ['fast', 'balanced', 'max'] as const) {
    if (cfg.tiers[tier] === model) return { num_ctx: cfg.routing.contextByTier[tier], ...(cpu ? { num_gpu: 0 } : {}) }
  }
  return { num_gpu: 0, num_ctx: cfg.routing.contextByTier.tiny || 8192 }
}

/**
 * Pick a model for background work (titles, memory extraction) without evicting what the
 * user is chatting with: reuse an idle loaded model with the options it was loaded with,
 * otherwise use the helper model (on the CPU when it is a local one).
 */
export function pickUtilityModel(): { model: string; options: Record<string, unknown> } | undefined {
  const cfg = settings.get()
  const loaded = new Set(monitor.snapshot().ollama.loaded.map((m) => m.name))
  for (const name of [cfg.tiers.fast, cfg.tiers.balanced, cfg.tiers.max]) {
    if (name && loaded.has(name) && ollama.loadedWith.has(name)) return { model: name, options: localOptions(name) }
  }
  const tiny = cfg.tiers.tiny
  if (!tiny) return undefined
  return isRemoteModel(tiny) ? { model: tiny, options: {} } : { model: tiny, options: localOptions(tiny) }
}

const background = new Set<AbortController>()

/**
 * Stop background jobs that are running now. Called when the person sends a message: on a computer
 * that runs one request at a time, their answer would otherwise wait behind a title or a memory note.
 */
export function cancelBackground(): void {
  for (const c of background) c.abort()
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
  background.add(ctrl)
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90000)
  try {
    const r = await llm.chatOnce(
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
    // Models without a JSON mode wrap the object in words or a code fence now and then.
    const value = looseJson(r.content)
    return value && typeof value === 'object' ? (value as T) : undefined
  } catch (e) {
    if (!ctrl.signal.aborted) log.warn('utility', 'quickJson failed', pick.model, e)
    return undefined
  } finally {
    clearTimeout(timer)
    background.delete(ctrl)
  }
}
