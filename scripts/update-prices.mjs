// Refreshes the price list that ships with Maris (src/shared/priceList.json) from OpenRouter's public
// model list, which carries the makers' own prices. Maris looks the same list up by itself once a day
// (Settings → Engine → Look up list prices); this copy is what it starts with and falls back to.
// Usage: node scripts/update-prices.mjs        (no key needed; nothing about you is sent)
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pricesFromOpenRouter } from '../src/shared/pricing.ts'
import { PRICE_LIST_URL, PRICE_VENDORS } from '../src/shared/priceVendors.ts'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared', 'priceList.json')
const res = await fetch(PRICE_LIST_URL, { headers: { Accept: 'application/json' } })
if (!res.ok) throw new Error(`The price list did not load: HTTP ${res.status}`)
const prices = pricesFromOpenRouter(await res.json(), PRICE_VENDORS)
const count = Object.keys(prices).length
if (count < 20) throw new Error(`Only ${count} prices came back, so the list was left as it is.`)
const sorted = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(out, `${JSON.stringify({ source: PRICE_LIST_URL, updated: new Date().toISOString().slice(0, 10), prices: sorted }, null, 1)}\n`)
console.log(`${count} prices written to ${path.relative(process.cwd(), out)}`)
