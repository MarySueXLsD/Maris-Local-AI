// The phone app's connection to Maris on a computer (see src/main/link/server.ts for the other end).
import { aesKey, b64u, deriveSessionKey, envelope, phoneKeyPair, randomId, seal, unseal, unsealBytes, type Box } from './crypto'

export type HostPlatform = 'win32' | 'darwin' | 'linux'

export interface Pairing {
  /** Addresses of the computer, the last one that worked first. */
  hosts: string[]
  port: number
  deviceId: string
  /** Session key (base64url). Stays on this phone and on the computer. */
  key: string
  hostName: string
  platform: HostPlatform
  name: string
}

const STORE = 'maris.link.pairing'

export function loadPairing(): Pairing | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Pairing | null
    return p && p.deviceId && p.key && p.hosts?.length ? p : undefined
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

const postJson = (url: string, body: unknown, timeoutMs?: number): Promise<Response> =>
  request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)

/** Is Maris answering at this address? */
export async function hello(host: string, port: number, timeoutMs = 2500): Promise<{ name: string; v: number; pairing: boolean } | undefined> {
  try {
    const r = await request(`${baseUrl(host, port)}/api/hello`, {}, timeoutMs)
    const j = (await r.json()) as { app?: string; name: string; v: number; pairing: boolean }
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

/** Pair with a computer that is showing a pairing code. */
export async function pair(opts: { hosts: string[]; port: number; code: string; name: string }): Promise<Pairing> {
  let host: string | undefined
  for (const h of opts.hosts) {
    const hi = await hello(h, opts.port)
    if (hi) {
      host = h
      if (!hi.pairing) throw new LinkError('The computer is not waiting for a phone. On the computer, open Settings → Phone and choose “Pair a phone”.', 'server')
      break
    }
  }
  if (!host) {
    throw new LinkError(
      `Can't reach ${opts.hosts.join(' or ')}:${opts.port}. Check that the phone is on the same Wi-Fi as the computer, Maris is open there, and “Allow the phone app to connect” is on.`,
      'unreachable'
    )
  }
  const base = baseUrl(host, opts.port)
  const deviceId = randomId(18)
  const kp = await phoneKeyPair()
  const start = await postJson(`${base}/api/pair/start`, { d: deviceId, name: opts.name, pub: b64u.enc(kp.pub) })
  const startJson = (await start.json()) as { pub?: string; error?: string }
  if (!start.ok || !startJson.pub) throw new LinkError(startJson.error ?? `Pairing failed (${start.status})`, 'server')
  const raw = await deriveSessionKey(kp.privateKey, b64u.dec(startJson.pub), opts.code, deviceId, kp.pub)
  const key = await aesKey(raw)
  const fin = await postJson(`${base}/api/pair/finish`, { d: deviceId, ...(await seal(key, { ...envelope(), name: opts.name })) })
  const finJson = (await fin.json()) as Box & { error?: string }
  if (!fin.ok) throw new LinkError(finJson.error ?? `Pairing failed (${fin.status})`, 'server')
  const info = await unseal<{ ok: boolean; host: string; platform: HostPlatform }>(key, finJson)
  return {
    hosts: [host, ...opts.hosts.filter((h) => h !== host)],
    port: opts.port,
    deviceId,
    key: b64u.enc(raw),
    hostName: info.host,
    platform: info.platform,
    name: opts.name
  }
}

export type LinkState = 'connecting' | 'online' | 'offline'

/** A paired connection: calls, the event stream, media and uploads, all encrypted. */
export class LinkClient {
  state: LinkState = 'connecting'
  private key?: CryptoKey
  private host: string
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  private stateListeners = new Set<(s: LinkState) => void>()
  private stopped = false
  private droppedAt = 0

  constructor(readonly pairing: Pairing) {
    this.host = pairing.hosts[0]!
  }

  private get base(): string {
    return baseUrl(this.host, this.pairing.port)
  }

  /** Find the computer (it may have a new address) and check that it still knows this phone. */
  async connect(): Promise<void> {
    this.key = await aesKey(b64u.dec(this.pairing.key))
    let found: string | undefined
    for (const h of this.pairing.hosts) {
      if (await hello(h, this.pairing.port)) {
        found = h
        break
      }
    }
    if (!found) throw new LinkError(`Can't reach ${this.pairing.hostName}.`, 'unreachable')
    this.host = found
    if (this.pairing.hosts[0] !== found) savePairing({ ...this.pairing, hosts: [found, ...this.pairing.hosts.filter((h) => h !== found)] })
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
    let res: Response
    try {
      res = await postJson(`${this.base}/api/invoke`, { d: this.pairing.deviceId, ...(await seal(this.key, { ...envelope(), ch: channel, a: args })) }, 120000)
    } catch {
      throw new LinkError(`Lost the connection to ${this.pairing.hostName}.`, 'unreachable')
    }
    if (res.status === 401) throw new LinkError('This phone is no longer paired with the computer.', 'unpaired')
    const j = (await res.json()) as Box & { error?: string }
    if (!res.ok) throw new LinkError(j.error ?? `Request failed (${res.status})`, 'server')
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

  /** Keep the event stream open, reconnecting with a growing pause when the network drops. */
  startEvents(onResync: () => void): void {
    let delay = 1000
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        try {
          const box = await seal(this.key!, envelope())
          const q = new URLSearchParams({ d: this.pairing.deviceId, iv: box.iv, ct: box.ct })
          const res = await fetch(`${this.base}/api/events?${q.toString()}`)
          if (res.status === 401) {
            this.setState('offline')
            window.dispatchEvent(new CustomEvent('maris-link-unpaired'))
            return
          }
          if (res.status === 409) {
            window.dispatchEvent(new CustomEvent('maris-link-clock', { detail: ((await res.json().catch(() => ({}))) as { error?: string }).error }))
            throw new Error('stale request')
          }
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
          // Events missed while the connection was down: reload the state once it is back.
          if (this.droppedAt && Date.now() - this.droppedAt > 3000) onResync()
          this.droppedAt = 0
          this.setState('online')
          delay = 1000
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i)
              buf = buf.slice(i + 2)
              const data = chunk
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('')
              if (!data) continue
              try {
                const msg = await unseal<{ ch: string; p: unknown }>(this.key!, JSON.parse(data) as Box)
                for (const cb of this.listeners.get(msg.ch) ?? []) cb(msg.p)
              } catch {
                /* not for us */
              }
            }
          }
        } catch {
          /* dropped; retry below */
        }
        if (this.stopped) return
        if (!this.droppedAt) this.droppedAt = Date.now()
        this.setState('connecting')
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(10000, delay * 1.6)
        // The computer may have a new address after a network change.
        if (delay > 4000) {
          for (const h of this.pairing.hosts) {
            if (await hello(h, this.pairing.port, 1500)) {
              this.host = h
              break
            }
          }
        }
        if (delay >= 10000) this.setState('offline')
      }
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
  }

  /** A picture or video from the computer, decrypted on the phone. */
  async media(path: string): Promise<Blob> {
    const res = await postJson(`${this.base}/api/media`, { d: this.pairing.deviceId, ...(await seal(this.key!, { ...envelope(), path })) }, 120000)
    if (!res.ok) throw new Error(`Could not load ${path.split(/[\\/]/).pop()}`)
    const plain = await unsealBytes(this.key!, await res.arrayBuffer())
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext]
    return new Blob([plain], { type: type ?? 'application/octet-stream' })
  }

  /** Send a file from the phone; the computer keeps it with Maris's attachments. */
  async upload(name: string, base64: string): Promise<unknown> {
    const res = await postJson(`${this.base}/api/upload`, { d: this.pairing.deviceId, ...(await seal(this.key!, { ...envelope(), name, data: base64 })) }, 300000)
    if (!res.ok) throw new Error(`Upload failed (${res.status})`)
    const out = await unseal<{ ok: boolean; r: unknown }>(this.key!, (await res.json()) as Box)
    return out.r
  }
}
