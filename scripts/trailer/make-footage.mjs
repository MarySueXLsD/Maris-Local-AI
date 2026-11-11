// Turns what capture.mjs recorded into the list the film page reads (film/footage.js), and cuts the
// sample video the app ships into frames, so the page can show it frame by frame.
// Usage: node scripts/trailer/make-footage.mjs   (after capture.mjs)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpeg } from './ffmpeg.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const footage = path.join(here, 'footage')
const previews = path.join(here, '..', '..', 'src', 'renderer', 'public', 'previews')
const read = (name) => JSON.parse(readFileSync(path.join(footage, `${name}.json`), 'utf8'))
const chat = read('chat')
const project = read('project')
const models = read('models')
const laptop = read('laptop')

// The sample clip (made by the app's own video pipeline for the Models page) as numbered frames.
// The lighthouse is the one whose movement (waves breaking) reads at the size of a tile.
const CLIP = { pack: 'video-quality', name: 'lighthouse', fps: 16 }
const clipDir = path.join(footage, 'clip')
rmSync(clipDir, { recursive: true, force: true })
mkdirSync(clipDir, { recursive: true })
const cut = spawnSync(ffmpeg(), ['-v', 'error', '-y', '-i', path.join(previews, CLIP.pack, `${CLIP.name}.mp4`), '-q:v', '2', path.join(clipDir, 'f-%03d.jpg')], { encoding: 'utf8' })
if (cut.status !== 0) throw new Error(`ffmpeg could not cut the sample clip: ${cut.stderr}`)
const clip = readdirSync(clipDir).filter((f) => f.endsWith('.jpg')).sort()

// The frames in which the approval request appears, and is gone after the click (the film puts both on beats).
const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'import numpy, PIL'], { encoding: 'utf8' }).status === 0)
if (!python) throw new Error('Python with numpy and Pillow is needed (the score needs it too): pip install numpy pillow scipy')
const landing = spawnSync(python, [path.join(here, 'landing.py'), footage], { encoding: 'utf8' })
if (landing.status !== 0) throw new Error(`landing.py: ${landing.stderr || landing.stdout}`)
Object.assign(project.marks, JSON.parse(landing.stdout))

const from = (dir) => (file) => `../footage/${dir}/${file}`
const timed = (dir, frames) => frames.map((f) => ({ t: f.t, src: from(dir)(f.file) }))
const still = (dir, s) => ({ src: from(dir)(s.file), ...(s.boxes ? { boxes: s.boxes } : {}) })
const picture = (pack, name) => {
  const file = path.join(previews, pack, `${name}.jpg`)
  if (!existsSync(file)) throw new Error(`no sample picture ${pack}/${name}.jpg`)
  return `../../../src/renderer/public/previews/${pack}/${name}.jpg`
}

const out = {
  w: chat.w,
  h: chat.h,
  chat: {
    typing: chat.typing.map(from('chat')),
    frames: timed('chat', chat.frames),
    marks: chat.marks,
    home: from('chat')('home.png'),
    final: still('chat', chat.final)
  },
  project: {
    typing: project.typing.map(from('project')),
    work: timed('project', project.work.frames),
    after: timed('project', project.after.frames),
    marks: project.marks,
    home: from('project')('home.png'),
    // Where "Read forecast.py" stood when the list of steps was opened.
    read: project.boxes.read,
    ask: still('project', project.stills.ask),
    hover: still('project', project.stills.hover),
    finished: still('project', project.stills.finished),
    changes: still('project', project.stills.changes),
    diff: still('project', project.stills.diff)
  },
  models: { api: still('models', models.api) },
  laptop: { scan: still('laptop', laptop.stills.scan) },
  // Pictures the app's own models made on this PC (scripts/make-previews.mjs), shown as they are.
  pictures: [picture('image-lite', 'alpine-lake'), picture('image-quality', 'nook'), picture('image-lite', 'ramen'), picture('image-quality', 'fox')],
  clip: { fps: CLIP.fps, frames: clip.map(from('clip')) }
}
writeFileSync(path.join(here, 'film', 'footage.js'), `// Made by make-footage.mjs from scripts/trailer/footage. Do not edit.\nwindow.FOOTAGE = ${JSON.stringify(out)}\n`)
console.log(`footage: chat ${out.chat.typing.length} + ${out.chat.frames.length} frames, project ${out.project.typing.length} + ${out.project.work.length} + ${out.project.after.length}, clip ${clip.length} frames`)
