// Footage for the trailer, shot from the real app: nothing in the film is drawn to look like Maris.
// Usage: npm run dist:dir && node scripts/trailer/capture.mjs [chat] [project] [models] [laptop]
//
// The window is 768 x 600 with the sidebar closed (the smallest desktop layout), photographed at two
// or three times the size, so the interface is large and sharp in a 1080p frame.
//   chat     a question typed and answered by a model in Ollama on this computer
//   project  Code mode: a task that needs a file changed, the approval request, the OK, the change
//   models   the Models page: services that can be added with an API key
//   laptop   the setup assistant on a simulated 2012 laptop (MARIS_FAKE_SCAN), with stand-in services
// Typing is recorded one frame per character, so the film can set its rhythm. Answers are filmed in
// real time, at the speed the model really writes (a screencast of the window, which is made
// 1536 x 1200 with everything at double size for it), and the film replays those frames by their
// times. A model does not answer the same way twice, so a scene is shot again (up to five takes)
// until the take suits the film: a short answer in the chat, and in the project a request to change
// the file as the first thing that needs approval. Every profile is a throwaway one, the window
// material is "Solid" (the see-through materials cannot be filmed in their true colours), and the
// graphics-card readings in the status bar are stand-in values, so the footage says nothing about
// the computer it was made on.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { makeProfile, removeProfile, root } from '../../tests/e2e/fixtures/app.mjs'
import { startMockLlm } from '../../tests/e2e/fixtures/mock-llm.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const footage = path.join(here, 'footage')
const parts = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['chat', 'project', 'models', 'laptop'])
process.env.MARIS_EXE ??= path.join(root, 'release', 'windows', 'win-unpacked', 'Maris.exe')

const W = 768
const H = 600
const TAKES = 5
const GPU = JSON.stringify({ name: 'Graphics card', utilization: 6, memUsedMB: 2900, memTotalMB: 12288, temperatureC: 44 })
const QUESTION = 'What can you do for me on this PC? Three short bullet points.'
const TASK = 'Add a to_fahrenheit function to forecast.py'
const FORECAST = `"""Tiny helpers for my weather notes."""


def describe(temp_c):
    """Say in one word how a temperature feels."""
    if temp_c < 5:
        return "cold"
    if temp_c < 18:
        return "mild"
    return "warm"
`
const LOOK = { status: { ram: false, vram: false, temp: false, power: false, models: false, load: false }, material: 'solid' }

/**
 * Starts Maris with a throwaway profile, like the tests do, but leaves the window's size alone:
 * the tests pin the page to 1320 x 860, and a pinned page cannot be filmed at double size.
 */
async function launch(profile, env = {}) {
  const app = await electron.launch({ executablePath: process.env.MARIS_EXE, args: [], env: { ...process.env, MARIS_USER_DATA: profile, ...env }, timeout: 90000 })
  app.process().stdout?.on('data', () => undefined)
  app.process().stderr?.on('data', () => undefined)
  const win = await app.firstWindow()
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 60000 })
  return { app, win }
}

/** The camera: stills, typing one frame per character, and real-time film of the window. */
async function camera(app, win, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cdp = await win.context().newCDPSession(win)
  const zoom = (n) => app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), n)
  // The real window at 1536 x 1200 with everything doubled: 768 x 600 to the page, two pixels a point.
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(400, 300)
    win.setContentSize(w, h)
    win.setPosition(8, 8)
  }, [W * 2, H * 2])
  await zoom(2)
  await win.waitForTimeout(700)
  const seen = await win.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])
  if (seen[0] !== W || seen[1] !== H || seen[2] !== 2) throw new Error(`the window is ${seen.join(' x ')}, not ${W} x ${H} x 2 (is the screen at least ${W * 2} x ${H * 2}?)`)
  const grab = async (file, png = false) => {
    const r = await cdp.send('Page.captureScreenshot', png ? { format: 'png' } : { format: 'jpeg', quality: 93 })
    writeFileSync(path.join(dir, file), Buffer.from(r.data, 'base64'))
    return file
  }
  const painted = () => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const box = async (locator) => {
    const b = await locator.first().boundingBox({ timeout: 3000 }).catch(() => null)
    return b ? { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 } : null
  }
  /**
   * A still at three pixels a point, for shots the film moves in on. `pose` puts the page and the
   * pointer the way the shot wants them (changing the scale can move a scrolled page), and `measure`
   * reads positions while the page is exactly as photographed.
   */
  const still = async (name, pose, measure) => {
    await zoom(1)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 3, mobile: false })
    await win.waitForTimeout(350)
    if (pose) await pose()
    await win.waitForTimeout(300)
    await painted()
    const measured = measure ? await measure() : undefined
    await grab(`${name}.png`, true)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await zoom(2)
    await win.waitForTimeout(350)
    if (pose) await pose()
    await win.waitForTimeout(200)
    console.log('  still', name)
    return { file: `${name}.png`, ...(measured ? { boxes: measured } : {}) }
  }
  /**
   * Film: every frame the window paints, with the second it was painted. While nothing on the page
   * has changed for a moment (a spinner turning during a long wait) a few frames a second are enough.
   * `words` is the text of the page each time it changed, to find the moments afterwards.
   */
  const film = async (prefix) => {
    const frames = []
    const words = []
    const writes = []
    const t0 = Date.now() / 1000
    const now = () => Math.round((Date.now() / 1000 - t0) * 1000) / 1000
    let lastChange = 0
    let lastKept = -1
    let n = 0
    let lively = false
    const onFrame = (f) => {
      const t = Math.round((f.metadata.timestamp - t0) * 1000) / 1000
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
      const busy = lively || t - lastChange < 0.6
      if (n >= 1500 || t - lastKept < (busy ? 1 / 50 : 1 / 4)) return
      lastKept = t
      const file = `${prefix}${String(n++).padStart(4, '0')}.jpg`
      frames.push({ t, file })
      writes.push(writeFile(path.join(dir, file), Buffer.from(f.data, 'base64')))
    }
    cdp.on('Page.screencastFrame', onFrame)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, everyNthFrame: 1, maxWidth: W * 2, maxHeight: H * 2 })
    let on = true
    const reader = (async () => {
      let last
      while (on) {
        const text = await win.evaluate(() => document.body.innerText).catch(() => undefined)
        if (text !== undefined && text !== last) {
          lastChange = now()
          words.push({ t: lastChange, text })
          last = text
        }
        await new Promise((r) => setTimeout(r, 60))
      }
    })()
    return {
      now,
      /** Keep every frame for a while (a scroll changes no text). */
      lively: (yes) => (lively = yes),
      stop: async () => {
        on = false
        await reader
        await cdp.send('Page.stopScreencast')
        cdp.off('Page.screencastFrame', onFrame)
        await Promise.all(writes)
        return { frames, words }
      },
      /** Throw the take away. */
      scrap: async () => {
        on = false
        await reader
        await cdp.send('Page.stopScreencast').catch(() => undefined)
        cdp.off('Page.screencastFrame', onFrame)
        await Promise.all(writes)
        for (const f of frames) rmSync(path.join(dir, f.file), { force: true })
      }
    }
  }
  /** One frame before typing, then one after every character. */
  const type = async (prefix, text) => {
    const frames = [await grab(`${prefix}000.jpg`)]
    for (let i = 0; i < text.length; i++) {
      await win.keyboard.type(text[i])
      await painted()
      frames.push(await grab(`${prefix}${String(i + 1).padStart(3, '0')}.jpg`))
    }
    return frames
  }
  return { grab, still, box, film, type, painted }
}

const sidebar = (win, open) =>
  win.evaluate((want) => {
    const s = window.__marisStore.getState()
    if (s.sidebarOpen !== want) s.toggleSidebar()
  }, open)
const composer = (win) => win.locator('textarea[aria-label="Message Maris"]')
const stopButton = (win) => win.locator('button[aria-label="Stop"]')
const done = async (win, timeout = 240000) => {
  await stopButton(win).waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined)
  await stopButton(win).waitFor({ state: 'detached', timeout })
}
/** The text caret blinks in real time; in a retimed recording that reads as a flicker. */
const CARET = 'trailer-no-caret'
const caret = (win, show) =>
  win.evaluate(
    ([id, show]) => {
      document.getElementById(id)?.remove()
      if (show) return
      const s = document.createElement('style')
      s.id = id
      s.textContent = '* { caret-color: transparent !important; }'
      document.head.append(s)
    },
    [CARET, show]
  )
const save = (name, data) => writeFileSync(path.join(footage, `${name}.json`), JSON.stringify(data, null, 1))
const close = async (app, profile) => {
  await app.close().catch(() => undefined)
  try {
    removeProfile(profile)
  } catch {
    /* still held for a moment */
  }
}

async function chat() {
  const profile = makeProfile('trailer-chat', { ui: LOOK })
  const { app, win } = await launch(profile, { MARIS_TEST_GPU: GPU })
  try {
    const cam = await camera(app, win, path.join(footage, 'chat'))
    await sidebar(win, false)
    // The same question is asked once before the recording: that loads the model Auto picks for it,
    // so the recorded answer comes as fast as every answer after the first one does.
    await composer(win).fill(QUESTION)
    await composer(win).press('Enter')
    await done(win)
    for (let take = 1; take <= TAKES; take++) {
      await win.keyboard.press('Control+n')
      await win.waitForTimeout(900)
      await sidebar(win, false)
      await caret(win, true)
      await win.waitForTimeout(500)
      await cam.grab('home.png', true)
      await composer(win).click()
      const typing = await cam.type('type-', QUESTION)
      await caret(win, false)
      const rec = await cam.film('ans-')
      await win.waitForTimeout(400)
      const marks = { sent: rec.now() }
      await composer(win).press('Enter')
      await win.locator('.prose-maris').first().waitFor({ timeout: 240000 })
      marks.answering = rec.now()
      await done(win)
      marks.done = rec.now()
      await win.waitForTimeout(1500)
      const answer = await win.locator('.prose-maris').last().innerText()
      const bullets = await win.locator('.prose-maris').last().locator('li').count()
      // A take for the film: three bullets that fit the window without scrolling, and nobody's name.
      const fits = bullets === 3 && answer.length <= 560 && !new RegExp(os.userInfo().username, 'i').test(answer) && marks.done - marks.sent < 6
      console.log(`  take ${take}: ${answer.length} characters, ${bullets} bullets, ${(marks.done - marks.sent).toFixed(1)} s${fits ? '' : ' (not used)'}`)
      if (!fits && take < TAKES) {
        await rec.scrap()
        continue
      }
      const { frames, words } = await rec.stop()
      const final = await cam.still('final', () => win.mouse.move(700, 80), async () => ({
        chip: await cam.box(win.getByText(/^Auto:/)),
        took: await cam.box(win.getByText(/^Answered in/)),
        answer: await cam.box(win.locator('.prose-maris').last()),
        composer: await cam.box(composer(win))
      }))
      save('chat', { w: W, h: H, question: QUESTION, typing, marks, frames, words, final, answer, take })
      console.log(`chat: ${typing.length} typing frames, ${frames.length} answer frames over ${frames.at(-1).t} s`, JSON.stringify(marks), JSON.stringify(final.boxes))
      console.log(`--- answer ---\n${answer}\n`)
      break
    }
  } finally {
    await close(app, profile)
  }
}

/** One try at the project scene. False when the model went another way than the film shows. */
async function projectTake() {
  const dir = path.join(os.tmpdir(), 'Weather Notes')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'forecast.py'), FORECAST)
  const profile = makeProfile('trailer-project', { ui: LOOK })
  const { app, win } = await launch(profile, { MARIS_TEST_GPU: GPU })
  try {
    const cam = await camera(app, win, path.join(footage, 'project'))
    await win.getByRole('radio', { name: 'Code' }).click()
    await win.evaluate((p) => window.maris.project.open(p), dir)
    await win.evaluate((p) => window.__marisStore.getState().openProject(p), dir)
    await win.locator('textarea[placeholder*="Weather Notes"]').waitFor({ timeout: 30000 })
    await sidebar(win, false)
    const hide = win.getByRole('button', { name: 'Hide project panel' })
    if (await hide.count()) await hide.click()
    await win.waitForTimeout(700)
    await cam.grab('home.png', true)
    await composer(win).click()
    const typing = await cam.type('type-', TASK)
    await caret(win, false)

    // From sending the task to the request for approval.
    const rec = await cam.film('work-')
    await win.waitForTimeout(400)
    const marks = { sent: rec.now() }
    await composer(win).press('Enter')
    const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
    const asked = panel.waitFor({ timeout: 90000 }).then(() => true, () => false)
    // Maris folds what it did into one row ("Worked for 1 s · 1 step"). The row is opened the moment
    // it shows, so the footage shows what was read: "Read forecast.py".
    const boxes = {}
    const steps = win.getByText(/\d+ steps?/).first()
    steps.waitFor({ timeout: 90000 }).then(
      async () => {
        marks.steps = rec.now()
        await steps.click()
        await win.waitForTimeout(250)
        marks.opened = rec.now()
        boxes.read = await cam.box(win.getByText(/^Read forecast\.py/))
        await win.mouse.move(700, 80)
      },
      () => undefined
    )
    await Promise.race([win.locator('.prose-maris').first().waitFor({ timeout: 90000 }).catch(() => undefined), asked])
    marks.firstWords = rec.now()
    if (!(await asked)) {
      console.log('  not used: no request for approval within a minute and a half')
      await rec.scrap()
      return false
    }
    marks.asked = rec.now()
    await win.waitForTimeout(1300)
    const asks = (await panel.innerText()).replace(/\n+/g, ' | ')
    console.log('  asks:', asks.slice(0, 160))
    // The film shows Maris reading the file, then asking to change it: a take needs both, in that order.
    const wrong = !/^Maris wants to change forecast\.py/.test(asks) ? 'the first request is not the change to forecast.py' : !boxes.read || !(marks.opened < marks.asked - 0.4) ? 'no "Read forecast.py" step was on screen before the request' : ''
    if (wrong) {
      console.log(`  not used: ${wrong}`, JSON.stringify(marks))
      await rec.scrap()
      return false
    }
    await win.mouse.move(700, 80)
    const work = await rec.stop()
    // The opened steps are folded away again before the request is photographed: once the request is
    // up, the list also names the change it is waiting for, and the film shows the request itself.
    await win.getByText('Waiting for your OK').first().click()
    await win.waitForTimeout(400)

    const approve = panel.getByRole('button', { name: 'Approve' })
    const off = () => win.mouse.move(700, 80)
    // Changing the scale for a still moves a scrolled page a little: back to the very end each time.
    const bottom = () =>
      panel.evaluate((el) => {
        let box = el.parentElement
        while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
        if (box) box.scrollTop = box.scrollHeight
      })
    const away = async () => {
      await bottom()
      await off()
    }
    const where = async () => ({
      panel: await cam.box(panel),
      approve: await cam.box(approve),
      deny: await cam.box(panel.getByRole('button', { name: 'Deny' })),
      title: await cam.box(panel.getByText(/^Maris wants to/)),
      waiting: await cam.box(win.getByText('Waiting for your OK')),
      bar: await cam.box(win.getByText(/waiting for your OK on one action/))
    })
    const stills = { ask: await cam.still('ask', away, where) }
    stills.hover = await cam.still('ask-hover', async () => {
      await bottom()
      await approve.hover()
    }, where)
    await bottom()

    // The OK, and what happens after it.
    await approve.hover()
    await win.waitForTimeout(300)
    const rec2 = await cam.film('after-')
    await win.waitForTimeout(400)
    marks.clicked = rec2.now()
    await approve.click()
    const finished = await done(win, 90000).then(() => true, () => false)
    const file = readFileSync(path.join(dir, 'forecast.py'), 'utf8')
    const failed = !finished ? 'it did not finish (a second request?)' : !file.includes('to_fahrenheit') ? 'the file has no to_fahrenheit' : ''
    if (failed) {
      console.log(`  not used: ${failed}`)
      await rec2.scrap()
      return false
    }
    marks.finished = rec2.now()
    await off()
    await win.waitForTimeout(1500)
    const after = await rec2.stop()
    stills.finished = await cam.still('finished', off)
    const answer = await win.locator('.prose-maris').last().innerText().catch(() => '')

    // The record of what changed: the Changes list, then the change itself.
    const show = win.getByRole('button', { name: 'Show project panel' })
    if (await show.count()) await show.click()
    const side = win.locator('aside[aria-label="Project"]')
    await side.getByRole('radio', { name: /^Changes/ }).click()
    await win.waitForTimeout(700)
    stills.changes = await cam.still('changes', off, async () => ({
      side: await cam.box(side),
      undo: await cam.box(side.getByRole('button', { name: 'Undo' })),
      see: await cam.box(side.getByRole('button', { name: /See the change/ })),
      name: await cam.box(side.getByText('forecast.py').first())
    }))
    await side.getByRole('button', { name: /See the change/ }).first().click()
    await win.getByText('Green lines were added, red lines removed.').waitFor({ state: 'attached', timeout: 10000 })
    await win.waitForTimeout(600)
    stills.diff = await cam.still('diff', off, async () => ({ dialog: await cam.box(win.getByRole('dialog')) }))
    await win.keyboard.press('Escape')
    save('project', { w: W, h: H, task: TASK, typing, marks, work, after, stills, boxes, asks, answer, before: FORECAST, file })
    console.log(`project: ${typing.length} typing frames, ${work.frames.length} frames to the request (${work.frames.at(-1).t} s), ${after.frames.length} after the OK (${after.frames.at(-1).t} s)`, JSON.stringify(marks))
    console.log('  ask', JSON.stringify(stills.ask.boxes), '\n  hover', JSON.stringify(stills.hover.boxes), '\n  changes', JSON.stringify(stills.changes.boxes))
    console.log(`--- answer ---\n${answer}\n`)
    return true
  } finally {
    await close(app, profile)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function project() {
  for (let take = 1; take <= TAKES + 3; take++) {
    if (await projectTake()) return
    console.log(`  take ${take} went another way than the film shows`)
  }
  throw new Error('no usable take of the project scene')
}

async function models() {
  const profile = makeProfile('trailer-models', { ui: LOOK })
  const { app, win } = await launch(profile, { MARIS_TEST_GPU: GPU })
  try {
    const cam = await camera(app, win, path.join(footage, 'models'))
    await win.getByRole('button', { name: 'Models', exact: true }).click()
    await win.getByRole('tab', { name: /API/ }).click()
    await sidebar(win, false)
    await win.waitForTimeout(600)
    const names = ['Claude (Anthropic)', 'OpenAI (GPT)', 'Google Gemini', 'OpenRouter', 'Groq', 'Mistral', 'DeepSeek', 'xAI (Grok)', 'LM Studio', 'llama.cpp server', 'Other service']
    // "Add a service" 126 points below the top edge: the line above it ("...you need an account with the
    // service and its API key") is in view, and the bottom edge falls between two rows of services.
    const pose = async () => {
      await win.getByRole('heading', { name: 'Add a service' }).evaluate((el) => {
        el.scrollIntoView({ block: 'start' })
        let box = el.parentElement
        while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
        box?.scrollBy(0, el.getBoundingClientRect().top - 126)
        document.activeElement?.blur?.()
      })
      await win.mouse.move(384, 24)
    }
    // Each service is a card; its box is the smallest ancestor of the name that is card-sized.
    const cards = () =>
      win.evaluate((names) => {
        const out = {}
        for (const name of names) {
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let card
          for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.trim() === name) card = n.parentElement
          while (card && (card.getBoundingClientRect().width < 250 || card.getBoundingClientRect().height < 56)) card = card.parentElement
          const r = card?.getBoundingClientRect()
          if (r) out[name] = { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
        }
        return out
      }, names)
    const api = await cam.still('api', pose, cards)
    save('models', { w: W, h: H, api })
    console.log('models:', JSON.stringify(api.boxes))
  } finally {
    await close(app, profile)
  }
}

async function laptop() {
  const scan = {
    ts: 0,
    os: 'Windows 10 Pro (build 19045)',
    disks: [{ root: 'C:\\', freeGB: 60, totalGB: 238, fs: 'NTFS' }],
    laptop: true,
    gpus: [],
    ollama: { installed: false, running: false, models: [], modelsDir: 'C:\\Users\\you\\.ollama\\models' },
    comfy: { installed: false },
    winget: true,
    notes: [],
    cpu: { name: 'Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz', cores: 2, threads: 4, avx2: false, avx512: false },
    ram: { totalMB: 4 * 1024, freeMB: 1700, speedMTs: 1600, type: 'DDR3', bandwidthGBs: 21 }
  }
  const file = path.join(os.tmpdir(), 'maris-trailer-old-laptop.json')
  writeFileSync(file, JSON.stringify(scan))
  const mock = await startMockLlm()
  const profile = makeProfile('trailer-laptop', { onboarded: false, ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, ui: LOOK })
  const { app, win } = await launch(profile, { MARIS_FAKE_SCAN: file })
  try {
    const cam = await camera(app, win, path.join(footage, 'laptop'))
    await win.getByRole('heading', { name: 'Here is what this PC has' }).waitFor({ timeout: 60000 })
    const cont = win.getByRole('button', { name: 'Continue' })
    for (let i = 0; i < 40 && !(await cont.isEnabled()); i++) await win.waitForTimeout(250)
    await win.waitForTimeout(400)
    const away = () => win.mouse.move(380, 20)
    const stills = {
      scan: await cam.still('scan', away, async () => ({
        memory: await cam.box(win.getByText('4 GB DDR3')),
        graphics: await cam.box(win.getByText(/^No dedicated/)),
        processor: await cam.box(win.getByText(/^Intel\(R\)/))
      }))
    }
    await cont.click()
    await win.getByRole('heading', { name: 'Where should models run?' }).waitFor()
    await win.getByRole('button', { name: 'See recommended models' }).click()
    await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
    await win.waitForTimeout(500)
    stills.picks = await cam.still('picks', away, async () => ({ fast: await cam.box(win.locator('select[aria-label$=" model"]').first()), heading: await cam.box(win.getByRole('heading', { name: 'Recommended for this PC' })) }))
    const page = await win.locator('[aria-label="Set up Maris"]').innerText()
    save('laptop', { w: W, h: H, stills, scan, page })
    console.log('laptop:', JSON.stringify(stills.scan.boxes), JSON.stringify(stills.picks.boxes), page.replace(/\n+/g, ' | ').slice(0, 300))
  } finally {
    await close(app, profile)
    await mock.close().catch(() => undefined)
    rmSync(file, { force: true })
  }
}

mkdirSync(footage, { recursive: true })
for (const [name, run] of Object.entries({ chat, project, models, laptop })) {
  if (!parts.has(name)) continue
  console.log(`== ${name}`)
  await run()
}
