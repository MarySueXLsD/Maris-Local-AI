// Photographs the film page frame by frame and encodes the frames with ffmpeg.
//   node scripts/trailer/render.mjs                       the whole film -> out/maris-trailer-picture.mp4
//   node scripts/trailer/render.mjs --stills 1.5,12,29.9  full-size stills -> out/stills/
//   node scripts/trailer/render.mjs --strip 24.3,24.9,0.05  a still every 0.05 s over a stretch
//   node scripts/trailer/render.mjs --draft               half size, 30 frames a second, to judge the rhythm
//   node scripts/trailer/render.mjs --from 20 --to 31      part of it
// Options: --out <file>, --workers <n> (pages rendering at once; 3), --crf <n> (16).
// The page is opened in the Chrome (or Edge) installed on this computer, headless. A script error or
// a missing picture on the page stops the render instead of producing a broken film.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { ffmpeg } from './ffmpeg.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'out')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)
const draft = has('draft')

async function openBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true, args: ['--force-color-profile=srgb', '--disable-lcd-text', '--hide-scrollbars'] })
    } catch {
      /* try the next one */
    }
  }
  throw new Error('neither Chrome nor Edge could be started')
}

/** A page with the film loaded and ready, and a way to photograph it at a time. */
async function openFilm(browser, scale) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
  page.on('requestfailed', (r) => problems.push(`could not load ${r.url()}`))
  await page.goto(`${pathToFileURL(path.join(here, 'film', 'index.html'))}#still`)
  await page.evaluate(() => window.READY)
  const cdp = await context.newCDPSession(page)
  const info = await page.evaluate(() => ({ dur: window.DUR, fps: window.FPS }))
  const shoot = async (t) => {
    await page.evaluate((t) => window.seek(t), t)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    if (problems.length) throw new Error(problems.join('\n'))
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(r.data, 'base64')
  }
  return { page, context, shoot, ...info }
}

const browser = await openBrowser()
try {
  if (has('stills') || has('strip')) {
    const film = await openFilm(browser, 1)
    let times = []
    if (has('stills')) times = arg('stills').split(',').map(Number)
    if (has('strip')) {
      const [a, b, step] = arg('strip').split(',').map(Number)
      for (let t = a; t <= b + 1e-9; t += step) times.push(Math.round(t * 1000) / 1000)
    }
    const dir = path.join(out, has('strip') ? 'strip' : 'stills')
    mkdirSync(dir, { recursive: true })
    for (const t of times) {
      const file = path.join(dir, `t-${t.toFixed(3).padStart(6, '0')}.png`)
      writeFileSync(file, await film.shoot(t))
      if (has('texts')) console.log(t, JSON.stringify(await film.page.evaluate(() => window.TEXTS())))
    }
    console.log(`${times.length} still(s) in ${dir}`)
  } else {
    const scale = draft ? 0.5 : 1
    const probe = await openFilm(browser, scale)
    const fps = draft ? 30 : probe.fps
    const first = Math.round(Number(arg('from', 0)) * fps)
    const last = Math.round(Number(arg('to', probe.dur)) * fps) // not included
    await probe.context.close()
    const workers = Math.max(1, Math.min(Number(arg('workers', 3)), Math.ceil((last - first) / (fps * 4))))
    const file = path.resolve(arg('out', path.join(out, draft ? 'maris-trailer-draft.mp4' : 'maris-trailer-picture.mp4')))
    const parts = path.join(out, 'parts')
    rmSync(parts, { recursive: true, force: true })
    mkdirSync(parts, { recursive: true })
    const edges = Array.from({ length: workers + 1 }, (_, i) => first + Math.round(((last - first) * i) / workers))
    const started = Date.now()
    let made = 0
    const tick = setInterval(() => process.stdout.write(`\r  ${made} of ${last - first} frames, ${((Date.now() - started) / 1000).toFixed(0)} s `), 2000)
    const files = await Promise.all(
      edges.slice(0, -1).map(async (from, i) => {
        const to = edges[i + 1]
        const film = await openFilm(browser, scale)
        const part = path.join(parts, `part-${i}.mp4`)
        // BT.709, TV range, constant frame rate; every part starts on a keyframe, so they join without a seam.
        const enc = spawn(ffmpeg(), ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(arg('crf', draft ? 24 : 16)), '-g', String(fps * 2), '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-r', String(fps), part], { stdio: ['pipe', 'inherit', 'inherit'] })
        const closed = new Promise((resolve, reject) => enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ended with ${code}`)))))
        for (let f = from; f < to; f++) {
          const png = await film.shoot(f / fps)
          if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once('drain', r))
          made++
        }
        enc.stdin.end()
        await closed
        await film.context.close()
        return part
      })
    )
    clearInterval(tick)
    const list = path.join(parts, 'list.txt')
    writeFileSync(list, files.map((f) => `file '${f.replaceAll('\\', '/')}'`).join('\n'))
    const join = spawnSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file], { encoding: 'utf8' })
    if (join.status !== 0) throw new Error(`ffmpeg could not join the parts: ${join.stderr}`)
    rmSync(parts, { recursive: true, force: true })
    console.log(`\n${last - first} frames at ${fps} a second in ${((Date.now() - started) / 1000).toFixed(0)} s -> ${file}`)
  }
} finally {
  await browser.close()
}
