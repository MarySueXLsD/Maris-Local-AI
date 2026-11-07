// End-to-end test of this round's features on a packaged build:
//   Models → Pictures (examples, full-size view, details), the composer's Image mode, pictures in chat,
//   a busy graphics card (link to the chat that renders, unread dots, stop-and-delete), the context
//   meter, paths in answers, Code mode (New project, live file tree, file viewer and "Mention lines",
//   Changes), connectors, skills from git, the hand cursor, and the launcher's PATH helper.
// Needs a packaged build with the image engine installed (MARIS_DATA_DIR, default H:\MarisData). The
// test runs its own engine on port 8191 so a Maris you are using keeps its own.
// Usage: npm run dist:dir && MARIS_EXE=release\windows\win-unpacked\Maris.exe node tests/e2e/features.mjs <shotsDir>
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = process.env.MARIS_EXE
if (!exe) throw new Error('Set MARIS_EXE to a packaged Maris.exe')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const stamp = Date.now()
const profile = path.join(os.tmpdir(), `maris-features-${stamp}`)
const outputs = path.join(os.tmpdir(), `maris-features-out-${stamp}`)
const projects = path.join(os.tmpdir(), `maris-features-projects-${stamp}`)
mkdirSync(projects, { recursive: true })
const PORT = 8191
// FEATURES_SKIP_MEDIA=1 skips making pictures (for runs while the graphics card is busy).
const SKIP_MEDIA = process.env.FEATURES_SKIP_MEDIA === '1'

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

/** Another Maris's engine on the usual port: let it free the graphics card first. */
async function freeOtherEngine() {
  await fetch('http://127.0.0.1:8188/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(4000) }).catch(() => undefined)
}

const app = await electron.launch({ executablePath: exe, env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
const win = await app.firstWindow()
const shot = (name) => win.screenshot({ path: path.join(shots, `${name}.png`) })
const nav = (label) => win.getByRole('button', { name: label, exact: true }).click()
const store = (fn, arg) => win.evaluate(fn, arg)
const composer = win.locator('textarea[aria-label="Message Maris"]')
const waitAnswer = (timeout = 300000) => win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
try {
  await composer.waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  await store(
    ([dir, out, url]) => window.maris.settings.set({ dataDir: dir, comfyUrl: url, media: { outputDir: out, extraArgs: '--disable-assets' } }),
    [process.env.MARIS_DATA_DIR ?? 'H:\\MarisData', outputs, `http://127.0.0.1:${PORT}`]
  )

  // ---- the hand cursor on everything clickable
  const cursor = await win.evaluate(() => getComputedStyle(document.querySelector('button[aria-label^="Hide sidebar"]')).cursor)
  check(cursor === 'pointer', `buttons show the hand cursor (${cursor})`)

  // ---- Models → Pictures: examples made with each model, full size, details
  await nav('Models')
  check((await win.getByRole('button', { name: 'Studio', exact: true }).count()) === 0, 'Studio is gone from the sidebar')
  await win.getByRole('tab', { name: 'Pictures' }).click()
  const turbo = win.getByRole('article', { name: 'Z-Image Turbo', exact: true })
  await turbo.waitFor({ timeout: 15000 })
  const firstSrc = (card) => card.locator('[aria-roledescription="slider"] img').first().getAttribute('src')
  const lite = win.getByRole('article', { name: 'Z-Image Turbo Lite' })
  const [turboSrc, liteSrc] = await Promise.all([firstSrc(turbo), firstSrc(lite).catch(() => null)])
  check(Boolean(turboSrc) && Boolean(liteSrc) && turboSrc !== liteSrc, `Turbo and Turbo Lite show their own examples (${turboSrc} / ${liteSrc})`)
  const width = await turbo.locator('[aria-roledescription="slider"] img').first().evaluate(async (img) => {
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }))
    return img.naturalWidth
  })
  check(width >= 1000, `example pictures are full size (${width} px wide)`)
  check(!(await win.getByText(/ s on (RTX|GeForce)/).count()), 'no timing from the computer that made the examples')
  check(await turbo.getByText('Good at', { exact: true }).isVisible(), 'cards say what a model is good at')
  check(await turbo.getByText(/per picture on your PC/).isVisible(), 'cards say how long it takes here')
  const cards = await win.getByRole('article').count()
  const withExamples = await win.locator('article [aria-roledescription="slider"]').count()
  check(withExamples === cards, `every picture model has examples (${withExamples} of ${cards})`)
  await shot('feat-01-models-pictures')
  await turbo.getByRole('button', { name: 'Open this example full size' }).click()
  const box = win.getByRole('dialog')
  await box.waitFor({ timeout: 5000 })
  check(await box.locator('img').first().isVisible(), 'clicking an example opens it full size')
  await shot('feat-02-full-size')
  await box.getByRole('button', { name: 'Use this prompt' }).click()
  const draft = await composer.inputValue()
  const imageMode = await win.getByRole('radio', { name: 'Image' }).getAttribute('aria-checked')
  const picked = await win.getByLabel('Model', { exact: true }).inputValue()
  check(imageMode === 'true' && picked === 'image-fast' && draft.length > 20 && !/^Make a picture/.test(draft), `"Use this prompt" opens Image mode with the model and prompt (${picked}: ${draft.slice(0, 40)}…)`)
  await shot('feat-02b-image-mode-controls')
  await nav('Models')
  await win.getByRole('tab', { name: 'Videos' }).click()
  const i2v = win.getByRole('article', { name: /image → video/ })
  check(await i2v.locator('img[alt="The picture this clip starts from"]').first().isVisible().catch(() => false), 'the picture-to-video model shows the picture each clip starts from')
  await shot('feat-03-models-videos')
  await win.getByRole('tab', { name: 'Text' }).click()
  await win.getByText('More about this model').first().click()
  check(await win.getByText(/Up to \d+K tokens/).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false), 'language models show their memory span from Ollama')
  await shot('feat-04-models-text')

  if (!SKIP_MEDIA) {
  // ---- a picture straight from the composer's Image mode
  await freeOtherEngine()
  await store(() => window.__marisStore.getState().setMode('chat'))
  await store(() => window.__marisStore.getState().newChat())
  await win.getByRole('radio', { name: 'Image' }).click()
  await win.getByLabel('Model', { exact: true }).selectOption('image-fast')
  await composer.fill('A small wooden cabin by a frozen lake under the northern lights, photograph')
  await composer.press('Enter')
  const card = win.locator('[role="group"][aria-label^="Drawing with"]').first()
  check(await card.waitFor({ timeout: 240000 }).then(() => true).catch(() => false), 'the picture card shows while it is made')
  let made = []
  for (let t = 0; t < 400 && !made.length; t++) {
    made = await store(() => {
      const s = window.__marisStore.getState()
      return (s.messages[s.currentId] ?? []).flatMap((m) => m.parts.filter((p) => p.type === 'media').map((p) => p.media.model))
    })
    if (!made.length) await win.waitForTimeout(1000)
  }
  check(made.length > 0, `Image mode made the picture without a language model (${made.join(', ')})`)
  check(await win.getByText('Picture, square').first().isVisible(), 'your message shows what was asked for')
  await shot('feat-05-image-mode')

  } else await store(() => window.__marisStore.getState().newChat())
  // ---- the context meter
  await win.getByRole('radio', { name: 'Text' }).click()
  await composer.fill('In one sentence: what is a fjord?')
  await composer.press('Enter')
  await waitAnswer()
  const ring = win.getByRole('button', { name: /^Context: \d+% used/ })
  check(await ring.isVisible(), 'the context ring shows how full the chat is')
  await ring.click()
  const pop = win.getByRole('dialog')
  check((await pop.getByText('Messages', { exact: true }).isVisible()) && (await pop.getByText('Free space').isVisible()), 'it lists what fills the context')
  check(await pop.getByRole('button', { name: /Summarise now/ }).isVisible(), 'Summarise now is offered')
  await shot('feat-06-context')
  await win.keyboard.press('Escape')

  // ---- paths in answers open the file manager (checked without opening a window)
  await store(() => {
    const s = window.__marisStore.getState()
    const id = s.currentId
    const m = { id: 'path-test', conversationId: id, role: 'assistant', parts: [{ type: 'text', text: 'Your files are in C:\\Windows\\Temp and `C:\\Maris\\nope\\file.txt`.' }], status: 'done', createdAt: Date.now() }
    window.__marisStore.setState({ messages: { ...s.messages, [id]: [...(s.messages[id] ?? []), m] } })
  })
  const links = await win.locator('a.path-link').allInnerTexts()
  check(links.includes('C:\\Windows\\Temp') && links.some((l) => l.includes('file.txt')), `paths in answers are links (${links.join(', ')})`)
  check((await store(() => window.maris.shell.reveal('C:\\Maris\\nope\\file.txt'))) === 'missing', 'a path that is not there says so instead of opening')

  if (!SKIP_MEDIA) {
  // ---- a busy graphics card: another chat links to the chat that renders; unread dots; stop and delete
  await freeOtherEngine()
  await store(() => window.__marisStore.getState().newChat())
  await win.getByRole('radio', { name: 'Image' }).click()
  await win.getByLabel('Model', { exact: true }).selectOption('image-quality')
  await win.getByRole('radiogroup', { name: 'How many' }).getByRole('radio', { name: '4' }).click()
  await composer.fill('A busy harbour at sunset with fishing boats and gulls, oil painting')
  await composer.press('Enter')
  await win.locator('[role="group"][aria-label^="Drawing with"]').first().waitFor({ timeout: 240000 })
  const renderChat = await store(() => window.__marisStore.getState().currentId)
  await win.waitForTimeout(20000)
  await store(() => window.__marisStore.getState().newChat())
  await win.getByRole('radio', { name: 'Text' }).click()
  await composer.fill('What is the capital of Norway? One word.')
  await composer.press('Enter')
  const link = win.getByRole('button', { name: 'Open that chat' })
  check(await link.waitFor({ timeout: 60000 }).then(() => true).catch(() => false), 'the busy notice links to the chat that is drawing')
  await shot('feat-07-busy-link')
  await waitAnswer()
  const askedChat = await store(() => window.__marisStore.getState().currentId)
  await link.click()
  check((await store(() => window.__marisStore.getState().currentId)) === renderChat, '"Open that chat" opens it')
  await store((id) => {
    const s = window.__marisStore.getState()
    window.__marisStore.setState({ unread: { ...s.unread, [id]: true } })
  }, askedChat)
  check(await win.getByRole('img', { name: 'New answer' }).first().isVisible(), 'a chat with a new answer gets a dot')
  await shot('feat-08-unread-dot')
  await win.getByRole('button', { name: /^Options for / }).first().hover()
  const row = win.locator('nav[aria-label="Chats"] div.group', { has: win.locator('button[aria-current="page"]') }).first()
  await row.hover()
  await row.getByRole('button', { name: /^Options for / }).click()
  await win.getByRole('menuitem', { name: 'Delete chat' }).click()
  const ask = win.getByRole('dialog', { name: 'Stop and delete this chat?' })
  check(await ask.waitFor({ timeout: 5000 }).then(() => true).catch(() => false), 'deleting a chat that is drawing asks first')
  await shot('feat-09-stop-and-delete')
  await ask.getByRole('button', { name: /Stop and delete/ }).click()
  await win.waitForTimeout(3000)
  const gone = await store((id) => !window.__marisStore.getState().conversations.some((c) => c.id === id), renderChat)
  const jobs = await store(() => window.maris.media.jobs())
  check(gone && jobs.filter((j) => j.params.conversationId === renderChat).every((j) => j.status !== 'running' && j.status !== 'queued'), 'the chat is deleted and its pictures stopped')

  }
  // ---- Code mode: New project, live file tree, file viewer, Mention lines
  await store(() => window.__marisStore.getState().setMode('code'))
  await win.getByRole('button', { name: 'New project' }).click()
  const dlg = win.getByRole('dialog', { name: 'New project' })
  await dlg.waitFor({ timeout: 5000 })
  // The folder picker is a system dialog, so the location is set through the app's own call.
  await dlg.getByLabel('Name').fill('Weather Notes')
  await store((p) => window.maris.project.create(p, 'Weather Notes', 'A tiny notes app about the weather.').then(() => window.__marisStore.getState().loadProjects()), projects)
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  const dir = path.join(projects, 'Weather Notes')
  await store((d) => window.__marisStore.getState().openProject(d), dir)
  check(existsSync(dir), 'New project makes the folder')
  writeFileSync(path.join(dir, 'forecast.py'), 'def forecast(city):\n    return f"Sunny in {city}"\n\nprint(forecast("Oslo"))\n')
  const fileRow = win.getByRole('button', { name: 'forecast.py' })
  check(await fileRow.waitFor({ timeout: 6000 }).then(() => true).catch(() => false), 'a file made outside Maris appears in the file tree by itself')
  const color = await fileRow.locator('svg').first().evaluate((s) => getComputedStyle(s).color)
  check(color !== 'rgb(0, 0, 0)' && color !== '', `files have a colour by type (${color})`)
  await shot('feat-10-live-tree')
  await fileRow.click()
  const viewer = win.getByRole('dialog')
  await viewer.locator('[data-line="1"]').waitFor({ timeout: 5000 })
  check((await viewer.locator('[data-line]').count()) >= 4, 'the file viewer shows line numbers')
  await viewer.evaluate((el) => {
    const a = el.querySelector('[data-line="1"] code')
    const b = el.querySelector('[data-line="2"] code')
    const r = document.createRange()
    r.setStart(a.firstChild ?? a, 0)
    r.setEnd(b, b.childNodes.length)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(r)
    a.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  const mention = viewer.getByRole('button', { name: /Mention lines 1–2/ })
  check(await mention.isEnabled().catch(() => false), 'selecting lines offers "Mention lines 1–2"')
  await shot('feat-11-viewer-selection')
  await mention.click()
  check(await win.getByText('lines 1–2').first().isVisible(), 'the selection is attached to the message')
  await shot('feat-12-snippet-attached')

  // ---- Changes: a task that writes several files
  await composer.fill('Create two files, sunny.txt and rainy.txt, each containing just the word ok.')
  await composer.press('Enter')
  for (let t = 0; t < 240; t++) {
    const pending = await store(() => window.maris.chat.approvals())
    for (const a of pending) await store((id) => window.maris.chat.approve(id, true), a.id)
    const done = await store(() => {
      const s = window.__marisStore.getState()
      return !s.running[s.currentId]
    })
    if (done && t > 3) break
    await win.waitForTimeout(1000)
  }
  await win.getByRole('radio', { name: /^Changes/ }).click()
  const added = await win.getByText('Added', { exact: true }).count()
  check(added >= 2 && existsSync(path.join(dir, 'sunny.txt')), `Changes lists the new files (${added} added)`)
  await shot('feat-13-changes')

  // ---- connectors: the form opens at the top, tokens are checked, connected services leave the list
  await nav('Connectors')
  await win.getByRole('button', { name: /^GitHub/ }).click()
  const form = win.getByRole('region', { name: 'Connect GitHub' })
  check(await form.isVisible(), 'choosing a service opens its form')
  await form.getByLabel('Personal access token').fill('my token')
  await form.getByRole('button', { name: 'Connect' }).click()
  check(await form.getByText(/not a GitHub token/).waitFor({ timeout: 5000 }).then(() => true).catch(() => false), 'a wrong token is explained before anything is sent')
  await shot('feat-14-connector-token')
  await store(() => window.maris.connectors.add('deepwiki', {}))
  await win.waitForTimeout(800)
  const offered = await win.locator('section:has(h2:text("Add a connector")) button').allInnerTexts()
  check(!offered.some((t) => t.startsWith('DeepWiki')) && offered.some((t) => /^Other service/.test(t)), 'a connected service leaves the list; your own servers stay')
  const dw = (await store(() => window.maris.connectors.list())).find((c) => c.preset === 'deepwiki')
  if (dw) await store((id) => window.maris.connectors.remove(id), dw.id)

  // ---- skills from git (the EPERM fix: git's read-only pack files)
  const skills = await store(() => window.maris.skills.install('https://github.com/anthropics/skills').then((l) => l.length, (e) => String(e?.message ?? e)))
  const skillsDir = path.join(profile, 'skills')
  const leftovers = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.startsWith('.incoming-')) : []
  check(typeof skills === 'number' && skills > 0 && leftovers.length === 0, `Anthropic's example skills install (${skills}), nothing left behind`)

  // ---- dark mode pictures for the README
  await store(() => window.maris.settings.set({ ui: { theme: 'dark' } }))
  await nav('Models')
  await win.getByRole('tab', { name: 'Videos' }).click()
  await win.waitForTimeout(1200)
  await shot('feat-15-dark-videos')
  await store(() => window.__marisStore.getState().setMode('chat'))
  await store(() => window.__marisStore.getState().newChat())
  await win.getByRole('radio', { name: 'Image' }).click()
  await win.waitForTimeout(600)
  await shot('feat-16-dark-image-mode')

  // ---- the launcher's PATH helper, on a scratch key (never the real PATH)
  const launcher = path.join(path.dirname(exe), 'bin', 'maris.exe')
  const key = 'Software\\MarisInstallerTest\\LauncherEnv'
  const env = { ...process.env, MARIS_TEST_ENV_KEY: key }
  try {
    execFileSync('reg.exe', ['add', `HKCU\\${key}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%USERPROFILE%\\tools;C:\\Other', '/f'], { stdio: 'ignore' })
    execFileSync(launcher, ['--maris-path', 'add', 'C:\\Program Files\\Maris\\bin'], { env, stdio: 'ignore' })
    execFileSync(launcher, ['--maris-path', 'add', 'C:\\Program Files\\Maris\\bin\\'], { env, stdio: 'ignore' })
    const after = execFileSync('reg.exe', ['query', `HKCU\\${key}`, '/v', 'Path'], { encoding: 'utf8' })
    check(/REG_EXPAND_SZ\s+%USERPROFILE%\\tools;C:\\Other;C:\\Program Files\\Maris\\bin\s*$/m.test(after), 'the launcher adds itself to PATH once and keeps %VARIABLES%')
    execFileSync(launcher, ['--maris-path', 'remove', 'c:\\program files\\maris\\bin'], { env, stdio: 'ignore' })
    const removed = execFileSync('reg.exe', ['query', `HKCU\\${key}`, '/v', 'Path'], { encoding: 'utf8' })
    check(/REG_EXPAND_SZ\s+%USERPROFILE%\\tools;C:\\Other\s*$/m.test(removed), 'and removes itself again')
  } finally {
    execFileSync('reg.exe', ['delete', 'HKCU\\Software\\MarisInstallerTest', '/f'], { stdio: 'ignore' })
  }
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('feat-error').catch(() => undefined)
} finally {
  await win.evaluate(() => window.maris.media.stopComfy()).catch(() => undefined)
  await app.close().catch(() => undefined)
  await new Promise((r) => setTimeout(r, 1500))
  for (const p of [profile, outputs, projects]) rmSync(p, { recursive: true, force: true, maxRetries: 3 })
}
console.log(failures ? `${failures} check(s) failed` : 'all feature checks passed')
process.exit(failures ? 1 : 0)
