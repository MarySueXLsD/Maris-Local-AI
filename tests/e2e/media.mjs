// Media end-to-end test: installs a Studio pack through the UI (ComfyUI + model files go to the
// real data folder, so they are kept for normal use) and generates something with it.
// Usage: node tests/e2e/media.mjs <shotsDir> <packName> <kind: image|video> "<prompt>"
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [shotsArg, packName = 'Z-Image Turbo', kind = 'image', prompt = 'A cozy wooden cabin in a snowy forest at dusk, warm light glowing in the windows, cinematic'] = process.argv.slice(2)
const shots = path.resolve(shotsArg ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-media-${Date.now()}`)
const electronPath = process.env.MARIS_ELECTRON ?? (await import('electron')).default
const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
// Always drain the app's stdout/stderr: on Windows a full pipe blocks the app's main thread.
const drainOutput = (s) => s?.on('data', () => undefined)
drainOutput(app.process().stdout)
drainOutput(app.process().stderr)
const win = await app.firstWindow()
const shot = (n) => win.screenshot({ path: path.join(shots, `${n}.png`) }).then(() => console.log('shot', n))
const call = (expr, arg) => win.evaluate(expr, arg)
let code = 0
try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  // A fresh profile opens the setup assistant; skip it.
  const skipSetup = win.getByRole('button', { name: 'Skip setup for now' })
  await skipSetup.waitFor({ timeout: 30000 }).then(() => skipSetup.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.getByRole('button', { name: 'Models', exact: true }).click()
  await win.getByRole('tab', { name: kind === 'video' ? 'Videos' : 'Pictures' }).click()
  await win.waitForTimeout(800)
  await shot(`m1-models-${kind}`)

  let packs = await call(() => window.maris.media.packs())
  let pack = packs.find((p) => p.name === packName)
  if (!pack) throw new Error(`No pack named ${packName}`)
  if (!pack.installed) {
    const row = win.getByRole('article', { name: packName, exact: true })
    await row.getByRole('button', { name: 'Install' }).click()
    console.log('installing', packName)
    const t0 = Date.now()
    let lastLog = 0
    while (!pack.installed) {
      await win.waitForTimeout(5000)
      packs = await call(() => window.maris.media.packs())
      pack = packs.find((p) => p.name === packName)
      if (Date.now() - lastLog > 60000) {
        lastLog = Date.now()
        console.log(`  ${Math.round((Date.now() - t0) / 1000)}s: installing=${pack.installing} missing=${pack.missingGB} GB`)
        await shot(`m2-installing-${kind}`)
      }
      if (!pack.installing && !pack.installed) {
        await win.waitForTimeout(3000)
        packs = await call(() => window.maris.media.packs())
        pack = packs.find((p) => p.name === packName)
        if (!pack.installing && !pack.installed) throw new Error('Install stopped without finishing (see m2 screenshot)')
      }
      if (Date.now() - t0 > 90 * 60000) throw new Error('Install timed out')
    }
    console.log(`installed in ${Math.round((Date.now() - t0) / 1000)}s`)
  }
  await win.waitForTimeout(1000)
  const t1 = Date.now()
  const job = await call(
    ([k, p, id]) => window.maris.media.generate({ kind: k, prompt: p, packId: id, seconds: 2, width: k === 'video' ? 832 : 1024, height: k === 'video' ? 480 : 1024 }),
    [kind, prompt, pack.id]
  )
  console.log(`job ${job.status} in ${Math.round((Date.now() - t1) / 1000)}s`, job.error ?? '', job.results?.map((r) => r.path).join(', ') ?? '')
  if (job.status !== 'done' || !job.results.length || !existsSync(job.results[0].path)) code = 1
  await win.getByRole('button', { name: 'Memory', exact: true }).click()
  await win.getByRole('button', { name: 'Models', exact: true }).click()
  await win.getByRole('tab', { name: kind === 'video' ? 'Videos' : 'Pictures' }).click()
  await win.waitForTimeout(1500)
  await shot(`m3-result-${kind}`)
} catch (e) {
  code = 1
  console.log('ERROR', e.message)
  await shot(`m9-error-${kind}`).catch(() => undefined)
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  process.exit(code)
}
