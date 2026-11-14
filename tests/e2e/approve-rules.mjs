// End-to-end test of "Always approve …" in approval boxes and the reminder at the bottom.
// Usage: npm run build && node tests/e2e/approve-rules.mjs <shotsDir>   (MARIS_EXE=<Maris.exe> for a packaged build)
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-rules-${Date.now()}`)
const work = path.join(shots, 'rules-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const file = (n) => path.join(work, `${n}.txt`)

const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000
})
const win = await app.firstWindow()
const logs = []
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
const shot = async (name) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot', name)
}
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const composer = () => win.locator('textarea[aria-label="Message Maris"]')
const panel = () => win.locator('[role="group"][aria-label^="Approval needed"]')
const bar = () => win.getByRole('status').filter({ hasText: 'Approving without asking' })
const send = async (text) => {
  await composer().fill(text)
  await composer().press('Enter')
}
const waitDone = async (timeout = 240000) => {
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
}
const newChat = async () => {
  await win.keyboard.press('Control+n')
  await win.waitForTimeout(400)
}
const askToCreate = (n) => send(`Create a text file at ${file(n)} containing exactly this text: ${n}`)
/** Waits until the answer is finished or an approval box appears; true when it asked. */
const askedForApproval = async () => {
  const asked = panel().first().waitFor({ timeout: 240000 }).then(() => true)
  const finished = (async () => {
    await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
    await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 240000 })
    return false
  })()
  return Promise.race([asked, finished])
}

try {
  await composer().waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  check(!(await bar().isVisible().catch(() => false)), 'no reminder while every change asks (the default)')

  // ---- 1. "Always approve creating and editing files"
  await askToCreate('a')
  check(await askedForApproval(), 'first file change asks')
  const select = panel().getByRole('combobox', { name: 'What to always approve' })
  const options = await select.locator('option').allInnerTexts()
  check(options.join('|') === 'creating and editing files|everything in this session|everything, everywhere', `options: ${options.join(' | ')}`)
  await panel().getByRole('checkbox', { name: 'Always approve' }).check()
  await shot('rules-01-always-kind')
  await panel().getByRole('button', { name: /^Approve/ }).click()
  await waitDone()
  check(existsSync(file('a')), 'file a created after approving')
  await win.waitForTimeout(500)
  check(await bar().isVisible(), `reminder shown: ${(await bar().innerText().catch(() => '')).replace(/\s+/g, ' ')}`)
  const statusItem = win.locator('footer button[aria-label^="Approving without asking"]')
  check(await statusItem.isVisible(), `status bar shows it: ${await statusItem.innerText().catch(() => '')}`)

  // Same kind again: no question, in this chat and in a new one.
  await newChat()
  await askToCreate('b')
  check(!(await askedForApproval()), 'file b in a new chat was not asked about')
  check(existsSync(file('b')), 'file b created automatically')
  check(await win.getByText(/Approved automatically: you always approve creating and editing files/).first().isVisible().catch(() => false), 'the step says why it ran without asking')
  await shot('rules-02-auto-kind')

  // ---- 2. Change it from the bottom: everything off again.
  await win.getByRole('button', { name: 'Change', exact: true }).click()
  await win.getByRole('button', { name: 'Ask before every change again' }).waitFor({ timeout: 5000 })
  await shot('rules-03-manager')
  await win.getByRole('button', { name: 'Ask before every change again' }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(500)
  check(!(await bar().isVisible().catch(() => false)), 'reminder gone after turning the rules off')

  // ---- 3. "Everything in this session"
  await newChat()
  await askToCreate('c')
  check(await askedForApproval(), 'asks again after turning rules off')
  await panel().getByRole('combobox', { name: 'What to always approve' }).selectOption({ label: 'everything in this session' })
  check(await panel().getByRole('checkbox', { name: 'Always approve' }).isChecked(), 'choosing a scope ticks "Always approve"')
  check(await panel().getByRole('note').isVisible(), 'a warning explains "everything in this session"')
  await shot('rules-04-session')
  await panel().getByRole('button', { name: /^Approve/ }).click()
  await waitDone()
  check(existsSync(file('c')), 'file c created')
  await askToCreate('d')
  check(!(await askedForApproval()), 'file d in the same chat was not asked about')
  check(existsSync(file('d')), 'file d created automatically')
  check(/everything in this session/.test(await bar().innerText().catch(() => '')), 'reminder says "everything in this session"')

  // A new chat is a new session: it asks, and denying works as before.
  await newChat()
  await askToCreate('e')
  check(await askedForApproval(), 'a new chat asks again')
  await panel().getByRole('button', { name: 'Deny', exact: true }).click()
  await waitDone()
  check(!existsSync(file('e')), 'denied file e was not created')

  // ---- 4. "Everything, everywhere"
  await newChat()
  await askToCreate('f')
  check(await askedForApproval(), 'file f asks')
  await panel().getByRole('combobox', { name: 'What to always approve' }).selectOption({ label: 'everything, everywhere' })
  await panel().getByRole('button', { name: /^Approve/ }).click()
  await waitDone()
  check(existsSync(file('f')), 'file f created')
  await newChat()
  await askToCreate('g')
  check(!(await askedForApproval()), 'file g in another chat was not asked about')
  check(existsSync(file('g')), 'file g created automatically')
  check(/Approving everything/.test(await statusItem.innerText().catch(() => '')), 'status bar warns: approving everything')
  await shot('rules-05-everything')
  // Turn it off from the status bar.
  await statusItem.click()
  const everywhere = win.getByRole('switch', { name: /Everything, everywhere/ })
  await everywhere.waitFor({ timeout: 5000 })
  await everywhere.click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(500)
  const settingsNow = await win.evaluate(() => window.maris.settings.get())
  check(settingsNow.agent.autoApprove.everything === false, 'turned off from the status bar')
  check(readFileSync(file('a'), 'utf8').trim() === 'a', 'file contents are what was asked')
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('rules-error').catch(() => undefined)
} finally {
  if (logs.length) console.log(logs.slice(-10).join('\n'))
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all approval-rule checks passed')
process.exit(failures ? 1 : 0)
