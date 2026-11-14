// Checking the signature of a release's checksum list (see src/shared/releaseKeys.ts). Only node:crypto,
// so tests can load it directly.
import { createPublicKey, verify } from 'node:crypto'

/** Whether `sig` (base64) is a valid Ed25519 signature of `text` by one of `keys` (base64 SPKI DER). */
export function verifySums(text: string, sig: string, keys: readonly string[]): boolean {
  const signature = Buffer.from(sig.trim(), 'base64')
  if (signature.length !== 64) return false
  const data = Buffer.from(text, 'utf8')
  return keys.some((k) => {
    try {
      return verify(null, data, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), signature)
    } catch {
      return false
    }
  })
}
