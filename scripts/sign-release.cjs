// Signs a release's SHA256SUMS.txt with the release key (Ed25519; the GitHub secret MARIS_RELEASE_KEY holds
// it in PEM). Copies of Maris that have a release key built in (src/shared/releaseKeys.ts) install an update
// only when this signature checks out.
//
// Without the secret the release is left unsigned, unless keys are built in: then installed copies would
// refuse it, so this stops the release instead. The signature is checked against the built-in keys before
// it is kept, so a secret that does not match them cannot slip through either.
//
// Usage: node scripts/sign-release.cjs dist/SHA256SUMS.txt
const { createPrivateKey, createPublicKey, sign, verify } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/sign-release.cjs <SHA256SUMS.txt>')
  process.exit(2)
}
const keysFile = readFileSync(path.join(__dirname, '..', 'src', 'shared', 'releaseKeys.ts'), 'utf8')
const builtIn = [...keysFile.replace(/^\s*\/\/.*$/gm, '').matchAll(/'([A-Za-z0-9+/=]{40,})'/g)].map((m) => m[1])
const pem = process.env.MARIS_RELEASE_KEY

if (!pem) {
  if (builtIn.length) {
    console.error('::error::Maris has a release key built in, but the MARIS_RELEASE_KEY secret is not set. Installed copies would refuse this release, so it is not published.')
    process.exit(1)
  }
  console.log('No release key: the checksum list is published without a signature.')
  process.exit(0)
}

const data = readFileSync(file)
const sig = sign(null, data, createPrivateKey(pem))
const ok = builtIn.some((k) => {
  try {
    return verify(null, data, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig)
  } catch {
    return false
  }
})
if (builtIn.length && !ok) {
  console.error('::error::The MARIS_RELEASE_KEY secret does not match any key in src/shared/releaseKeys.ts. Installed copies would refuse this release, so it is not published.')
  process.exit(1)
}
if (!builtIn.length) console.log('No release key is built into Maris yet: the signature is published, and checked once a key is built in.')
writeFileSync(`${file}.sig`, `${sig.toString('base64')}\n`)
console.log(`Signed ${path.basename(file)} → ${path.basename(file)}.sig`)
