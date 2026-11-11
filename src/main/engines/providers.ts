import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cleanBaseUrl,
  defaultPicks,
  isLocalAddress,
  looksLikeChatModel,
  parseRemoteModel,
  PROVIDER_PRESETS,
  remoteModelLabel,
  remoteModelName,
  type ProviderConfig,
  type ProviderInfo,
  type ProviderModel,
  type ProviderPreset
} from '@shared/providers'
import { cleanSecret } from '@shared/connectorPresets'
import type { Price, PriceSource } from '@shared/pricing'
import type { ModelInfo } from '@shared/types'
import { Emitter, errMsg, log, uid } from '../util'
import { anthropicModels } from './anthropic'
import { openaiModels } from './openaiCompat'
import { priceList } from './priceList'

/** How to reach a service: what the engines need for one request. */
export interface Connection {
  id: string
  name: string
  baseUrl: string
  key?: string
  local: boolean
}

/**
 * What Maris found out about a model by using it, so it does not have to find out again: a request
 * option the service refused, or something the model cannot do. Nothing here is written by hand per
 * model; it all comes from the services' own error replies.
 */
export interface Quirks {
  /** Refused tool definitions: tools are described in text instead. */
  noTools?: boolean
  noVision?: boolean
  noThink?: boolean
  /** Refused a system message: the instructions go into the first user message. */
  noSystem?: boolean
  /** Request options the service refused for this model. */
  drop?: string[]
  /** The name this service uses for the longest-answer option. */
  maxTokensKey?: 'max_tokens' | 'max_completion_tokens'
}

const MAX_MODELS = 2000

/**
 * The model services the person added (Claude, OpenAI-compatible ones). Addresses and the chosen
 * models are kept in providers.json; keys are encrypted with the system keychain and never leave the
 * main process.
 */
class Providers {
  readonly changed = new Emitter<ProviderInfo[]>()
  private configs: ProviderConfig[] = []
  private state = new Map<string, { status: ProviderInfo['status']; error?: string }>()
  private quirkMap: Record<string, Quirks> = {}
  private loaded = false

  private file(name: string): string {
    return path.join(app.getPath('userData'), name)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.configs = JSON.parse(readFileSync(this.file('providers.json'), 'utf8')) as ProviderConfig[]
    } catch {
      this.configs = []
    }
    try {
      this.quirkMap = JSON.parse(readFileSync(this.file('provider-quirks.json'), 'utf8')) as Record<string, Quirks>
    } catch {
      this.quirkMap = {}
    }
  }

  private save(): void {
    writeFileSync(this.file('providers.json'), JSON.stringify(this.configs, null, 2))
  }

  private secrets(): Record<string, string> {
    try {
      if (!existsSync(this.file('providers-secrets.bin')) || !safeStorage.isEncryptionAvailable()) return {}
      return JSON.parse(safeStorage.decryptString(readFileSync(this.file('providers-secrets.bin')))) as Record<string, string>
    } catch (e) {
      log.warn('providers', 'could not read saved keys', e)
      return {}
    }
  }

  private saveSecrets(all: Record<string, string>): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system has no keychain to keep keys safe, so the key cannot be saved.')
    writeFileSync(this.file('providers-secrets.bin'), safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 })
  }

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS
  }

  list(): ProviderInfo[] {
    this.load()
    return this.configs.map((c) => {
      const s = this.state.get(c.id)
      const local = isLocalAddress(c.baseUrl)
      const priced: ProviderInfo['priced'] = {}
      // A server on this computer or network is not paid per token: no prices to show for it.
      if (!local) {
        for (const m of c.models) {
          const p = this.priceOf(c, m.id, m)
          if (p) priced[m.id] = p
        }
      }
      return { ...c, status: !c.enabled ? 'off' : (s?.status ?? 'ready'), error: s?.error, local, priced }
    })
  }

  /** The price in effect for one model: the person's own, else the service's own, else the list price. */
  private priceOf(c: ProviderConfig, modelId: string, model = c.models.find((m) => m.id === modelId)): { price: Price; source: PriceSource } | undefined {
    const own = c.prices?.[modelId]
    if (own) return { price: own, source: 'yours' }
    const said = model?.price
    if (said) return { price: said, source: 'service' }
    const listed = priceList.find(c.preset, modelId)
    return listed ? { price: listed, source: 'list' } : undefined
  }

  /** What a model ("@service/model") costs, when that is known. */
  priceFor(name: string): { price: Price; source: PriceSource } | undefined {
    const r = parseRemoteModel(name)
    const c = r ? this.get(r.provider) : undefined
    return r && c ? this.priceOf(c, r.model) : undefined
  }

  /** The person's own price for a model (per million tokens); without one, back to the lists. */
  setPrice(id: string, modelId: string, price?: { in: number; out: number } | null): ProviderInfo[] {
    const c = this.get(id)
    if (!c) throw new Error('Unknown service')
    const prices = { ...(c.prices ?? {}) }
    if (!price) delete prices[modelId]
    else {
      const pIn = Number(price.in)
      const pOut = Number(price.out)
      if (!(pIn >= 0) || !(pOut >= 0) || !Number.isFinite(pIn + pOut)) throw new Error('A price is a number of dollars per million tokens, 0 or more.')
      prices[modelId] = { in: pIn, out: pOut }
    }
    c.prices = Object.keys(prices).length ? prices : undefined
    this.save()
    this.emit()
    return this.list()
  }

  /** The makers' list prices are looked up once a day, while a service that they apply to is in use. */
  private lookUpPrices(): void {
    this.load()
    priceList.refreshStale(this.configs.some((c) => c.enabled && !isLocalAddress(c.baseUrl) && priceList.covers(c.preset)))
  }

  private emit(): void {
    this.changed.emit(this.list())
  }

  /** Something outside changed what the lists show (a newer price list). */
  refreshed(): void {
    this.emit()
  }

  get(id: string): ProviderConfig | undefined {
    this.load()
    return this.configs.find((c) => c.id === id)
  }

  /** How to reach the service a model name ("@id/model") belongs to. */
  connection(providerId: string): Connection {
    const c = this.get(providerId)
    if (!c) throw new Error('The service this model belongs to was removed. Pick another model, or add the service again in Models → API.')
    if (!c.enabled) throw new Error(`${c.name} is turned off. Turn it on in Models → API, or pick another model.`)
    return { id: c.id, name: c.name, baseUrl: c.baseUrl, key: this.secrets()[c.id], local: isLocalAddress(c.baseUrl) }
  }

  /** What the service said about one of its models. */
  model(name: string): ProviderModel | undefined {
    const r = parseRemoteModel(name)
    return r ? this.get(r.provider)?.models.find((m) => m.id === r.model) : undefined
  }

  /** The chosen models of every service that is on, in the shape the rest of Maris lists models in. */
  modelInfos(): ModelInfo[] {
    this.load()
    const out: ModelInfo[] = []
    for (const c of this.configs) {
      if (!c.enabled) continue
      const local = isLocalAddress(c.baseUrl)
      for (const id of c.picked) {
        const m = c.models.find((x) => x.id === id) ?? { id }
        const name = remoteModelName(c.id, id)
        const q = this.quirkMap[name] ?? {}
        const caps = ['completion']
        // Not said by the service means "try it": a refusal is remembered (see Quirks).
        if (m.tools !== false && !q.noTools) caps.push('tools')
        if (m.vision !== false && !q.noVision) caps.push('vision')
        if (m.thinking && !q.noThink) caps.push('thinking')
        const priced = local ? undefined : this.priceOf(c, id)
        out.push({
          name,
          sizeBytes: 0,
          capabilities: caps,
          contextLength: m.contextLength,
          label: remoteModelLabel(name, m.label),
          provider: c.id,
          providerName: c.name,
          remote: !local,
          ...(priced ? { price: { in: priced.price.in, out: priced.price.out } } : {})
        })
      }
    }
    return out
  }

  quirks(name: string): Quirks {
    this.load()
    return this.quirkMap[name] ?? {}
  }

  /** Remember what a service's reply taught about a model. */
  learn(name: string, patch: Quirks): void {
    this.load()
    const cur = this.quirkMap[name] ?? {}
    const next: Quirks = { ...cur, ...patch, drop: [...new Set([...(cur.drop ?? []), ...(patch.drop ?? [])])] }
    if (!next.drop?.length) delete next.drop
    this.quirkMap[name] = next
    try {
      writeFileSync(this.file('provider-quirks.json'), JSON.stringify(this.quirkMap, null, 1))
    } catch (e) {
      log.warn('providers', 'could not save what was learned', e)
    }
    log.info('providers', `${name}: learned ${JSON.stringify(patch)}`)
  }

  /** Add a service from a preset; reads its models to check the address and key. */
  async add(presetId: string, values: { key?: string; baseUrl?: string; name?: string }): Promise<ProviderInfo[]> {
    this.load()
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
    if (!preset) throw new Error('Unknown service')
    const baseUrl = cleanBaseUrl(values.baseUrl || preset.baseUrl)
    if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw new Error('Enter the address of the service, starting with http:// or https://')
    const key = cleanSecret(values.key ?? '')
    if (!key && !preset.local && !preset.custom) throw new Error('Paste the API key of your account.')
    const config: ProviderConfig = {
      id: `${preset.id}${this.configs.some((c) => c.id === preset.id) ? `-${uid().slice(0, 4)}` : ''}`,
      preset: preset.id,
      kind: preset.kind,
      name: values.name?.trim() || preset.name,
      baseUrl,
      enabled: true,
      hasKey: Boolean(key),
      models: [],
      picked: [],
      createdAt: Date.now()
    }
    // Read the models before anything is saved: a wrong key or address is caught here.
    const models = await this.fetchModels(config, key || undefined)
    config.models = models
    config.picked = defaultPicks(models)
    config.fetchedAt = Date.now()
    if (key) {
      const all = this.secrets()
      all[config.id] = key
      this.saveSecrets(all)
    }
    this.configs.push(config)
    this.save()
    this.state.set(config.id, { status: 'ready' })
    this.emit()
    this.lookUpPrices()
    return this.list()
  }

  async edit(id: string, values: { key?: string; baseUrl?: string; name?: string }): Promise<ProviderInfo[]> {
    const c = this.get(id)
    if (!c) throw new Error('Unknown service')
    const preset = PROVIDER_PRESETS.find((p) => p.id === c.preset)
    const baseUrl = values.baseUrl !== undefined && (preset?.custom || preset?.local) ? cleanBaseUrl(values.baseUrl) : c.baseUrl
    if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw new Error('Enter the address of the service, starting with http:// or https://')
    const all = this.secrets()
    const newKey = cleanSecret(values.key ?? '')
    const key = newKey || all[id]
    const models = await this.fetchModels({ ...c, baseUrl }, key)
    c.baseUrl = baseUrl
    if (values.name?.trim()) c.name = values.name.trim()
    c.models = models
    c.picked = c.picked.filter((p) => models.some((m) => m.id === p))
    if (!c.picked.length) c.picked = defaultPicks(models)
    c.fetchedAt = Date.now()
    if (newKey) {
      all[id] = newKey
      this.saveSecrets(all)
      c.hasKey = true
    }
    this.save()
    this.state.set(id, { status: 'ready' })
    this.emit()
    return this.list()
  }

  remove(id: string): ProviderInfo[] {
    this.load()
    this.configs = this.configs.filter((c) => c.id !== id)
    this.save()
    const all = this.secrets()
    if (all[id]) {
      delete all[id]
      try {
        this.saveSecrets(all)
      } catch (e) {
        log.warn('providers', e)
      }
    }
    this.state.delete(id)
    for (const k of Object.keys(this.quirkMap)) if (k.startsWith(`@${id}/`)) delete this.quirkMap[k]
    this.emit()
    return this.list()
  }

  setEnabled(id: string, on: boolean): ProviderInfo[] {
    const c = this.get(id)
    if (!c) throw new Error('Unknown service')
    c.enabled = on
    this.save()
    this.emit()
    return this.list()
  }

  /** Which of the service's models show up in Maris. */
  setPicked(id: string, picked: string[]): ProviderInfo[] {
    const c = this.get(id)
    if (!c) throw new Error('Unknown service')
    const known = new Set(c.models.map((m) => m.id))
    // A model the service does not list can still be typed in by hand (a private or preview one).
    c.picked = [...new Set(picked.map((p) => p.trim()).filter(Boolean))].slice(0, 200)
    for (const p of c.picked) if (!known.has(p)) c.models.push({ id: p })
    this.save()
    this.emit()
    return this.list()
  }

  /** Read the service's models again (new ones appear, removed ones go). */
  async refresh(id: string): Promise<ProviderInfo[]> {
    const c = this.get(id)
    if (!c) throw new Error('Unknown service')
    this.state.set(id, { status: 'checking' })
    this.emit()
    try {
      const models = await this.fetchModels(c, this.secrets()[id])
      // Keep models the person typed in by hand that the service does not list.
      const typed = c.picked.filter((p) => !models.some((m) => m.id === p)).map((p) => c.models.find((m) => m.id === p) ?? { id: p })
      c.models = [...models, ...typed]
      c.fetchedAt = Date.now()
      this.save()
      this.state.set(id, { status: 'ready' })
    } catch (e) {
      this.state.set(id, { status: 'error', error: errMsg(e) })
    }
    this.emit()
    return this.list()
  }

  /** Once a day, in the background, so new models show up by themselves. */
  refreshStale(maxAgeMs = 24 * 3600_000): void {
    this.load()
    this.lookUpPrices()
    for (const c of this.configs) {
      if (c.enabled && Date.now() - (c.fetchedAt ?? 0) > maxAgeMs) void this.refresh(c.id).catch(() => undefined)
    }
  }

  private async fetchModels(c: ProviderConfig, key?: string): Promise<ProviderModel[]> {
    const conn: Connection = { id: c.id, name: c.name, baseUrl: c.baseUrl, key, local: isLocalAddress(c.baseUrl) }
    const models = c.kind === 'anthropic' ? await anthropicModels(conn) : await openaiModels(conn)
    const seen = new Set<string>()
    const out = models.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id) && looksLikeChatModel(m.id)).slice(0, MAX_MODELS)
    if (!out.length) throw new Error(`${c.name} answered, but listed no chat models. Check the address${key ? '' : ' and whether it needs a key'}.`)
    return out
  }
}

export const providers = new Providers()
