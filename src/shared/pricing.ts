// What models at API services cost. Prices are data, not code: they come from the person (their own
// price for a model), from a service's own model list, or from a public price list that Maris looks
// up and keeps a copy of. Nothing here knows a model by name, so a model released tomorrow is priced
// as soon as a list carries it. All prices are US dollars per million tokens.
// Pure (no imports), so tests/pricing.test.ts checks it directly.

/** Other prices from a prompt size on: with some models a long prompt costs more per token. */
export interface PriceTier {
  /** Applies when the prompt has at least this many tokens. */
  above: number
  in: number
  out: number
  cacheRead?: number
  cacheWrite?: number
}

export interface Price {
  /** Per million tokens read (the prompt). */
  in: number
  /** Per million tokens written (the answer, thinking included). */
  out: number
  /** Per million prompt tokens the service had cached from an earlier request. */
  cacheRead?: number
  /** Per million prompt tokens the service stores in its cache for the next request. */
  cacheWrite?: number
  tiers?: PriceTier[]
}

/** Where a price comes from: the person, the service's own model list, or the public price list. */
export type PriceSource = 'yours' | 'service' | 'list'

/** The tokens of one request. `prompt` includes the cached ones. */
export interface TokenCounts {
  prompt: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** The sums Maris keeps and shows: for a day, a month, a model. */
export interface UsageTotals {
  requests: number
  /** Prompt tokens, cached ones included. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** Dollars, as far as prices were known. */
  cost: number
  /** Requests whose model had no known price (their tokens are counted, their cost is not). */
  unpriced: number
}

export interface UsageByModel extends UsageTotals {
  provider: string
  providerName: string
  model: string
}

export interface UsageSummary {
  today: UsageTotals
  month: UsageTotals
  all: UsageTotals
  /** This month, per model, the most expensive first. */
  models: UsageByModel[]
  /** The last 30 days that saw any use, oldest first. */
  days: { day: string; cost: number; tokens: number }[]
  /** The public price list in use: when it was last looked up and how many models it prices. */
  prices: { updated: string; count: number; lookup: boolean }
  /** The monthly guide from Settings (0: none). */
  budget: number
  /** The record is on (Settings → Engine). */
  tracking: boolean
}

export const NO_USAGE: UsageTotals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, unpriced: 0 }

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * A price from the `pricing` object of a service's model list. Services write these per token
 * ("0.000004") or per million tokens (4); the size of the number tells which. Returns undefined when
 * the object names no price for reading and writing.
 */
export function readPricing(raw: unknown): Price | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const pIn = num(o.prompt) ?? num(o.input) ?? num(o.input_tokens)
  const pOut = num(o.completion) ?? num(o.output) ?? num(o.output_tokens)
  if (pIn === undefined || pOut === undefined) return undefined
  // A price per token is far below a cent; a price per million tokens is not.
  const k = Math.max(pIn, pOut) < 0.01 ? 1e6 : 1
  const round = (n: number): number => Math.round(n * k * 1e6) / 1e6
  const opt = (...vals: unknown[]): number | undefined => {
    for (const v of vals) {
      const n = num(v)
      if (n !== undefined) return round(n)
    }
    return undefined
  }
  const price: Price = { in: round(pIn), out: round(pOut) }
  const read = opt(o.input_cache_read, o.cache_read, o.cached_input)
  const write = opt(o.input_cache_write, o.cache_write)
  if (read !== undefined) price.cacheRead = read
  if (write !== undefined) price.cacheWrite = write
  if (Array.isArray(o.overrides)) {
    const tiers: PriceTier[] = []
    for (const t of o.overrides as Record<string, unknown>[]) {
      const above = num(t?.min_prompt_tokens)
      const tIn = num(t?.prompt) ?? num(t?.input)
      const tOut = num(t?.completion) ?? num(t?.output)
      if (above === undefined || tIn === undefined || tOut === undefined) continue
      const tier: PriceTier = { above, in: round(tIn), out: round(tOut) }
      const tRead = opt(t.input_cache_read, t.cache_read)
      const tWrite = opt(t.input_cache_write, t.cache_write)
      if (tRead !== undefined) tier.cacheRead = tRead
      if (tWrite !== undefined) tier.cacheWrite = tWrite
      tiers.push(tier)
    }
    if (tiers.length) price.tiers = tiers.sort((a, b) => a.above - b.above)
  }
  return price
}

/** What one request cost, in dollars. */
export function costOf(u: TokenCounts, p: Price): number {
  const tier = [...(p.tiers ?? [])].sort((a, b) => b.above - a.above).find((t) => u.prompt >= t.above)
  const q = tier ?? p
  const read = Math.min(Math.max(0, u.cacheRead ?? 0), u.prompt)
  const write = Math.min(Math.max(0, u.cacheWrite ?? 0), u.prompt - read)
  const fresh = Math.max(0, u.prompt - read - write)
  return (fresh * q.in + read * (q.cacheRead ?? q.in) + write * (q.cacheWrite ?? q.in) + Math.max(0, u.output) * q.out) / 1e6
}

/** A model id as price lists write it: lower case, dots as dashes, no "models/" in front. */
export function priceKey(id: string): string {
  return id.trim().toLowerCase().replace(/^models\//, '').replace(/\./g, '-')
}

const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/

/**
 * The list price of a maker's model: by its id as it is, then without a date at the end
 * ("claude-haiku-4-5-20251001" is listed as "claude-haiku-4-5"), then without "-latest". Only an exact
 * name counts: a model that is not in the list has no price, rather than a neighbour's.
 */
export function findPrice(list: Record<string, Price>, vendor: string, modelId: string): Price | undefined {
  const k = priceKey(modelId)
  for (const key of new Set([k, k.replace(DATED, ''), k.replace(/-latest$/, '')])) {
    const hit = list[`${vendor}/${key}`]
    if (hit) return hit
  }
  return undefined
}

/**
 * A price list from OpenRouter's public model list (https://openrouter.ai/api/v1/models), which
 * carries the makers' own prices: "maker/model" → price. Variants with a colon (":free", ":extended")
 * are left out, and only the makers asked for are kept.
 */
export function pricesFromOpenRouter(reply: unknown, vendors: readonly string[]): Record<string, Price> {
  const data = (reply as { data?: unknown })?.data
  const out: Record<string, Price> = {}
  if (!Array.isArray(data)) return out
  const wanted = new Set(vendors)
  for (const m of data as { id?: unknown; pricing?: unknown }[]) {
    if (typeof m?.id !== 'string' || m.id.includes(':')) continue
    const slash = m.id.indexOf('/')
    if (slash < 1) continue
    const vendor = m.id.slice(0, slash)
    if (!wanted.has(vendor)) continue
    const price = readPricing(m.pricing)
    // A list entry without real prices (0 and 0) says nothing about what the maker charges.
    if (price && (price.in > 0 || price.out > 0)) out[`${vendor}/${priceKey(m.id.slice(slash + 1))}`] = price
  }
  return out
}

/** Dollars as people read them: $0.0042, $0.38, $12.40, $1,234.00. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.0001) return 'under $0.0001'
  const digits = n < 0.01 ? 4 : n < 1 ? 3 : 2
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`
}

const plain = (n: number): string => String(Math.round(n * 1000) / 1000)

/** "$4 / $20": per million tokens read and written. */
export function priceLabel(p: Price): string {
  return `$${plain(p.in)} / $${plain(p.out)}`
}

/** A price in a sentence, with the cache prices and the long-prompt prices when there are any. */
export function priceWords(p: Price): string {
  const parts = [`$${plain(p.in)} per million tokens read, $${plain(p.out)} per million written`]
  if (p.cacheRead !== undefined) parts.push(`$${plain(p.cacheRead)} for tokens the service had cached`)
  for (const t of p.tiers ?? []) parts.push(`$${plain(t.in)} / $${plain(t.out)} when the prompt is over ${Math.round(t.above / 1000)}K tokens`)
  return parts.join('; ')
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    cost: a.cost + b.cost,
    unpriced: a.unpriced + b.unpriced
  }
}
