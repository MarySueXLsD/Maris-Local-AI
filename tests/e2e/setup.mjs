// End-to-end check of the first-run setup assistant and the Settings page.
// Usage: npm run build && node tests/e2e/setup.mjs <shotsDir>
// Uses a throwaway profile, so the assistant opens as on a fresh install. It never installs anything:
// it walks through scan → this PC → models, then skips, and exercises Settings.
// MARIS_EXE=<Maris.exe> tests a packaged build; MARIS_ELECTRON=<electron.exe> runs this folder with another Electron binary.
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-e2e-setup-${Date.now()}`)
const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile },
  timeout: 90000
})
const logs = []
app.process().stdout?.on('data', (d) => logs.push(String(d)))
app.process().stderr?.on('data', (d) => logs.push(String(d)))
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
win.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`))
const shot = async (name, full = false) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`), fullPage: full })
  console.log('shot', name)
}
const fail = async (msg) => {
  console.error('✗', msg)
  await shot('failure').catch(() => undefined)
  console.error(errors.join('\n').slice(-3000))
  console.error(logs.join('').slice(-1500))
  await app.close().catch(() => undefined)
  process.exit(1)
}

try {
  // ---- 1. scan
  await win.getByRole('heading', { name: 'Here is what this PC has' }).waitFor({ timeout: 90000 })
  const cont = win.getByRole('button', { name: 'Continue' })
  await cont.waitFor()
  for (let i = 0; i < 40 && !(await cont.isEnabled()); i++) await win.waitForTimeout(250)
  await shot('setup-1-scan')
  const scan = await win.evaluate(() => window.maris.setup.lastScan())
  console.log(`scan: ${scan.cpu.name} (${scan.cpu.cores}c) · ${Math.round(scan.ram.totalMB / 1024)} GB ${scan.ram.type ?? ''} ≈${scan.ram.bandwidthGBs} GB/s`)
  console.log(`      GPU: ${scan.gpu ? `${scan.gpu.name} ${Math.round(scan.gpu.vramMB / 1024)} GB · llm=${scan.gpu.llm} comfy=${scan.gpu.comfy} bw=${scan.gpu.bandwidthGBs} perf=${scan.gpu.perf}` : 'none'}`)
  console.log(`      disks: ${scan.disks.map((d) => `${d.root} ${Math.round(d.freeGB)} GB free`).join(', ')} · ollama ${scan.ollama.version ?? 'off'} (${scan.ollama.models.length} models)`)

  // ---- 2. where models run
  await cont.click()
  await win.getByRole('heading', { name: 'Where should models run?' }).waitFor()
  await win.waitForTimeout(300)
  await shot('setup-2-pc')
  await win.getByRole('radio', { name: /GPU \+ CPU/ }).click()
  await win.waitForTimeout(200)
  await shot('setup-2b-hybrid')
  await win.getByRole('radio', { name: /GPU only/ }).click()

  // ---- 3. recommended models
  await win.getByRole('button', { name: 'See recommended models' }).click()
  await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
  await win.waitForTimeout(300)
  await shot('setup-3-models')
  const picks = await win.evaluate(() =>
    [...document.querySelectorAll('select[aria-label$=" model"]')].map((s) => `${s.getAttribute('aria-label')}: ${s.selectedOptions[0]?.textContent ?? '?'}`)
  )
  console.log(picks.map((p) => `  ${p}`).join('\n'))
  // scroll to the bottom for the media rows
  await win.evaluate(() => document.querySelector('[aria-label="Set up Maris"] main')?.scrollTo({ top: 99999 }))
  await win.waitForTimeout(200)
  await shot('setup-3b-models-media')

  // ---- 4. finish with a plan that downloads nothing: images and video off, only installed models.
  // (A test never downloads models; on a PC without the recommended models it skips instead.)
  await win.getByRole('button', { name: 'Back' }).click()
  await win.getByRole('switch', { name: 'Image generation' }).click()
  const video = win.getByRole('switch', { name: 'Video generation' })
  if ((await video.getAttribute('aria-checked')) === 'true') await video.click()
  await win.getByRole('button', { name: 'See recommended models' }).click()
  await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
  const finishBtn = win.getByRole('button', { name: /^Finish/ })
  if (await finishBtn.count()) {
    await finishBtn.click()
    await win.getByRole('heading', { name: 'Maris is ready' }).waitFor({ timeout: 30000 })
    await shot('setup-4-done')
    await win.getByRole('button', { name: /Start using Maris/ }).click()
    await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 })
    const cfg = await win.evaluate(() => window.__marisStore.getState().settings)
    console.log(`✓ finished: max=${cfg.tiers.max} code=${cfg.tiers.code || '(Max)'} fast=${cfg.tiers.fast} processing=${cfg.engine.processing} codeContext=${cfg.routing.codeContext / 1024}K`)
    if (!cfg.onboarded || !cfg.tiers.max) await fail('finishing did not save the plan')
  } else {
    console.log('(recommended models are not installed here, so the test skips instead of downloading)')
    await win.getByRole('button', { name: 'Skip setup for now' }).click()
    await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 })
  }
  const onboarded = await win.evaluate(() => window.__marisStore.getState().settings.onboarded)
  if (!onboarded) await fail('setup did not mark itself as done')

  // ---- 5. Settings: every section renders, search works, reset works
  await win.keyboard.press('Control+Comma')
  await win.getByRole('textbox', { name: 'Search settings' }).waitFor()
  await shot('settings-appearance')
  const sections = await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').allTextContents()
  for (const name of sections) {
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click()
    await win.getByRole('heading', { name, exact: true, level: 2 }).waitFor()
  }
  console.log(`✓ ${sections.length} settings sections render`)
  for (const name of ['Engine', 'Generation', 'Images and video']) {
    await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click()
    await win.waitForTimeout(150)
    await shot(`settings-${name.toLowerCase().replace(/\W+/g, '-')}`)
  }
  await win.getByRole('textbox', { name: 'Search settings' }).fill('vram')
  await win.waitForTimeout(200)
  await shot('settings-search-vram')
  const hits = await win.locator('[data-setting]').count()
  if (hits < 3) await fail(`search for "vram" found only ${hits} settings`)
  console.log(`✓ search "vram" → ${hits} settings`)
  await win.getByRole('button', { name: 'Clear' }).click()

  // change a setting, see the reset control, reset it
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click()
  await win.getByRole('radio', { name: 'Compact' }).click()
  await win.waitForTimeout(250)
  let density = await win.evaluate(() => window.__marisStore.getState().settings.ui.density)
  if (density !== 'compact') await fail(`density is ${density}`)
  await win.getByRole('button', { name: 'Reset Density to default' }).click()
  await win.waitForTimeout(250)
  density = await win.evaluate(() => window.__marisStore.getState().settings.ui.density)
  if (density !== 'comfortable') await fail(`density after reset is ${density}`)
  console.log('✓ change and reset a setting')

  // a number field commits on blur and clamps to its range
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Engine', exact: true }).click()
  const keep = win.getByRole('textbox', { name: 'Keep models loaded for' })
  await keep.fill('45')
  await keep.press('Enter')
  await win.waitForTimeout(250)
  const keepAlive = await win.evaluate(() => window.__marisStore.getState().settings.engine.keepAliveMin)
  if (keepAlive !== 45) await fail(`keepAliveMin is ${keepAlive}`)
  console.log('✓ number setting saved')

  // ---- 6. dark theme + run setup again from Settings
  await win.evaluate(() => window.__marisStore.getState().updateSettings({ ui: { theme: 'dark' } }))
  await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Data and setup', exact: true }).click()
  await shot('settings-data-dark')
  await win.getByRole('button', { name: 'Run setup' }).click()
  await win.getByRole('heading', { name: 'Here is what this PC has' }).waitFor({ timeout: 90000 })
  for (let i = 0; i < 40 && !(await cont.isEnabled()); i++) await win.waitForTimeout(250)
  await cont.click()
  await win.getByRole('button', { name: 'See recommended models' }).click()
  await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
  await win.waitForTimeout(300)
  await shot('setup-3-models-dark')
  await win.getByRole('button', { name: 'Close setup' }).click()
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 })

  if (errors.length) await fail(`renderer errors:\n${errors.join('\n')}`)
  console.log('✓ setup assistant and settings work')
} catch (e) {
  await fail(e.stack ?? String(e))
}
await app.close()
