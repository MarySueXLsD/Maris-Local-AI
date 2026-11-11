// The public price list: what the makers charge for their models, per million tokens. Maris ships
// with a copy (src/shared/priceList.json, built by scripts/update-prices.mjs) and, when the setting
// allows it and a service on the internet is set up, looks the list up again once a day. The request
// is a plain download: nothing about the person, their key or their chats goes with it.
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { findPrice, pricesFromOpenRouter, type Price } from '@shared/pricing'
import snapshot from '@shared/priceList.json'
import { PRICE_LIST_URL, PRICE_VENDOR, PRICE_VENDORS } from '@shared/priceVendors'
import { settings } from '../settings'
import { Emitter, log } from '../util'

interface Stored {
  updated: string
  prices: Record<string, Price>
}

class PriceList {
  /** A newer list was taken: prices shown anywhere may have changed. */
  readonly changed = new Emitter<void>()
  private data: Stored = { updated: snapshot.updated, prices: snapshot.prices as Record<string, Price> }
  private loaded = false
  private checkedAt = 0
  private busy?: Promise<boolean>

  private file(): string {
    return path.join(app.getPath('userData'), 'price-list.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const saved = JSON.parse(readFileSync(this.file(), 'utf8')) as Stored
      // A list looked up after the one Maris shipped with takes its place.
      if (saved?.prices && typeof saved.updated === 'string' && saved.updated >= this.data.updated && Object.keys(saved.prices).length >= 20) this.data = saved
    } catch {
      /* none looked up yet */
    }
  }

  /** The list price of a model, by the kind of service it belongs to (the service's preset). */
  find(preset: string, modelId: string): Price | undefined {
    this.load()
    const vendor = PRICE_VENDOR[preset]
    return vendor ? findPrice(this.data.prices, vendor, modelId) : undefined
  }

  /** True for services whose models the list can price at all. */
  covers(preset: string): boolean {
    return Boolean(PRICE_VENDOR[preset])
  }

  meta(): { updated: string; count: number } {
    this.load()
    return { updated: this.data.updated, count: Object.keys(this.data.prices).length }
  }

  /** Look the list up now. Resolves true when a new list was taken. */
  refresh(): Promise<boolean> {
    this.busy ??= this.lookUp().finally(() => (this.busy = undefined))
    return this.busy
  }

  /** At most once a day, and only when Settings allow it and some service could use the prices. */
  refreshStale(useful: boolean): void {
    if (!useful || !settings.get().usage.priceLookup) return
    this.load()
    if (this.data.updated === new Date().toISOString().slice(0, 10) || Date.now() - this.checkedAt < 6 * 3600_000) return
    void this.refresh()
  }

  private async lookUp(): Promise<boolean> {
    this.load()
    this.checkedAt = Date.now()
    try {
      const res = await fetch(process.env.MARIS_PRICE_LIST_URL ?? PRICE_LIST_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const prices = pricesFromOpenRouter(await res.json(), PRICE_VENDORS)
      // A reply with hardly any prices in it is a broken reply, not a new list.
      if (Object.keys(prices).length < 20) throw new Error('the reply held no prices')
      this.data = { updated: new Date().toISOString().slice(0, 10), prices }
      writeFileSync(this.file(), JSON.stringify(this.data))
      log.info('prices', `price list looked up: ${Object.keys(prices).length} models`)
      this.changed.emit()
      return true
    } catch (e) {
      log.warn('prices', 'the price list could not be looked up; the one at hand stays in use', e)
      return false
    }
  }
}

export const priceList = new PriceList()
