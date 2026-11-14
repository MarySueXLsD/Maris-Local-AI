// The phone app's connection to Maris on a computer (see src/main/link/server.ts for the other end). On the
// home network it talks to the computer directly; anywhere else it goes through the Maris relay, if the
// computer has "Connect from anywhere" on. Either way every request, answer and update is sealed with the
// key only this phone and the computer hold: the relay passes them on without being able to read them.
import { FrameJoiner, roomUrl, splitFrame, type RelayInfo } from '@shared/relay'
import { aesKey, b64u, deriveSessionKey, envelope, phoneKeyPair, randomId, seal, unseal, unsealBytes, type Box } from './crypto'

export type HostPlatform = 'win32' | 'darwin' | 'linux'

export interface Pairing {
  /** Addresses of the computer on its network, the last one that worked first. */
  hosts: string[]
  port: number
  deviceId: string
  /** Session key (base64url). Stays on this phone and on the computer. */
  key: string
  hostName: string
  platform: HostPlatform
  name: string
  /** Where the computer can be reached away from home (when it has "Connect from anywhere" on). */
  relay?: RelayInfo
}

const STORE = 'maris.link.pairing'

export function loadPairing(): Pairing | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Pairing | null
    return p && p.deviceId && p.key && (p.hosts?.length || p.relay) ? p : undefined
  } catch {
    return undefined
  }
}

export function savePairing(p: Pairing): void {
  localStorage.setItem(STORE, JSON.stringify(p))
}

export function forgetPairing(): void {
  localStorage.removeItem(STORE)
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'unpaired' | 'server'
  ) {
    super(message)
  }
}

const baseUrl = (host: string, port: number): string => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`

async function request(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Is Maris answering at this address on the network? */
export async function hello(host: string, port: number, timeoutMs = 2500): Promise<{ name?: string; v: number; pairing: boolean } | undefined> {
  try {
    const r = await request(`${baseUrl(host, port)}/api/hello`, {}, timeoutMs)
    const j = (await r.json()) as { app?: string; name?: string; v: number; pairing: boolean }
    return j.app === 'maris' ? j : undefined
  } catch {
    return undefined
  }
}

/** "192.168.1.20:7341" or "192.168.1.20" → host and port. */
export function parseAddress(text: string, defaultPort = 7341): { host: string; port: number } | undefined {
  const t = text.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const m = /^\[?([^\]]+?)\]?(?::(\d{2,5}))?$/.exec(t)
  if (!m || !m[1]) return undefined
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort }
}

// ------------------------------------------------------------------ the two ways to the computer

/** An answer from the computer, whichever way it came. */
interface Reply {
  status: number
  json?: unknown
  bytes?: ArrayBuffer
}

interface Transport {
  readonly kind: 'lan' | 'relay'
  request(method: 'GET' | 'POST', path: string, body?: unknown, query?: string, timeoutMs?: number): Promise<Reply>
  /** The update stream: `onOpen` once it is open, then every update; ends (with why) when the stream does. */
  stream(query: string, onOpen: () => void, onEvent: (box: Box) => void): Promise<{ status: number; error?: string }>
  close(): void
}

/** Directly on the home network: HTTP, with server-sent events for updates. */
class LanTransport implements Transport {
  readonly kind = 'lan' as const
  private aborts = new Set<AbortController>()

  constructor(readonly host: string, private port: number) {}

  private get base(): string {
    return baseUrl(this.host, this.port)
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown, query?: string, timeoutMs = 15000): Promise<Reply> {
    const res = await request(
      `${this.base}${path}${query ? `?${query}` : ''}`,
      method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {},
      timeoutMs
    )
    if (path === '/api/media' && res.ok) return { status: res.status, bytes: await res.arrayBuffer() }
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  async stream(query: string, onOpen: () => void, onEvent: (box: Box) => void): Promise<{ status: number; error?: string }> {
    const ctl = new AbortController()
    this.aborts.add(ctl)
    try {
      const res = await fetch(`${this.base}/api/events?${query}`, { signal: ctl.signal })
      if (!res.ok || !res.body) return { status: res.status, error: ((await res.json().catch(() => ({}))) as { error?: string }).error }
      onOpen()
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf
            .slice(0, i)
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('')
          buf = buf.slice(i + 2)
          if (!data) continue
          try {
            onEvent(JSON.parse(data) as Box)
          } catch {
            /* not for us */
          }
        }
      }
      return { status: 0 }
    } catch {
      return { status: 0 }
    } finally {
      this.aborts.delete(ctl)
    }
  }

  close(): void {
    for (const a of this.aborts) a.abort()
    this.aborts.clear()
  }
}

/** Through the Maris relay: one WebSocket that carries requests, answers and updates. */
class RelayTransport implements Transport {
  readonly kind = 'relay' as const
  private ws?: WebSocket
  private seq = 0
  private pending = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private joiner = new FrameJoiner()
  private onEvent?: (box: Box) => void
  private ended?: (r: { status: number }) => void
  private ping?: ReturnType<typeof setInterval>

  constructor(private url: string) {}

  /** Connect; resolves with whether the computer is in the room right now. */
  open(timeoutMs = 10000): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (v: boolean | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (v instanceof Error) reject(v)
        else resolve(v)
      }
      const timer = setTimeout(() => {
        this.close()
        done(new Error('The relay did not answer'))
      }, timeoutMs)
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        clearInterval(this.ping)
        this.ping = setInterval(() => {
          try {
            ws.send('ping')
          } catch {
            /* closing */
          }
        }, 25000)
      }
      ws.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return
        const text = e.data
        if (text.startsWith('{"relay"')) {
          let what = ''
          try {
            what = (JSON.parse(text) as { relay: string }).relay
          } catch {
            return
          }
          if (what === 'pc-online') done(true)
          if (what === 'pc-offline') {
            done(false)
            this.endAll('The computer is not connected to the relay right now.')
          }
          return
        }
        const whole = this.joiner.take('pc', text)
        if (whole === undefined) return
        let f: { id?: string; s?: number; j?: unknown; x?: string; ev?: Box }
        try {
          f = JSON.parse(whole) as typeof f
        } catch {
          return
        }
        if (f.ev) {
          this.onEvent?.(f.ev)
          return
        }
        const p = f.id !== undefined ? this.pending.get(String(f.id)) : undefined
        if (!p) return
        this.pending.delete(String(f.id))
        clearTimeout(p.timer)
        p.resolve({ status: Number(f.s) || 0, json: f.j, bytes: typeof f.x === 'string' ? b64ToBytes(f.x) : undefined })
      }
      ws.onclose = () => {
        clearInterval(this.ping)
        if (this.ws === ws) this.ws = undefined
        done(new Error('Could not reach the relay'))
        this.endAll('Lost the connection to the relay.')
      }
      ws.onerror = () => undefined
    })
  }

  private endAll(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(why))
      this.pending.delete(id)
    }
    this.onEvent = undefined
    const end = this.ended
    this.ended = undefined
    end?.({ status: 0 })
  }

  request(method: 'GET' | 'POST', path: string, body?: unknown, query?: string, timeoutMs = 15000): Promise<Reply> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the relay'))
    const id = String(++this.seq)
    const frame = JSON.stringify({ id, m: method, p: path, ...(query ? { q: query } : {}), ...(body !== undefined ? { b: body } : {}) })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The computer did not answer in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      for (const part of splitFrame(frame)) ws.send(part)
    })
  }

  async stream(query: string, onOpen: () => void, onEvent: (box: Box) => void): Promise<{ status: number; error?: string }> {
    this.onEvent = onEvent
    let r: Reply
    try {
      r = await this.request('GET', '/api/events', undefined, query)
    } catch {
      this.onEvent = undefined
      return { status: 0 }
    }
    if (r.status !== 200) {
      this.onEvent = undefined
      return { status: r.status, error: (r.json as { error?: string } | undefined)?.error }
    }
    onOpen()
    return new Promise((resolve) => {
      if (!this.ws) resolve({ status: 0 })
      else this.ended = resolve
    })
  }

  close(): void {
    const ws = this.ws
    this.ws = undefined
    clearInterval(this.ping)
    try {
      ws?.close(1000, 'bye')
    } catch {
      /* closed */
    }
    this.endAll('Closed')
  }
}

function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** The computer on the home network, at the first of these addresses that answers. */
async function findOnNetwork(hosts: string[], port: number, timeoutMs = 2000): Promise<{ host: string; pairing: boolean } | undefined> {
  for (const h of hosts) {
    const hi = await hello(h, port, timeoutMs)
    if (hi) return { host: h, pairing: hi.pairing }
  }
  return undefined
}

// ------------------------------------------------------------------ pairing

/** Pair with a computer that is showing a pairing code: on its network, or through the relay when not there. */
export async function pair(opts: { hosts: string[]; port: number; code: string; name: string; relay?: RelayInfo }): Promise<Pairing> {
  const deviceId = randomId(18)
  let transport: Transport | undefined
  const near = await findOnNetwork(opts.hosts, opts.port, 2500)
  if (near) {
    if (!near.pairing) throw new LinkError('The computer is not waiting for a phone. On the computer, open Settings → Phone and choose “Pair a phone”.', 'server')
    transport = new LanTransport(near.host, opts.port)
  } else if (opts.relay) {
    const t = new RelayTransport(roomUrl(opts.relay.url, opts.relay.room, 'phone', deviceId))
    const pcHere = await t.open().catch(() => undefined)
    if (pcHere !== true) {
      t.close()
      throw new LinkError(
        pcHere === false
          ? 'The computer is not connected to the relay. Check that Maris is open there and “Connect from anywhere” is on.'
          : 'Could not reach the computer: it is not on this network, and the relay did not answer. Check the internet connection.',
        'unreachable'
      )
    }
    const hi = await t.request('GET', '/api/hello').catch(() => undefined)
    if (!(hi?.json as { pairing?: boolean } | undefined)?.pairing) {
      t.close()
      throw new LinkError('The computer is not waiting for a phone. On the computer, open Settings → Phone and choose “Pair a phone”.', 'server')
    }
    transport = t
  }
  if (!transport) {
    throw new LinkError(
      `Can't reach ${opts.hosts.join(' or ')}:${opts.port}. Check that the phone is on the same Wi-Fi as the computer, Maris is open there, and “Allow the phone app to connect” is on (or turn on “Connect from anywhere” there and scan the code again).`,
      'unreachable'
    )
  }
  try {
    const kp = await phoneKeyPair()
    const start = await transport.request('POST', '/api/pair/start', { d: deviceId, name: opts.name, pub: b64u.enc(kp.pub) })
    const startJson = (start.json ?? {}) as { pub?: string; error?: string }
    if (start.status !== 200 || !startJson.pub) throw new LinkError(startJson.error ?? `Pairing failed (${start.status})`, 'server')
    const raw = await deriveSessionKey(kp.privateKey, b64u.dec(startJson.pub), opts.code, deviceId, kp.pub)
    const key = await aesKey(raw)
    const fin = await transport.request('POST', '/api/pair/finish', { d: deviceId, ...(await seal(key, { ...envelope(), name: opts.name })) })
    const finJson = (fin.json ?? {}) as Box & { error?: string }
    if (fin.status !== 200) throw new LinkError(finJson.error ?? `Pairing failed (${fin.status})`, 'server')
    const info = await unseal<{ ok: boolean; host: string; platform: HostPlatform; relay?: RelayInfo }>(key, finJson)
    return {
      hosts: near ? [near.host, ...opts.hosts.filter((h) => h !== near.host)] : opts.hosts,
      port: opts.port,
      deviceId,
      key: b64u.enc(raw),
      hostName: info.host,
      platform: info.platform,
      name: opts.name,
      relay: info.relay ?? opts.relay
    }
  } finally {
    transport.close()
  }
}

// ------------------------------------------------------------------ a paired connection

export type LinkState = 'connecting' | 'online' | 'offline'

/** A paired connection: calls, the update stream, media and uploads, all encrypted. */
export class LinkClient {
  state: LinkState = 'connecting'
  private key?: CryptoKey
  private transport?: Transport
  private reaching?: Promise<Transport>
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  private stateListeners = new Set<(s: LinkState) => void>()
  private stopped = false
  private droppedAt = 0

  constructor(public pairing: Pairing) {}

  /** How the phone is connected right now. */
  get via(): 'lan' | 'relay' | undefined {
    return this.transport?.kind
  }

  /** Find the computer: on the home network first (it may have a new address there), else through the relay. */
  private reach(): Promise<Transport> {
    if (this.transport) return Promise.resolve(this.transport)
    this.reaching ??= (async () => {
      try {
        const near = await findOnNetwork(this.pairing.hosts, this.pairing.port)
        if (near) {
          if (this.pairing.hosts[0] !== near.host) this.update({ hosts: [near.host, ...this.pairing.hosts.filter((h) => h !== near.host)] })
          return (this.transport = new LanTransport(near.host, this.pairing.port))
        }
        const relay = this.pairing.relay
        if (relay) {
          const t = new RelayTransport(roomUrl(relay.url, relay.room, 'phone', this.pairing.deviceId))
          const pcHere = await t.open().catch(() => undefined)
          if (pcHere === true) return (this.transport = t)
          t.close()
          if (pcHere === false) throw new LinkError(`${this.pairing.hostName} is not connected to the relay. Check that Maris is open there and “Connect from anywhere” is on.`, 'unreachable')
        }
        throw new LinkError(`Can't reach ${this.pairing.hostName}.`, 'unreachable')
      } finally {
        this.reaching = undefined
      }
    })()
    return this.reaching
  }

  private update(patch: Partial<Pairing>): void {
    this.pairing = { ...this.pairing, ...patch }
    savePairing(this.pairing)
  }

  /** Find the computer and check that it still knows this phone. */
  async connect(): Promise<void> {
    this.key = await aesKey(b64u.dec(this.pairing.key))
    await this.reach()
    await this.call('app:info', [])
  }

  onState(cb: (s: LinkState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  private setState(s: LinkState): void {
    if (this.state === s) return
    this.state = s
    for (const cb of this.stateListeners) cb(s)
  }

  async call(channel: string, args: unknown[]): Promise<unknown> {
    if (!this.key) throw new LinkError('Not connected', 'unreachable')
    let r: Reply
    try {
      const t = await this.reach()
      r = await t.request('POST', '/api/invoke', { d: this.pairing.deviceId, ...(await seal(this.key, { ...envelope(), ch: channel, a: args })) }, undefined, 120000)
    } catch (e) {
      if (e instanceof LinkError && e.kind !== 'unreachable') throw e
      throw new LinkError(`Lost the connection to ${this.pairing.hostName}.`, 'unreachable')
    }
    if (r.status === 401) throw new LinkError('This phone is no longer paired with the computer.', 'unpaired')
    const j = (r.json ?? {}) as Box & { error?: string }
    if (r.status !== 200) throw new LinkError(j.error ?? `Request failed (${r.status})`, 'server')
    const out = await unseal<{ ok: boolean; r?: unknown; e?: string }>(this.key, j)
    if (!out.ok) throw new Error(out.e ?? 'Failed')
    return out.r
  }

  on(channel: string, cb: (payload: unknown) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) this.listeners.set(channel, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }

  private async dispatch(box: Box): Promise<void> {
    let msg: { ch: string; p: unknown }
    try {
      msg = await unseal<{ ch: string; p: unknown }>(this.key!, box)
    } catch {
      return
    }
    // Where the computer can be found away from home (sent first on every connection).
    if (msg.ch === 'relay:info') {
      const relay = (msg.p as RelayInfo | null) ?? undefined
      if (JSON.stringify(relay) !== JSON.stringify(this.pairing.relay)) this.update({ relay })
    }
    for (const cb of this.listeners.get(msg.ch) ?? []) cb(msg.p)
  }

  /** Keep the update stream open, reconnecting with a growing pause when the network drops. */
  startEvents(onResync: () => void): void {
    let delay = 1000
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        let homeCheck: ReturnType<typeof setInterval> | undefined
        try {
          const t = await this.reach()
          const box = await seal(this.key!, envelope())
          const q = new URLSearchParams({ d: this.pairing.deviceId, iv: box.iv, ct: box.ct }).toString()
          // Through the relay: look for the home network now and then, which is quicker and keeps traffic at home.
          if (t.kind === 'relay' && this.pairing.hosts.length) {
            homeCheck = setInterval(() => {
              void findOnNetwork(this.pairing.hosts, this.pairing.port, 1500).then((near) => {
                if (near && this.transport === t) t.close()
              })
            }, 60000)
          }
          const end = await t.stream(
            q,
            () => {
              // Updates missed while the connection was down: reload the state once it is back.
              if (this.droppedAt && Date.now() - this.droppedAt > 3000) onResync()
              this.droppedAt = 0
              this.setState('online')
              delay = 1000
            },
            (b) => void this.dispatch(b)
          )
          if (end.status === 401) {
            this.setState('offline')
            window.dispatchEvent(new CustomEvent('maris-link-unpaired'))
            return
          }
          if (end.status === 409) window.dispatchEvent(new CustomEvent('maris-link-clock', { detail: end.error }))
        } catch {
          /* not reachable right now; retry below */
        } finally {
          clearInterval(homeCheck)
        }
        // The stream ended: the next round looks for the computer again, at home first.
        this.transport?.close()
        this.transport = undefined
        if (this.stopped) return
        if (!this.droppedAt) this.droppedAt = Date.now()
        this.setState('connecting')
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(10000, delay * 1.6)
        if (delay >= 10000) this.setState('offline')
      }
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    this.transport?.close()
  }

  /** A picture or video from the computer, decrypted on the phone. */
  async media(path: string): Promise<Blob> {
    const t = await this.reach()
    const r = await t.request('POST', '/api/media', { d: this.pairing.deviceId, ...(await seal(this.key!, { ...envelope(), path })) }, undefined, 300000)
    if (r.status !== 200 || !r.bytes) throw new Error(`Could not load ${path.split(/[\\/]/).pop()}`)
    const plain = await unsealBytes(this.key!, r.bytes)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext]
    return new Blob([plain], { type: type ?? 'application/octet-stream' })
  }

  /** Send a file from the phone; the computer keeps it with Maris's attachments. */
  async upload(name: string, base64: string): Promise<unknown> {
    const t = await this.reach()
    const r = await t.request('POST', '/api/upload', { d: this.pairing.deviceId, ...(await seal(this.key!, { ...envelope(), name, data: base64 })) }, undefined, 300000)
    if (r.status !== 200) throw new Error(`Upload failed (${r.status})`)
    const out = await unseal<{ ok: boolean; r: unknown }>(this.key!, r.json as Box)
    return out.r
  }
}
