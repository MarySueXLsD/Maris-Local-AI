// Visual check of themes, the Help page and hover explanations.
// Usage: npm run build && node tests/e2e/ux.mjs <shotsDir>   (MARIS_ELECTRON / MARIS_EXE as in the other tests)
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const app = await electron.launch({
  executablePath: process.env.MARIS_EXE ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: process.env.MARIS_EXE ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: path.join(os.tmpdir(), `maris-e2e-ux-${Date.now()}`) },
  timeout: 90000
})
app.process().stdout?.on('data', () => undefined)
app.process().stderr?.on('data', () => undefined)
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const shot = async (name) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot', name)
}
const set = (patch) => win.evaluate((p) => window.__marisStore.getState().updateSettings(p), patch)
let failed = false
try {
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 90000 })
  await skip.click()
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 })

  // ---- themes
  await win.keyboard.press('Control+Comma')
  await win.getByRole('radiogroup', { name: 'Colour theme' }).waitFor()
  await shot('ux-1-themes-maris')
  for (const name of ['Neon Purple', 'Neon Pink', 'Sakura', 'Midnight']) {
    await win.getByRole('radio', { name, exact: true }).click()
    await win.waitForTimeout(350)
    const palette = await win.evaluate(() => document.documentElement.dataset.palette)
    if (!palette || palette === 'maris') throw new Error(`${name} did not apply`)
    await shot(`ux-2-theme-${name.toLowerCase().replace(/\s+/g, '-')}`)
  }
  await win.getByRole('radio', { name: 'Custom', exact: true }).click()
  await win.getByText('Start from:').waitFor()
  await win.getByRole('textbox', { name: 'Accent colour code' }).fill('#00ffa3')
  await win.getByRole('textbox', { name: 'Accent colour code' }).press('Enter')
  await win.waitForTimeout(350)
  const petal = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--petal').trim())
  if (petal.toLowerCase() !== '#00ffa3') throw new Error(`custom accent not applied: ${petal}`)
  await shot('ux-3-theme-custom')
  console.log('✓ themes apply, custom accent works')

  // ---- a chat-sized look at a neon theme
  await set({ ui: { palette: 'neon-purple' } })
  await win.keyboard.press('Control+n')
  await win.waitForTimeout(600)
  await shot('ux-4-neon-purple-home')

  // ---- help
  await win.keyboard.press('F1')
  await win.getByRole('heading', { name: 'Welcome to Maris', level: 1 }).waitFor()
  await shot('ux-5-help-welcome')
  await win.getByRole('textbox', { name: 'Search help' }).fill('vram')
  await win.waitForTimeout(250)
  const hits = await win.getByRole('navigation', { name: 'Help articles' }).getByRole('button').count()
  if (hits < 2) throw new Error(`help search for vram found ${hits}`)
  await win.getByRole('navigation', { name: 'Help articles' }).getByRole('button').first().click()
  await win.waitForTimeout(300)
  await shot('ux-6-help-article')
  // a help: link inside an article opens another article
  await win.getByRole('textbox', { name: 'Search help' }).fill('')
  await win.getByRole('navigation', { name: 'Help articles' }).getByRole('button', { name: 'Welcome to Maris' }).click()
  await win.getByRole('link', { name: 'Maris asks before changing anything' }).click()
  await win.getByRole('heading', { name: 'Maris asks before changing anything', level: 1 }).waitFor()
  console.log('✓ help opens, searches and links between articles')

  // ---- hover explanations in Settings
  await set({ ui: { palette: 'maris', theme: 'light' } })
  await win.keyboard.press('Control+Comma')
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Engine', exact: true }).click()
  const term = win.locator('span[role="button"].cursor-help').first()
  await term.waitFor()
  await term.hover()
  await win.waitForTimeout(500)
  await shot('ux-7-term-hover')
  console.log(`✓ ${await win.locator('span[role="button"].cursor-help').count()} explained words on the Engine page`)
  if (errors.length) throw new Error(errors.join('\n'))
} catch (e) {
  failed = true
  console.error('✗', e.message)
  await shot('ux-failure').catch(() => undefined)
}
await app.close()
process.exit(failed ? 1 : 0)
