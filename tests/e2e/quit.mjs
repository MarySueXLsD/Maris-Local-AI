// Closing Maris: it asks first when an answer is still being written, and then closes completely:
// the answer is stopped, models leave memory and (when the setting is on) the Ollama server is stopped.
// With "keep running in the tray" it stays, and frees the graphics card's memory after a minute.
// Usage: npm run build && node tests/e2e/quit.mjs <shotsDir>   (MARIS_EXE as in the other tests)
// The real Ollama of this computer is never touched: fixtures/mock-llm.mjs stands in for the server,
// and two idle stand-in programs stand in for its processes.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const only = new Set(process.argv.slice(3))
const wants = (step) => !only.size || only.has(step)
const t = checker()
const WIN = process.platform === 'win32'
const MODEL = 'mock-local:1b'

const mock = await startMockLlm()
mock.addLocalModel(MODEL, { caps: ['completion', 'tools'] })
const base = { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, tiers: { tiny: MODEL, fast: MODEL, balanced: MODEL, max: MODEL } }

// ---- stand-ins for "ollama app.exe" and "ollama.exe" (Windows): copies of Node that just wait.
const IMAGES = ['maris-test-ollama app.exe', 'maris-test-ollama.exe']
const standDir = path.join(os.tmpdir(), `maris-e2e-standins-${Date.now()}`)
const running = (image) => WIN && execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8' }).toLowerCase().includes(image.toLowerCase())
const startStandIns = () => {
  if (!WIN) return
  mkdirSync(standDir, { recursive: true })
  for (const image of IMAGES) {
    if (running(image)) continue
    const exe = path.join(standDir, image)
    copyFileSync(process.execPath, exe)
    spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
}
const stopStandIns = () => {
  if (!WIN) return
  for (const image of IMAGES) {
    try {
      execFileSync('taskkill', ['/F', '/IM', image], { stdio: 'ignore' })
    } catch {
      /* not running */
    }
  }
  rmSync(standDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
// Under a test harness Maris closes without asking; this test is about the question, so it asks for it.
const env = { MARIS_TEST_OLLAMA_IMAGES: IMAGES.join(';'), MARIS_TEST_QUIT_PROMPT: '1' }

/** Answer the "close anyway?" question without a person: record it and press the given button. */
const answerWith = (app, button) =>
  app.evaluate(({ dialog, Notification }, button) => {
    globalThis.__asked = []
    dialog.showMessageBoxSync = (...args) => {
      const box = args[args.length - 1]
      globalThis.__asked.push({ message: box.message, detail: box.detail, buttons: box.buttons })
      return button
    }
    // No "still running in the tray" toast on the desktop of whoever runs the tests.
    Notification.isSupported = () => false
  }, button)
const asked = (app) => app.evaluate(() => globalThis.__asked ?? [])
const closeWindow = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined)
const windowVisible = (app) => app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()))
const within = (promise, ms) => Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))])
const until = async (fn, ms) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const profiles = []
try {
  startStandIns()
  if (WIN) t.check(IMAGES.every(running), 'stand-in server programs are running')

  // ------------------------------------------------------------ nothing going on: no question
  if (wants('idle')) {
    const profile = makeProfile('quit-idle', base)
    profiles.push(profile)
    const { app, win, exited } = await launch(profile, env)
    const d = driver(win, shots)
    await d.send('Hello before closing')
    await d.waitDone()
    t.check(/Hello from mock-local/.test(await d.lastAnswer()), 'chatted with a model on this computer')
    t.check(mock.loadedModels().includes(MODEL), 'the model is in memory')
    await answerWith(app, 0)
    const t0 = Date.now()
    await closeWindow(app)
    const gone = await within(exited, 15000)
    t.check(gone, `with nothing going on, closing the window closes Maris (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    t.check(mock.counts.unloads.includes(MODEL) && !mock.loadedModels().length, 'its model was taken out of memory on the way out')
    if (WIN) t.check(IMAGES.every(running), 'the Ollama server is left alone when the setting is off')
    if (!gone) await app.close().catch(() => undefined)
  }

  // ------------------------------------------------------------ an answer is being written: ask
  if (wants('busy')) {
    mock.counts.unloads.length = 0
    const profile = makeProfile('quit-busy', base)
    profiles.push(profile)
    let { app, win, exited } = await launch(profile, env)
    let d = driver(win, shots)
    await d.send('SLOW-TEST please write for a long time')
    await win.getByText(/word3/).waitFor({ timeout: 30000 })
    await answerWith(app, 0)
    await closeWindow(app)
    await win.waitForTimeout(700)
    const q = await asked(app)
    t.check(q.length === 1 && /still working/.test(q[0].message) && /An answer is still being written/.test(q[0].detail), `closing while an answer is written asks first: "${q[0]?.detail?.replace(/\s+/g, ' ')}"`)
    t.check(q[0]?.buttons?.[0] === 'Keep Maris open' && q[0].buttons[1] === 'Close anyway', 'the safe choice comes first')
    t.check((await windowVisible(app)) && (await win.locator('button[aria-label="Stop"]').count()) === 1, '"Keep Maris open" keeps the window and the answer going')
    await d.shot('quit-01-still-writing')
    await answerWith(app, 1)
    const t0 = Date.now()
    await closeWindow(app)
    const gone = await within(exited, 20000)
    t.check(gone, `"Close anyway" closes Maris (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    t.check(mock.counts.slowAborted === 1, 'the answer was stopped at the engine')
    t.check(mock.counts.unloads.includes(MODEL), 'and the model unloaded')
    if (!gone) await app.close().catch(() => undefined)

    // What was written so far is still there the next time.
    ;({ app, win, exited } = await launch(profile, env))
    d = driver(win, shots)
    await win.getByText(/SLOW-TEST/).first().click()
    await win.getByText(/word3/).waitFor({ timeout: 15000 })
    t.check((await win.locator('button[aria-label="Stop"]').count()) === 0, 'after a restart the interrupted answer is kept and not shown as running')
    await d.shot('quit-02-after-restart')
    await answerWith(app, 0)
    await closeWindow(app)
    t.check(await within(exited, 15000), 'closes again')
  }

  // ------------------------------------------------------------ the Ollama server is stopped too
  if (wants('server') && WIN) {
    const profile = makeProfile('quit-server', { ...base, engine: { stopOllamaOnQuit: true } })
    profiles.push(profile)
    const { app, win, exited } = await launch(profile, env)
    await win.waitForTimeout(1500)
    t.check(IMAGES.every(running), 'the server programs run while Maris is open')
    await answerWith(app, 0)
    await closeWindow(app)
    const gone = await within(exited, 20000)
    t.check(gone, 'Maris closes')
    t.check(await until(() => !IMAGES.some(running), 6000), 'with the setting on, closing Maris stops the Ollama server and its tray app')
    if (!gone) await app.close().catch(() => undefined)
    startStandIns()
  }

  // ------------------------------------------------------------ a download is running: ask
  if (wants('download')) {
    const profile = makeProfile('quit-download', base)
    profiles.push(profile)
    const { app, win, exited } = await launch(profile, env)
    await win.evaluate(() => void window.maris.models.pull('qwen3:0.6b'))
    await until(() => mock.requests.some((r) => r.path === '/api/pull'), 10000)
    await answerWith(app, 0)
    await closeWindow(app)
    await win.waitForTimeout(700)
    const q = await asked(app)
    t.check(q.length === 1 && /download is still running/i.test(q[0].detail), `closing during a download asks first: "${q[0]?.detail?.replace(/\s+/g, ' ')}"`)
    await answerWith(app, 1)
    await closeWindow(app)
    t.check(await within(exited, 20000), 'and closes when told to')
  }

  // ------------------------------------------------------------ staying in the tray
  if (wants('tray')) {
    mock.counts.unloads.length = 0
    const profile = makeProfile('quit-tray', { ...base, ui: { closeToTray: true } })
    profiles.push(profile)
    const { app, win, exited } = await launch(profile, env)
    const d = driver(win, shots)
    await d.send('Hello before hiding')
    await d.waitDone()
    await answerWith(app, 0)
    await closeWindow(app)
    await new Promise((r) => setTimeout(r, 1500))
    t.check(!(await windowVisible(app)), 'with "keep running in the tray" the window only hides')
    t.check(mock.loadedModels().includes(MODEL), 'the model stays for a moment, in case the window comes right back')
    console.log('waiting for the hidden app to free memory (about a minute)…')
    t.check(await until(() => mock.counts.unloads.includes(MODEL), 90000), 'after a minute in the tray the model is taken out of memory')
    t.check(!(await within(exited, 500)), 'Maris itself keeps running')
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    t.check(await within(exited, 20000), 'Quit closes it')
  }
} catch (e) {
  t.check(false, `stopped: ${e.message}`)
} finally {
  stopStandIns()
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
