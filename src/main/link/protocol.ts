// Maris Link: the phone app talks to this computer over the home network.
//
// Pairing: the computer shows a one-time code (60 bits, 10 minutes). The phone and the computer swap
// ECDH P-256 public keys and both derive the session key with HKDF from the shared secret, salted with
// the code. Someone listening on the Wi-Fi cannot compute the key (no ECDH secret); someone in the
// middle cannot either without the code, and the computer cancels the code after a few wrong tries.
// Afterwards every request, response and event is sealed with AES-256-GCM and carries a timestamp and
// a nonce, so it can be neither read, changed nor replayed. The phone's WebCrypto does the same steps.
//
// Only node:crypto here, so the unit tests can run it.
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto'

export const LINK_VERSION = 1

/** Crockford base32: no I, L, O or U, so codes are easy to read aloud and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const b64u = {
  enc: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  dec: (s: string): Buffer => Buffer.from(s, 'base64url')
}

/** A new pairing code, 12 characters shown as XXXX-XXXX-XXXX. */
export function newPairingCode(): string {
  const bytes = randomBytes(12)
  let s = ''
  for (const b of bytes) s += ALPHABET[b & 31]
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
}

/** What the person typed, in canonical form: upper case, no separators, look-alike letters mapped. */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/** The computer's half of the key exchange. */
export function serverKeyPair(): { pub: Buffer; secret: (peerPub: Buffer) => Buffer } {
  const ecdh = createECDH('prime256v1')
  const pub = ecdh.generateKeys()
  return { pub, secret: (peer) => ecdh.computeSecret(peer) }
}

/** The session key both sides derive (the phone with WebCrypto HKDF, same inputs). */
export function deriveKey(shared: Buffer, code: string, deviceId: string, phonePub: Buffer, serverPub: Buffer): Buffer {
  const salt = createHash('sha256').update(`maris-link-code:${normalizeCode(code)}`).digest()
  const info = Buffer.from(`maris-link-v${LINK_VERSION}|${deviceId}|${b64u.enc(phonePub)}|${b64u.enc(serverPub)}`)
  return Buffer.from(hkdfSync('sha256', shared, salt, info, 32))
}

export interface Box {
  iv: string
  ct: string
}

/** Encrypt a JSON value. The tag is appended to the ciphertext, as WebCrypto does. */
export function seal(key: Buffer, value: unknown): Box {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()])
  return { iv: b64u.enc(iv), ct: b64u.enc(ct) }
}

/** Decrypt and check a sealed JSON value; throws if it was not made with this key or was altered. */
export function unseal<T>(key: Buffer, box: Box): T {
  const iv = b64u.dec(box.iv)
  const data = b64u.dec(box.ct)
  if (iv.length !== 12 || data.length < 17) throw new Error('bad box')
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(data.subarray(data.length - 16))
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()])
  return JSON.parse(plain.toString('utf8')) as T
}

/** Encrypt raw bytes (media files): iv (12 bytes) followed by ciphertext and tag. */
export function sealBytes(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()])
}

/** Requests must be fresh: within two minutes of this computer's clock. */
export const MAX_SKEW_MS = 120_000

/** Addresses allowed to connect: this computer, private networks, link-local and Tailscale/CGNAT. */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/i, '')
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])]
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127)
  }
  const v6 = a.toLowerCase()
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)
}
