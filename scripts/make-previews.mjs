// Renders the sample prompts (src/shared/mediaSamples.ts) with picture and video models, through the
// packaged app's own pipeline, into src/renderer/public/previews/<pack>/ and records them in
// src/renderer/src/lib/previews.json; model cards show them with "Use this prompt".
//
// Usage: npm run dist:dir && MARIS_EXE=release\windows\win-unpacked\Maris.exe node scripts/make-previews.mjs [options] [packId…]
//   --install-missing  install the models that are not there yet (through the app), render with them,
//                      and remove them again at the end (files other installed models use are kept)
//   --port N           run the app's own image engine on this port, so an engine another Maris is
//                      using on 8188 is left alone (its graphics memory is freed before each model)
//   --remove a,b       also remove these models at the end (installed earlier just for previews)
//   MARIS_DATA_DIR     the data folder with the image engine (default H:\MarisData)
// Without pack ids it renders the installed models (with --install-missing: the ones it installed).
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANIMATE_SAMPLES, IMAGE_SAMPLES, LITE_SAMPLES, VIDEO_SAMPLES } from '../src/shared/mediaSamples.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.env.MARIS_EXE
if (!exe) throw new Error('Set MARIS_EXE to a packaged Maris.exe')
const argv = process.argv.slice(2)
const installMissing = argv.includes('--install-missing')
const valueOf = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined)
const port = valueOf('--port')
const removeAfter = (valueOf('--remove') ?? '').split(',').filter(Boolean)
const only = argv.filter((a, i) => !a.startsWith('--') && !['--port', '--remove'].includes(argv[i - 1]))
const dataDir = process.env.MARIS_DATA_DIR ?? 'H:\\MarisData'
const outRoot = path.join(root, 'src', 'renderer', 'public', 'previews')
const manifestFile = path.join(root, 'src', 'renderer', 'src', 'lib', 'previews.json')
const profile = path.join(os.tmpdir(), `maris-previews-${Date.now()}`)
const scratch = path.join(os.tmpdir(), `maris-previews-out-${Date.now()}`)
mkdirSync(scratch, { recursive: true })
const python = path.join(dataDir, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe')
const comfyOut = path.join(dataDir, 'ComfyUI_windows_portable', 'ComfyUI', 'output', 'maris')
const started = Date.now()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const needsStart = (p) => p.startImage === 'needed' || p.id === 'video-quality-i2v'
// Turbo Lite is Turbo in 8 bits: with Turbo's seeds its pictures would look the same, so it gets its own.
const SEED_BASE = { 'image-lite': 7301 }
const seedOf = (packId, i) => (SEED_BASE[packId] ?? 1106) + i

const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { gpu: '', packs: {} }
const app = await electron.launch({ executablePath: exe, env: { ...process.env, MARIS_USER_DATA: profile }, timeout: 60000 })
const win = await app.firstWindow()
const installedByUs = []

/** Another Maris's engine on the usual port: wait until it is idle, then ask it to free the graphics card. */
async function freeOtherEngine() {
  if (!port || port === '8188') return
  try {
    for (let i = 0; i < 720; i++) {
      const q = await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
      if (!q.queue_running.length && !q.queue_pending.length) break
      if (i === 0) log('The other image engine is busy; waiting for it to finish…')
      await new Promise((r) => setTimeout(r, 5000))
    }
    await fetch('http://127.0.0.1:8188/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(5000) })
    await new Promise((r) => setTimeout(r, 3000))
  } catch {
    /* no other engine running */
  }
}

async function generate(params) {
  return win.evaluate((p) => window.maris.media.generate(p), params)
}

/** A preview JPEG (at most 1024 pixels wide, so it can open full size) made by the app's own image library. */
async function saveJpeg(src, dest, width, max = 1024) {
  const b64 = await app.evaluate(({ nativeImage }, [file, w]) => nativeImage.createFromPath(file).resize({ width: w, quality: 'best' }).toJPEG(84).toString('base64'), [src, Math.min(max, width)])
  writeFileSync(dest, Buffer.from(b64, 'base64'))
}

try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  // A second engine next to another Maris's: its own port, and without ComfyUI's assets database (only one
  // engine at a time may hold it).
  await win.evaluate(
    ([dir, out, url]) => window.maris.settings.set({ dataDir: dir, media: { outputDir: out, ...(url ? { extraArgs: '--disable-assets' } : {}) }, ...(url ? { comfyUrl: url } : {}) }),
    [dataDir, scratch, port ? `http://127.0.0.1:${port}` : undefined]
  )
  // The monitor needs a moment for its first reading of the graphics card.
  for (let t = 0; t < 30 && !manifest.gpu; t++) {
    const status = await win.evaluate(() => window.maris.system.status())
    if (status.gpu?.name) manifest.gpu = status.gpu.name
    else await win.waitForTimeout(1000)
  }
  let packs = await win.evaluate(() => window.maris.media.packs())

  if (installMissing) {
    await win.evaluate(() => {
      window.__dl = {}
      window.maris.media.onDownload((d) => (window.__dl[d.id] = d))
    })
    for (const p of packs) {
      if (p.installed || (only.length && !only.includes(p.id))) continue
      log(`Installing ${p.name} (${p.missingGB} GB to download)…`)
      const t0 = Date.now()
      const done = win.evaluate((id) => window.maris.media.installPack(id).then(() => '', (e) => String(e?.message ?? e)), p.id)
      let err
      for (;;) {
        const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 30000))])
        if (r !== null) {
          err = r
          break
        }
        const d = await win.evaluate((id) => window.__dl[id], p.id)
        if (d?.totalBytes) log(`  ${(d.receivedBytes / 1e9).toFixed(1)} of ${(d.totalBytes / 1e9).toFixed(1)} GB${d.file ? ` (${d.file})` : ''}`)
      }
      if (err) {
        log(`  failed: ${err}`)
        continue
      }
      installedByUs.push(p.id)
      log(`  installed in ${Math.round((Date.now() - t0) / 60000)} min`)
    }
    packs = await win.evaluate(() => window.maris.media.packs())
  }

  const targets = packs.filter((p) => p.installed && (only.length ? only.includes(p.id) : installMissing ? installedByUs.includes(p.id) : true))
  for (const pack of targets) {
    await freeOtherEngine()
    const dir = path.join(outRoot, pack.id)
    mkdirSync(dir, { recursive: true })
    const entries = []
    // One untimed picture first, so the times recorded do not include starting the engine or loading the model.
    if (pack.kind === 'image') {
      log(`${pack.name}: warming up…`)
      await generate({ kind: 'image', prompt: IMAGE_SAMPLES[0].prompt, packId: pack.id, width: 1024, height: 1024, seed: 1, count: 1 })
    }
    const samples = pack.kind === 'image' ? (pack.id === 'image-lite' ? LITE_SAMPLES : IMAGE_SAMPLES) : needsStart(pack) ? ANIMATE_SAMPLES : VIDEO_SAMPLES
    for (const [i, s] of samples.entries()) {
      let start
      if (s.image) {
        // The picture the clip starts from, made with the fast picture model at the clip's shape.
        const pic = IMAGE_SAMPLES.find((x) => x.id === s.image)
        const made = await generate({ kind: 'image', prompt: pic.prompt, packId: 'image-fast', width: 1280, height: 704, seed: 2206 + i, count: 1 })
        if (made.status !== 'done' || !made.results[0]) {
          log(`${pack.name}: ${s.id}: start picture failed: ${made.error ?? made.status}`)
          continue
        }
        start = made.results[0].path
        await freeOtherEngine()
      }
      const params =
        pack.kind === 'image'
          ? { kind: 'image', prompt: s.prompt, packId: pack.id, width: 1024, height: 1024, seed: seedOf(pack.id, i), count: 1 }
          : { kind: 'video', prompt: s.prompt, packId: pack.id, seed: seedOf(pack.id, i), seconds: pack.tier === 'fast' ? 3 : 5, inputImage: start }
      log(`${pack.name}: ${s.id}…`)
      const job = await generate(params)
      if (job.status !== 'done' || !job.results[0]) {
        log(`  failed: ${job.error ?? job.status}`)
        continue
      }
      const r = job.results[0]
      const seconds = Math.round(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 100) / 10
      if (pack.kind === 'image') {
        await saveJpeg(r.path, path.join(dir, `${s.id}.jpg`), r.width)
        entries.push({ sample: s.id, file: `${s.id}.jpg`, seconds, width: r.width, height: r.height })
      } else {
        execFileSync(python, ['-I', path.join(root, 'scripts', 'shrink-video.py'), r.path, path.join(dir, `${s.id}.mp4`), path.join(dir, `${s.id}.jpg`), '832', '30'], { stdio: 'ignore' })
        const entry = { sample: s.id, file: `${s.id}.mp4`, poster: `${s.id}.jpg`, seconds, width: r.width, height: r.height }
        if (start) {
          await saveJpeg(start, path.join(dir, `${s.id}-start.jpg`), 1280)
          entry.start = `${s.id}-start.jpg`
        }
        entries.push(entry)
      }
      log(`  ${seconds} s`)
    }
    if (entries.length) {
      // Files from an earlier set of examples (other prompts) go, so the app only ships what it shows.
      const keep = new Set(entries.flatMap((e) => [e.file, e.poster, e.start].filter(Boolean)))
      for (const f of readdirSync(dir)) if (!keep.has(f)) await rm(path.join(dir, f), { force: true })
      manifest.packs[pack.id] = entries
      // Saved after every model, so a later failure keeps what was made.
      writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
      log(`Wrote ${entries.length} previews for ${pack.name}`)
    }
  }
} finally {
  const toRemove = [...new Set([...installedByUs, ...removeAfter])]
  if (toRemove.length) {
    // The engine keeps model files open; stop it before removing what was installed for the previews.
    await win.evaluate(() => window.maris.media.stopComfy()).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 4000))
    for (const id of toRemove) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await win.evaluate((x) => window.maris.media.removePack(x), id).catch(() => undefined)
        const p = (await win.evaluate(() => window.maris.media.packs())).find((x) => x.id === id)
        if (!p?.installed) {
          log(`Removed ${p?.name ?? id} again`)
          break
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  await app.close().catch(() => undefined)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined)
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined)
  // The image engine keeps its own copy of every result; remove the ones made for the previews.
  if (existsSync(comfyOut)) {
    for (const f of readdirSync(comfyOut)) {
      const p = path.join(comfyOut, f)
      if (statSync(p).isFile() && statSync(p).mtimeMs >= started) await rm(p, { force: true }).catch(() => undefined)
    }
  }
}
