// End-to-end test of how the assistant behaves on this computer, with the real installed models:
//   - "find the biggest files" is done by Maris itself (a read-only tool, no approval, no command pasted
//     for the person to run);
//   - Maris changes its own settings only after asking, even with "approve everything" on, and the
//     approval offers no "Always approve";
//   - the chat column grows with a wide window, and dropdown lists follow the dark theme.
// Usage: node tests/e2e/assistant.mjs <shotsDir>   (MARIS_EXE=<Maris.exe> for a packaged build)
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-assistant-${Date.now()}`)
const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile },
  timeout: 60000
})
const win = await app.firstWindow()
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const shot = (name) => win.screenshot({ path: path.join(shots, `assistant-${name}.png`) }).catch(() => undefined)
const composer = () => win.locator('textarea[aria-label="Message Maris"]')
const send = async (text) => {
  await composer().fill(text)
  await composer().press('Enter')
}
const waitDone = async (timeout = 300000) => {
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined)
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
}
const lastAnswer = async () => (await win.locator('.prose-maris').last().innerText().catch(() => '')).trim()
const setSettings = (patch) => win.evaluate((p) => window.maris.settings.set(p), patch)

try {
  await composer().waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await setSettings({ ui: { theme: 'dark', palette: 'maris' } })

  // ---- The chat column grows with the window
  const widthAt = async (w) => {
    await win.setViewportSize({ width: w, height: 1000 })
    await win.waitForTimeout(300)
    return (await composer().boundingBox())?.width ?? 0
  }
  const narrow = await widthAt(1320)
  const wide = await widthAt(2560)
  check(wide > narrow * 1.3, `the message box grows with the window (${Math.round(narrow)} px at 1320, ${Math.round(wide)} px at 2560)`)
  await win.setViewportSize({ width: 1400, height: 900 })

  // ---- Dropdown lists follow the theme (a styleable select draws its own list)
  const styled = await win.evaluate(() => CSS.supports('appearance', 'base-select'))
  check(styled, 'dropdowns can be themed in this Chromium (appearance: base-select)')

  // ---- The context popover: window sizes with what each costs, and picking one saves it
  await win.getByRole('button', { name: /^Context:/ }).click()
  const sizes = win.getByRole('radiogroup', { name: /Context window size/ })
  const hasSizes = await sizes.waitFor({ timeout: 10000 }).then(() => true, () => false)
  check(hasSizes, 'the context popover offers window sizes')
  if (hasSizes) {
    const labels = (await sizes.getByRole('radio').allInnerTexts()).map((t) => t.trim())
    const current = (await sizes.getByRole('radio', { checked: true }).innerText()).trim()
    console.log(`  sizes: ${labels.join(' ')}; current ${current}`)
    check(current === '32K', `32K is the default (${current})`)
    await sizes.getByRole('radio', { name: '64K' }).hover().catch(() => undefined)
    await win.waitForTimeout(300)
    await shot('00-context-sizes')
    const explain = await win.locator('[aria-live="polite"]').filter({ hasText: /tokens: about/ }).innerText().catch(() => '')
    console.log(`  64K: ${explain}`)
    check(/words/.test(explain) && /(full speed|slower|processor)/.test(explain), 'each size says what it means for speed')
    await sizes.getByRole('radio', { name: '64K' }).click()
    await win.waitForTimeout(500)
    const saved = await win.evaluate(() => window.maris.settings.get().then((s) => [s.routing.contextByTier.balanced, s.routing.contextByTier.max, s.routing.contextByTier.fast]))
    check(saved.includes(65536), `picking 64K saves it for the model in use (${saved.join(', ')})`)
    await win.evaluate(() => window.maris.settings.set({ routing: { contextByTier: { fast: 32768, balanced: 32768, max: 32768 } } }))
    await win.keyboard.press('Escape')
  }

  // ---- Find the biggest files: done by Maris, read-only, without asking
  await send('Find the 10 largest files in my Downloads folder')
  // What the answer says it is doing while it works (loading, reading, thinking).
  const stages = new Set()
  const t0 = Date.now()
  while (Date.now() - t0 < 300000) {
    for (const s of await win.locator('[role="status"]').allInnerTexts().catch(() => [])) {
      const t = s.replace(/\s+\d+\s*(s|min).*$/, '').trim()
      if (t) stages.add(t.slice(0, 60))
    }
    if (!(await win.locator('button[aria-label="Stop"]').isVisible().catch(() => false)) && Date.now() - t0 > 5000) break
    await win.waitForTimeout(400)
  }
  await waitDone()
  console.log(`  stages seen: ${[...stages].join(' | ')}`)
  check([...stages].some((s) => /^(Loading|Reading|Thinking|Deciding)/.test(s)), 'the answer says what the model is doing while it works')
  const answer = await lastAnswer()
  const steps = await win.locator('[role="group"][aria-label^="Approval needed"]').count()
  const toolText = await win.locator('main').last().innerText()
  console.log(`  answer: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`)
  check(steps === 0, 'it ran without an approval prompt (reading is free)')
  check(/\b(MB|GB|KB|bytes?)\b/i.test(answer) || /\.(zip|exe|mp4|iso|msi|7z|pdf|png|jpg)\b/i.test(answer), 'the answer lists files with sizes')
  check(!/\b(run (this|the following)|copy (this|the) command|open (powershell|a terminal)|shall i run|want me to run)\b/i.test(answer), 'it did not hand the person a command to run')
  // PC tasks start on Balanced; with the graphics card full of other programs Maris still steps down.
  console.log(`  note: ${(/Auto: \w+/.exec(toolText) ?? ['?'])[0]} answered (Fast only when other programs leave too little video memory)`)
  await shot('01-largest-files')

  // ---- Changing Maris's own settings always asks, even with "approve everything" on
  await win.keyboard.press('Control+n')
  await setSettings({ agent: { autoApprove: { everything: true } } })
  await send("Switch Maris's theme to light mode.")
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
  const asked = await panel.waitFor({ timeout: 300000 }).then(() => true, () => false)
  check(asked, 'changing a setting asks first, even with "approve everything" on')
  if (asked) {
    check((await panel.getByText('Always approve').count()) === 0, 'the approval offers no "Always approve"')
    check(await panel.getByText(/asks every time before it changes its own settings/).isVisible(), 'and says it always asks')
    await shot('02-settings-approval')
    await panel.getByRole('button', { name: 'Approve' }).click()
    await waitDone()
    const theme = await win.evaluate(() => document.documentElement.dataset.theme)
    check(theme === 'light', `the theme changed after approval (now ${theme})`)
    await shot('03-settings-changed')
  }

  // ---- A task that needs administrator rights: Maris asks for full control with a button in the chat.
  // The test turns it on in its throwaway profile but never presses "Continue", so nothing runs as administrator.
  await setSettings({ agent: { autoApprove: { everything: false }, fullControl: false } })
  await win.keyboard.press('Control+n')
  await send('Restart the Windows Print Spooler service for me.')
  const card = win.getByRole('group', { name: 'Maris asks for full control' })
  // The model may first try the ordinary way. Only a command about the Print Spooler is approved (without
  // administrator rights it fails and changes nothing); anything else is denied.
  let askedForControl = false
  const until = Date.now() + 360000
  while (Date.now() < until) {
    if (await card.isVisible().catch(() => false)) {
      askedForControl = true
      break
    }
    const pending = win.locator('[role="group"][aria-label^="Approval needed"]').last()
    if (await pending.isVisible().catch(() => false)) {
      const what = await pending.getAttribute('aria-label')
      const ok = /spool/i.test(what ?? '') && !/administrator/i.test(what ?? '')
      console.log(`  ${ok ? 'approving' : 'denying'}: ${what}`)
      await pending.getByRole('button', { name: ok ? 'Approve' : 'Deny', exact: true }).click()
    }
    if (!(await win.locator('button[aria-label="Stop"]').isVisible().catch(() => false)) && !(await card.isVisible().catch(() => false))) {
      await win.waitForTimeout(1500)
      if (!(await win.locator('button[aria-label="Stop"]').isVisible().catch(() => false))) break
    }
    await win.waitForTimeout(500)
  }
  askedForControl ||= await card.isVisible().catch(() => false)
  if (!askedForControl) console.log(`  answer: ${(await lastAnswer()).replace(/\s+/g, ' ').slice(0, 300)}`)
  await waitDone().catch(() => undefined)
  check(askedForControl, 'a task that needs administrator rights shows "Turn on full control" in the chat')
  if (askedForControl) {
    await shot('04-full-control-ask')
    await card.getByRole('button', { name: 'Turn on full control' }).click()
    await card.getByRole('button', { name: 'Continue the task' }).waitFor({ timeout: 5000 })
    const turnedOn = await win.evaluate(() => window.maris.settings.get().then((s) => s.agent.fullControl))
    check(turnedOn === true, 'the button turns full control on (and offers to continue)')
    await shot('05-full-control-on')
  }
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('error')
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all assistant checks passed')
process.exit(failures ? 1 : 0)
