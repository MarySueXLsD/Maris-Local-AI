import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cleanSecret, CONNECTOR_PRESETS, connectorToolName, splitCommand } from '@shared/connectorPresets'
import type { ConnectorConfig, ConnectorInfo, ConnectorPreset } from '@shared/extensions'
import type { ToolRisk } from '@shared/types'
import { settings } from '../settings'
import { ToolError, type ToolDef } from '../tools/types'
import { Emitter, log, uid } from '../util'

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

interface Live {
  client?: Client
  status: ConnectorInfo['status']
  error?: string
  tools: McpTool[]
}

const MAX_TOOLS = 60

/**
 * Connectors: outside services (GitHub, Notion, Home Assistant, …) reached through the Model Context
 * Protocol. Their tools join Maris's own; anything that is not marked read-only waits for approval.
 */
class Connectors {
  readonly changed = new Emitter<ConnectorInfo[]>()
  private configs: ConnectorConfig[] = []
  private live = new Map<string, Live>()
  private loaded = false

  private file(name: string): string {
    return path.join(app.getPath('userData'), name)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.configs = JSON.parse(readFileSync(this.file('connectors.json'), 'utf8')) as ConnectorConfig[]
    } catch {
      this.configs = []
    }
  }

  private saveConfigs(): void {
    writeFileSync(this.file('connectors.json'), JSON.stringify(this.configs, null, 2))
  }

  private secrets(): Record<string, Record<string, string>> {
    try {
      if (!existsSync(this.file('connectors-secrets.bin')) || !safeStorage.isEncryptionAvailable()) return {}
      return JSON.parse(safeStorage.decryptString(readFileSync(this.file('connectors-secrets.bin')))) as Record<string, Record<string, string>>
    } catch (e) {
      log.warn('connectors', 'could not read saved keys', e)
      return {}
    }
  }

  private saveSecrets(all: Record<string, Record<string, string>>): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system has no keychain to keep keys safe, so they cannot be saved.')
    writeFileSync(this.file('connectors-secrets.bin'), safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 })
  }

  presets(): ConnectorPreset[] {
    return CONNECTOR_PRESETS
  }

  list(): ConnectorInfo[] {
    this.load()
    return this.configs.map((c) => {
      const l = this.live.get(c.id)
      return {
        ...c,
        status: !c.enabled ? 'off' : (l?.status ?? 'connecting'),
        error: l?.error,
        tools: (l?.tools ?? []).map((t) => ({ name: t.annotations?.title || t.name, description: (t.description ?? '').slice(0, 200), readOnly: readOnly(c, t) }))
      }
    })
  }

  private emit(): void {
    this.changed.emit(this.list())
  }

  /** Connect everything that is turned on (at start-up). */
  startAll(): void {
    this.load()
    if (!settings.get().extensions.connectors) return
    for (const c of this.configs) if (c.enabled) void this.connect(c.id)
  }

  /** Add a connector from a preset with the person's values (secrets go to the keychain). */
  async add(presetId: string, values: Record<string, string>, name?: string): Promise<ConnectorInfo[]> {
    this.load()
    const preset = CONNECTOR_PRESETS.find((p) => p.id === presetId)
    if (!preset) throw new Error('Unknown connector')
    const id = `${preset.id}-${uid().slice(0, 6)}`
    const config: ConnectorConfig = {
      id,
      preset: preset.id,
      name: name?.trim() || preset.name,
      transport: preset.transport,
      enabled: true,
      values: {},
      savedFields: [],
      createdAt: Date.now()
    }
    this.applyValues(config, preset, values)
    this.configs.push(config)
    this.saveConfigs()
    this.emit()
    await this.connect(id)
    return this.list()
  }

  async edit(id: string, values: Record<string, string>, name?: string): Promise<ConnectorInfo[]> {
    this.load()
    const config = this.configs.find((c) => c.id === id)
    const preset = CONNECTOR_PRESETS.find((p) => p.id === config?.preset)
    if (!config || !preset) throw new Error('Unknown connector')
    if (name?.trim()) config.name = name.trim()
    this.applyValues(config, preset, values)
    this.saveConfigs()
    await this.disconnect(id)
    if (config.enabled) await this.connect(id)
    return this.list()
  }

  private applyValues(config: ConnectorConfig, preset: ConnectorPreset, values: Record<string, string>): void {
    const all = this.secrets()
    const mine = all[config.id] ?? {}
    for (const f of preset.fields) {
      const raw = values[f.key]
      const v = raw === undefined ? undefined : f.secret && 'header' in f.target ? cleanSecret(raw) : raw.trim()
      if (v && f.pattern && !new RegExp(f.pattern).test(v)) throw new Error(f.patternHint ?? `${f.label} does not look right.`)
      if (f.secret) {
        // An empty secret on edit keeps the saved one.
        if (v) mine[f.key] = v
      } else if (v !== undefined) config.values[f.key] = v
      if (!f.optional && !(f.secret ? mine[f.key] : config.values[f.key])) throw new Error(`${f.label} is needed.`)
    }
    if (preset.fields.some((f) => 'url' in f.target)) {
      const u = config.values.url ?? ''
      if (!/^https?:\/\//i.test(u)) throw new Error('The address must start with http:// or https://')
    }
    all[config.id] = mine
    config.savedFields = Object.keys(mine).filter((k) => mine[k])
    this.saveSecrets(all)
  }

  async setEnabled(id: string, on: boolean): Promise<ConnectorInfo[]> {
    this.load()
    const c = this.configs.find((x) => x.id === id)
    if (!c) throw new Error('Unknown connector')
    c.enabled = on
    this.saveConfigs()
    if (on) await this.connect(id)
    else await this.disconnect(id)
    return this.list()
  }

  async remove(id: string): Promise<ConnectorInfo[]> {
    this.load()
    await this.disconnect(id)
    this.configs = this.configs.filter((c) => c.id !== id)
    this.saveConfigs()
    const all = this.secrets()
    delete all[id]
    if (Object.keys(all).length || existsSync(this.file('connectors-secrets.bin'))) this.saveSecrets(all)
    this.live.delete(id)
    this.emit()
    return this.list()
  }

  async reconnect(id: string): Promise<ConnectorInfo[]> {
    await this.disconnect(id)
    await this.connect(id)
    return this.list()
  }

  private async disconnect(id: string): Promise<void> {
    const l = this.live.get(id)
    this.live.set(id, { status: 'off', tools: [] })
    try {
      await l?.client?.close()
    } catch {
      /* already closed */
    }
    this.emit()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)))
  }

  private async connect(id: string): Promise<void> {
    const c = this.configs.find((x) => x.id === id)
    const preset = CONNECTOR_PRESETS.find((p) => p.id === c?.preset)
    if (!c || !preset || !c.enabled) return
    this.live.set(id, { status: 'connecting', tools: [] })
    this.emit()
    const secret = this.secrets()[id] ?? {}
    const value = (key: string): string | undefined => secret[key] ?? c.values[key]
    try {
      const client = new Client({ name: 'Maris', version: app.getVersion() })
      if (preset.transport === 'http') {
        const urlField = preset.fields.find((f) => 'url' in f.target)
        const url = (preset.url ?? '{url}').replace('{url}', (urlField ? value(urlField.key) : '')?.replace(/\/+$/, '') ?? '')
        const headers: Record<string, string> = {}
        for (const f of preset.fields) {
          const v = value(f.key)
          if (v && 'header' in f.target) headers[f.target.header] = `${f.target.prefix ?? ''}${f.secret ? cleanSecret(v) : v}`
        }
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
        } catch (e) {
          const first = errText(e)
          // A refused key is the answer; trying the older transport would only hide it.
          if (/\b(400|401|403)\b|unauthori[sz]ed|forbidden|authorization|token|credential/i.test(first)) throw new Error(first)
          // Older servers speak the earlier SSE transport.
          log.info('connectors', `${c.name}: Streamable HTTP failed (${first}), trying SSE`)
          try {
            await client.connect(new SSEClientTransport(new URL(url), { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } }))
          } catch (e2) {
            log.info('connectors', `${c.name}: SSE failed too (${errText(e2)})`)
            throw new Error(first)
          }
        }
      } else {
        const cmdField = preset.fields.find((f) => 'command' in f.target)
        const parts = cmdField ? splitCommand(value(cmdField.key) ?? '') : [preset.command ?? '', ...(preset.args ?? [])]
        if (!parts[0]) throw new Error('No command to run.')
        const env: Record<string, string> = { ...getDefaultEnvironment() }
        for (const f of preset.fields) {
          const v = value(f.key)
          if (!v) continue
          if ('env' in f.target) env[f.target.env] = v
          if ('envList' in f.target) {
            for (const line of v.split(/\r?\n/)) {
              const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
              if (m) env[m[1]!] = m[2]!.trim()
            }
          }
        }
        await client.connect(new StdioClientTransport({ command: parts[0], args: parts.slice(1), env, stderr: 'ignore' }))
      }
      const tools: McpTool[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        tools.push(...(page.tools as McpTool[]))
        cursor = page.nextCursor
      } while (cursor && tools.length < MAX_TOOLS)
      this.live.set(id, { client, status: 'ready', tools: tools.slice(0, MAX_TOOLS) })
      log.info('connectors', `${c.name}: connected, ${tools.length} tools`)
    } catch (e) {
      const msg = errText(e)
      const error = await explainFailure(preset, msg, value)
      this.live.set(id, { status: 'error', error, tools: [] })
      log.warn('connectors', `${c.name}: ${msg}`)
    }
    this.emit()
  }

  /** The tools of every ready connector, in the form the assistant uses. */
  tools(): ToolDef[] {
    if (!settings.get().extensions.connectors) return []
    this.load()
    const out: ToolDef[] = []
    for (const c of this.configs) {
      const l = this.live.get(c.id)
      if (!c.enabled || l?.status !== 'ready' || !l.client) continue
      for (const t of l.tools) out.push(this.toolDef(c, t, l.client))
    }
    return out
  }

  find(name: string): ToolDef | undefined {
    return this.tools().find((t) => t.name === name)
  }

  private toolDef(c: ConnectorConfig, t: McpTool, client: Client): ToolDef {
    const risk: ToolRisk = readOnly(c, t) ? 'read' : 'change'
    const label = t.annotations?.title || t.name.replace(/[_-]+/g, ' ')
    return {
      name: connectorToolName(c.id, t.name),
      risk,
      description: `[${c.name}] ${(t.description ?? label).replace(/\s+/g, ' ').slice(0, 700)}`,
      parameters: cleanSchema(t.inputSchema),
      async prepare(args) {
        return {
          risk,
          title: `${c.name}: ${label}`,
          detail: risk === 'read' ? undefined : `This acts in your ${c.name} account.`,
          preview: Object.keys(args).length ? { kind: 'text', text: JSON.stringify(args, null, 2).slice(0, 4000) } : undefined
        }
      },
      async run(args, ctx) {
        let r: { content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string }; uri?: string }[]; isError?: boolean; structuredContent?: unknown }
        try {
          r = (await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 180000 })) as typeof r
        } catch (e) {
          throw new ToolError(`${c.name}: ${(e as Error).message}`)
        }
        const parts: string[] = []
        for (const item of r.content ?? []) {
          if (item.type === 'text' && item.text) parts.push(item.text)
          else if (item.type === 'image' && item.data) {
            if (ctx.modelSupportsVision) ctx.attachImageForModel(item.data, `Picture from ${c.name}`)
            parts.push(`[picture from ${c.name}${ctx.modelSupportsVision ? ', attached' : ''}]`)
          } else if (item.type === 'resource') parts.push(item.resource?.text ?? item.resource?.uri ?? '')
          else if (item.type === 'resource_link' && item.uri) parts.push(item.uri)
        }
        if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 1))
        const text = parts.join('\n\n') || '(no content)'
        if (r.isError) throw new ToolError(`${c.name}: ${text.slice(0, 2000)}`)
        return text
      }
    }
  }
}

function errText(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).replace(/\s+/g, ' ').trim()
}

/** What went wrong, in words a person can act on. */
async function explainFailure(preset: ConnectorPreset, msg: string, value: (key: string) => string | undefined): Promise<string> {
  if (/ENOENT|not recognized|cannot find/i.test(msg) && preset.needsNode) return `${msg.slice(0, 200)} This connector needs Node.js; install it from nodejs.org.`
  if (preset.id === 'github') {
    if (/badly formatted|unsupported authorization/i.test(msg)) {
      return 'GitHub did not accept the token\'s format. Paste only the token itself: it starts with github_pat_ or ghp_ (edit the connector to paste it again).'
    }
    // Ask GitHub itself whether the token works, to tell a wrong token from missing access.
    const token = value('token')
    if (token && /\b(400|401|403)\b|unauthori[sz]ed|forbidden/i.test(msg)) {
      try {
        const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${cleanSecret(token)}`, 'User-Agent': 'Maris' }, signal: AbortSignal.timeout(10000) })
        if (r.status === 401) return 'GitHub refused the token: it is wrong, expired or was revoked. Create a new token and paste it here.'
        if (r.ok) {
          const login = ((await r.json()) as { login?: string }).login
          return `The token works for ${login ?? 'your account'}, but GitHub's connector service refused it (${msg.slice(0, 120)}). Give the token access to the repositories and permissions you want Maris to use.`
        }
      } catch {
        /* offline: fall through */
      }
    }
  }
  if (/\b401\b|unauthori[sz]ed/i.test(msg)) return `The service refused the key (${msg.slice(0, 160)}). Check it, or create a new one.`
  if (/\b403\b|forbidden/i.test(msg)) return `The key has no access to this (${msg.slice(0, 160)}). Give it the permissions you want Maris to use.`
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(msg)) return `Could not reach the service (${msg.slice(0, 160)}). Check the internet connection or the address.`
  return msg.slice(0, 300)
}

/** A tool only reads when it says so, or when its whole service only reads (DeepWiki). */
function readOnly(c: ConnectorConfig, t: McpTool): boolean {
  return Boolean(t.annotations?.readOnlyHint) || Boolean(CONNECTOR_PRESETS.find((p) => p.id === c.preset)?.readOnly)
}

/** Models need a plain object schema; MCP schemas can carry extras such as $schema. */
function cleanSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'object', properties: {}, ...(s ?? {}) }
  delete out.$schema
  if (out.type !== 'object') out.type = 'object'
  if (!out.properties || typeof out.properties !== 'object') out.properties = {}
  return out
}

export const connectors = new Connectors()
