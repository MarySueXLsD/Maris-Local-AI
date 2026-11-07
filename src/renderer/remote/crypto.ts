// The phone's half of Maris Link encryption, with WebCrypto. Mirrors src/main/link/protocol.ts.
// No imports, so the unit tests can run it against the computer's half.

export const LINK_VERSION = 1

const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('This device has no WebCrypto, which Maris needs for an encrypted connection.')
  return s
}

export const b64u = {
  enc(bytes: Uint8Array | ArrayBuffer): string {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s: string): Uint8Array<ArrayBuffer> {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
}

/** Same canonical form as the computer: upper case, no separators, look-alike letters mapped. */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

export function randomId(bytes = 16): string {
  return b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
}

/** A fresh ECDH P-256 key pair and its public key in raw (uncompressed) form. */
export async function phoneKeyPair(): Promise<{ privateKey: CryptoKey; pub: Uint8Array<ArrayBuffer> }> {
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey))
  return { privateKey: kp.privateKey, pub }
}

/** The session key: HKDF-SHA256 over the ECDH secret, salted with the pairing code. */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  serverPub: Uint8Array<ArrayBuffer>,
  code: string,
  deviceId: string,
  phonePub: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const peer = await subtle().importKey('raw', serverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)
  const salt = await subtle().digest('SHA-256', enc.encode(`maris-link-code:${normalizeCode(code)}`))
  const info = enc.encode(`maris-link-v${LINK_VERSION}|${deviceId}|${b64u.enc(phonePub)}|${b64u.enc(serverPub)}`)
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, 256))
}

export function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface Box {
  iv: string
  ct: string
}

export async function seal(key: CryptoKey, value: unknown): Promise<Box> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)))
  return { iv: b64u.enc(iv), ct: b64u.enc(ct) }
}

export async function unseal<T>(key: CryptoKey, box: Box): Promise<T> {
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: b64u.dec(box.iv) }, key, b64u.dec(box.ct))
  return JSON.parse(dec.decode(plain)) as T
}

/** Media files: 12-byte iv, then ciphertext and tag. */
export async function unsealBytes(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data)
  return subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))
}

/** Timestamp and nonce that make every request unique (the computer refuses replays). */
export const envelope = (): { ts: number; n: string } => ({ ts: Date.now(), n: randomId(12) })
