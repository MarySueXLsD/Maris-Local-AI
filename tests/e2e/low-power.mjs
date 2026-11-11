// A slow computer: what the setup assistant recommends for an old laptop, and what low-power mode
// sends to a small model (short instructions, few tools, tools as text for a model without tool calling).
// Usage: npm run build && node tests/e2e/low-power.mjs <shotsDir>   (MARIS_EXE as in the other tests)
// Nothing is installed or downloaded: the PC is simulated (MARIS_FAKE_SCAN) and fixtures/mock-llm.mjs
// stands in for Ollama.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const only = new Set(process.argv.slice(3))
const wants = (step) => !only.size || only.has(step)
const work = path.join(shots, 'lite-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'notes.txt'), 'n')
writeFileSync(path.join(work, 'todo.md'), 't')
const t = checker()

// A 2012 business laptop and a 2018 office laptop, as the hardware scan would describe them.
const scanBase = {
  ts: 0,
  os: 'Windows 10 Pro (build 19045)',
  disks: [{ root: 'C:\\', freeGB: 60, totalGB: 238, fs: 'NTFS' }],
  laptop: true,
  gpus: [],
  ollama: { installed: false, running: false, models: [], modelsDir: 'C:\\Users\\you\\.ollama\\models' },
  comfy: { installed: false },
  winget: true,
  notes: []
}
const PCS = {
  'old-laptop-4gb': { ...scanBase, cpu: { name: 'Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz', cores: 2, threads: 4, avx2: false, avx512: false }, ram: { totalMB: 4 * 1024, freeMB: 1700, speedMTs: 1600, type: 'DDR3', bandwidthGBs: 21 } },
  'office-laptop-8gb': { ...scanBase, cpu: { name: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', cores: 4, threads: 8, avx2: true, avx512: false }, ram: { totalMB: 8 * 1024, freeMB: 3600, speedMTs: 2400, type: 'DDR4', bandwidthGBs: 38 } }
}

const mock = await startMockLlm()
const profiles = []
try {
  // ------------------------------------------------------------ what setup recommends
  if (wants('setup')) {
    for (const [name, scan] of Object.entries(PCS)) {
      const file = path.join(os.tmpdir(), `maris-fake-scan-${name}.json`)
      writeFileSync(file, JSON.stringify(scan))
      const profile = makeProfile(`lite-setup-${name}`, { onboarded: false, ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy` })
      profiles.push(profile)
      const { app, win } = await launch(profile, { MARIS_FAKE_SCAN: file })
      try {
        await win.getByRole('heading', { name: 'Here is what this PC has' }).waitFor({ timeout: 60000 })
        const cont = win.getByRole('button', { name: 'Continue' })
        for (let i = 0; i < 40 && !(await cont.isEnabled()); i++) await win.waitForTimeout(250)
        await win.screenshot({ path: path.join(shots, `lite-${name}-1-scan.png`) })
        await cont.click()
        await win.getByRole('heading', { name: 'Where should models run?' }).waitFor()
        await win.waitForTimeout(300)
        await win.screenshot({ path: path.join(shots, `lite-${name}-2-where.png`) })
        await win.getByRole('button', { name: 'See recommended models' }).click()
        await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
        await win.waitForTimeout(400)
        await win.screenshot({ path: path.join(shots, `lite-${name}-3-models.png`) })
        const picks = await win.evaluate(() =>
          [...document.querySelectorAll('select[aria-label$=" model"]')].map((s) => `${s.getAttribute('aria-label').replace(' model', '')}: ${s.selectedOptions[0]?.textContent ?? '?'}`)
        )
        const page = await win.locator('[aria-label="Set up Maris"]').innerText()
        console.log(`\n${name}\n${picks.map((p) => `  ${p}`).join('\n')}`)
        t.check(picks.length > 0 && picks.every((p) => !/\b(1[0-9]|[2-9][0-9])(\.\d)?B\b/.test(p)), `${name}: only small models are recommended`)
        t.check(/low-power|slow|small/i.test(page), `${name}: the page says why these models were chosen`)
        t.check(/Lite|lite|true/.test(String(await win.evaluate(() => window.maris.system.status().then((s) => s.lite)))), `${name}: low-power mode is on by itself`)
        t.check((await win.evaluate(() => document.documentElement.dataset.lite)) !== undefined, `${name}: the interface is in its plain form`)
      } catch (e) {
        t.check(false, `${name}: ${e.message}`)
        await win.screenshot({ path: path.join(shots, `lite-${name}-error.png`) }).catch(() => undefined)
      }
      await app.close().catch(() => undefined)
    }
  }

  // ------------------------------------------------------------ chatting in low-power mode
  if (wants('chat')) {
    // gemma3:1b has no tool calling of its own (as in Ollama); qwen3:0.6b has tools and thinking.
    mock.addLocalModel('gemma3:1b', { sizeGB: 0.8, caps: ['completion'], ctx: 32768, family: 'gemma3', params: '1B' })
    mock.addLocalModel('qwen3:0.6b', { sizeGB: 0.5, caps: ['completion', 'tools', 'thinking'], ctx: 40960, family: 'qwen3', params: '752M' })
    const one = (m) => ({ tiny: m, fast: m, balanced: m, max: m })
    const profile = makeProfile('lite-chat', {
      ollamaUrl: mock.url,
      comfyUrl: `${mock.url}/comfy`,
      tiers: one('gemma3:1b'),
      engine: { profile: 'lite', processing: 'cpu' },
      routing: { contextByTier: { tiny: 4096, fast: 4096, balanced: 4096, max: 4096 } }
    })
    profiles.push(profile)
    const { app, win, logs } = await launch(profile)
    const d = driver(win, shots)
    try {
      await win.waitForTimeout(2500)
      t.check((await win.evaluate(() => document.documentElement.dataset.lite)) !== undefined, 'low-power mode puts the interface in its plain form')
      t.check((await win.getByText('Low-power').count()) > 0, 'the status bar says low-power mode is on')
      await d.shot('lite-01-home')

      // ---- a plain message: one request, short instructions
      await d.send('Hello there')
      await d.waitDone()
      await win.waitForTimeout(1500)
      const hello = mock.of('gemma3:1b')
      t.check(/Hello from gemma3:1b/.test(await d.lastAnswer()), `a small model answers: ${(await d.lastAnswer()).slice(0, 60)}`)
      t.check(hello.length === 1, `one model call for one message, no helper calls (${hello.length})`)
      const sys = hello[0].body.messages[0].content
      const toolsIn = (text) => [...text.matchAll(/^- ([\w.-]+)\(/gm)].map((m) => m[1])
      t.check(!hello[0].body.tools && toolsIn(sys).length === 0, 'a greeting carries no tools at all')
      t.check(sys.length < 1500, `its instructions are a few lines (${sys.length} characters, about ${Math.round(sys.length / 4)} tokens)`)
      t.check(hello[0].body.options.num_ctx <= 8192 && hello[0].body.options.num_gpu === 0, `a small window on the processor (${hello[0].body.options.num_ctx})`)
      t.check(hello[0].body.think === undefined, 'no thinking option for a model that cannot think')
      const title = await win.locator('header, [data-testid="chat-title"]').first().innerText().catch(() => '')
      console.log(`  title: ${title.replace(/\s+/g, ' ').slice(0, 60)}`)

      // ---- a tool through text
      await d.newChat()
      await d.send(`List the files in this folder: ${work}`)
      await d.waitDone()
      const page = await win.locator('main').innerText()
      t.check(/notes\.txt/.test(await d.lastAnswer()) && /todo\.md/.test(await d.lastAnswer()), 'the small model uses a tool written as text and gets real results')
      t.check(!/INVENTED|<tool_call>|<tool_result/.test(page), 'the call block never shows in the chat')
      const asked = mock.of('gemma3:1b')[1].body
      const offered = toolsIn(asked.messages[0].content)
      t.check(!asked.tools && offered.length > 0 && offered.length <= 12, `a model without tool calling gets a few tools as text (${offered.join(', ')})`)
      t.check(asked.messages[0].content.length < 6000, `with instructions that stay short (${asked.messages[0].content.length} characters)`)
      const step2 = mock.of('gemma3:1b').pop().body
      t.check(/<tool_result name="list_dir">/.test(step2.messages[step2.messages.length - 1].content) && step2.messages[step2.messages.length - 1].role === 'user', 'the result goes back as text')
      await d.shot('lite-02-text-tool')

      // ---- a model with tool calling of its own: few tools, one sentence each
      await d.setSettings({ tiers: one('qwen3:0.6b') })
      await win.waitForTimeout(600)
      await d.newChat()
      await d.send(`List the files in this folder: ${work}`)
      await d.waitDone()
      const q = mock.of('qwen3:0.6b')[0].body
      t.check(Array.isArray(q.tools) && q.tools.length > 0 && q.tools.length <= 12, `a model with tool calling gets a short tool list (${q.tools?.length}: ${q.tools?.map((x) => x.function.name).join(', ')})`)
      t.check(q.tools.every((x) => x.function.description.length <= 170), 'each tool is described in one sentence')
      t.check(/notes\.txt/.test(await d.lastAnswer()), 'and uses them')
      const liteTokens = Math.round((q.messages[0].content.length + JSON.stringify(q.tools).length) / 4)

      // ---- the same message with low-power mode off: everything is sent
      await d.setSettings({ engine: { profile: 'standard' } })
      await win.waitForTimeout(2500)
      await d.newChat()
      await d.send(`List the files in this folder: ${work}`)
      await d.waitDone()
      const full = mock.of('qwen3:0.6b').filter((r) => r.body.tools?.length > 20)[0]?.body
      const fullTokens = full ? Math.round((full.messages[0].content.length + JSON.stringify(full.tools).length) / 4) : 0
      t.check(full && fullTokens > liteTokens * 2.5, `low-power mode sends a fraction of the usual prompt (about ${liteTokens} tokens instead of ${fullTokens})`)
      t.check((await win.evaluate(() => document.documentElement.dataset.lite)) === undefined, 'turning it off brings the full interface back')
      await d.shot('lite-03-standard')
    } catch (e) {
      t.check(false, `stopped: ${e.message}`)
      await d.shot('lite-99-error').catch(() => undefined)
    }
    const errs = logs.filter((l) => /\berror\b|exception|unhandled|pageerror/i.test(l) && !/DevTools|GPU process|Autofill/i.test(l)).slice(-20)
    if (errs.length) console.log(`--- app log (errors) ---\n${errs.join('\n')}`)
    await app.close().catch(() => undefined)
  }
} finally {
  await mock.close()
  for (const p of profiles) {
    try {
      removeProfile(p)
    } catch {
      /* still held for a moment */
    }
  }
  console.log(t.failures ? `${t.failures} check(s) failed` : 'all checks passed')
  process.exit(t.failures ? 1 : 0)
}
