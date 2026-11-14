// Maris relay: passes frames between a computer running Maris and the phones paired with it, for when they
// are not on the same network. It cannot read them: every frame is sealed end to end with keys that only
// the computer and the phone hold (src/main/link/protocol.ts). The relay only sees a room id, device ids,
// and when and how much is sent.
//
// Who is who in a room: the computer proves it holds the room key (the room id is a hash of it, so the
// phones, which only know the id, cannot take the computer's place); a phone gives its device id.
// Frames: computer → relay "<device id or *>\n<frame>", relay → computer "<device id>\n<frame>", phone ↔
// relay just "<frame>". The relay's own messages are JSON objects with a "relay" field.
//
// No imports and no platform APIs: the Cloudflare Worker (index.mjs) and the test relay
// (tests/e2e/fixtures/mock-relay.mjs) both use this file.

/** A room id: the URL-safe SHA-256 of "maris-relay-room:" + the room key. */
export const ROOM_RX = /^[A-Za-z0-9_-]{43}$/
/** A room key: 32 random bytes, URL-safe base64. */
export const KEY_RX = /^[A-Za-z0-9_-]{43}$/
export const DEV_RX = /^[A-Za-z0-9_-]{16,64}$/
/** Cloudflare takes WebSocket messages up to 1 MiB; Maris sends longer frames in parts (src/shared/relay.ts). */
export const MAX_FRAME = 1_000_000
export const MAX_PHONES = 16

const control = (what, extra = {}) => JSON.stringify({ relay: what, ...extra })
const deviceOf = (tags) => tags.find((t) => t.startsWith('dev:'))?.slice(4)

/**
 * The tags of a socket that wants to join, or why it may not.
 * @param {string | null} role "pc" or "phone"
 * @param {string | null} dev the phone's device id
 * @param {number} phonesNow phones in the room already
 * @param {boolean} keyOk the computer's room key matches the room id
 * @returns {{ tags: string[] } | { error: string, status: number }}
 */
export function tagsFor(role, dev, phonesNow, keyOk) {
  if (role === 'pc') return keyOk ? { tags: ['pc'] } : { error: 'Wrong room key', status: 403 }
  if (role !== 'phone' || !dev || !DEV_RX.test(dev)) return { error: 'Bad request', status: 400 }
  if (phonesNow >= MAX_PHONES) return { error: 'Too many phones in this room', status: 429 }
  return { tags: ['phone', `dev:${dev}`] }
}

/**
 * A socket was accepted with its tags: retire older sockets of the same computer or phone, and tell each
 * side who is there.
 * @template S
 * @param {{ withTag(tag: string): S[], tagsOf(s: S): string[], send(s: S, text: string): void, close(s: S, code: number, reason: string): void }} room
 * @param {S} s
 */
export function joined(room, s) {
  const tags = room.tagsOf(s)
  if (tags.includes('pc')) {
    for (const old of room.withTag('pc')) if (old !== s) room.close(old, 4000, 'Another copy of Maris took over this room')
    for (const p of room.withTag('phone')) {
      room.send(p, control('pc-online'))
      const dev = deviceOf(room.tagsOf(p))
      if (dev) room.send(s, control('phone-joined', { dev }))
    }
    return
  }
  const dev = deviceOf(tags)
  for (const old of room.withTag(`dev:${dev}`)) if (old !== s) room.close(old, 4000, 'This phone connected again')
  const pcs = room.withTag('pc')
  room.send(s, control(pcs.length ? 'pc-online' : 'pc-offline'))
  for (const pc of pcs) room.send(pc, control('phone-joined', { dev }))
}

/**
 * A text frame from a socket: the computer's go to one phone (or all of them), a phone's go to the computer.
 * @template S
 * @param {{ withTag(tag: string): S[], tagsOf(s: S): string[], send(s: S, text: string): void }} room
 * @param {S} s
 * @param {string} text
 */
export function relayed(room, s, text) {
  if (text === 'ping' || text.length > MAX_FRAME) return
  const tags = room.tagsOf(s)
  if (tags.includes('pc')) {
    const nl = text.indexOf('\n')
    if (nl < 1) return
    const to = text.slice(0, nl)
    const frame = text.slice(nl + 1)
    const targets = to === '*' ? room.withTag('phone') : DEV_RX.test(to) ? room.withTag(`dev:${to}`) : []
    for (const t of targets) room.send(t, frame)
    return
  }
  const dev = deviceOf(tags)
  if (!dev) return
  for (const pc of room.withTag('pc')) room.send(pc, `${dev}\n${text}`)
}

/**
 * A socket went away: tell the other side (unless a newer socket of the same computer or phone is there).
 * @template S
 * @param {{ withTag(tag: string): S[], tagsOf(s: S): string[], send(s: S, text: string): void }} room
 * @param {S} s
 */
export function left(room, s) {
  const tags = room.tagsOf(s)
  if (tags.includes('pc')) {
    if (room.withTag('pc').some((o) => o !== s)) return
    for (const p of room.withTag('phone')) room.send(p, control('pc-offline'))
    return
  }
  const dev = deviceOf(tags)
  if (!dev || room.withTag(`dev:${dev}`).some((o) => o !== s)) return
  for (const pc of room.withTag('pc')) room.send(pc, control('phone-left', { dev }))
}
