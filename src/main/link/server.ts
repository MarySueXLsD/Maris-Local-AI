import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { LinkDevice, LinkStatus } from '@shared/types'
import { handlers, outbound } from '../bridge'
import { comfy } from '../media/comfy'
import { media } from '../media/jobs'
import { settings } from '../settings'
import { Emitter, log } from '../util'
import { b64u, deriveKey, isPrivateAddress, LINK_VERSION, MAX_SKEW_MS, newPairingCode, seal, sealBytes, serverKeyPair, unseal, type Box } from './protocol'

interface StoredDevice extends LinkDevice {
  /** The session key, encrypted with the OS keychain (safeStorage) when available. */
  key: string
}

interface Device extends LinkDevice {
  key: Buffer
}

interface Envelope {
  ts: number
  n: string
}

/** Channels the phone app may not call: dialogs and folders on this computer, setup, and pairing itself. */
const BLOCKED = new Set([
  'settings:pickFolder',
  'settings:export',
  'settings:import',
  'files:pick',
  'files:pickImage',
  'files:attach',
  'shell:openPath',
  'shell:showInFolder',
  'shell:openExternal',
  'shell:reveal',
  // New project folders are made on the computer, with its folder picker.
  'project:create',
  'setup:apply',
  'setup:skip',
  'setup:cancel',
  'setup:scan',
  // Updates install on the computer itself; skills from a folder use a dialog there.
  'updates:install',
  'updates:download',
  // Ending programs on the computer needs someone at the computer.
  'system:endProgram',
  'skills:pickFolder',
  // Keys for model services are entered at the computer, and so is where chats may be sent.
  'providers:add',
  'providers:edit',
  'providers:remove',
  'providers:setPrice',
  'providers:clearUsage',
  // The terminal command belongs to this computer.
  'cli:show',
  'cli:status',
  'cli:set'
])
/** Channels that change this computer and follow "Approve changes from the phone". */
const NEEDS_APPROVAL_RIGHT = new Set(['chat:approve', 'project:installToolchain', 'project:revert'])

const MAX_BODY = 40 * 2 ** 20
const MAX_MEDIA = 300 * 2 ** 20

class LinkServer {
  readonly changed = new Emitter<LinkStatus>()
  private server?: http.Server
  private port = 0
  private error?: string
  private devices = new Map<string, Device>()
  private pairing?: { code: string; expiresAt: number; failures: number; pending: Map<string, { key: Buffer; name: string; expiresAt: number }> }
  private clients = new Set<{ device: Device; res: ServerResponse }>()
  private nonces = new Map<string, number>()
  private blocked = new Map<string, { count: number; until: number }>()
  private offOutbound?: () => void

  private file(): string {
    return path.join(app.getPath('userData'), 'link-devices.json')
  }

  private load(): void {
    try {
      const list = JSON.parse(readFileSync(this.file(), 'utf8')) as StoredDevice[]
      for (const d of list) {
        const raw = d.key.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(d.key.slice(4), 'base64')) : d.key
        this.devices.set(d.id, { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, key: b64u.dec(raw) })
      }
    } catch {
      /* no paired devices yet */
    }
  }

  private save(): void {
    const enc = safeStorage.isEncryptionAvailable()
    const list: StoredDevice[] = [...this.devices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      key: enc ? `enc:${safeStorage.encryptString(b64u.enc(d.key)).toString('base64')}` : b64u.enc(d.key)
    }))
    writeFileSync(this.file(), JSON.stringify(list, null, 2), { mode: 0o600 })
  }

  /** Follow the setting: start, stop or move to a new port. */
  apply(): void {
    const cfg = settings.get().link
    if (!this.devices.size && existsSync(this.file())) this.load()
    if (!cfg.enabled) return this.stop()
    if (this.server && this.port === cfg.port) return
    this.stop()
    this.start(cfg.port)
  }

  private start(port: number): void {
    this.error = undefined
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.on('error', (e: NodeJS.ErrnoException) => {
      this.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : e.message
      log.warn('link', e)
      this.server = undefined
      this.emit()
    })
    // MARIS_LINK_HOST=127.0.0.1 keeps it on this computer (tests, emulators); no firewall prompt.
    server.listen(port, process.env.MARIS_LINK_HOST || '0.0.0.0', () => {
      log.info('link', `Maris Link listening on port ${port}`)
      this.emit()
    })
    this.server = server
    this.port = port
    this.offOutbound = outbound.on(({ channel, payload }) => this.forward(channel, payload))
    this.emit()
  }

  stop(): void {
    if (this.devices.size) this.save()
    for (const c of this.clients) c.res.end()
    this.clients.clear()
    this.offOutbound?.()
    this.offOutbound = undefined
    this.server?.close()
    this.server = undefined
    this.pairing = undefined
    this.emit()
  }

  // ---------------------------------------------------------------- status and pairing (desktop UI)

  status(): LinkStatus {
    const cfg = settings.get().link
    const online = new Set([...this.clients].map((c) => c.device.id))
    const addresses = lanAddresses()
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined
    return {
      enabled: cfg.enabled,
      running: Boolean(this.server?.listening),
      port: cfg.port,
      addresses,
      hostName: os.hostname(),
      devices: [...this.devices.values()]
        .map(({ key: _k, ...d }) => ({ ...d, online: online.has(d.id) }))
        .sort((a, b) => (b.lastSeen ?? b.createdAt) - (a.lastSeen ?? a.createdAt)),
      pairing: pairing
        ? {
            code: pairing.code,
            expiresAt: pairing.expiresAt,
            url: `maris://pair?h=${encodeURIComponent(addresses.slice(0, 3).join(','))}&p=${cfg.port}&c=${encodeURIComponent(pairing.code)}&n=${encodeURIComponent(os.hostname())}`
          }
        : undefined,
      error: this.error
    }
  }

  private emit(): void {
    this.changed.emit(this.status())
  }

  startPairing(): LinkStatus {
    if (!this.server) throw new Error('Turn on "Allow the phone app to connect" first')
    this.pairing = { code: newPairingCode(), expiresAt: Date.now() + 10 * 60000, failures: 0, pending: new Map() }
    this.emit()
    return this.status()
  }

  cancelPairing(): LinkStatus {
    this.pairing = undefined
    this.emit()
    return this.status()
  }

  removeDevice(id: string): LinkStatus {
    this.devices.delete(id)
    for (const c of [...this.clients]) {
      if (c.device.id === id) {
        c.res.end()
        this.clients.delete(c)
      }
    }
    this.save()
    this.emit()
    return this.status()
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? ''
    // Phones on the same network (or a private VPN such as Tailscale) only.
    if (!isPrivateAddress(ip)) {
      req.destroy()
      return
    }
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const block = this.blocked.get(ip)
    if (block && block.until > Date.now()) {
      json(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://maris')
    try {
      if (req.method === 'GET' && url.pathname === '/api/hello') {
        json(res, 200, { app: 'maris', v: LINK_VERSION, name: os.hostname(), pairing: Boolean(this.pairing && this.pairing.expiresAt > Date.now()) })
      } else if (req.method === 'POST' && url.pathname === '/api/pair/start') {
        await this.pairStart(req, res, ip)
      } else if (req.method === 'POST' && url.pathname === '/api/pair/finish') {
        await this.pairFinish(req, res, ip)
      } else if (req.method === 'POST' && url.pathname === '/api/invoke') {
        await this.invoke(req, res, ip)
      } else if (req.method === 'GET' && url.pathname === '/api/events') {
        this.events(url, res, ip)
      } else if (req.method === 'POST' && url.pathname === '/api/media') {
        await this.media(req, res, ip)
      } else if (req.method === 'POST' && url.pathname === '/api/upload') {
        await this.upload(req, res, ip)
      } else {
        json(res, 404, { error: 'Not found' })
      }
    } catch (e) {
      log.warn('link', e)
      if (!res.headersSent) json(res, 400, { error: 'Bad request' })
      else res.end()
    }
  }

  private fail(ip: string): void {
    const b = this.blocked.get(ip) ?? { count: 0, until: 0 }
    b.count += 1
    if (b.count >= 20) {
      b.until = Date.now() + 10 * 60000
      b.count = 0
    }
    this.blocked.set(ip, b)
  }

  /**
   * Open a sealed request from a paired device, checking freshness and that it was not seen before.
   * On failure it answers the request itself: 401 for an unknown phone or a wrong key (the phone then
   * forgets its pairing), 409 for a stale or repeated request (a clock problem; the pairing stays).
   */
  private openFrom<T extends Envelope>(res: ServerResponse, deviceId: string, box: Box, ip: string): { device: Device; body: T } | undefined {
    const device = this.devices.get(deviceId)
    let body: T | undefined
    if (device) {
      try {
        body = unseal<T>(device.key, box)
      } catch {
        body = undefined
      }
    }
    if (!device || !body) {
      this.fail(ip)
      json(res, 401, { error: 'Not paired' })
      return undefined
    }
    const now = Date.now()
    if (Math.abs(now - body.ts) > MAX_SKEW_MS || typeof body.n !== 'string' || this.nonces.has(body.n)) {
      json(res, 409, { error: "Request refused: it was sent twice, or the phone's clock differs from the computer's by more than two minutes." })
      return undefined
    }
    this.nonces.set(body.n, now + MAX_SKEW_MS * 2)
    if (this.nonces.size > 5000) for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n)
    device.lastSeen = now
    return { device, body }
  }

  private async pairStart(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const p = this.pairing
    if (!p || p.expiresAt < Date.now()) {
      json(res, 409, { error: 'Pairing is not open. On the computer, open Settings → Phone and choose "Pair a phone".' })
      return
    }
    const { d, name, pub } = (await readJson(req)) as { d?: string; name?: string; pub?: string }
    if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d) || !pub) {
      json(res, 400, { error: 'Bad request' })
      return
    }
    const phonePub = b64u.dec(pub)
    const kp = serverKeyPair()
    let shared: Buffer
    try {
      shared = kp.secret(phonePub)
    } catch {
      this.fail(ip)
      json(res, 400, { error: 'Bad key' })
      return
    }
    p.pending.set(d, { key: deriveKey(shared, p.code, d, phonePub, kp.pub), name: String(name ?? 'Phone').slice(0, 60), expiresAt: Date.now() + 120000 })
    json(res, 200, { pub: b64u.enc(kp.pub), name: os.hostname() })
  }

  private async pairFinish(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const p = this.pairing
    const { d, iv, ct } = (await readJson(req)) as { d?: string } & Box
    const pending = p && d ? p.pending.get(d) : undefined
    if (!p || !pending || pending.expiresAt < Date.now() || p.expiresAt < Date.now()) {
      json(res, 409, { error: 'Pairing expired. Start again on the computer.' })
      return
    }
    let body: Envelope & { name?: string }
    try {
      body = unseal(pending.key, { iv, ct })
    } catch {
      // Wrong code: a few tries, then the code is cancelled so it cannot be guessed.
      p.pending.delete(d!)
      p.failures += 1
      this.fail(ip)
      if (p.failures >= 5) this.pairing = undefined
      this.emit()
      json(res, 403, { error: p.failures >= 5 ? 'Too many wrong codes. Start pairing again on the computer.' : 'The code does not match. Check it and try again.' })
      return
    }
    if (Math.abs(Date.now() - body.ts) > MAX_SKEW_MS) {
      json(res, 400, { error: "The phone's clock is too far from the computer's. Check the time on both." })
      return
    }
    const device: Device = { id: d!, name: (body.name || pending.name).slice(0, 60), createdAt: Date.now(), lastSeen: Date.now(), key: pending.key }
    this.devices.set(device.id, device)
    this.pairing = undefined
    this.save()
    log.info('link', `paired ${device.name}`)
    this.emit()
    json(res, 200, seal(device.key, { ok: true, host: os.hostname(), platform: process.platform, version: app.getVersion() }))
  }

  private async invoke(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const { d, iv, ct } = (await readJson(req)) as { d: string } & Box
    const opened = this.openFrom<Envelope & { ch: string; a?: unknown[] }>(res, d, { iv, ct }, ip)
    if (!opened) return
    const { device, body } = opened
    const reply = (value: unknown): void => json(res, 200, seal(device.key, value))
    const fn = handlers.get(body.ch)
    // Publishing posts needs the admin's token and stays at the computer.
    if (!fn || BLOCKED.has(body.ch) || body.ch.startsWith('link:') || body.ch.startsWith('admin:')) {
      reply({ ok: false, e: 'Not available from the phone' })
      return
    }
    if (NEEDS_APPROVAL_RIGHT.has(body.ch) && !settings.get().link.allowApprovals) {
      reply({ ok: false, e: 'Approving changes from the phone is turned off on the computer (Settings → Phone).' })
      return
    }
    let args = Array.isArray(body.a) ? body.a : []
    const mayApprove = settings.get().link.allowApprovals
    // The phone cannot change how the link itself works, nor turn on automatic approvals without the
    // right to approve (turning them off is always allowed), nor where updates come from (an update
    // installs a program on the computer) or the Admin page.
    if (body.ch === 'settings:set' && args[0] && typeof args[0] === 'object') {
      const { link: _l, ...rest } = args[0] as Record<string, unknown>
      const agent = rest.agent as Record<string, unknown> | undefined
      if (!mayApprove && agent?.autoApprove && typeof agent.autoApprove === 'object') {
        const offOnly = Object.fromEntries(Object.entries(agent.autoApprove as Record<string, unknown>).filter(([, v]) => v === false))
        rest.agent = { ...agent, autoApprove: offOnly }
      }
      if (rest.updates && typeof rest.updates === 'object') {
        const { repo: _r, admin: _a, ...keep } = rest.updates as Record<string, unknown>
        rest.updates = keep
      }
      args = [rest]
    }
    if (body.ch === 'approvals:setSession' && args[1] === true && !mayApprove) {
      reply({ ok: false, e: 'Approving changes from the phone is turned off on the computer (Settings → Phone).' })
      return
    }
    if (body.ch === 'settings:reset' && args[0] === 'link') {
      reply({ ok: false, e: 'Not available from the phone' })
      return
    }
    try {
      const r = await fn(...args)
      reply({ ok: true, r })
    } catch (e) {
      reply({ ok: false, e: (e as Error)?.message ?? String(e) })
    }
  }

  private events(url: URL, res: ServerResponse, ip: string): void {
    const d = url.searchParams.get('d') ?? ''
    const opened = this.openFrom<Envelope>(res, d, { iv: url.searchParams.get('iv') ?? '', ct: url.searchParams.get('ct') ?? '' }, ip)
    if (!opened) return
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(': hello\n\n')
    const client = { device: opened.device, res }
    this.clients.add(client)
    const ping = setInterval(() => res.write(': ping\n\n'), 20000)
    res.on('close', () => {
      clearInterval(ping)
      this.clients.delete(client)
      this.emit()
    })
    this.emit()
  }

  private forward(channel: string, payload: unknown): void {
    // Link status (with the pairing code) is for this computer's own window only.
    if (!this.clients.size || channel.startsWith('link:')) return
    for (const c of this.clients) {
      try {
        c.res.write(`data: ${JSON.stringify(seal(c.device.key, { ch: channel, p: payload }))}\n\n`)
      } catch {
        /* closed */
      }
    }
  }

  /** A generated picture or video (only from Maris's own folders), encrypted as a whole. */
  private async media(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const { d, iv, ct } = (await readJson(req)) as { d: string } & Box
    const opened = this.openFrom<Envelope & { path: string }>(res, d, { iv, ct }, ip)
    if (!opened) return
    const file = path.resolve(String(opened.body.path ?? ''))
    const roots = [media.outputsDir(), comfy.outputDir(), ...['pasted', 'uploads', 'news-cache'].map((d) => path.join(app.getPath('userData'), d))].map((r) =>
      path.resolve(r).toLowerCase()
    )
    const lower = file.toLowerCase()
    if (!roots.some((r) => lower.startsWith(r + path.sep)) || !existsSync(file) || statSync(file).size > MAX_MEDIA) {
      json(res, 404, { error: 'Not found' })
      return
    }
    const data = sealBytes(opened.device.key, await fs.readFile(file))
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) })
    res.end(data)
  }

  /** A picture or file sent from the phone, saved where attachments can read it. */
  private async upload(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const { d, iv, ct } = (await readJson(req)) as { d: string } & Box
    const opened = this.openFrom<Envelope & { name: string; data: string }>(res, d, { iv, ct }, ip)
    if (!opened) return
    const dir = path.join(app.getPath('userData'), 'uploads')
    await fs.mkdir(dir, { recursive: true })
    const safe = path.basename(String(opened.body.name || 'upload')).replace(/[^\w.\- ()]/g, '_').slice(-80) || 'upload'
    const file = path.join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`)
    await fs.writeFile(file, Buffer.from(String(opened.body.data ?? ''), 'base64'))
    const toAttachment = handlers.get('files:attach')
    const [att] = toAttachment ? ((await toAttachment([file])) as unknown[]) : [{ path: file }]
    json(res, 200, seal(opened.device.key, { ok: true, r: att }))
  }
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // Chrome's Private Network Access preflight.
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Access-Control-Max-Age', '600')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) })
  res.end(text)
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/** This computer's addresses on private networks, Wi-Fi and Ethernet first, virtual adapters last. */
export function lanAddresses(): string[] {
  const out: { addr: string; score: number }[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== 'IPv4' || !isPrivateAddress(a.address) || a.address.startsWith('169.254.')) continue
      const virtual = /vethernet|virtual|vmware|vbox|hyper-v|docker|wsl|br-|veth|loopback|utun|zerotier/i.test(name)
      const vpn = a.address.startsWith('100.') || /tailscale/i.test(name)
      out.push({ addr: a.address, score: (virtual ? 2 : 0) + (vpn ? 1 : 0) + (a.address.startsWith('192.168.') ? -1 : 0) })
    }
  }
  return out.sort((a, b) => a.score - b.score).map((a) => a.addr)
}

export const link = new LinkServer()

