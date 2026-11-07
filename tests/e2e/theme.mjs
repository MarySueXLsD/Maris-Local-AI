// Screenshots of the main views in dark mode. Usage: node tests/e2e/theme.mjs <shotsDir>
import { _electron as electron } from 'playwright-core'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? os.tmpdir())
const profile = path.join(os.tmpdir(), `maris-theme-${Date.now()}`)
const app = await electron.launch({ executablePath: process.env.MARIS_ELECTRON ?? (await import('electron')).default, args: [root], env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
app.process().stdout?.on('data', () => undefined)
app.process().stderr?.on('data', () => undefined)
try {
  const win = await app.firstWindow()
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  await win.evaluate(() => window.__marisStore.getState().updateSettings({ ui: { theme: 'dark' }, onboarded: false }))
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(shots, 'd1-dark-welcome.png') })
  await win.getByRole('button', { name: 'Skip setup for now' }).click()
  await win.waitForTimeout(1300)
  await win.screenshot({ path: path.join(shots, 'd2-dark-chat.png') })
  await win.getByRole('radio', { name: 'Code' }).click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(shots, 'd3-dark-code.png') })
  await win.getByRole('button', { name: 'Models', exact: true }).click()
  await win.getByRole('tab', { name: 'Pictures' }).click()
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(shots, 'd4-dark-pictures.png') })
  console.log('dark screenshots saved')
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
