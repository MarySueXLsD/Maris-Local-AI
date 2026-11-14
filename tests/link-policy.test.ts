import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DECIDED, phoneAccess, phoneArgs, phoneSettingsPatch } from '../src/main/link/policy.ts'
import { cleanPatch, DEFAULT_SETTINGS, PROTECTED_ON_IMPORT } from '../src/shared/defaults.ts'
import { foldersToWatch } from '../src/main/watchTree.ts'

test('every channel the window can call has a decision about the phone', () => {
  const src = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const channels = [...src.matchAll(/\bh\(\s*'([\w:]+)'/g)].map((m) => m[1]!)
  assert.ok(channels.length > 100, `found only ${channels.length} channels`)
  const undecided = [...channels, 'cli:show'].filter((c) => !DECIDED.has(c))
  assert.deepEqual(undecided, [], `add these to src/main/link/policy.ts: ${undecided.join(', ')}`)
})

test('the phone may not reach dialogs, keys, setup or the link, and new channels stay on the computer', () => {
  for (const c of ['shell:openPath', 'shell:reveal', 'files:pick', 'setup:apply', 'updates:install', 'providers:add', 'link:startPairing', 'admin:publish', 'cli:show']) assert.equal(phoneAccess(c), 'desktop', c)
  assert.equal(phoneAccess('some:newChannel'), 'desktop')
  // Starting programs needs the right to approve: a connector is a program (a custom one runs any command).
  for (const c of ['connectors:add', 'connectors:setEnabled', 'media:installComfy', 'project:installToolchain', 'chat:approve', 'models:delete']) assert.equal(phoneAccess(c), 'approve', c)
  for (const c of ['chat:send', 'conv:list', 'settings:set', 'memory:add']) assert.equal(phoneAccess(c), 'phone', c)
})

test('settings changed from the phone keep the link, the addresses and, without the right, approvals as they are', () => {
  const patch = {
    link: { allowApprovals: true },
    ollamaUrl: 'http://evil:11434',
    comfyUrl: 'http://evil:8188',
    dataDir: 'D:\\x',
    updates: { repo: 'evil/repo', admin: true, check: false },
    media: { extraArgs: '--listen 0.0.0.0', imageWidth: 768 },
    agent: { autoApprove: { everything: true, files: false }, fullControl: true, maxSteps: 3 },
    extensions: { connectors: true, skills: false },
    ui: { theme: 'dark' }
  }
  const without = phoneSettingsPatch(patch, false)
  assert.deepEqual(without, {
    updates: { check: false },
    media: { imageWidth: 768 },
    agent: { autoApprove: { files: false }, maxSteps: 3 },
    extensions: { skills: false },
    ui: { theme: 'dark' }
  })
  const withRight = phoneSettingsPatch(patch, true)
  assert.equal((withRight.agent as { fullControl?: boolean }).fullControl, true)
  assert.equal('ollamaUrl' in withRight || 'link' in withRight || 'dataDir' in withRight, false)
  // Switching things off is always allowed.
  assert.deepEqual(phoneSettingsPatch({ agent: { fullControl: false } }, false), { agent: { fullControl: false } })
})

test('calls from the phone that switch approvals on, open a folder picker or reset the link are refused', () => {
  assert.ok('refused' in phoneArgs('approvals:setSession', ['c1', true], false))
  assert.ok('args' in phoneArgs('approvals:setSession', ['c1', false], false))
  assert.ok('refused' in phoneArgs('chat:autoEdits', ['c1', true], false))
  assert.ok('args' in phoneArgs('chat:autoEdits', ['c1', true], true))
  assert.ok('refused' in phoneArgs('project:open', [], true))
  assert.ok('refused' in phoneArgs('settings:reset', ['link'], true))
  assert.ok('refused' in phoneArgs('settings:reset', [], true))
  assert.deepEqual(phoneArgs('project:watch', ['C:\\p'], true), { args: ['C:\\p', 'phone'] })
})

test('settings of the wrong kind are left out, numbers stay in range', () => {
  const ranges = new Map([['ui.fontScale', { min: 0.8, max: 1.6 }]])
  assert.deepEqual(cleanPatch({ ui: { fontScale: 'huge', theme: 'dark' } }, DEFAULT_SETTINGS, ranges), { ui: { theme: 'dark' } })
  assert.deepEqual(cleanPatch({ ui: { fontScale: 9 } }, DEFAULT_SETTINGS, ranges), { ui: { fontScale: 1.6 } })
  assert.deepEqual(cleanPatch({ ollamaUrl: { host: 'x' }, onboarded: 'yes' }), {})
  assert.deepEqual(cleanPatch({ engine: { cpuThreads: Number.NaN } }), { engine: {} })
  // Settings without a default (the model for a role, a temperature) take plain values.
  assert.deepEqual(cleanPatch({ tiers: { fast: 'qwen3:4b', max: undefined } }), { tiers: { fast: 'qwen3:4b', max: undefined } })
  assert.deepEqual(cleanPatch({ generation: { fast: { temperature: 0.4 } } }), { generation: { fast: { temperature: 0.4 } } })
  assert.ok(PROTECTED_ON_IMPORT.includes('agent.autoApprove') && PROTECTED_ON_IMPORT.includes('link'))
})

test('on Linux the project watcher looks into the folders it shows, not node_modules or build output', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maris-watch-'))
  try {
    for (const d of ['src/app', 'node_modules/a/b', '.git/objects', 'target/debug', 'docs']) mkdirSync(path.join(root, d), { recursive: true })
    writeFileSync(path.join(root, 'src', 'main.ts'), '')
    const rel = foldersToWatch(root).map((d) => path.relative(root, d).replace(/\\/g, '/') || '.')
    assert.deepEqual(rel.sort(), ['.', 'docs', 'src', 'src/app'])
    assert.equal(foldersToWatch(root, 2).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
