import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addUsage, costOf, findPrice, NO_USAGE, priceKey, priceLabel, pricesFromOpenRouter, readPricing, usd, type Price } from '../src/shared/pricing.ts'
import { PRICE_VENDOR, PRICE_VENDORS } from '../src/shared/priceVendors.ts'

test('a service that prices per token and one that prices per million give the same price', () => {
  assert.deepEqual(readPricing({ prompt: '0.000004', completion: '0.00002' }), { in: 4, out: 20 })
  assert.deepEqual(readPricing({ input: 4, output: 20 }), { in: 4, out: 20 })
  assert.deepEqual(readPricing({ prompt: '0.0000001', completion: '0.0000005' }), { in: 0.1, out: 0.5 })
  assert.deepEqual(readPricing({ prompt: '0', completion: '0' }), { in: 0, out: 0 }, 'a free model')
  assert.equal(readPricing({ image: '0.01' }), undefined, 'no price for reading and writing')
  assert.equal(readPricing(undefined), undefined)
  assert.equal(readPricing('cheap'), undefined)
})

test('cache prices and prices for long prompts are read too', () => {
  const p = readPricing({
    prompt: '0.0000001',
    completion: '0.0000005',
    input_cache_read: '0.00000001',
    input_cache_write: '0.000000125',
    overrides: [{ min_prompt_tokens: 100000, prompt: '0.0000005', completion: '0.0000025', input_cache_read: '0.00000005' }]
  })
  assert.deepEqual(p, { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ above: 100000, in: 0.5, out: 2.5, cacheRead: 0.05 }] })
})

test('a request costs what was read and written, with cached tokens at their own price', () => {
  const p: Price = { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 }
  // 10,000 read and 1,000 written, nothing cached.
  assert.ok(Math.abs(costOf({ prompt: 10000, output: 1000 }, p) - 0.06) < 1e-9)
  // Of the 10,000 read, 8,000 came from the cache and 1,000 were stored in it.
  const cached = costOf({ prompt: 10000, output: 1000, cacheRead: 8000, cacheWrite: 1000 }, p)
  assert.ok(Math.abs(cached - (1000 * 4 + 8000 * 0.2 + 1000 * 5 + 1000 * 20) / 1e6) < 1e-9)
  assert.ok(cached < 0.06, 'a cached prompt is cheaper')
  // Without cache prices, cached tokens cost what any read token costs.
  assert.ok(Math.abs(costOf({ prompt: 10000, output: 0, cacheRead: 9000 }, { in: 4, out: 20 }) - 0.04) < 1e-9)
  // More cached tokens than the prompt holds cannot make it cheaper than free.
  assert.ok(costOf({ prompt: 100, output: 0, cacheRead: 5000 }, p) >= 0)
})

test('a long prompt is charged at the long-prompt price', () => {
  const p: Price = { in: 0.1, out: 0.5, tiers: [{ above: 100000, in: 0.5, out: 2.5 }] }
  assert.ok(Math.abs(costOf({ prompt: 50000, output: 1000 }, p) - (50000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-9)
  assert.ok(Math.abs(costOf({ prompt: 150000, output: 1000 }, p) - (150000 * 0.5 + 1000 * 2.5) / 1e6) < 1e-9)
})

test('a model is found under the name its maker lists it by, and not under a neighbour', () => {
  assert.equal(priceKey('Claude-Opus-5.5'), 'claude-opus-5-5')
  assert.equal(priceKey('models/gemini-3.5-flash'), 'gemini-3-5-flash')
  const list: Record<string, Price> = { 'anthropic/claude-haiku-4-5': { in: 1, out: 5 }, 'anthropic/claude-opus-5-5': { in: 4, out: 20 }, 'openai/gpt-5-4': { in: 2.5, out: 15 }, 'openai/gpt-5-4-mini': { in: 0.75, out: 4.5 } }
  assert.deepEqual(findPrice(list, 'anthropic', 'claude-opus-5-5'), { in: 4, out: 20 })
  assert.deepEqual(findPrice(list, 'anthropic', 'claude-haiku-4-5-20251001'), { in: 1, out: 5 }, 'a dated id is its model')
  assert.deepEqual(findPrice(list, 'openai', 'gpt-5.4'), { in: 2.5, out: 15 })
  assert.deepEqual(findPrice(list, 'openai', 'gpt-5.4-mini'), { in: 0.75, out: 4.5 }, 'the small model has its own price')
  assert.equal(findPrice(list, 'openai', 'gpt-5.4-nano'), undefined, 'not in the list: no price, rather than a guess')
  assert.equal(findPrice(list, 'openai', 'claude-opus-5-5'), undefined, 'another maker')
})

test('a price list is built from a public model list, makers by name, variants left out', () => {
  const reply = {
    data: [
      { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' } },
      { id: 'anthropic/claude-opus-5.5:extended', pricing: { prompt: '0.00001', completion: '0.00005' } },
      { id: 'openai/gpt-5.4', pricing: { prompt: '0.0000025', completion: '0.000015' } },
      { id: 'someone/free-model', pricing: { prompt: '0', completion: '0' } },
      { id: 'meta-llama/llama-4', pricing: { prompt: '0.0000002', completion: '0.0000002' } },
      { id: 'google/no-prices' }
    ]
  }
  assert.deepEqual(pricesFromOpenRouter(reply, ['anthropic', 'openai', 'google']), {
    'anthropic/claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
    'openai/gpt-5-4': { in: 2.5, out: 15 }
  })
  assert.deepEqual(pricesFromOpenRouter({ error: 'nope' }, PRICE_VENDORS), {})
})

test('the list Maris ships with prices the makers it knows how to look up', () => {
  const list = JSON.parse(readFileSync(new URL('../src/shared/priceList.json', import.meta.url), 'utf8')) as { updated: string; prices: Record<string, Price> }
  const keys = Object.keys(list.prices)
  assert.match(list.updated, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(keys.length >= 40, `${keys.length} prices`)
  for (const vendor of PRICE_VENDORS) assert.ok(keys.some((k) => k.startsWith(`${vendor}/`)), `prices for ${vendor}`)
  for (const [k, p] of Object.entries(list.prices)) {
    assert.ok(p.in >= 0 && p.out >= 0 && p.in + p.out > 0 && p.in < 1000 && p.out < 5000, `${k}: ${JSON.stringify(p)}`)
    assert.equal(k, k.toLowerCase())
    assert.ok(!k.includes('.') && !k.includes(':'), k)
  }
  // Every kind of service that has list prices names a maker that the list really carries.
  assert.deepEqual(Object.keys(PRICE_VENDOR).sort(), ['anthropic', 'deepseek', 'google', 'mistral', 'openai', 'xai'])
})

test('dollars are written the way people read them', () => {
  assert.equal(usd(0), '$0')
  assert.equal(usd(0.00004), 'under $0.0001')
  assert.equal(usd(0.0042), '$0.0042')
  assert.equal(usd(0.012), '$0.012')
  assert.equal(usd(0.38), '$0.38')
  assert.equal(usd(12.4), '$12.40')
  assert.equal(usd(1234), '$1,234.00')
  assert.equal(priceLabel({ in: 4, out: 20 }), '$4 / $20')
  assert.equal(priceLabel({ in: 0.1, out: 0.5 }), '$0.1 / $0.5')
})

test('sums of use add up', () => {
  const a = { requests: 2, input: 1000, cacheRead: 400, cacheWrite: 100, output: 50, cost: 0.01, unpriced: 0 }
  const b = { requests: 1, input: 500, cacheRead: 0, cacheWrite: 0, output: 20, cost: 0, unpriced: 1 }
  assert.deepEqual(addUsage(addUsage(NO_USAGE, a), b), { requests: 3, input: 1500, cacheRead: 400, cacheWrite: 100, output: 70, cost: 0.01, unpriced: 1 })
})
