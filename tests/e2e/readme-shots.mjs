// README screenshots: dark mode views and each colour theme. Usage: node tests/e2e/readme-shots.mjs <shotsDir>
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? os.tmpdir())
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-readme-${Date.now()}`)
const app = await electron.launch({ executablePath: process.env.MARIS_ELECTRON ?? (await import('electron')).default, args: [root], env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
app.process().stdout?.on('data', () => undefined)
app.process().stderr?.on('data', () => undefined)
const shot = (name) => win.screenshot({ path: path.join(shots, `${name}.png`) }).then(() => console.log('shot', name))
const set = (ui) => win.evaluate((ui) => window.__marisStore.getState().updateSettings({ ui }), ui)
const nav = async (name) => {
  await win.getByRole('button', { name, exact: true }).first().click()
  await win.waitForTimeout(1200)
}
let win
try {
  win = await app.firstWindow()
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  await set({ theme: 'dark', palette: 'maris' })
  await win.waitForTimeout(1200)
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await win.waitForTimeout(1300)

  // Dark mode views
  await shot('dark-chat')
  await win.getByRole('radio', { name: 'Code' }).click()
  await win.waitForTimeout(900)
  await shot('dark-code')
  await win.getByRole('radio', { name: 'Chat' }).click()
  await win.waitForTimeout(600)
  for (const [name, file, tab] of [['Models', 'dark-pictures', 'Pictures'], ['Models', 'dark-models', 'Text']]) {
    try {
      await nav(name)
      await win.getByRole('tab', { name: tab }).click()
      await win.waitForTimeout(900)
      await shot(file)
    } catch (e) {
      console.log('skip', file, e.message.split('\n')[0])
    }
  }

  // Colour themes on the empty chat
  await win.getByRole('button', { name: /^New chat/ }).first().click()
  await win.waitForTimeout(1200)
  for (const id of ['ember', 'neon-purple', 'neon-pink', 'midnight', 'forest', 'sakura', 'daylight']) {
    await set({ palette: id })
    await win.waitForTimeout(1200)
    await shot(`theme-${id}`)
  }
  await set({ theme: 'light', palette: 'maris' })
  await win.waitForTimeout(1200)
  await shot('theme-maris-light')
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
