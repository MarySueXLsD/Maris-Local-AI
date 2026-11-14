// End-to-end test of the chat tools: "Undo changes" on an answer, "Branch from here", exporting a chat and
// the Ctrl+K box. Uses the stand-in model (fixtures/mock-llm.mjs); no Ollama, models or keys needed.
// Usage: npm run build && node tests/e2e/chat-tools.mjs <shotsDir>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
const work = path.join(shots, 'chat-tools-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const t = checker()

const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)

const mock = await startMockLlm()
mock.addLocalModel('qwen3:4b', { sizeGB: 2.5, caps: ['completion', 'tools'], ctx: 32768, family: 'qwen3', params: '4B' })
const one = (m) => ({ tiny: m, fast: m, balanced: m, max: m })
const profile = makeProfile('chat-tools', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, tiers: one('qwen3:4b') })
const { app, win, logs } = await launch(profile)
const d = driver(win, shots)
const panel = () => win.locator('[role="group"][aria-label^="Approval needed"]').first()
try {
  // ---- An answer that changes one file and creates another (both approved).
  const keep = path.join(work, 'keep.txt')
  const made = path.join(work, 'made.txt')
  writeFileSync(keep, 'original')
  await d.send(`Write two files: ${keep} = changed | ${made} = hello`)
  await panel().waitFor({ timeout: 60000 })
  await panel().getByRole('button', { name: 'Approve', exact: true }).click()
  await until(() => read(keep) === 'changed')
  await panel().waitFor({ timeout: 30000 })
  await panel().getByRole('button', { name: 'Approve', exact: true }).click()
  await d.waitDone()
  t.check(read(keep) === 'changed' && read(made) === 'hello', 'the answer changed one file and created another')

  // ---- Undo changes: the list first, then both go back, and a note says so.
  const answer = win.locator('.group').filter({ has: win.locator('button[aria-label="Undo changes"]') }).last()
  await answer.hover()
  await answer.locator('button[aria-label="Undo changes"]').click()
  const dialog = win.getByRole('dialog')
  await dialog.waitFor({ timeout: 5000 })
  const listed = await dialog.getByRole('listitem').allInnerTexts()
  t.check(listed.length === 2 && /made\.txt/.test(listed[0]) && /keep\.txt/.test(listed[1]), `the dialog lists both files, newest first (${listed.map((l) => l.split('\n')[0]).join(', ')})`)
  t.check(/Recycle Bin|Trash/.test(listed[0]) && /Back to how it was before/.test(listed[1]), 'it says what happens to each')
  await d.shot('tools-01-undo-list')
  await dialog.getByRole('button', { name: 'Undo changes' }).click()
  await dialog.getByRole('heading', { name: 'Changes undone' }).waitFor({ timeout: 15000 })
  t.check(read(keep) === 'original', 'the changed file is back to how it was')
  t.check(!existsSync(made), 'the created file is gone (to the Recycle Bin or Trash)')
  await d.shot('tools-02-undone')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await win.getByText('You undid these changes.').waitFor({ timeout: 5000 })
  t.check((await win.locator('button[aria-label="Undo changes"]').count()) === 0, 'the button is gone once the changes are undone')

  // The model reads the note in the next turn.
  const before = mock.requests.length
  await d.send('17 × 23')
  await d.waitDone()
  const told = mock.requests
    .slice(before)
    .filter((r) => r.path === '/api/chat' && !r.body.format)
    .some((r) => (r.body.messages ?? []).some((m) => m.role === 'assistant' && /Later the person undid these changes\. Back to how it was before: .*keep\.txt/.test(m.content ?? '')))
  t.check(told, 'the model is told the changes were undone')

  // ---- Branch from here: a new chat with the messages up to that answer.
  const firstAnswer = win.locator('.group').filter({ has: win.locator('button[aria-label^="Branch from here"]') }).first()
  await firstAnswer.hover()
  await firstAnswer.locator('button[aria-label^="Branch from here"]').click()
  await win.locator('nav[aria-label="Chats"] [aria-current="page"]', { hasText: '(branch)' }).waitFor({ timeout: 10000 })
  const state = await win.evaluate(() => {
    const s = window.__marisStore.getState()
    return { id: s.currentId, n: (s.messages[s.currentId] ?? []).length, title: s.conversations.find((c) => c.id === s.currentId)?.title }
  })
  t.check(state.n === 2, `the branch has the two messages up to that answer (${state.n}, "${state.title}")`)
  await d.shot('tools-03-branch')

  // ---- Export: the save dialog is answered by the test.
  const out = path.join(work, 'export.md')
  await app.evaluate(({ dialog: dlg }, p) => {
    dlg.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, out)
  const row = win.locator('nav[aria-label="Chats"] [aria-current="page"]').locator('..')
  await row.hover()
  await row.locator('button[aria-label^="Options for"]').click()
  await win.getByRole('menuitem', { name: 'Export' }).hover()
  await win.getByRole('menuitem', { name: /Markdown/ }).click()
  await until(() => existsSync(out), 10000)
  const md = read(out) ?? ''
  t.check(/^# .*\(branch\)/.test(md) && /## You · /.test(md) && /## Maris/.test(md), 'the chat is saved as Markdown')

  // ---- Ctrl+K: a setting by name opens Settings searched for it; a chat by name opens it.
  await win.keyboard.press('Control+k')
  const box = win.getByRole('combobox', { name: 'Go anywhere' })
  await box.waitFor({ timeout: 5000 })
  await box.fill('high contrast')
  await win.getByRole('option').first().waitFor({ timeout: 5000 })
  await d.shot('tools-04-palette')
  const first = await win.getByRole('option').first().innerText()
  await box.press('Enter')
  const search = win.getByLabel('Search settings')
  await search.waitFor({ timeout: 5000 })
  t.check(/contrast/i.test(first) && /contrast/i.test(await search.inputValue()), `a setting opens Settings searched for it ("${first.split('\n')[0]}")`)
  await win.keyboard.press('Control+k')
  await box.fill('branch')
  await win.getByRole('option', { name: /\(branch\)/ }).first().waitFor({ timeout: 5000 })
  await box.press('Enter')
  await d.composer().waitFor({ timeout: 5000 })
  t.check((await win.evaluate(() => window.__marisStore.getState().view)) === 'chat', 'a chat by name opens it')
  await win.keyboard.press('Control+k')
  await box.waitFor({ timeout: 5000 })
  await win.keyboard.press('Escape')
  t.check(await until(() => true) && (await win.getByRole('combobox', { name: 'Go anywhere' }).count()) === 0, 'Escape closes the box')
} catch (err) {
  t.check(false, String(err))
  await d.shot('tools-error').catch(() => undefined)
} finally {
  await app.close().catch(() => undefined)
  await mock.close?.()
  try {
    removeProfile(profile)
  } catch {
    /* in use */
  }
}
if (t.failures) console.log(logs.slice(-30).join('\n'))
console.log(t.failures ? `\n${t.failures} check(s) failed` : '\nAll chat tool checks passed')
process.exit(t.failures ? 1 : 0)
