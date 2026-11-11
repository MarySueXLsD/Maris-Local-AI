// End-to-end smoke test: drives the built Maris app with Playwright.
// Usage: npm run build && node tests/e2e/smoke.mjs <shotsDir> [steps...]
// Steps: ui, chat, tools, approve, deny, views (default: all). Uses a throwaway profile.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
const steps = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ['ui', 'chat', 'tools', 'approve', 'deny', 'views'])
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-e2e-${Date.now()}`)
const work = path.join(shots, 'work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// MARIS_EXE=<path to Maris.exe> tests the packaged app instead of the development build.
const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000
})
const logs = []
app.process().stdout?.on('data', (d) => logs.push(String(d)))
app.process().stderr?.on('data', (d) => logs.push(String(d)))
const win = await app.firstWindow()
win.on('console', (m) => {
  if (m.type() === 'error') logs.push(`[renderer] ${m.text()}`)
})
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

const shot = async (name) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot', name)
}
const composer = () => win.locator('textarea[aria-label="Message Maris"]')
const send = async (text) => {
  await composer().fill(text)
  await composer().press('Enter')
}
const waitDone = async (timeout = 240000) => {
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
}
const lastAnswer = async () => (await win.locator('.prose-maris').last().innerText().catch(() => '')).slice(0, 400)
const newChat = async () => {
  await win.keyboard.press('Control+n')
  await win.waitForTimeout(300)
}

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

try {
  await composer().waitFor({ timeout: 30000 })
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  await win.waitForTimeout(1500)

  if (steps.has('ui')) {
    await shot('01-welcome')
    // A fresh profile opens the setup assistant; skip it.
    const skipSetup = win.getByRole('button', { name: 'Skip setup for now' })
    await skipSetup.waitFor({ timeout: 30000 }).then(() => skipSetup.click()).catch(() => undefined)
    await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
    await win.waitForTimeout(1200)
    await shot('02-empty')
  } else {
    // A fresh profile opens the setup assistant; skip it.
    const skipSetup = win.getByRole('button', { name: 'Skip setup for now' })
    await skipSetup.waitFor({ timeout: 30000 }).then(() => skipSetup.click()).catch(() => undefined)
    await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  }

  if (steps.has('chat')) {
    await send('Hi! In one short sentence, who are you?')
    await waitDone()
    await win.waitForTimeout(500)
    const a = await lastAnswer()
    check(a.length > 5, `small talk answered: ${a.replace(/\s+/g, ' ').slice(0, 120)}`)
    await shot('03-chat')
  }

  if (steps.has('tools')) {
    await newChat()
    await send(`List the files in this folder and tell me how many there are: ${root}\\src\\main\\tools`)
    await waitDone()
    await win.waitForTimeout(500)
    // Simple view lists steps in plain words; Detailed view shows one row per tool call.
    const simpleRows = await win.locator('[role="list"][aria-label="What Maris did"] [role="listitem"]').count()
    const detailedRows = await win.locator('button[aria-expanded]').filter({ hasText: /List|Search|Inspect/ }).count()
    const toolRows = simpleRows + detailedRows
    const waited = await win.locator('[role="group"][aria-label^="Approval needed"]').count()
    check(toolRows > 0 && waited === 0, `read-only tool ran without approval (${toolRows} step(s), ${waited} approval prompt(s))`)
    // A small model may name the files or sum them up ("18 files: tools for …"); either shows it read the folder.
    const inFolder = readdirSync(path.join(root, 'src', 'main', 'tools')).length
    const told = await lastAnswer()
    check(/fs\.ts|shell\.ts|classify/i.test(told) || new RegExp(`\\b${inFolder}\\b`).test(told), `answer mentions real files, or how many there are (${inFolder})`)
    await shot('04-tools')
  }

  const target = path.join(work, 'hello.txt')
  if (steps.has('approve')) {
    await newChat()
    await send(`Create a text file at ${target} containing exactly this text: Hello from Maris`)
    const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
    await panel.waitFor({ timeout: 240000 })
    check(!existsSync(target), 'file does not exist before approval')
    await shot('05-approval')
    await panel.getByRole('button', { name: 'Approve' }).click()
    await waitDone()
    check(existsSync(target) && readFileSync(target, 'utf8').includes('Hello from Maris'), 'file written after approval')
    await shot('06-approved')
  }

  if (steps.has('deny')) {
    await send('Now delete that file.')
    const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
    await panel.waitFor({ timeout: 240000 })
    await shot('07-deny-request')
    await panel.getByRole('button', { name: 'Deny' }).click()
    await waitDone()
    check(existsSync(target), 'file still exists after denying')
    await shot('08-denied')
  }

  if (steps.has('views')) {
    for (const [label, name] of [
      ['Models', '09-models'],
      ['Memory', '10-memory'],
      ['Skills', '11-skills'],
      ['Settings', '12-settings']
    ]) {
      await win.getByRole('button', { name: label, exact: true }).click()
      await win.waitForTimeout(900)
      await shot(name)
    }
  }
} catch (e) {
  failures++
  console.log('ERROR', e.message)
  await shot('99-error').catch(() => undefined)
} finally {
  const errs = logs.filter((l) => /error|exception|failed/i.test(l)).slice(-25)
  if (errs.length) console.log('--- app log (errors) ---\n' + errs.join('\n'))
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exit(failures ? 1 : 0)
}
