// End-to-end test of steps with several actions: reads asked for together run side by side, and after
// "Deny and say why" the rest of the step is not run and the model is told what the person said.
// Uses the stand-in model (fixtures/mock-llm.mjs); no Ollama, models or keys needed.
// Usage: npm run build && node tests/e2e/agent-steps.mjs <shotsDir>
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
const work = path.join(shots, 'steps-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const t = checker()

const mock = await startMockLlm()
mock.addLocalModel('qwen3:4b', { sizeGB: 2.5, caps: ['completion', 'tools'], ctx: 32768, family: 'qwen3', params: '4B' })
const one = (m) => ({ tiny: m, fast: m, balanced: m, max: m })
const profile = makeProfile('steps', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, tiers: one('qwen3:4b') })
const { app, win, logs } = await launch(profile)
const d = driver(win, shots)
try {
  // ---- Two reads in one step: both run, and the answer has both.
  const a = path.join(work, 'a.txt')
  const b = path.join(work, 'b.txt')
  writeFileSync(a, 'alpha-content')
  writeFileSync(b, 'beta-content')
  await d.send(`Read both of these files: ${a} | ${b}`)
  await d.waitDone()
  const both = await d.lastAnswer()
  t.check(/alpha-content/.test(both) && /beta-content/.test(both), `two reads in one step both ran (${both.slice(0, 90)})`)
  await d.shot('steps-01-two-reads')

  // ---- Two changes in one step; the first is denied with a reason.
  await d.newChat()
  const c = path.join(work, 'c.txt')
  const e = path.join(work, 'd.txt')
  await d.send(`Write two files: ${c} = one | ${e} = two`)
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]').first()
  await panel.waitFor({ timeout: 60000 })
  t.check((await win.locator('[role="group"][aria-label^="Approval needed"]').count()) === 1, 'only the first change asks; the second waits its turn')
  await panel.getByRole('button', { name: 'Deny and say why' }).click()
  await panel.getByLabel('What Maris should do instead').fill('Put them in the notes folder instead')
  await d.shot('steps-02-say-why')
  await panel.getByRole('button', { name: 'Deny and tell Maris' }).click()
  await d.waitDone()
  const said = await d.lastAnswer()
  t.check(!existsSync(c) && !existsSync(e), 'neither file was written')
  t.check(/Put them in the notes folder instead/.test(said), 'the model was told what the person said')
  t.check(/Not run: the user denied an earlier action/.test(said), 'the second change was not run, and the model was told why')
  t.check((await win.getByText('You said: Put them in the notes folder instead').count()) > 0, 'the denied action shows what was said')
  t.check((await win.getByText('Not run, because you said no to the step before it.').count()) > 0, 'the skipped action says why it did not run')
  await d.shot('steps-03-denied')

  // ---- A long result reaches the model word for word in the next message too (so it reuses what it read).
  await d.newChat()
  const long = path.join(work, 'long.txt')
  writeFileSync(long, Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'))
  const before = mock.requests.length
  await d.send(`Read the file ${long} and reply`)
  await d.waitDone()
  await d.send('17 × 23')
  await d.waitDone()
  const toolMsgs = mock.requests
    .slice(before)
    .filter((r) => r.path === '/api/chat' && !r.body.format)
    .map((r) => (r.body.messages ?? []).find((m) => m.role === 'tool')?.content)
    .filter(Boolean)
  t.check(
    toolMsgs.length >= 2 && toolMsgs[0].length > 6500 && toolMsgs.every((c) => c === toolMsgs[0]),
    `a long result reaches the model the same in later messages (${toolMsgs.map((c) => c.length).join(', ')} characters)`
  )
} catch (err) {
  t.check(false, String(err))
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
console.log(t.failures ? `\n${t.failures} check(s) failed` : '\nAll step checks passed')
process.exit(t.failures ? 1 : 0)
