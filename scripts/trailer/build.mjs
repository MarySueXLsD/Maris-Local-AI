// Builds the trailer from what capture.mjs recorded: timeline -> footage list -> score -> picture ->
// the film with its sound -> the checks.
//   node scripts/trailer/build.mjs            everything
//   node scripts/trailer/build.mjs --sound     only the score and the mux (the picture is kept)
//   node scripts/trailer/build.mjs --draft     a quick half-size picture instead of the master
// Result: scripts/trailer/out/maris-trailer.mp4 (and maris-trailer-picture.mp4 without sound).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpeg } from './ffmpeg.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'out')
const draft = process.argv.includes('--draft')
const soundOnly = process.argv.includes('--sound')
const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'import numpy, scipy, PIL'], { encoding: 'utf8' }).status === 0)
if (!python) throw new Error('Python with numpy, scipy and Pillow is needed: pip install numpy scipy pillow imageio-ffmpeg')

const run = (what, exe, args) => {
  console.log(`\n== ${what}`)
  const r = spawnSync(exe, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${what} failed`)
}
const node = (script, ...args) => [process.execPath, [path.join(here, script), ...args]]

run('timeline', ...node('make-timeline.mjs'))
if (!soundOnly) run('footage list', ...node('make-footage.mjs'))
run('score', python, [path.join(here, 'score.py')])
const picture = path.join(out, draft ? 'maris-trailer-draft.mp4' : 'maris-trailer-picture.mp4')
if (!soundOnly || !existsSync(picture)) run('picture', ...node('render.mjs', ...(draft ? ['--draft'] : [])))
const film = path.join(out, draft ? 'maris-trailer-draft-sound.mp4' : 'maris-trailer.mp4')
// The picture is copied as it is; the sound becomes AAC and ends where the picture ends.
run('film', ffmpeg(), ['-v', 'error', '-y', '-i', picture, '-i', path.join(out, 'score.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', film])
console.log(`\n${film}`)
if (!draft) {
  // A small copy for places with a size limit (a README, a chat): 720p, 30 frames a second.
  const small = path.join(out, 'maris-trailer-720p.mp4')
  run('small copy', ffmpeg(), ['-v', 'error', '-y', '-i', film, '-vf', 'scale=1280:720:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', small])
  console.log(small)
}
run('checks', python, [path.join(here, 'qa.py'), film, '--out', path.join(out, draft ? 'qa-draft' : 'qa')])
