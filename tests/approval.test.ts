import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anyAutoApprove, approvalKind, autoApproveReason, type AutoApproveSettings } from '../src/shared/approval.ts'
import { DEFAULT_SETTINGS } from '../src/shared/defaults.ts'

const off: AutoApproveSettings = { everything: false, files: false, delete: false, commands: false, programs: false, clipboard: false, memory: false, connectors: false }

test('by default every change asks', () => {
  assert.deepEqual(DEFAULT_SETTINGS.agent.autoApprove, off)
  for (const tool of ['write_file', 'delete_path', 'run_command', 'open_target', 'set_clipboard', 'forget', 'some_new_tool']) {
    assert.equal(autoApproveReason(off, { tool, risk: 'change', inSession: false }), undefined, tool)
  }
  assert.equal(anyAutoApprove(off, false), false)
})

test('tools map to the kinds people choose', () => {
  assert.equal(approvalKind('edit_file', 'change'), 'files')
  assert.equal(approvalKind('move_path', 'change'), 'files')
  assert.equal(approvalKind('delete_path', 'change'), 'delete')
  assert.equal(approvalKind('run_command', 'system'), 'commands')
  assert.equal(approvalKind('start_process', 'system'), 'commands')
  assert.equal(approvalKind('kill_process', 'system'), 'programs')
  assert.equal(approvalKind('set_clipboard', 'change'), 'clipboard')
  assert.equal(approvalKind('forget', 'change'), 'memory')
  assert.equal(approvalKind('unknown_tool', 'change'), undefined)
  assert.equal(approvalKind('mcp_github_create_issue', 'change'), 'connectors')
})

test('a kind rule covers only that kind, and never file changes in system folders', () => {
  const files = { ...off, files: true }
  assert.match(autoApproveReason(files, { tool: 'write_file', risk: 'change', inSession: false }) ?? '', /creating and editing files/)
  assert.equal(autoApproveReason(files, { tool: 'write_file', risk: 'system', inSession: false }), undefined, 'system folders still ask')
  assert.equal(autoApproveReason(files, { tool: 'delete_path', risk: 'change', inSession: false }), undefined, 'deleting is a different kind')
  assert.equal(autoApproveReason(files, { tool: 'run_command', risk: 'system', inSession: false }), undefined)
  assert.match(autoApproveReason({ ...off, delete: true }, { tool: 'delete_path', risk: 'change', inSession: false }, 'Trash') ?? '', /Trash/)
  assert.match(autoApproveReason({ ...off, commands: true }, { tool: 'run_command', risk: 'system', inSession: false }) ?? '', /running commands/)
})

test('"this session" covers everything in that chat only; "everywhere" covers everything', () => {
  assert.match(autoApproveReason(off, { tool: 'delete_path', risk: 'system', inSession: true }) ?? '', /this session/)
  assert.match(autoApproveReason(off, { tool: 'some_new_tool', risk: 'system', inSession: true }) ?? '', /this session/)
  const all = { ...off, everything: true }
  assert.match(autoApproveReason(all, { tool: 'write_file', risk: 'system', inSession: false }) ?? '', /everything, everywhere/)
  assert.equal(anyAutoApprove(off, true), true)
  assert.equal(anyAutoApprove(all, false), true)
  assert.equal(anyAutoApprove({ ...off, memory: true }, false), true)
})
