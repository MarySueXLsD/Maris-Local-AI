import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerPlan, canUndo, chatToMarkdown, exportFileName, undoPlan, undoSummary, type UndoResult } from '../src/shared/chatExport.ts'
import type { ChatMessage, Conversation, Part, ToolCallRecord } from '../src/shared/types.ts'
import { phoneAccess } from '../src/main/link/policy.ts'

const call = (name: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord =>
  ({ id: `${name}-${Math.random()}`, name, args: {}, status: 'done', risk: 'change', title: name, ...extra }) as ToolCallRecord

const conv: Conversation = { id: 'c1', title: 'Fix the "login" page?', createdAt: Date.UTC(2026, 10, 14, 9, 30), updatedAt: Date.UTC(2026, 10, 14, 10), pinned: false, model: 'auto', mode: 'chat' } as Conversation

test('exported file names come from the title without characters files cannot have', () => {
  assert.equal(exportFileName(conv.title, 'md'), 'Fix the login page.md')
  assert.equal(exportFileName('  <>:  ', 'json'), 'Chat.json')
  assert.equal(exportFileName('a'.repeat(100), 'md'), `${'a'.repeat(60)}.md`)
  assert.equal(exportFileName('Ends with dots...', 'md'), 'Ends with dots.md')
})

test('a chat in Markdown has who said what, the actions as a list and pictures as links', () => {
  const messages = [
    { id: 'u1', conversationId: 'c1', role: 'user', createdAt: Date.UTC(2026, 10, 14, 9, 31), status: 'done', parts: [{ type: 'text', text: 'Please fix it' }], attachments: [{ id: 'a', kind: 'file', name: 'login.ts', path: 'C:\\app\\login.ts' }] },
    {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      model: 'qwen3:14b',
      createdAt: Date.UTC(2026, 10, 14, 9, 32),
      status: 'done',
      parts: [
        { type: 'thinking', text: 'secret thoughts' },
        { type: 'tool', call: call('read_file', { title: 'Read login.ts' }) },
        { type: 'tool', call: call('write_file', { title: 'Write login.ts', status: 'denied' }) },
        { type: 'text', text: 'Done, here it is.' },
        { type: 'media', media: { kind: 'image', prompt: 'a cat', path: 'C:\\pics\\cat 1.png' } },
        { type: 'notice', text: 'Compacted 3 earlier messages', tone: 'info' }
      ]
    }
  ] as unknown as ChatMessage[]
  const md = chatToMarkdown(conv, messages)
  assert.match(md, /^# Fix the "login" page\?\n/)
  assert.match(md, /## You · 2026-11-14 09:31\n\nPlease fix it\n\n\*Attached: login\.ts \(C:\\app\\login\.ts\)\*/)
  assert.match(md, /## Maris \(qwen3:14b\) · 2026-11-14 09:32/)
  assert.match(md, /- Read login\.ts\n- Write login\.ts \(you said no\)\n\nDone, here it is\./)
  assert.match(md, /!\[a cat\]\(file:\/\/\/C:\/pics\/cat%201\.png\)/)
  assert.match(md, /> Compacted 3 earlier messages/)
  assert.doesNotMatch(md, /secret thoughts/, 'thinking is not exported')
  assert.doesNotMatch(md, /\n{3,}/)
})

test('undoing an answer: backups come back, new files and copies go to the bin, moves go back, newest first', () => {
  const steps = undoPlan([
    call('write_file', { targets: ['C:\\p\\new.ts'], result: 'Wrote 10 B to C:\\p\\new.ts' }),
    call('edit_file', { targets: ['C:\\p\\old.ts'], backup: 'C:\\bak\\old.ts' }),
    call('make_dir', { targets: ['C:\\p\\dir'], result: 'Created folder C:\\p\\dir' }),
    call('copy_path', { targets: ['C:\\p\\copy.txt'], result: 'Copied …' }),
    call('move_path', { targets: ['C:\\p\\a.txt', 'C:\\p\\b.txt'], result: 'Moved C:\\p\\a.txt to C:\\p\\b.txt' }),
    call('write_files', { result: 'Replaced C:\\p\\x (1).ts (3 B), backup C:\\bak\\x.ts\nCreated C:\\p\\y.ts (4 B)' }),
    call('run_command', { title: 'Run npm install' }),
    call('delete_path', { targets: ['C:\\p\\gone.txt'] }),
    call('read_file', { targets: ['C:\\p\\old.ts'] }),
    call('edit_file', { targets: ['C:\\p\\failed.ts'], backup: 'C:\\bak\\failed.ts', status: 'error' })
  ])
  assert.deepEqual(
    steps.map((s) => [s.action, s.path, s.from]),
    [
      ['none', 'C:\\p\\gone.txt', undefined],
      ['none', 'Run npm install', undefined],
      ['remove', 'C:\\p\\y.ts', undefined],
      ['restore', 'C:\\p\\x (1).ts', 'C:\\bak\\x.ts'],
      ['move-back', 'C:\\p\\a.txt', 'C:\\p\\b.txt'],
      ['remove', 'C:\\p\\copy.txt', undefined],
      ['remove-folder', 'C:\\p\\dir', undefined],
      ['restore', 'C:\\p\\old.ts', 'C:\\bak\\old.ts'],
      ['remove', 'C:\\p\\new.ts', undefined]
    ]
  )
})

test('undo never acts on a relative path or a file whose backup is missing from the record', () => {
  const steps = undoPlan([
    call('write_file', { args: { path: 'src/a.ts' }, result: 'Wrote 1 B to src/a.ts' }),
    call('write_file', { targets: ['/home/me/b.ts'], result: 'Wrote 1 B to /home/me/b.ts. Previous version backed up to /x' }),
    call('edit_file', { targets: ['/home/me/c.ts'] })
  ])
  assert.ok(steps.every((s) => s.action === 'none'), JSON.stringify(steps))
})

test('"Undo changes" shows only for answers that changed files and were not undone yet', () => {
  const changed: Part[] = [{ type: 'tool', call: call('edit_file', { targets: ['/p/a.ts'], backup: '/bak/a.ts' }) }]
  assert.equal(canUndo(changed), true)
  assert.equal(canUndo([{ type: 'tool', call: call('run_command') }]), false)
  assert.equal(canUndo([{ type: 'tool', call: call('read_file', { targets: ['/p/a.ts'] }) }]), false)
  assert.equal(canUndo([...changed, { type: 'notice', text: 'done', kind: 'undo' }]), false)
  assert.equal(answerPlan(changed)[0]?.action, 'restore')
})

test('what undoing did, in words for the chat and the model', () => {
  const r = (action: UndoResult['step']['action'], p: string, ok: boolean, error?: string): UndoResult => ({ step: { action, path: p, why: 'x' }, ok, error })
  assert.equal(
    undoSummary([r('restore', '/p/a.ts', true), r('remove', '/p/n.ts', true), r('move-back', '/p/m', true), r('restore', '/p/b.ts', false, 'the backup is gone'), r('none', 'Run npm install', false, 'x')], 'Trash'),
    'Back to how it was before: /p/a.ts. Removed (in the Trash): /p/n.ts. Moved back: /p/m. Could not undo: /p/b.ts (the backup is gone). Left as they are: Run npm install.'
  )
  assert.equal(undoSummary([]), 'There was nothing to undo.')
})

test('the phone may export and branch chats, but undoing changes needs the right to approve', () => {
  assert.equal(phoneAccess('conv:export'), 'phone')
  assert.equal(phoneAccess('conv:branch'), 'phone')
  assert.equal(phoneAccess('chat:undoAnswer'), 'approve')
  assert.equal(phoneAccess('files:saveText'), 'desktop')
})
