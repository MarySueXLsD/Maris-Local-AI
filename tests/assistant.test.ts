import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsName } from '../src/main/platform.ts'
import { resolveToolName, shellAlias } from '../src/main/agent/toolAlias.ts'
import { escapeSendKeys, needsAdmin, sendKeysFor } from '../src/main/tools/keys.ts'
import { connectorsInPlay } from '../src/shared/connectorPresets.ts'
import { coerceSetting, lockedReason, showSetting } from '../src/main/tools/settingValues.ts'
import { SETTINGS_SCHEMA } from '../src/renderer/src/views/settings/schema.ts'
import { autoApproveReason } from '../src/shared/approval.ts'

test('Windows 11 is named as such, not as version 10.0', () => {
  assert.equal(windowsName('10.0.26200', 'Professional', '24H2'), 'Windows 11 Pro 24H2 (build 26200)')
  assert.equal(windowsName('10.0.22631', 'Core'), 'Windows 11 Home (build 22631)')
  assert.equal(windowsName('10.0.19045', 'Professional', '22H2'), 'Windows 10 Pro 22H2 (build 19045)')
  assert.equal(windowsName('10.0.26100'), 'Windows 11 (build 26100)')
})

test('a shell called by name runs as run_command', () => {
  assert.deepEqual(shellAlias('sh', { command: 'Get-Process' }), { name: 'run_command', args: { command: 'Get-Process' } })
  assert.deepEqual(shellAlias('PowerShell', { script: 'dir', cwd: 'C:\\x' }), { name: 'run_command', args: { command: 'dir', cwd: 'C:\\x' } })
  assert.deepEqual(shellAlias('execute_command', { cmd: ['ls', 'pwd'] }), { name: 'run_command', args: { command: 'ls; pwd' } })
  assert.deepEqual(shellAlias('bash', { x: 'df -h' }), { name: 'run_command', args: { command: 'df -h' } })
  assert.equal(shellAlias('read_file', { command: 'x' }), undefined, 'not a shell name')
  assert.equal(shellAlias('sh', {}), undefined, 'nothing to run')
})

const def = (path: string) => {
  const d = SETTINGS_SCHEMA.find((x) => x.path === path)
  assert.ok(d, `schema has ${path}`)
  return d!
}

test('settings the chat may change are checked like the Settings page does', () => {
  const sw = SETTINGS_SCHEMA.find((d) => d.type === 'switch' && !lockedReason(d))!
  assert.equal(coerceSetting(sw, 'on'), true)
  assert.equal(coerceSetting(sw, false), false)
  assert.throws(() => coerceSetting(sw, 'maybe'))

  const choice = SETTINGS_SCHEMA.find((d) => (d.type === 'select' || d.type === 'segmented') && (d.options?.length ?? 0) > 1 && !lockedReason(d))!
  const opt = choice.options![1]!
  assert.equal(coerceSetting(choice, String(opt.value)), opt.value, 'by value')
  assert.equal(coerceSetting(choice, opt.label.toUpperCase()), opt.value, 'by label, any case')
  assert.throws(() => coerceSetting(choice, 'no-such-choice'), /must be one of/)
  assert.equal(showSetting(choice, opt.value), opt.label)

  const n = SETTINGS_SCHEMA.find((d) => d.type === 'number' && d.min !== undefined && d.max !== undefined && !lockedReason(d))!
  assert.equal(coerceSetting(n, String(n.min)), n.min)
  assert.throws(() => coerceSetting(n, n.max! + 1), /goes from/)
})

test('approval rules, the phone link, update source and keys stay on the Settings page', () => {
  for (const p of ['agent.autoApprove.everything', 'agent.autoApprove.commands', 'agent.autoRunReadOnlyCommands', 'link.enabled', 'link.allowApprovals', 'updates.repo', 'updates.admin', 'web.braveKey']) {
    assert.ok(lockedReason(def(p)), `${p} is locked`)
  }
  assert.equal(lockedReason(def('updates.check')), undefined)
})

test('made-up tool names map to the real tool', () => {
  const known = ['system_info', 'read_file', 'list_dir', 'run_command', 'search_files', 'web_search', 'take_screenshot']
  assert.equal(resolveToolName('system_tool_system_info', known), 'system_info')
  assert.equal(resolveToolName('system_information', known), 'system_info')
  assert.equal(resolveToolName('get_system_info', known), 'system_info')
  assert.equal(resolveToolName('functions.read_file', known), 'read_file')
  assert.equal(resolveToolName('list_files', known), 'list_dir')
  assert.equal(resolveToolName('screenshot', known), 'take_screenshot')
  assert.equal(resolveToolName('web_search', known.filter((k) => k !== 'web_search')), undefined, 'not offered: no match')
  assert.equal(resolveToolName('make_coffee', known), undefined)
})

test('connected services bring their tools only when the chat needs them', () => {
  const ready = [
    { id: 'github', name: 'GitHub', preset: 'github' },
    { id: 'notion', name: 'Notion', preset: 'notion' },
    { id: 'homeassistant', name: 'Home Assistant', preset: 'homeassistant' }
  ]
  const ids = (text: string, used: string[] = []) => [...connectorsInPlay(ready, text, used)].sort()
  assert.deepEqual(ids('Create a responsive landing page with HTML, CSS and vanilla JavaScript.'), [], 'a coding task needs none')
  assert.deepEqual(ids('Switch Maris to the light theme, there is an issue with my code'), [], 'everyday words do not pull them in')
  assert.deepEqual(ids('Open a pull request for this branch'), ['github'])
  assert.deepEqual(ids('Add this to my Notion page'), ['notion'])
  assert.deepEqual(ids('turn on the lights in the kitchen'), ['homeassistant'])
  assert.deepEqual(ids('and the next one', ['mcp_github_create_issue']), ['github'], 'used earlier in the chat')
  assert.deepEqual(ids('go on', ['Notion']), ['notion'], 'asked for with use_connector')
})

test('key names become SendKeys', () => {
  assert.equal(sendKeysFor('ctrl+s'), '^s')
  assert.equal(sendKeysFor('alt+f4'), '%{F4}')
  assert.equal(sendKeysFor('ctrl+shift+esc'), '^+{ESC}')
  assert.equal(sendKeysFor('enter'), '{ENTER}')
  assert.equal(escapeSendKeys('50% (a+b)\nok'), '50{%} {(}a{+}b{)}{ENTER}ok')
})

test('commands that need administrator rights are recognised before they run', () => {
  for (const c of [
    'Restart-Service Spooler',
    'Start-Process -FilePath "services.exe" -ArgumentList "sc", "stop", "spooler"',
    'sc.exe stop spooler',
    'net stop spooler',
    'Set-ItemProperty -Path HKLM:\\SOFTWARE\\X -Name a -Value 1',
    'reg add HKLM\\Software\\X /v a /d b',
    'Start-Process powershell -Verb RunAs',
    'dism /online /enable-feature /featurename:x'
  ]) {
    assert.ok(needsAdmin(c, 'win32'), c)
  }
  for (const c of ['Get-Service Spooler', 'Get-ChildItem C:\\', 'sc query spooler', 'Set-ItemProperty -Path HKCU:\\Software\\X -Name a -Value 1', 'net view']) {
    assert.ok(!needsAdmin(c, 'win32'), c)
  }
  assert.ok(needsAdmin('sudo apt install x', 'linux'))
  assert.ok(needsAdmin('systemctl restart cups', 'linux'))
  assert.ok(!needsAdmin('systemctl --user restart pipewire', 'linux'))
  assert.ok(!needsAdmin('systemctl status cups', 'linux'))
})

test('full control is only turned on by the person', () => {
  assert.ok(lockedReason(def('agent.fullControl')))
})

test('changing Maris settings always asks, whatever is approved automatically', () => {
  const rules = { everything: true, files: true, delete: true, commands: true, programs: true, clipboard: true, memory: true, connectors: true }
  assert.equal(autoApproveReason(rules, { tool: 'change_maris_settings', risk: 'change', inSession: true }), undefined)
  assert.ok(autoApproveReason(rules, { tool: 'write_file', risk: 'change', inSession: false }))
})
