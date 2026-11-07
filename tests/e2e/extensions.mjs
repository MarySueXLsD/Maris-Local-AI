// End-to-end test of skills and connectors against the real app and a local model.
// Skills: installs a skill from a folder and checks that the model loads it for a matching request.
// Connectors: adds a local test service (fixtures/echo-mcp.mjs, needs Node.js) through the Connectors
// page; its read-only tool runs freely, its tool that changes something waits for approval.
// Usage: npm run build && node tests/e2e/extensions.mjs <shotsDir>   (MARIS_EXE=<Maris.exe> for a packaged build)
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const stamp = Date.now()
const profile = path.join(os.tmpdir(), `maris-ext-${stamp}`)
const skillRoot = path.join(os.tmpdir(), `maris-skill-${stamp}`)
const noteFile = path.join(os.tmpdir(), `maris-notes-${stamp}.txt`)
mkdirSync(path.join(skillRoot, 'weather-poet'), { recursive: true })
writeFileSync(
  path.join(skillRoot, 'weather-poet', 'SKILL.md'),
  [
    '---',
    'name: weather-poet',
    'description: Writes poems about the weather. Use this whenever the user asks for a poem about rain, snow, sun or wind.',
    '---',
    '',
    '# Weather poet',
    '',
    'Write exactly three short lines. End the last line with the word PETRICHOR in capital letters.'
  ].join('\n')
)

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
const send = async (text) => {
  await composer().fill(text)
  await composer().press('Enter')
}
const waitDone = async (timeout = 300000) => {
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
  await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
}
const lastAnswer = async () => (await win.locator('.prose-maris').last().innerText().catch(() => '')).trim()
const toolsUsed = async () =>
  win.evaluate(() => {
    const s = window.__marisStore.getState()
    return (s.messages[s.currentId] ?? []).flatMap((m) => m.parts.filter((p) => p.type === 'tool').map((p) => p.call.name))
  })

try {
  await composer().waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)

  // ---- Skills: install from a folder (typed into the box, like a git address)
  await win.getByRole('button', { name: 'Skills', exact: true }).click()
  await win.getByLabel('Git address').fill(skillRoot)
  await win.getByRole('button', { name: 'Install' }).click()
  await win.getByText(/Added 1 skill: weather-poet/).waitFor({ timeout: 30000 })
  check(true, 'skill installed from a folder')
  await win.getByRole('button', { name: 'Show weather-poet' }).click()
  check(await win.getByText(/End the last line with the word PETRICHOR/).waitFor({ timeout: 5000 }).then(() => true).catch(() => false), 'skill instructions viewable')
  await shot('ext-01-skills')

  await win.keyboard.press('Control+n')
  await send('Write me a short poem about rain.')
  await waitDone()
  const used = await toolsUsed()
  check(used.includes('use_skill'), `the model loaded the skill (tools: ${used.join(', ') || 'none'})`)
  check(/PETRICHOR/.test(await lastAnswer()), `answer follows the skill: ${(await lastAnswer()).replace(/\s+/g, ' ').slice(0, 100)}`)
  await shot('ext-02-skill-used')

  // Turning a skill off removes it from what the model sees.
  await win.getByRole('button', { name: 'Skills', exact: true }).click()
  await win.getByLabel('Use weather-poet').uncheck()
  const tools = await win.evaluate(() => window.maris.skills.list())
  check(tools.every((s) => !s.enabled), 'skill turned off')

  // ---- Connectors: the local test service through the page
  await win.getByRole('button', { name: 'Connectors', exact: true }).click()
  await win.getByRole('button', { name: /Other service \(program\)/ }).click()
  await win.getByLabel('Name in Maris').fill('Test service')
  await win.getByLabel('Command').fill(`node "${path.join(root, 'tests', 'e2e', 'fixtures', 'echo-mcp.mjs')}"`)
  await win.getByLabel(/Environment variables/).fill(`NOTE_FILE=${noteFile}`)
  await win.getByRole('button', { name: 'Connect', exact: true }).click()
  await win.getByText(/Connected · 2 tools/).waitFor({ timeout: 30000 })
  check(true, 'test service connected with 2 tools')
  await shot('ext-03-connectors')

  await win.keyboard.press('Control+n')
  await send('Use the test service to get the secret number, and tell me what it is.')
  await waitDone()
  check(/4217/.test(await lastAnswer()), `read-only connector tool ran without asking: ${(await lastAnswer()).replace(/\s+/g, ' ').slice(0, 80)}`)
  check((await win.locator('[role="group"][aria-label^="Approval needed"]').count()) === 0, 'no approval for reading')

  await win.keyboard.press('Control+n')
  await send('Use the test service to save a note with exactly this text: hello from Maris')
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
  await panel.waitFor({ timeout: 300000 })
  check(!existsSync(noteFile), 'nothing saved before approval')
  const options = await panel.getByRole('combobox', { name: 'What to always approve' }).locator('option').allInnerTexts()
  check(options.includes('actions in connected services'), `"Always approve" offers the connectors kind (${options.join(' | ')})`)
  const heading = (await panel.innerText()).split('\n').find((l) => l.startsWith('Maris wants to')) ?? ''
  check(heading.startsWith('Maris wants to use Test service:'), `approval names the service: ${heading}`)
  await shot('ext-04-connector-approval')
  await panel.getByRole('button', { name: /^Approve/ }).click()
  await waitDone()
  check(existsSync(noteFile) && /hello from Maris/i.test(readFileSync(noteFile, 'utf8')), 'note saved after approval')
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('ext-error').catch(() => undefined)
} finally {
  if (logs.length) console.log(logs.slice(-10).join('\n'))
  await app.close().catch(() => undefined)
  for (const p of [profile, skillRoot, noteFile]) rmSync(p, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all extension checks passed')
process.exit(failures ? 1 : 0)
