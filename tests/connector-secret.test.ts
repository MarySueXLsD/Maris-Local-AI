import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSecret, CONNECTOR_PRESETS } from '../src/shared/connectorPresets.ts'

const github = CONNECTOR_PRESETS.find((p) => p.id === 'github')!.fields.find((f) => f.key === 'token')!
const valid = (v: string): boolean => new RegExp(github.pattern!).test(cleanSecret(v))
const pat = `github_pat_${'A1b2C3d4'.repeat(10)}`
const classic = `ghp_${'x9'.repeat(18)}`

test('a pasted key loses what tends to come with it', () => {
  assert.equal(cleanSecret(`  ${classic}\n`), classic)
  assert.equal(cleanSecret(`Bearer ${classic}`), classic)
  assert.equal(cleanSecret(`Authorization: Bearer ${classic}`), classic)
  assert.equal(cleanSecret(`token ${classic}`), classic)
  assert.equal(cleanSecret(`"${pat}"`), pat)
  assert.equal(cleanSecret(`${pat.slice(0, 20)}​${pat.slice(20)}`), pat)
})

test('GitHub tokens are recognised, and other text is not', () => {
  assert.equal(valid(pat), true)
  assert.equal(valid(classic), true)
  assert.equal(valid(`Bearer ${classic}`), true)
  assert.equal(valid('a'.repeat(40).replace(/a/g, 'f')), true)
  assert.equal(valid('my GitHub token'), false)
  assert.equal(valid('Maris'), false)
  assert.equal(valid('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'), false)
})
