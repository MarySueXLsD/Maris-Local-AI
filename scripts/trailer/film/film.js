// The Maris trailer as a page. Every frame is a function of time alone: seek(t) sets everything on the
// stage from t, with no timers, transitions or state carried over, so frames can be photographed in
// any order (render.mjs) and always come out the same. Times come from timeline.js (made from the same
// data as timeline.json, which the score and the checks read too): beats are named, never typed here.
;(() => {
  'use strict'
  const TL = window.TL
  const F = window.FOOTAGE
  const stage = document.getElementById('stage')
  const scene = Object.fromEntries(TL.scenes.map((s) => [s.id, s]))
  /** The second of a named beat: at('halt.ask'). */
  const at = (ref) => {
    const [s, b] = ref.split('.')
    const v = scene[s]?.beats[b]
    if (v === undefined) throw new Error(`the timeline has no beat "${ref}"`)
    return v
  }
  const words = Object.fromEntries(TL.texts.map((x) => [x.id, x]))
  const DUR = TL.meta.dur

  // ------------------------------------------------------------------ motion
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
  const lerp = (a, b, p) => a + (b - a) * p
  const prog = (t, start, dur) => clamp((t - start) / dur)
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1
    const bx = 3 * (x2 - x1) - cx
    const ax = 1 - cx - bx
    const cy = 3 * y1
    const by = 3 * (y2 - y1) - cy
    const ay = 1 - cy - by
    const fx = (u) => ((ax * u + bx) * u + cx) * u
    return (x) => {
      if (x <= 0) return 0
      if (x >= 1) return 1
      let lo = 0
      let hi = 1
      let u = x
      for (let i = 0; i < 40; i++) {
        u = (lo + hi) / 2
        if (fx(u) < x) lo = u
        else hi = u
      }
      return ((ay * u + by) * u + cy) * u
    }
  }
  const arrive = bezier(0.16, 1, 0.3, 1) // entrances: fast in, long settle
  const leave = bezier(0.6, 0, 0.9, 0.35) // exits: slow start, gone
  const travel = bezier(0.65, 0, 0.35, 1) // from one state to another
  /** A spring from 0 to 1 that starts at rest. */
  const spring = (tau, f, z) => {
    if (tau <= 0) return 0
    const w = 2 * Math.PI * f
    const wd = w * Math.sqrt(1 - z * z)
    return 1 - Math.exp(-z * w * tau) * (Math.cos(wd * tau) + ((z * w) / wd) * Math.sin(wd * tau))
  }

  // ------------------------------------------------------------------ the stage
  // The window is shown without its status bar (the strip of processor and graphics-card readings at
  // its foot): 574 of its 600 points, at 1.5 screen pixels a point.
  const SEEN = 574
  const CARD = { x: 720, y: 110, w: 1152, h: SEEN * 1.5, r: 18 } // the window, at rest
  const PEEK = 1240 // its left edge while the hook is up
  const add = (tag, attrs = {}, parent = stage, html) => {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    if (html !== undefined) e.innerHTML = html
    parent.append(e)
    return e
  }
  const px = (n) => `${Math.round(n * 100) / 100}px`

  // The Maris mark, from the same shapes as src/renderer/src/components/MarisMark.tsx (a 64 x 64 box).
  const MARK = {
    face: 'M16 5H23.8A8.5 8.5 0 0 0 36.8 5H44.6A6 6 0 0 1 50.6 11V37.2A6 6 0 0 1 44.6 43.2H16A6 6 0 0 1 10 37.2V11A6 6 0 0 1 16 5Z',
    connector: 'M15.8 45.6H44.8V54.6A3 3 0 0 1 41.8 57.6H18.8A3 3 0 0 1 15.8 54.6Z',
    pins: [17.5, 23.1, 28.7, 34.3, 39.9],
    ridges: 'M15.4 10.6H21.7M15.4 13.6H21.7M38.9 10.6H45.2M38.9 13.6H45.2',
    highlight: 'M11.6 37V11A4.4 4.4 0 0 1 16 6.6H21.9M38.7 6.6H44.6',
    m: 'M22.8 21.5h3v15h-3zM34.8 21.5h3v15h-3zM25.8 24.5h3v3h-3zM31.8 24.5h3v3h-3zM28.8 27.5h3v3h-3z',
    seal: '45.3 12.7 46.18 15.38 48.69 14.11 47.42 16.62 50.1 17.5 47.42 18.38 48.69 20.89 46.18 19.62 45.3 22.3 44.42 19.62 41.91 20.89 43.18 18.38 40.5 17.5 43.18 16.62 41.91 14.11 44.42 15.38',
    box: { x: 10, y: 5, w: 40.6, h: 38.2 } // the face
  }
  const markSvg = (size) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<path d="${MARK.face}" transform="translate(3.4 3.4)" fill="#523cb0"/>` +
    `<path d="${MARK.connector}" fill="#3a2980"/>` +
    MARK.pins.map((x) => `<rect x="${x}" y="49.2" width="3.2" height="6.4" rx="0.8" fill="#f2b544"/>`).join('') +
    `<path d="${MARK.face}" fill="#6a4fe0"/>` +
    `<path d="${MARK.ridges}" stroke="#5f46ca" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path d="${MARK.highlight}" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="1.4" stroke-linecap="round"/>` +
    `<rect x="15.3" y="17.5" width="30" height="23" rx="3" fill="#f7f5ff"/>` +
    `<path d="${MARK.m}" fill="#6a4fe0"/>` +
    `<polygon points="${MARK.seal}" fill="#f2b544" stroke="#3a2980" stroke-width="0.9" stroke-linejoin="round"/>` +
    `</svg>`

  const dim = add('div', { id: 'dim' })
  const card = add('div', { id: 'card' })
  const view = add('div', { id: 'view' }, card)
  const shot = add('img', { id: 'shot', alt: '' }, view)
  const ring = add('div', { id: 'ring' }, view)
  const glass = add('div', { id: 'glass' }, view)
  const glassShot = add('img', { alt: '' }, glass)
  const ripple = add('div', { id: 'ripple' }, view)
  const cursor = add(
    'div',
    { id: 'cursor' },
    view,
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="40" viewBox="0 0 13 20"><path d="M1 1v15.2l3.7-3.5 2.6 6 2.5-1.1-2.6-5.9H12.2z" fill="#fff" stroke="#17122e" stroke-width="1.1" stroke-linejoin="round"/></svg>'
  )

  // Pictures: three squares over one square and a wide tile for the clip, in the window's place.
  const GAP = 24
  const SIDE = (CARD.w - 2 * GAP) / 3
  const ROW = CARD.y + (CARD.h - (2 * SIDE + GAP)) / 2
  const tiles = [
    { x: CARD.x, y: ROW, w: SIDE, h: SIDE, src: F.pictures[0], t: at('pictures.tile1') },
    { x: CARD.x + SIDE + GAP, y: ROW, w: SIDE, h: SIDE, src: F.pictures[1], t: at('pictures.tile2') },
    { x: CARD.x + 2 * (SIDE + GAP), y: ROW, w: SIDE, h: SIDE, src: F.pictures[2], t: at('pictures.tile3') },
    { x: CARD.x, y: ROW + SIDE + GAP, w: SIDE, h: SIDE, src: F.pictures[3], t: at('pictures.tile4') },
    { x: CARD.x + SIDE + GAP, y: ROW + SIDE + GAP, w: 2 * SIDE + GAP, h: SIDE, clip: true, t: at('pictures.clip') }
  ]
  for (const tile of tiles) {
    tile.el = add('div', { class: 'tile' })
    tile.img = add('img', { alt: '' }, tile.el)
    Object.assign(tile.el.style, { left: px(tile.x), top: px(tile.y), width: px(tile.w), height: px(tile.h) })
  }

  // Headlines: one per scene, in the left column, with at most one small line under it.
  // `to` (when it leaves) comes from the timeline's texts.
  const HEADS = [
    { id: 'ask', lines: ['Ask it', 'anything.'], start: at('chat.line'), note: 'local', noteAt: at('chat.chip') },
    { id: 'make', lines: ['Make pictures', 'and video.'], start: at('pictures.line'), note: 'made' },
    { id: 'any', lines: ['Use any', 'model.'], start: at('models.line'), note: 'key' },
    { id: 'old', lines: ['Even on an', 'old laptop.'], start: at('laptop.line'), note: 'sim' },
    { id: 'reads', lines: ['It can read', 'everything.'], start: at('read.line') },
    // The rule stays, whole, until the very frame of the click: no fade under the word that replaces it.
    { id: 'rule', lines: ['It changes', 'nothing', 'without', '<b>your OK.</b>'], start: at('halt.rule'), cut: at('payoff.click') },
    { id: 'approved', lines: ['<b>Approved.</b>'], start: at('payoff.click'), snap: true },
    // It comes a quarter beat after the cut, when "Approved." has left: the two never share a frame.
    { id: 'undo', lines: ['Undo any', 'edit.'], start: at('payoff.line'), note: 'code' }
  ]
  for (const h of HEADS) {
    h.el = add('div', { class: 'head' })
    h.el.style.fontSize = px(words[h.id].px)
    h.parts = h.lines.map((line) => add('div', { class: 'line' }, h.el, line))
    if (h.note) h.parts.push(add('div', { class: 'note' }, h.el, words[h.note].text))
    h.end = h.cut ?? words[h.id].to
  }

  const hook = add('div', { id: 'hook' })
  const hookParts = [
    add('div', { class: 'brand' }, hook, `${markSvg(92)}<span>${words.name.text}</span>`),
    add('div', { class: 'promise' }, hook, 'Private AI that runs<br>on your PC.'),
    add('div', { class: 'cta' }, hook, `<span class="url">${words.cta.text}</span>`)
  ]

  const end = add('div', { id: 'end' })
  const endParts = [add('div', { class: 'name' }, end, words.endname.text), add('div', { class: 'promise' }, end, words.endline.text)]
  const links = add('div', { class: 'links' }, end)
  for (const id of ['repo', 'git', 'itch']) endParts.push(add('div', { class: `link ${id}` }, links, `<span class="what">${words[`what-${id}`].text}</span><span class="url">${words[`link-${id}`].text}</span>`))

  // The cartridge the window turns into: 600 px, standing where the window stood.
  const MARK_SIZE = 600
  const K = MARK_SIZE / 64
  const MARK_AT = { x: 1500 - 32 * K, y: 528 - 31.3 * K }
  const FACE = { x: MARK_AT.x + MARK.box.x * K, y: MARK_AT.y + MARK.box.y * K, w: MARK.box.w * K, h: MARK.box.h * K, r: 6 * K }
  const mark = add('div', { id: 'mark' }, stage, markSvg(MARK_SIZE))

  // ------------------------------------------------------------------ what the window shows
  /** The last frame painted at or before tau. */
  const frameAt = (frames, tau) => {
    let lo = 0
    let hi = frames.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (frames[mid].t <= tau) lo = mid
      else hi = mid - 1
    }
    return frames[lo].src
  }
  const typedBy = (times, t) => {
    let n = 0
    while (n < times.length && times[n] <= t) n++
    return n
  }
  if (F.chat.typing.length !== TL.typing.hook.length + 1) throw new Error('the typed text in the footage is not the one in the timeline: run capture.mjs and make-timeline.mjs again')

  const pm = F.project.marks
  // From the task to the request. The scene opens a moment after the task was sent. The wait while
  // the model loads is left out: after half a second the film goes to just before Maris's first words
  // and runs from there to the frame before the request shows (a little fast when that stretch is
  // longer than the scene has).
  const WORK = (() => {
    const a = at('read.cut')
    const b = at('halt.ask')
    const lead = 0.5
    const from = pm.firstWords - 0.1
    const speed = Math.max(1, (pm.landed - from) / (b - a - lead))
    return { a, b, lead, speed, shown: b - (pm.landed - (pm.opened + 0.12)) / speed } // shown: "Read forecast.py" is up
  })()
  function workTime(t) {
    if (t < WORK.a + WORK.lead) return pm.sent + 0.12 + (t - WORK.a)
    return Math.min(pm.landed - 0.02, pm.landed - (WORK.b - t) * WORK.speed)
  }
  /** What is in the window at t: the picture, and how many points of it are cut off at the top. */
  function shotAt(t) {
    const c = F.chat
    const p = F.project
    const is = (src, top = 0) => ({ src, top })
    if (t < at('chat.send')) return is(c.typing[typedBy(TL.typing.hook, t)])
    if (t < at('models.cut')) {
      const tau = c.marks.sent + (t - at('chat.send'))
      return is(tau > c.frames[c.frames.length - 1].t + 0.05 ? c.final.src : frameAt(c.frames, tau))
    }
    if (t < at('laptop.cut')) return is(F.models.api.src)
    // The setup assistant fills the whole window, so it loses 13 points at the top and 13 at the foot.
    if (t < at('read.cut')) return is(F.laptop.scan.src, 13)
    if (t < at('halt.ask')) return is(frameAt(p.work, workTime(t)))
    // The request, as it is once the page has been scrolled to show all of it (a cut: see FACTS.md).
    if (t < at('payoff.click')) return is(p.ask.src)
    if (t < at('payoff.diff')) {
      // On the frame of the click the film is at the frame in which the request is gone.
      const tau = pm.gone + (t - at('payoff.click'))
      return is(tau > p.after[p.after.length - 1].t + 0.05 ? p.finished.src : frameAt(p.after, tau))
    }
    if (t < at('payoff.undo')) return is(p.diff.src)
    return is(p.changes.src)
  }

  // ------------------------------------------------------------------ the camera
  // zoom is screen pixels per point of the window; (fx, fy) is the point of the window at the middle
  // of the card. Places are named in the timeline and found in the footage here.
  const ask = F.project.ask.boxes
  const PLACES = {
    whole: () => ({ fx: F.w / 2, fy: SEEN / 2 }),
    // The request from its left edge, with "Waiting for your OK" as the first line of the close-up
    // (so no line of the answer above it is cut in half) and the waiting bar under it.
    request: (zoom) => ({ fx: ask.panel.x - 10 + CARD.w / zoom / 2, fy: ask.waiting.y - 6 + CARD.h / zoom / 2 })
  }
  const KEYS = TL.camera.map((k) => ({ t: k.t, zoom: k.zoom, ...PLACES[k.focus](k.zoom) }))
  function cameraAt(t) {
    let i = 0
    while (i < KEYS.length - 1 && KEYS[i + 1].t <= t) i++
    const a = KEYS[i]
    const b = KEYS[Math.min(i + 1, KEYS.length - 1)]
    const p = b.t > a.t ? travel(prog(t, a.t, b.t - a.t)) : 0
    const zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), p))
    // Never show past the edges of what is seen of the window.
    const halfW = CARD.w / zoom / 2
    const halfH = CARD.h / zoom / 2
    return { zoom, fx: clamp(lerp(a.fx, b.fx, p), halfW, F.w - halfW), fy: clamp(lerp(a.fy, b.fy, p), halfH, SEEN - halfH) }
  }

  // ------------------------------------------------------------------ the ring ("look here") and the glass
  const grow = (b, x, y = x) => ({ x: b.x - x, y: b.y - y, w: b.w + 2 * x, h: b.h + 2 * y })
  const cards = F.models.api.boxes
  const memory = F.laptop.scan.boxes.memory
  // The chip that names the model, from its icon to just short of "Answered in".
  const said = F.chat.final.boxes
  const chip = { x: said.chip.x - 22, y: said.chip.y - 7, w: said.took.x - 6 - (said.chip.x - 22), h: said.chip.h + 14 }
  const read = { x: F.project.read.x - 26, y: F.project.read.y - 5, w: F.project.read.w + 36, h: F.project.read.h + 10 } // with its tick
  const undo = grow(F.project.changes.boxes.undo, 7, 6)
  const RINGS = [
    { off: at('pictures.cut'), stops: [{ t: at('chat.chip'), r: chip }] },
    { off: at('laptop.cut'), stops: ['Claude (Anthropic)', 'OpenAI (GPT)', 'Google Gemini'].map((name, i) => ({ t: at(`models.hop${i + 1}`), r: grow(cards[name], -2) })) },
    // The Memory card of the scan: its text sits 58 right of and 31 below the card's corner.
    { off: at('read.cut'), stops: [{ t: at('laptop.memory'), r: { x: memory.x - 58, y: memory.y - 31, w: 222, h: 104 } }] },
    { off: at('halt.ask'), stops: [{ t: WORK.shown, r: read }] },
    { off: at('end.morph'), stops: [{ t: at('payoff.look'), r: undo }] }
  ]
  function ringAt(t) {
    for (const seg of RINGS) {
      if (t < seg.stops[0].t || t >= seg.off) continue
      let i = 0
      while (i < seg.stops.length - 1 && seg.stops[i + 1].t <= t) i++
      const stop = seg.stops[i]
      if (i === 0) {
        const p = arrive(prog(t, stop.t, 0.26))
        return { ...stop.r, scale: lerp(1.16, 1, p), opacity: clamp(p * 2.5) }
      }
      const from = seg.stops[i - 1].r
      const p = arrive(prog(t, stop.t, 0.24))
      return { x: lerp(from.x, stop.r.x, p), y: lerp(from.y, stop.r.y, p), w: lerp(from.w, stop.r.w, p), h: lerp(from.h, stop.r.h, p), scale: 1, opacity: 1 }
    }
    return null
  }
  // A glass shows the same pixels of the window, larger, where a small word is the proof.
  // `power` is screen pixels per point inside it; it opens under its word, or beside it.
  const GLASSES = [
    { from: at('chat.chip') + 0.1, to: at('pictures.cut'), r: chip, power: 3.2, put: 'under' },
    { from: WORK.shown + 0.1, to: at('halt.ask'), r: read, power: 3.4, put: 'under' },
    { from: at('payoff.look') + 0.1, to: at('end.morph'), r: undo, power: 3.4, put: 'under' }
  ]

  // ------------------------------------------------------------------ the pointer
  const button = ask.approve
  const TIP = { x: button.x + button.w * 0.88, y: button.y + button.h * 0.74 } // where it presses: on the button, clear of its word
  const WAIT = { x: TIP.x + 232, y: TIP.y + 64 } // where it rests while the rule is read
  const DOOR = { x: TIP.x + 470, y: TIP.y + 250 } // off the edge of the close-up
  function cursorAt(t) {
    const click = at('payoff.click')
    if (t < at('halt.cursor')) return null
    if (t < at('halt.move')) {
      const p = arrive(prog(t, at('halt.cursor'), at('halt.held') - at('halt.cursor')))
      return { x: lerp(DOOR.x, WAIT.x, p), y: lerp(DOOR.y, WAIT.y, p), press: 0, opacity: 1 }
    }
    // To the button along a shallow arc, at rest before the press; after it the pointer simply goes.
    if (t >= click + 0.3) return null
    const p = travel(prog(t, at('halt.move'), at('halt.aim') - at('halt.move')))
    const press = t >= click ? Math.sin(Math.PI * prog(t, click, 0.17)) : 0
    return { x: lerp(WAIT.x, TIP.x, p), y: lerp(WAIT.y, TIP.y, p) + Math.sin(Math.PI * p) * 12, press, opacity: 1 - prog(t, click + 0.12, 0.18) }
  }

  // ------------------------------------------------------------------ one frame
  const shown = new Map() // text id -> how far in it is (0..1), for TEXTS
  const waits = []
  const show = (img, src) => {
    if (img.dataset.src === src) return
    img.dataset.src = src
    img.src = src
    waits.push(img.decode().catch(() => undefined))
  }
  /** A part of a block coming in from below at `start` and leaving upward at `end`. */
  function part(el, t, start, end, { rise = 34, time = 0.5 } = {}) {
    const p = arrive(prog(t, start, time))
    const q = leave(prog(t, end, 0.22))
    el.style.opacity = String(clamp(p * 1.7) * (1 - q))
    el.style.transform = `translateY(${px((1 - p) * rise - q * 22)})`
    return t < end ? p : 0
  }

  async function seek(time) {
    const t = clamp(time, 0, DUR - 1e-6)
    waits.length = 0
    shown.clear()

    // ---- the room: it dims while the film waits for the OK, and is itself again on the click
    const click = at('payoff.click')
    dim.style.opacity = String(t < click ? 0.42 * travel(prog(t, at('halt.stop') - 0.5, 1.6)) : 0)

    // ---- the window
    const morph = prog(t, at('end.morph'), at('end.land') - at('end.morph'))
    const m = travel(morph)
    // In the hook the window is already in frame at 0, still gliding in; it settles within a second
    // and keeps a slow drift, so the first seconds are alive without anything having to be waited for.
    const slide = t < at('chat.send') ? PEEK + 190 * (1 - arrive(prog(t, 0, 1.2))) + 44 * (1 - t / at('chat.send')) : lerp(PEEK, CARD.x, travel(prog(t, at('chat.send'), 0.62)))
    const rect = { x: lerp(slide, FACE.x, m), y: lerp(CARD.y, FACE.y, m), w: lerp(CARD.w, FACE.w, m), h: lerp(CARD.h, FACE.h, m), r: lerp(CARD.r, FACE.r, m) }
    const pictures = t >= at('pictures.cut') && t < at('models.cut')
    // A small push on the two moments the window itself answers: it comes back, and it is clicked.
    const punch = 0.012 * Math.exp(-14 * Math.max(0, t - at('models.cut'))) * (t >= at('models.cut') ? 1 : 0) + 0.016 * Math.exp(-13 * Math.max(0, t - click)) * (t >= click ? 1 : 0)
    Object.assign(card.style, {
      transform: `translate(${px(rect.x)}, ${px(rect.y)}) scale(${1 + punch})`,
      width: px(rect.w),
      height: px(rect.h),
      borderRadius: px(rect.r),
      // In the morph the cartridge is drawn over the card first, and only then does the card go.
      opacity: pictures ? '0' : String(1 - prog(morph, 0.86, 0.12))
    })
    const cam = cameraAt(t)
    const now = shotAt(t)
    const k = rect.w / CARD.w // the picture shrinks with the card while it becomes the logo
    show(shot, now.src)
    Object.assign(shot.style, {
      width: px(F.w * cam.zoom * k),
      height: px(F.h * cam.zoom * k),
      left: px((CARD.w / 2 - cam.fx * cam.zoom) * k),
      top: px((CARD.h / 2 - (cam.fy + now.top) * cam.zoom) * k),
      opacity: String(1 - prog(morph, 0.08, 0.42))
    })
    const sx = (x) => CARD.w / 2 + (x - cam.fx) * cam.zoom
    const sy = (y) => CARD.h / 2 + (y - now.top - cam.fy) * cam.zoom

    const r = morph > 0 ? null : ringAt(t)
    ring.style.opacity = r ? String(r.opacity) : '0'
    if (r) Object.assign(ring.style, { left: px(sx(r.x)), top: px(sy(r.y)), width: px(r.w * cam.zoom), height: px(r.h * cam.zoom), transform: `scale(${r.scale})` })

    const g = morph > 0 ? undefined : GLASSES.find((x) => t >= x.from && t < x.to)
    glass.style.opacity = g ? String(clamp((t - g.from) / 0.08)) : '0'
    if (g) {
      const s = spring(t - g.from, 3, 0.74)
      const w = g.r.w * g.power
      const h = g.r.h * g.power
      // Under its word, 16 px lower, kept inside the window.
      const left = clamp(sx(g.r.x) - 8, 18, CARD.w - w - 26)
      const top = sy(g.r.y + g.r.h) + 16
      Object.assign(glass.style, { left: px(left), top: px(top), width: px(w), height: px(h), transform: `scale(${lerp(0.55, 1, s)})`, transformOrigin: `${px(clamp(sx(g.r.x + g.r.w / 2) - left, 0, w))} 0` })
      show(glassShot, now.src)
      Object.assign(glassShot.style, { width: px(F.w * g.power), height: px(F.h * g.power), left: px(-g.r.x * g.power), top: px(-g.r.y * g.power) })
    }

    const c = cursorAt(t)
    cursor.style.opacity = c ? String(c.opacity) : '0'
    if (c) cursor.style.transform = `translate(${px(sx(c.x))}, ${px(sy(c.y))}) scale(${(cam.zoom / 2) * (1 - 0.14 * c.press)})`
    const wave = prog(t, click, 0.32)
    const spread = arrive(wave)
    ripple.style.opacity = String(t >= click && wave < 1 ? 0.95 * (1 - wave) : 0)
    Object.assign(ripple.style, { left: px(sx(TIP.x) - 14 - spread * 60), top: px(sy(TIP.y) - 14 - spread * 60), width: px(28 + spread * 120), height: px(28 + spread * 120), borderWidth: px(lerp(7, 2, spread)) })

    // ---- pictures
    for (const tile of tiles) {
      const tau = t - tile.t
      const on = pictures && tau >= 0
      tile.el.style.opacity = on ? String(clamp(tau / 0.09)) : '0'
      if (!on) continue
      const s = spring(tau, 3.1, 0.7)
      tile.el.style.transform = `translateY(${px((1 - s) * 34)}) scale(${lerp(0.8, 1, s)})`
      if (tile.clip) show(tile.img, F.clip.frames[clamp(Math.floor((t - at('pictures.clip')) * F.clip.fps), 0, F.clip.frames.length - 1)])
      else show(tile.img, tile.src)
    }

    // ---- type
    for (const h of HEADS) {
      const live = t >= h.start - 0.02 && t < (h.cut ?? h.end + 0.4)
      h.el.style.opacity = live ? '1' : '0'
      if (!live) continue
      let least = 1
      let small = 1
      h.parts.forEach((el, i) => {
        // "Approved." does not rise in: it is stamped, large to its size, in a few frames.
        if (h.snap) {
          const p = arrive(prog(t, h.start, 0.2))
          const q = leave(prog(t, h.end, 0.22))
          el.style.opacity = String(clamp(p * 3) * (1 - q))
          el.style.transform = `translateY(${px(-q * 22)}) scale(${lerp(1.12, 1, p)})`
          el.style.transformOrigin = '0 60%'
          least = Math.min(least, t < h.end ? p : 0)
        } else if (el.className === 'note') small = part(el, t, h.noteAt ?? h.start + i * 0.07 + 0.1, h.end + i * 0.025, { rise: 22 })
        else least = Math.min(least, part(el, t, h.start + i * 0.07, h.end + i * 0.025))
      })
      shown.set(h.id, least)
      if (h.note) shown.set(h.note, small)
    }
    const gone = at('hook.leave')
    hook.style.opacity = t < gone + 0.5 ? '1' : '0'
    hookParts.forEach((el, i) => {
      const q = leave(prog(t, gone + i * 0.04, 0.24))
      el.style.opacity = String(1 - q)
      el.style.transform = `translateY(${px(-q * 26)})`
    })
    for (const id of ['hook', 'name', 'cta']) shown.set(id, t < gone ? 1 : 0)
    const coming = at('end.links')
    end.style.opacity = t >= coming - 0.02 ? '1' : '0'
    endParts.forEach((el, i) => {
      const p = part(el, t, coming + i * 0.12, DUR + 1, { rise: 28 })
      const ids = [['endname'], ['endline'], ['what-repo', 'link-repo'], ['what-git', 'link-git'], ['what-itch', 'link-itch']][i]
      for (const id of ids) shown.set(id, p)
    })

    // ---- the cartridge: it takes over from the window once the window is nearly its size, then
    // seats with one soft bounce
    const seat = Math.max(0, t - at('end.land'))
    const wobble = Math.exp(-9 * seat) * Math.sin(2 * Math.PI * 2.5 * seat)
    const scale = rect.w / FACE.w
    mark.style.opacity = String(prog(morph, 0.6, 0.28))
    mark.style.transform = `translate(${px(rect.x - MARK.box.x * K * scale)}, ${px(rect.y - MARK.box.y * K * scale + 18 * wobble)}) scale(${scale}, ${scale * (1 - 0.028 * wobble)})`

    if (waits.length) await Promise.all(waits)
  }

  // ------------------------------------------------------------------ the page's contract
  const TEXT_ELS = () => {
    const out = {}
    for (const h of HEADS) {
      out[h.id] = h.parts.filter((p) => p.className === 'line')
      if (h.note) out[h.note] = h.parts.filter((p) => p.className === 'note')
    }
    out.hook = [hookParts[1]]
    out.name = [hookParts[0].querySelector('span')]
    out.cta = [hookParts[2].querySelector('.url')]
    out.endname = [endParts[0]]
    out.endline = [endParts[1]]
    for (const [i, id] of ['repo', 'git', 'itch'].entries()) {
      out[`what-${id}`] = [endParts[2 + i].querySelector('.what')]
      out[`link-${id}`] = [endParts[2 + i].querySelector('.url')]
    }
    return out
  }
  /** Text that is fully in at the time last sought, with where it is on the frame. */
  function TEXTS() {
    const els = TEXT_ELS()
    const scale = stage.getBoundingClientRect().width / TL.meta.w
    return [...shown]
      .filter(([, p]) => p >= 0.985)
      .map(([id]) => {
        const range = document.createRange()
        let box
        for (const el of els[id] ?? []) {
          range.selectNodeContents(el)
          const r = range.getBoundingClientRect()
          box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom }
        }
        return { id, text: words[id].text, x: Math.round(box.l / scale), y: Math.round(box.t / scale), w: Math.round((box.r - box.l) / scale), h: Math.round((box.b - box.t) / scale) }
      })
  }

  const preload = (src) => {
    const img = new Image()
    img.src = src
    return img.decode().catch(() => {
      throw new Error(`could not load ${src}`)
    })
  }
  window.DUR = DUR
  window.FPS = TL.meta.fps
  window.CUES = TL
  window.TEXTS = TEXTS
  window.seek = seek
  window.READY = (async () => {
    await document.fonts.ready
    const p = F.project
    await Promise.all([F.chat.final.src, p.ask.src, p.finished.src, p.changes.src, p.diff.src, F.models.api.src, F.laptop.scan.src, ...F.pictures].map(preload))
    await seek(0)
  })()

  // ------------------------------------------------------------------ watching it in a browser
  // (render.mjs opens the page with #still and drives seek itself.)
  if (location.hash !== '#still') {
    const fit = () => (stage.style.transform = `scale(${Math.min(innerWidth / TL.meta.w, innerHeight / TL.meta.h)})`)
    addEventListener('resize', fit)
    fit()
    let playing = true
    let now = Number(new URLSearchParams(location.search).get('t') ?? 0)
    let last
    const tick = async (stamp) => {
      if (playing && last !== undefined) now = (now + (stamp - last) / 1000) % DUR
      last = stamp
      await seek(now)
      requestAnimationFrame(tick)
    }
    addEventListener('keydown', (e) => {
      if (e.key === ' ') playing = !playing
      if (e.key === 'ArrowRight') now = Math.min(DUR - 0.001, now + (e.shiftKey ? 1 : 1 / TL.meta.fps))
      if (e.key === 'ArrowLeft') now = Math.max(0, now - (e.shiftKey ? 1 : 1 / TL.meta.fps))
    })
    window.READY.then(() => requestAnimationFrame(tick))
  }
})()
