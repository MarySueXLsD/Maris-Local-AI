// The trailer's one timeline. Everything is written in beats of a designed grid (112.5 BPM, so a
// beat is 32 frames at 60 fps and every cut lands on a whole frame) and turned into seconds here.
// The picture (film/), the score (score.py) and the checks all read timeline.json; nothing else
// holds a time. Usage: node scripts/trailer/make-timeline.mjs
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BPM = 112.5
const BEAT = 60 / BPM
const FPS = 60
const s = (beats) => Math.round(beats * BEAT * 1e4) / 1e4

// Scene edges, in beats.
const B = { hook: 0, chat: 6, pictures: 15, models: 21, laptop: 28, read: 34, halt: 40, payoff: 48, end: 57, fin: 69 }

// Named beats inside each scene, in beats from the start of the film.
const beats = {
  hook: { start: 0, type: 0.5, typed: 5.4, leave: 5.85 },
  chat: { send: 6, line: 6.5, chip: 9.5 },
  pictures: { cut: 15, line: 15.25, tile1: 15, tile2: 15.5, tile3: 16, tile4: 16.5, clip: 17 },
  models: { cut: 21, line: 21.25, hop1: 22.5, hop2: 23.5, hop3: 24.5 },
  laptop: { cut: 28, line: 28.25, memory: 29 },
  read: { cut: 34, line: 34.25, build: 36 },
  halt: { ask: 40, push: 40.3, rule: 40.75, stop: 41.5, cursor: 44.5, rest: 45.2, held: 45.5, move: 46.3, aim: 47.2 },
  payoff: { click: 48, release: 48.2, back: 50, diff: 51.5, line: 51.75, undo: 53.5, look: 54.25 },
  end: { morph: 57, land: 59, links: 59.5 }
}

// What is typed on screen during the hook (the same words capture.mjs types), and when each character
// appears: an uneven rhythm, a little slower after a space, from a seeded generator so it never changes.
const TYPED = { hook: { text: 'What can you do for me on this PC? Three short bullet points.', from: beats.hook.type, to: beats.hook.typed } }
function rhythm({ text, from, to }, seed) {
  let a = seed
  const random = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gaps = [...text].map((c, i) => (0.7 + 0.6 * random()) * (i > 0 && text[i - 1] === ' ' ? 1.5 : 1))
  const total = gaps.reduce((x, y) => x + y, 0)
  let run = 0
  return gaps.map((g) => s(from + ((run += g) / total) * (to - from)))
}

const order = ['hook', 'chat', 'pictures', 'models', 'laptop', 'read', 'halt', 'payoff', 'end']
const next = (id) => order[order.indexOf(id) + 1] ?? 'fin'
const seams = {
  hook: { type: 'next step', dur: 0.6, why: 'the question typed during the hook is sent, and the window moves in to answer it', bridge: 'window' },
  chat: { type: 'match on position', dur: 0, why: 'the window opens into the pictures it can make, in the same place', bridge: 'window' },
  pictures: { type: 'match on position', dur: 0, why: 'the pictures close back into the window, now on the Models page', bridge: 'window' },
  models: { type: 'time cut', dur: 0, why: 'same window, another computer: the setup assistant on an old laptop', bridge: 'window' },
  laptop: { type: 'time cut', dur: 0, why: 'same window, back on this PC, a moment after it was given work in a project', bridge: 'window' },
  read: { type: 'cause → effect', dur: 0, why: 'the task needs a file changed, so Maris stops and asks', bridge: 'window' },
  halt: { type: 'cause → effect', dur: 0, why: 'the click on Approve is what lets everything move again', bridge: 'cursor' },
  payoff: { type: 'shape morph', dur: 1.07, why: 'the window becomes the cartridge it comes in: the logo', bridge: 'window' }
}

// Text that is meant to be read. from/to bound the time it is fully legible; px is the rendered size;
// box is where it is on the frame (measured from the page with render.mjs --texts), for the checks.
const texts = [
  { id: 'hook', role: 'hook', px: 100, text: 'Private AI that runs on your PC.', from: s(0), to: s(5.85), box: [96, 428, 844, 235] },
  { id: 'name', role: 'term', px: 76, text: 'Maris', from: s(0), to: s(5.85), box: [210, 309, 189, 101] },
  { id: 'cta', role: 'cta', px: 48, text: 'github.com/MarySueXLsD/Maris-Local-AI', from: s(0), to: s(5.85), box: [96, 694, 1023, 56] },
  { id: 'ask', px: 88, text: 'Ask it anything.', from: s(7.3), to: s(14.6) },
  { id: 'local', px: 36, text: 'Answered on this PC.', from: s(10.3), to: s(14.6) },
  { id: 'make', px: 88, text: 'Make pictures and video.', from: s(16.0), to: s(20.6) },
  { id: 'made', px: 36, text: 'Made locally in Maris.', from: s(16.3), to: s(20.6) },
  { id: 'any', px: 88, text: 'Use any model.', from: s(21.9), to: s(27.6) },
  { id: 'key', px: 36, text: 'Local, or with your own key.', from: s(22.1), to: s(27.6) },
  { id: 'old', px: 88, text: 'Even on an old laptop.', from: s(28.9), to: s(33.6) },
  { id: 'sim', px: 36, text: 'Simulated 2012 laptop.', from: s(29.1), to: s(33.6) },
  { id: 'reads', px: 88, text: 'It can read everything.', from: s(34.9), to: s(39.6) },
  { id: 'rule', px: 88, text: 'It changes nothing without your OK.', from: s(41.7), to: s(47.98) },
  { id: 'approved', px: 124, text: 'Approved.', from: s(48.3), to: s(51.2) },
  { id: 'undo', px: 88, text: 'Undo any edit.', from: s(52.55), to: s(56.7) },
  { id: 'code', px: 36, text: 'In Code mode.', from: s(52.75), to: s(56.7) },
  { id: 'endname', role: 'term', px: 104, text: 'Maris', from: s(60.4), to: s(69), box: [96, 231, 256, 138] },
  { id: 'endline', px: 40, text: 'Private AI that runs on your PC.', from: s(60.6), to: s(69) },
  { id: 'what-repo', px: 34, text: 'Get it for Windows, macOS and Linux', from: s(60.9), to: s(69) },
  { id: 'link-repo', role: 'cta', px: 52, text: 'github.com/MarySueXLsD/Maris-Local-AI', from: s(60.9), to: s(69), box: [96, 507, 1108, 60] },
  { id: 'what-git', px: 34, text: 'More from the author', from: s(61.1), to: s(69) },
  { id: 'link-git', px: 40, text: 'github.com/MarySueXLsD', from: s(61.1), to: s(69) },
  { id: 'what-itch', px: 34, text: 'Games', from: s(61.3), to: s(69) },
  { id: 'link-itch', px: 40, text: 'marysue.itch.io', from: s(61.3), to: s(69) }
]

const tl = {
  meta: {
    w: 1920, h: 1080, fps: FPS, dur: s(B.fin), clock: 'music', register: 'clean', loop: false,
    bpm: BPM, meter: '4/4', bars: B.fin / 4, t0: 0, songOffset: 0, grid: 'designed', hookWaiver: null,
    beat: BEAT, framesPerBeat: (FPS * 60) / BPM
  },
  objects: [
    { id: 'window', role: 'constant', what: 'the Maris window: one card, in one place; what is in it changes on the beat, and at the end it becomes the cartridge logo' },
    { id: 'headline', role: 'prop', what: 'one line of large type in the left column per scene, with at most one small line under it' },
    { id: 'ring', role: 'prop', what: 'a drawn ring that says "look here" on the real interface; never part of it' },
    { id: 'glass', role: 'prop', what: 'a magnifying glass on the real interface: the same pixels, larger, where a small word is the proof' },
    { id: 'cursor', role: 'hero', what: 'the pointer that gives the OK: it appears only for the approval' },
    { id: 'cartridge', role: 'bridge', what: 'the Maris mark: beside the name in the hook, and what the window turns into at the end' }
  ],
  scenes: order.map((id) => ({
    id,
    start: s(B[id]),
    end: s(B[next(id)]),
    beats: Object.fromEntries(Object.entries(beats[id]).map(([k, v]) => [k, s(v)])),
    ...(seams[id] ? { transitionOut: seams[id] } : {})
  })),
  // Where the whole window changes at once.
  cuts: [B.pictures, B.models, B.laptop, B.read, B.halt, beats.payoff.diff, beats.payoff.undo].map(s),
  hero: { t: s(beats.payoff.click), what: 'after three and a half seconds in which nothing moves on and nothing sounds, the pointer presses Approve and the film starts again' },
  silences: [{ from: s(beats.halt.stop) + 0.12, to: s(beats.payoff.click) - 0.05 }],
  arc: { quantity: 'how close the camera is to the window', values: { 'hook to laptop': 1.5, read: '1.5 → 1.55', halt: '1.55 → 2.3', payoff: '2.3 → 1.5', end: 'the window becomes the logo' } },
  // Sound: every cue hangs on a named beat. gain is relative (score.py sets the levels).
  sfx: [
    { at: 'hook.type', offset: 0, src: 'keys', gain: 0.5, why: 'the question being typed; a tick for about every second character' },
    { at: 'chat.send', offset: 0, src: 'pop', gain: 0.5, why: 'the message leaves' },
    { at: 'pictures.tile1', offset: 0, src: 'tile:0', gain: 0.6, why: 'a picture lands (rising notes, one per picture)' },
    { at: 'pictures.tile2', offset: 0, src: 'tile:1', gain: 0.6, why: 'second picture' },
    { at: 'pictures.tile3', offset: 0, src: 'tile:2', gain: 0.6, why: 'third picture' },
    { at: 'pictures.tile4', offset: 0, src: 'tile:3', gain: 0.6, why: 'fourth picture' },
    { at: 'pictures.clip', offset: 0, src: 'tile:4', gain: 0.65, why: 'the video tile' },
    { at: 'halt.ask', offset: 0, src: 'thunk', gain: 0.8, why: 'the approval request lands and the music starts to fall away' },
    { at: 'payoff.click', offset: 0, src: 'click+hit', gain: 1.0, why: 'the OK: the loudest moment of the film' },
    { at: 'end.land', offset: 0, src: 'latch+note', gain: 0.5, why: 'the cartridge seats; one soft note in key, then the tail' }
  ],
  texts,
  terms: ['Maris', 'Private AI', 'your PC'],
  // The second each typed character appears (the picture shows it, the score ticks on some of them).
  typing: { hook: rhythm(TYPED.hook, 7) },
  // zoom is screen pixels per point of the window; focus names a place in the footage (film.js resolves it).
  camera: [
    { t: s(0), zoom: 1.5, focus: 'whole', why: 'the whole window' },
    { t: s(beats.read.cut), zoom: 1.5, focus: 'whole', why: 'the task has just been sent' },
    { t: s(beats.halt.push), zoom: 1.545, focus: 'whole', why: 'a 3% lean in while Maris works: the hold is alive, and it is the start of the push' },
    { t: s(beats.halt.rest), zoom: 2.3, focus: 'request', why: 'a slow push through the silence, at rest before the pointer goes to Approve' },
    { t: s(beats.payoff.release), zoom: 2.3, focus: 'request', why: 'still through the click' },
    { t: s(beats.payoff.back), zoom: 1.5, focus: 'whole', why: 'release: back to the whole window as work resumes' }
  ]
}

writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(tl, null, 2) + '\n')
writeFileSync(path.join(here, 'film', 'timeline.js'), `// Made by make-timeline.mjs from the same data as timeline.json. Do not edit.\nwindow.TL = ${JSON.stringify(tl)}\n`)
console.log(`timeline: ${tl.meta.dur} s, ${tl.meta.bars} bars at ${BPM} BPM, ${tl.scenes.length} scenes, hero at ${tl.hero.t} s (${Math.round((tl.hero.t / tl.meta.dur) * 100)}%)`)
