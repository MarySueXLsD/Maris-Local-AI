// Checks that the packaged app (release/windows/win-unpacked/Maris.exe) starts and its main-process services work from the asar.
import { _electron as electron } from 'playwright-core'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const exe = process.env.MARIS_EXE ?? path.join(root, 'release', 'windows', 'win-unpacked', 'Maris.exe')
const shots = path.resolve(process.argv[2] ?? os.tmpdir())
const profile = path.join(os.tmpdir(), `maris-pkg-${Date.now()}`)
const app = await electron.launch({ executablePath: exe, env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
let code = 0
try {
  // Always drain the app's stdout/stderr: on Windows a full pipe blocks the app's main thread.
const drainOutput = (s) => s?.on('data', () => undefined)
drainOutput(app.process().stdout)
drainOutput(app.process().stderr)
const win = await app.firstWindow()
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  // A fresh profile opens the setup assistant; skip it.
  const skipSetup = win.getByRole('button', { name: 'Skip setup for now' })
  await skipSetup.waitFor({ timeout: 30000 }).then(() => skipSetup.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  const info = await win.evaluate(async () => {
    const a = window.maris
    const [models, packs, comfy, app] = await Promise.all([a.models.list(), a.media.packs(), a.media.comfyState(), a.app.info()])
    return { models: models.length, packs: packs.length, comfyDir: comfy.dir, version: app.version }
  })
  console.log('packaged app OK', JSON.stringify(info))
  if (!info.models || info.packs !== 5) code = 1
  await win.screenshot({ path: path.join(shots, 'p1-packaged.png') })
} catch (e) {
  code = 1
  console.log('ERROR', e.message)
} finally {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  process.exit(code)
}
