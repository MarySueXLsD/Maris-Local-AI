import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeCall, describeCommand, exitCode, isCompound, summarize, testCounts } from '../src/renderer/src/components/chat/describe.ts'

const call = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: 'x', name, args, risk: 'read', status: 'done', ...extra }) as Parameters<typeof describeCall>[0]

test('everyday commands become plain words and stay quiet', () => {
  for (const [cmd, words] of [
    ['python -m pytest -q', 'Ran the Python tests'],
    ['cargo test --release', 'Ran the Rust tests'],
    ['dotnet build MyApp.sln', 'Built the .NET project'],
    ['haxelib run lime test html5', 'Built and started the game'],
    ['npm run build', 'Built the project'],
    ['git status', 'Checked the version history'],
    ['Get-ChildItem -Recurse | Select-Object Name', 'Looked at files'],
    ['cargo test 2>&1', 'Ran the Rust tests']
  ] as const) {
    const d = describeCommand(cmd)
    assert.equal(d.done, words, cmd)
    assert.equal(d.important, false, `${cmd} should not be flagged`)
  }
})

test('installs, deletions, history changes and chained commands are always shown', () => {
  for (const cmd of ['pip install requests', 'npm install', 'winget install Git.Git', 'Remove-Item -Recurse build', 'git push origin main', 'git commit -m x', 'python -m pytest; Remove-Item x', 'dir > files.txt', 'Get-Content a.txt | Set-Content b.txt']) {
    assert.equal(describeCommand(cmd).important, true, cmd)
  }
  assert.ok(isCompound('a && b'))
  assert.ok(!isCompound('git log --oneline | Select-Object -First 5'))
})

test('test results are read from common runners', () => {
  assert.deepEqual(testCounts('==== 3 passed in 0.12s ===='), { passed: 3, failed: 0 })
  assert.deepEqual(testCounts('==== 1 failed, 4 passed in 0.3s ===='), { passed: 4, failed: 1 })
  assert.deepEqual(testCounts('test result: ok. 5 passed; 0 failed; 0 ignored'), { passed: 5, failed: 0 })
  assert.deepEqual(testCounts('Passed!  - Failed:     0, Passed:    12, Skipped:     0'), { passed: 12, failed: 0 })
  assert.deepEqual(testCounts('Ran 4 tests in 0.001s\n\nFAILED (failures=1)'), { passed: 3, failed: 1 })
  assert.equal(exitCode('$ cargo test\n(exit code 101, 2.1s)\n…'), 101)
})

test('a finished test run reads like a sentence with its result', () => {
  const ok = describeCall(call('run_command', { command: 'python -m pytest' }, { risk: 'system', result: '$ python -m pytest\n(exit code 0, 1.0s)\n3 passed in 0.1s' }))
  assert.equal(ok.done, 'Ran the Python tests')
  assert.equal(ok.outcome, 'all 3 passed')
  assert.equal(ok.ok, true)
  assert.equal(ok.important, false)
  const bad = describeCall(call('run_command', { command: 'python -m pytest' }, { risk: 'system', result: '$ python -m pytest\n(exit code 1, 1.0s)\n1 failed, 2 passed' }))
  assert.equal(bad.outcome, '1 of 3 failed')
  assert.equal(bad.ok, false)
  const unknown = describeCall(call('run_command', { command: 'Invoke-Thing -Force' }, { risk: 'system', result: '(exit code 0, 0.1s)' }))
  assert.equal(unknown.important, true, 'an unknown command that needed approval is shown')
})

test('edits show the file and size of the change, and a turn summary adds them up', () => {
  const edit = call('edit_file', { path: 'C:\\proj\\calc.py' }, { diff: '--- a\n+++ b\n@@\n-  return a - b\n+  return a + b\n', title: 'Edit C:\\proj\\calc.py', risk: 'change' })
  const d = describeCall(edit)
  assert.equal(d.done, 'Changed calc.py')
  assert.equal(d.outcome, '+1 −1')
  const created = call('write_file', { path: 'C:\\proj\\README.md' }, { title: 'Create C:\\proj\\README.md', diff: '+a\n+b\n', risk: 'change' })
  const tests = call('run_command', { command: 'python -m pytest' }, { risk: 'system', result: '(exit code 0, 1s)\n2 passed' })
  const s = summarize([edit, created, tests])
  assert.deepEqual(s.changed, ['calc.py'])
  assert.deepEqual(s.created, ['README.md'])
  assert.equal(s.tests, true)
})

test('the summary reports the latest test run, so a fixed failure ends as passing', () => {
  const failed = call('run_command', { command: 'python -m pytest' }, { risk: 'system', result: '(exit code 1, 1s)\n1 failed, 1 passed' })
  const passed = call('run_command', { command: 'python -m pytest' }, { risk: 'system', result: '(exit code 0, 1s)\n2 passed' })
  assert.equal(summarize([failed, passed]).tests, true)
  assert.equal(summarize([passed, failed]).tests, false)
  assert.equal(describeCall(passed).outcome, 'both passed')
})
