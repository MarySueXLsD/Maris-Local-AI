// Makes a release signing key (once). Installed copies of Maris that know its public key install an update
// only when the release is signed with it, so a release published with stolen GitHub access is refused.
//
// What it does:
//   1. Makes an Ed25519 key pair.
//   2. Saves the private key to a file of yours (default: ~/maris-release-key.pem). KEEP A COPY somewhere
//      safe: Maris versions that know this key cannot be updated by a release signed with any other.
//   3. Adds the public key to src/shared/releaseKeys.ts (commit it with the next release).
// Then put the private key in the repository's secrets, so the Build workflow signs releases:
//   gh secret set MARIS_RELEASE_KEY --repo MarySueXLsD/Maris-Local-AI < ~/maris-release-key.pem
// The Build workflow refuses to publish a release while a key is built in and the secret is missing.
//
// Usage: node scripts/release-key.mjs [--out <file>]
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--out')
const out = path.resolve(at > 0 ? process.argv[at + 1] : path.join(os.homedir(), 'maris-release-key.pem'))
if (existsSync(out)) {
  console.error(`${out} already exists. Move it away first (or pass --out <another file>): this script never overwrites a key.`)
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

const keysFile = path.join(root, 'src', 'shared', 'releaseKeys.ts')
const src = readFileSync(keysFile, 'utf8')
const next = src.replace(/export const RELEASE_KEYS: readonly string\[\] = \[([^\]]*)\]/, (_m, list) => {
  const items = list.split(',').map((s) => s.trim()).filter(Boolean)
  return `export const RELEASE_KEYS: readonly string[] = [${[...items, `'${pub}'`].join(', ')}]`
})
if (next === src) {
  console.error(`Could not find RELEASE_KEYS in ${keysFile}.`)
  process.exit(1)
}
writeFileSync(keysFile, next)

console.log(`Private key: ${out}  (keep a copy somewhere safe; never commit it)`)
console.log(`Public key added to src/shared/releaseKeys.ts: ${pub}`)
console.log('\nNext, so releases get signed:')
console.log(`  gh secret set MARIS_RELEASE_KEY --repo MarySueXLsD/Maris-Local-AI < "${out}"`)
console.log('Then commit src/shared/releaseKeys.ts with the next release.')
