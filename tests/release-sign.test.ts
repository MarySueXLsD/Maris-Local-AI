import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifySums } from '../src/main/feed/signature.ts'

const sums = 'abc123  Maris-0.5.0-Windows-Setup.exe\ndef456  Maris-0.5.0-macOS-Intel-x64.dmg\n'

test('a checksum list counts only with a valid signature by a built-in release key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const other = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const sig = sign(null, Buffer.from(sums), privateKey).toString('base64')
  assert.equal(verifySums(sums, sig, [pub]), true)
  assert.equal(verifySums(sums, `${sig}\n`, [pub]), true)
  // Another key, a changed list, a broken signature: refused.
  assert.equal(verifySums(sums, sig, [other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]), false)
  assert.equal(verifySums(sums.replace('abc123', 'abc124'), sig, [pub]), false)
  assert.equal(verifySums(sums, 'not a signature', [pub]), false)
  assert.equal(verifySums(sums, sig, []), false)
  // An old key next to a new one still verifies what the old key signed.
  assert.equal(verifySums(sums, sig, [other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pub]), true)
})

test('the release job signs the list, and with no key built in an unsigned release still goes out', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-sign-'))
  try {
    const file = path.join(dir, 'SHA256SUMS.txt')
    writeFileSync(file, sums)
    const script = path.join(import.meta.dirname, '..', 'scripts', 'sign-release.cjs')
    // No secret: nothing to sign (src/shared/releaseKeys.ts holds no key yet in this repository).
    execFileSync(process.execPath, [script, file], { env: { ...process.env, MARIS_RELEASE_KEY: '' }, stdio: 'pipe' })
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    execFileSync(process.execPath, [script, file], { env: { ...process.env, MARIS_RELEASE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, stdio: 'pipe' })
    const sig = readFileSync(`${file}.sig`, 'utf8')
    assert.equal(verifySums(sums, sig, [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
