// What models at API services used and what that cost. Every request to such a model passes through
// here once (engines/llm.ts): the tokens are the ones the service reports, the cost comes from the
// model's price (the person's own, the service's, or the list price), and both are added to a small
// record per day and model in Maris's own database. Nothing of this leaves the computer.
import { addUsage, costOf, NO_USAGE, type UsageByModel, type UsageSummary, type UsageTotals } from '@shared/pricing'
import { isLocalAddress, parseRemoteModel } from '@shared/providers'
import { repo, type ApiUsageRow } from '../db'
import { settings } from '../settings'
import { estimateTokens, log } from '../util'
import { priceList } from './priceList'
import { providers } from './providers'
import type { LlmChunk, LlmRequest } from './types'

/** The local date, as 2026-11-11. */
const dayOf = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Roughly what a request holds, for when the service did not get to say (the answer was stopped). */
function promptEstimate(req: LlmRequest): number {
  let n = req.tools?.length ? estimateTokens(JSON.stringify(req.tools)) : 0
  for (const m of req.messages) n += estimateTokens(m.content) + (m.images?.length ?? 0) * 1200 + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) + 4
  return n
}

const totals = (r: ApiUsageRow): UsageTotals => ({ requests: r.requests, input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output, cost: r.cost, unpriced: r.unpriced })

class Usage {
  /**
   * A request to a model of a service has ended: work out what it cost, add it to the record and hand
   * the last chunk back with the cost on it. Without a last chunk (the answer was stopped part-way)
   * the tokens are estimated, because the service charges for what it read and wrote all the same.
   */
  account(req: LlmRequest, chunk: LlmChunk | undefined, streamedChars: number): LlmChunk | undefined {
    try {
      const r = parseRemoteModel(req.model)
      const c = r ? providers.get(r.provider) : undefined
      // A server on this computer or network costs nothing per token: not counted as API use.
      if (!r || !c || isLocalAddress(c.baseUrl)) return chunk
      const prompt = chunk?.prompt_eval_count ?? promptEstimate(req)
      const output = chunk?.eval_count ?? Math.ceil(streamedChars / 3.6)
      const cacheRead = Math.min(Math.max(0, chunk?.cache_read_count ?? 0), prompt)
      const cacheWrite = Math.min(Math.max(0, chunk?.cache_write_count ?? 0), prompt - cacheRead)
      const priced = providers.priceFor(req.model)
      // A service that says what the request cost is believed over any list.
      const cost = chunk?.cost_usd ?? (priced ? costOf({ prompt, output, cacheRead, cacheWrite }, priced.price) : undefined)
      if (settings.get().usage.track) {
        repo.addApiUsage({ day: dayOf(), provider: c.id, providerName: c.name, model: r.model, requests: 1, input: prompt, cacheRead, cacheWrite, output, cost: cost ?? 0, unpriced: cost === undefined ? 1 : 0 })
      }
      return chunk ? { ...chunk, ...(cost !== undefined ? { cost_usd: cost } : {}) } : undefined
    } catch (e) {
      log.warn('usage', 'could not record a request', e)
      return chunk
    }
  }

  /** This month's estimated cost so far, in dollars. */
  monthCost(): number {
    const month = dayOf().slice(0, 7)
    return repo.apiUsage(`${month}-01`).reduce((s, r) => s + r.cost, 0)
  }

  summary(): UsageSummary {
    const cfg = settings.get()
    const today = dayOf()
    const month = today.slice(0, 7)
    const rows = repo.apiUsage()
    let all = NO_USAGE
    let thisMonth = NO_USAGE
    let thisDay = NO_USAGE
    const byModel = new Map<string, UsageByModel>()
    const byDay = new Map<string, { day: string; cost: number; tokens: number }>()
    const names = new Map(providers.list().map((p) => [p.id, p.name]))
    for (const r of rows) {
      const t = totals(r)
      all = addUsage(all, t)
      const d = byDay.get(r.day) ?? { day: r.day, cost: 0, tokens: 0 }
      d.cost += r.cost
      d.tokens += r.input + r.output
      byDay.set(r.day, d)
      if (!r.day.startsWith(month)) continue
      thisMonth = addUsage(thisMonth, t)
      if (r.day === today) thisDay = addUsage(thisDay, t)
      const key = `${r.provider}\n${r.model}`
      const m = byModel.get(key)
      // The service's name as it is now; the one kept with the record when the service is gone.
      byModel.set(key, { ...addUsage(m ?? NO_USAGE, t), provider: r.provider, providerName: names.get(r.provider) ?? r.providerName ?? r.provider, model: r.model })
    }
    const meta = priceList.meta()
    return {
      today: thisDay,
      month: thisMonth,
      all,
      models: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output)),
      days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
      prices: { ...meta, lookup: cfg.usage.priceLookup },
      budget: cfg.usage.monthlyBudget,
      tracking: cfg.usage.track
    }
  }

  clear(): void {
    repo.clearApiUsage()
    repo.setKv('usage-budget-told', { month: '', level: 0 })
  }

  /**
   * The monthly guide from Settings: a sentence for the chat the first time this month's costs pass
   * 80% of it, and again when they pass all of it. Undefined when there is nothing new to say.
   */
  budgetNote(): string | undefined {
    const budget = settings.get().usage.monthlyBudget
    if (!(budget > 0)) return undefined
    const spent = this.monthCost()
    const level = spent >= budget ? 2 : spent >= budget * 0.8 ? 1 : 0
    if (!level) return undefined
    const month = dayOf().slice(0, 7)
    const told = repo.getKv<{ month: string; level: number }>('usage-budget-told')
    if (told && told.month === month && told.level >= level) return undefined
    repo.setKv('usage-budget-told', { month, level })
    const money = (n: number): string => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`
    return level === 2
      ? `API models have used about ${money(spent)} this month, more than the ${money(budget)} you set as a monthly guide (Settings → Engine). Maris keeps answering; this is only so you know. Models → API shows where it went.`
      : `API models have used about ${money(spent)} of the ${money(budget)} you set as a monthly guide (Settings → Engine).`
  }
}

export const usage = new Usage()
