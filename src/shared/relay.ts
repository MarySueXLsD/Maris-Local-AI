// The Maris relay: how the computer and the phone app reach each other when they are not on the same
// network (relay/ holds the relay itself, with what it sees). Everything is sealed end to end before it
// gets here; the relay only passes text on. Shared by the computer (src/main/link) and the phone app.

/**
 * The relay every copy of Maris uses unless Settings → Phone names another one. Empty until the relay is
 * deployed (relay/README.md); "Connect from anywhere" then needs a relay address in Settings.
 */
export const DEFAULT_RELAY_URL = ''

/** The relay address in use (wss://…, no trailing slash): the setting, else the built-in one; '' when there is none. */
export function relayBase(setting?: string): string {
  const raw = (setting?.trim() || DEFAULT_RELAY_URL).replace(/\/+$/, '')
  if (!raw) return ''
  const ws = raw.replace(/^http(s?):\/\//i, 'ws$1://')
  return /^wss?:\/\/[^\s/]+/i.test(ws) ? ws : ''
}

/** A room's WebSocket address: the computer gives its room key, a phone its device id. */
export function roomUrl(base: string, room: string, role: 'pc' | 'phone', id: string): string {
  return `${base}/v1/room/${room}?as=${role}&${role === 'pc' ? 'key' : 'dev'}=${encodeURIComponent(id)}`
}

/** What a paired phone needs to reach its computer through the relay. */
export interface RelayInfo {
  url: string
  room: string
}

/** Frames longer than this travel in parts (the relay takes messages up to 1 MiB). */
export const PART_SIZE = 600_000

/** A frame as the messages that carry it: itself, or parts that say which frame they belong to. */
export function splitFrame(text: string, size = PART_SIZE): string[] {
  if (text.length <= size) return [text]
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const n = Math.ceil(text.length / size)
  return Array.from({ length: n }, (_, i) => JSON.stringify({ part: id, i, n, x: text.slice(i * size, (i + 1) * size) }))
}

/** Puts frames sent in parts back together (per sender). Gives a whole frame back once its last part came. */
export class FrameJoiner {
  private open = new Map<string, { n: number; got: number; xs: string[]; at: number }>()

  take(sender: string, text: string): string | undefined {
    if (!text.startsWith('{"part":')) return text
    let p: { part: string; i: number; n: number; x: string }
    try {
      p = JSON.parse(text) as typeof p
    } catch {
      return undefined
    }
    if (typeof p.x !== 'string' || !(p.n > 0) || !(p.i >= 0 && p.i < p.n) || p.n > 2000) return undefined
    const key = `${sender}|${p.part}`
    let f = this.open.get(key)
    if (!f) {
      // Parts of frames that never finished are dropped after a few minutes.
      const now = Date.now()
      for (const [k, v] of this.open) if (now - v.at > 300_000) this.open.delete(k)
      this.open.set(key, (f = { n: p.n, got: 0, xs: new Array<string>(p.n), at: now }))
    }
    if (f.xs[p.i] === undefined) {
      f.xs[p.i] = p.x
      f.got++
    }
    if (f.got < f.n) return undefined
    this.open.delete(key)
    return f.xs.join('')
  }
}
