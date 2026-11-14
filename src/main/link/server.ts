import { app, safeStorage } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { relayBase, roomUrl, type RelayInfo } from '@shared/relay'
import type { LinkDevice, LinkStatus, RelayState } from '@shared/types'
import { handlers, outbound } from '../bridge'
import { comfy } from '../media/comfy'
import { media } from '../media/jobs'
import { settings } from '../settings'
import { Emitter, log } from '../util'
import { phoneAccess, phoneArgs } from './policy'
import { b64u, deriveKey, isPrivateAddress, LINK_VERSION, MAX_SKEW_MS, newPairingCode, seal, sealBytes, serverKeyPair, unseal, type Box } from './protocol'
import { RelayClient } from './relayClient'

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

/** A request from a phone, whichever way it came: over the home network, or through the relay. */
interface Incoming {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  /** Who to count failed attempts against: an IP address, or "relay:<device id>". */
  peer: string
  /** The device the relay delivered it from (requests through the relay only). */
  relayDev?: string
}

type Outgoing = { status: number; json: unknown } | { status: number; bytes: Buffer } | { status: 200; events: Device }

// What the phone may call is decided channel by channel in ./policy.ts (anything not listed there stays on
// the computer). Requests through the Maris relay go through the same steps as those on the home network.

const MAX_BODY = 40 * 2 ** 20
const MAX_MEDIA = 300 * 2 ** 20
/** The status bar's readings go to a phone on the relay every few seconds, not every one. */
const RELAY_STATUS_MS = 10_000

class LinkServer {
  readonly changed = new Emitter<LinkStatus>()
  private server?: http.Server
  private port = 0
  private error?: string
  private devices = new Map<string, Device>()
  private pairing?: { code: string; expiresAt: number; failures: number; pending: Map<string, { key: Buffer; name: string; expiresAt: number }> }
  private clients = new Set<{ device: Device; res: ServerResponse }>()
  /** Phones listening for updates through the relay, by device id. */
  private relayClients = new Map<string, { device: Device; statusAt: number }>()
  private nonces = new Map<string, number>()
  private blocked = new Map<string, { count: number; until: number }>()
  private offOutbound?: () => void
  private relay = new RelayClient({
    frame: (dev, text) => void this.onRelayFrame(dev, text),
    phone: (dev, here) => {
      if (!here && this.relayClients.delete(dev)) this.emit()
    },
    state: (s: RelayState) => {
      if (s !== 'online') this.relayClients.clear()
      this.emit()
    }
  })
  private relayKey?: string

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

  // ---------------------------------------------------------------- the relay's room

  /**
   * The key of this computer's room at the relay (made once, kept with the OS keychain). The room id phones
   * use is a hash of it, so knowing the id is not enough to take this computer's place there.
   */
  private roomKey(): string {
    if (this.relayKey) return this.relayKey
    const file = path.join(app.getPath('userData'), 'link-relay.json')
    try {
      const stored = (JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key
      this.relayKey = stored.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) : stored
    } catch {
      this.relayKey = b64u.enc(randomBytes(32))
      const enc = safeStorage.isEncryptionAvailable()
      writeFileSync(file, JSON.stringify({ key: enc ? `enc:${safeStorage.encryptString(this.relayKey).toString('base64')}` : this.relayKey }), { mode: 0o600 })
    }
    return this.relayKey
  }

  /** Where paired phones find this computer when they are away from home; undefined while that is off. */
  private relayInfo(): RelayInfo | undefined {
    const cfg = settings.get().link
    const url = relayBase(cfg.relayUrl)
    if (!cfg.enabled || !cfg.anywhere || !url) return undefined
    return { url, room: createHash('sha256').update(`maris-relay-room:${this.roomKey()}`).digest('base64url') }
  }

  private applyRelay(): void {
    const info = this.relayInfo()
    if (!info || !this.server) return this.relay.stop()
    this.relay.start(roomUrl(info.url, info.room, 'pc', this.roomKey()))
  }

  // ---------------------------------------------------------------- on and off

  /** Follow the settings: start, stop, move to a new port, connect to the relay or leave it. */
  apply(): void {
    const cfg = settings.get().link
    if (!this.devices.size && existsSync(this.file())) this.load()
    if (!cfg.enabled) return this.stop()
    if (!this.server || this.port !== cfg.port) {
      this.stop()
      this.start(cfg.port)
    }
    this.applyRelay()
    this.emit()
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
    this.relayClients.clear()
    this.relay.stop()
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
    const lan = new Set([...this.clients].map((c) => c.device.id))
    const addresses = lanAddresses()
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined
    const info = this.relayInfo()
    return {
      enabled: cfg.enabled,
      running: Boolean(this.server?.listening),
      port: cfg.port,
      addresses,
      hostName: os.hostname(),
      devices: [...this.devices.values()]
        .map(({ key: _k, ...d }) => {
          const via = lan.has(d.id) ? ('lan' as const) : this.relayClients.has(d.id) ? ('relay' as const) : undefined
          return { ...d, online: Boolean(via), via }
        })
        .sort((a, b) => (b.lastSeen ?? b.createdAt) - (a.lastSeen ?? a.createdAt)),
      pairing: pairing
        ? {
            code: pairing.code,
            expiresAt: pairing.expiresAt,
            url:
              `maris://pair?h=${encodeURIComponent(addresses.slice(0, 3).join(','))}&p=${cfg.port}&c=${encodeURIComponent(pairing.code)}&n=${encodeURIComponent(os.hostname())}` +
              // A phone that is not on this network pairs through the relay.
              (info ? `&r=${encodeURIComponent(info.url)}&m=${info.room}` : '')
          }
        : undefined,
      error: this.error,
      relay: cfg.enabled && cfg.anywhere ? { state: info ? this.relay.state : 'off', url: info?.url ?? '', error: info ? this.relay.error : 'No relay address is set.' } : undefined
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
    this.relayClients.delete(id)
    this.save()
    this.emit()
    return this.status()
  }

  // ---------------------------------------------------------------- requests, from either way in

  private async route(r: Incoming): Promise<Outgoing> {
    const block = this.blocked.get(r.peer)
    if (block && block.until > Date.now()) return { status: 429, json: { error: 'Too many failed attempts. Try again in a few minutes.' } }
    const { method, path: p } = r
    if (method === 'GET' && p === '/api/hello') {
      // The computer's name only on the home network: a phone that only knows the relay room learns it when paired.
      return { status: 200, json: { app: 'maris', v: LINK_VERSION, ...(r.relayDev ? {} : { name: os.hostname() }), pairing: Boolean(this.pairing && this.pairing.expiresAt > Date.now()) } }
    }
    if (method === 'POST' && p === '/api/pair/start') return this.pairStart(r)
    if (method === 'POST' && p === '/api/pair/finish') return this.pairFinish(r)
    if (method === 'POST' && p === '/api/invoke') return this.invoke(r)
    if (method === 'GET' && p === '/api/events') return this.eventsRequest(r)
    if (method === 'POST' && p === '/api/media') return this.media(r)
    if (method === 'POST' && p === '/api/upload') return this.upload(r)
    return { status: 404, json: { error: 'Not found' } }
  }

  /** The home network: phones on the same network (or a private VPN such as Tailscale) only. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? ''
    if (!isPrivateAddress(ip)) {
      req.destroy()
      return
    }
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://maris')
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined
      const out = await this.route({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, peer: ip })
      if ('events' in out) this.openStream(out.events, res)
      else if ('bytes' in out) {
        res.writeHead(out.status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(out.bytes.length) })
        res.end(out.bytes)
      } else json(res, out.status, out.json)
    } catch (e) {
      log.warn('link', e)
      if (!res.headersSent) json(res, 400, { error: 'Bad request' })
      else res.end()
    }
  }

  /** The relay: a request frame {id, m, p, q?, b?} from a phone; the answer goes back the same way. */
  private async onRelayFrame(dev: string, text: string): Promise<void> {
    let f: { id?: unknown; m?: unknown; p?: unknown; q?: unknown; b?: unknown }
    try {
      f = JSON.parse(text) as typeof f
    } catch {
      return
    }
    if (typeof f.id !== 'string' && typeof f.id !== 'number') return
    let out: Outgoing
    try {
      out = await this.route({
        method: typeof f.m === 'string' ? f.m : 'POST',
        path: typeof f.p === 'string' ? f.p : '',
        query: new URLSearchParams(typeof f.q === 'string' ? f.q : ''),
        body: f.b,
        peer: `relay:${dev}`,
        relayDev: dev
      })
    } catch (e) {
      log.warn('link', e)
      out = { status: 400, json: { error: 'Bad request' } }
    }
    if ('events' in out) {
      this.relayClients.set(dev, { device: out.events, statusAt: 0 })
      this.relay.send(dev, JSON.stringify({ id: f.id, s: 200, j: { ok: true } }))
      this.sendRelayInfo(out.events, (frame) => this.relay.send(dev, frame))
      this.emit()
    } else if ('bytes' in out) this.relay.send(dev, JSON.stringify({ id: f.id, s: out.status, x: out.bytes.toString('base64') }))
    else this.relay.send(dev, JSON.stringify({ id: f.id, s: out.status, j: out.json }))
  }

  private fail(peer: string): void {
    const b = this.blocked.get(peer) ?? { count: 0, until: 0 }
    b.count += 1
    if (b.count >= 20) {
      b.until = Date.now() + 10 * 60000
      b.count = 0
    }
    this.blocked.set(peer, b)
  }

  /**
   * Open a sealed request from a paired device, checking freshness and that it was not seen before.
   * 401 for an unknown phone or a wrong key (the phone then forgets its pairing), 409 for a stale or
   * repeated request (a clock problem; the pairing stays).
   */
  private openFrom<T extends Envelope>(deviceId: string, box: Box, peer: string): { device: Device; body: T } | { status: number; json: unknown } {
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
      this.fail(peer)
      return { status: 401, json: { error: 'Not paired' } }
    }
    const now = Date.now()
    if (Math.abs(now - body.ts) > MAX_SKEW_MS || typeof body.n !== 'string' || this.nonces.has(body.n)) {
      return { status: 409, json: { error: "Request refused: it was sent twice, or the phone's clock differs from the computer's by more than two minutes." } }
    }
    this.nonces.set(body.n, now + MAX_SKEW_MS * 2)
    if (this.nonces.size > 5000) for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n)
    device.lastSeen = now
    return { device, body }
  }

  private sealedOf(r: Incoming): { d: string; box: Box } {
    const b = (r.body ?? {}) as { d?: unknown; iv?: unknown; ct?: unknown }
    return { d: String(b.d ?? ''), box: { iv: String(b.iv ?? ''), ct: String(b.ct ?? '') } }
  }

  private pairStart(r: Incoming): Outgoing {
    const p = this.pairing
    if (!p || p.expiresAt < Date.now()) return { status: 409, json: { error: 'Pairing is not open. On the computer, open Settings → Phone and choose "Pair a phone".' } }
    const { d, name, pub } = (r.body ?? {}) as { d?: string; name?: string; pub?: string }
    if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d) || !pub) return { status: 400, json: { error: 'Bad request' } }
    // Through the relay, a phone can only pair as the device it connected as.
    if (r.relayDev && r.relayDev !== d) return { status: 400, json: { error: 'Bad request' } }
    const phonePub = b64u.dec(pub)
    const kp = serverKeyPair()
    let shared: Buffer
    try {
      shared = kp.secret(phonePub)
    } catch {
      this.fail(r.peer)
      return { status: 400, json: { error: 'Bad key' } }
    }
    p.pending.set(d, { key: deriveKey(shared, p.code, d, phonePub, kp.pub), name: String(name ?? 'Phone').slice(0, 60), expiresAt: Date.now() + 120000 })
    return { status: 200, json: { pub: b64u.enc(kp.pub), name: os.hostname() } }
  }

  private pairFinish(r: Incoming): Outgoing {
    const p = this.pairing
    const { d, box } = this.sealedOf(r)
    const pending = p && d ? p.pending.get(d) : undefined
    if (!p || !pending || pending.expiresAt < Date.now() || p.expiresAt < Date.now()) return { status: 409, json: { error: 'Pairing expired. Start again on the computer.' } }
    let body: Envelope & { name?: string }
    try {
      body = unseal(pending.key, box)
    } catch {
      // Wrong code: a few tries, then the code is cancelled so it cannot be guessed.
      p.pending.delete(d)
      p.failures += 1
      this.fail(r.peer)
      if (p.failures >= 5) this.pairing = undefined
      this.emit()
      return { status: 403, json: { error: p.failures >= 5 ? 'Too many wrong codes. Start pairing again on the computer.' : 'The code does not match. Check it and try again.' } }
    }
    if (Math.abs(Date.now() - body.ts) > MAX_SKEW_MS) return { status: 400, json: { error: "The phone's clock is too far from the computer's. Check the time on both." } }
    const device: Device = { id: d, name: (body.name || pending.name).slice(0, 60), createdAt: Date.now(), lastSeen: Date.now(), key: pending.key }
    this.devices.set(device.id, device)
    this.pairing = undefined
    this.save()
    log.info('link', `paired ${device.name}${r.relayDev ? ' through the relay' : ''}`)
    this.emit()
    return { status: 200, json: seal(device.key, { ok: true, host: os.hostname(), platform: process.platform, version: app.getVersion(), relay: this.relayInfo() }) }
  }

  private async invoke(r: Incoming): Promise<Outgoing> {
    const { d, box } = this.sealedOf(r)
    const opened = this.openFrom<Envelope & { ch: string; a?: unknown[] }>(d, box, r.peer)
    if (!('device' in opened)) return opened
    const { device, body } = opened
    const reply = (value: unknown): Outgoing => ({ status: 200, json: seal(device.key, value) })
    const fn = handlers.get(body.ch)
    const access = phoneAccess(body.ch)
    if (!fn || access === 'desktop') return reply({ ok: false, e: 'Not available from the phone' })
    const mayApprove = settings.get().link.allowApprovals
    if (access === 'approve' && !mayApprove) return reply({ ok: false, e: 'Approving changes from the phone is turned off on the computer (Settings → Phone).' })
    const checked = phoneArgs(body.ch, Array.isArray(body.a) ? body.a : [], mayApprove)
    if ('refused' in checked) return reply({ ok: false, e: checked.refused })
    try {
      return reply({ ok: true, r: await fn(...checked.args) })
    } catch (e) {
      return reply({ ok: false, e: (e as Error)?.message ?? String(e) })
    }
  }

  private eventsRequest(r: Incoming): Outgoing {
    const opened = this.openFrom<Envelope>(r.query.get('d') ?? '', { iv: r.query.get('iv') ?? '', ct: r.query.get('ct') ?? '' }, r.peer)
    if (!('device' in opened)) return opened
    // Updates go to the device that asked, never to another one in the same relay room.
    if (r.relayDev && r.relayDev !== opened.device.id) return { status: 400, json: { error: 'Bad request' } }
    return { status: 200, events: opened.device }
  }

  /** An event stream on the home network (server-sent events). */
  private openStream(device: Device, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(': hello\n\n')
    const client = { device, res }
    this.clients.add(client)
    this.sendRelayInfo(device, (frame) => res.write(`data: ${frame}\n\n`), true)
    const ping = setInterval(() => res.write(': ping\n\n'), 20000)
    res.on('close', () => {
      clearInterval(ping)
      this.clients.delete(client)
      this.emit()
    })
    this.emit()
  }

  /**
   * The relay address and room, sealed for one phone as its first update: a phone paired at home learns where
   * to find this computer away from it (or that it no longer can).
   */
  private sendRelayInfo(device: Device, write: (frame: string) => void, sse = false): void {
    const box = seal(device.key, { ch: 'relay:info', p: this.relayInfo() ?? null })
    write(sse ? JSON.stringify(box) : JSON.stringify({ ev: box }))
  }

  private forward(channel: string, payload: unknown): void {
    // Link status (with the pairing code) is for this computer's own window only.
    if (channel.startsWith('link:')) return
    for (const c of this.clients) {
      try {
        c.res.write(`data: ${JSON.stringify(seal(c.device.key, { ch: channel, p: payload }))}\n\n`)
      } catch {
        /* closed */
      }
    }
    if (!this.relayClients.size) return
    const now = Date.now()
    for (const [dev, c] of this.relayClients) {
      if (channel === 'system:status') {
        if (now - c.statusAt < RELAY_STATUS_MS) continue
        c.statusAt = now
      }
      this.relay.send(dev, JSON.stringify({ ev: seal(c.device.key, { ch: channel, p: payload }) }))
    }
  }

  /** A generated picture or video (only from Maris's own folders), encrypted as a whole. */
  private async media(r: Incoming): Promise<Outgoing> {
    const { d, box } = this.sealedOf(r)
    const opened = this.openFrom<Envelope & { path: string }>(d, box, r.peer)
    if (!('device' in opened)) return opened
    const file = path.resolve(String(opened.body.path ?? ''))
    const roots = [media.outputsDir(), comfy.outputDir(), ...['pasted', 'uploads', 'news-cache'].map((x) => path.join(app.getPath('userData'), x))].map((x) => path.resolve(x).toLowerCase())
    const lower = file.toLowerCase()
    if (!roots.some((x) => lower.startsWith(x + path.sep)) || !existsSync(file) || statSync(file).size > MAX_MEDIA) return { status: 404, json: { error: 'Not found' } }
    return { status: 200, bytes: sealBytes(opened.device.key, await fs.readFile(file)) }
  }

  /** A picture or file sent from the phone, saved where attachments can read it. */
  private async upload(r: Incoming): Promise<Outgoing> {
    const { d, box } = this.sealedOf(r)
    const opened = this.openFrom<Envelope & { name: string; data: string }>(d, box, r.peer)
    if (!('device' in opened)) return opened
    const dir = path.join(app.getPath('userData'), 'uploads')
    await fs.mkdir(dir, { recursive: true })
    const safe = path.basename(String(opened.body.name || 'upload')).replace(/[^\w.\- ()]/g, '_').slice(-80) || 'upload'
    const file = path.join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`)
    await fs.writeFile(file, Buffer.from(String(opened.body.data ?? ''), 'base64'))
    const toAttachment = handlers.get('files:attach')
    const [att] = toAttachment ? ((await toAttachment([file])) as unknown[]) : [{ path: file }]
    return { status: 200, json: seal(opened.device.key, { ok: true, r: att }) }
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
