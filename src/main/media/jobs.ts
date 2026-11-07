import { app } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MediaJob, MediaPack, MediaParams, MediaResult } from '@shared/types'
import { budgetOf, mediaPlacement } from '@shared/recommend'
import { repo } from '../db'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { monitor } from '../system/monitor'
import { lastScan } from '../system/scan'
import { Emitter, errMsg, log, sleep, uid } from '../util'
import { buildWorkflow, choosePack, fitSize, nativeSize, PACKS, packById, packSizeGB } from './catalog'
import { comfy } from './comfy'
import { downloadAll } from './downloader'

class MediaJobs {
  readonly changed = new Emitter<MediaJob>()
  private jobs: MediaJob[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private running = 0
  private pending = 0
  private cancelled = new Set<string>()
  private idleTimer?: NodeJS.Timeout
  private installing = new Set<string>()
  /** Jobs the person moved to another model, by job id. */
  private switches = new Map<string, string>()
  /** Real timings of earlier jobs on this computer, by pack: amount of work, seconds in all, seconds to load. */
  private stats?: Record<string, { work: number; total: number; load: number }[]>

  get activeCount(): number {
    return this.running
  }
  get queuedCount(): number {
    return this.pending
  }

  list(): MediaJob[] {
    return this.jobs.slice(0, 50)
  }

  outputsDir(): string {
    return settings.get().media.outputDir || path.join(settings.get().dataDir, 'outputs')
  }

  installedIds(): Set<string> {
    const dir = comfy.modelsDir()
    const ok = new Set<string>()
    if (!comfy.isInstalled()) return ok
    for (const p of PACKS) {
      if (p.files.every((f) => existsSync(path.join(dir, f.dir, f.name)) && (!f.sizeBytes || statSync(path.join(dir, f.dir, f.name)).size === f.sizeBytes)))
        ok.add(p.id)
    }
    return ok
  }

  packs(): (MediaPack & { installing: boolean; missingGB: number; estimateSec: number; estimateMeasured: boolean })[] {
    const installed = this.installedIds()
    const dir = comfy.modelsDir()
    const cfg = settings.get().media
    return PACKS.map(({ order: _o, supportsImageInput: _s, ...p }) => {
      const files = p.files.map((f) => ({ ...f, present: existsSync(path.join(dir, f.dir, f.name)) }))
      // One result as the app would make it by default (models already loaded).
      const est = this.expectSeconds(p.id, p.kind === 'image' ? { kind: 'image', prompt: '', width: cfg.imageWidth, height: cfg.imageHeight } : { kind: 'video', prompt: '', seconds: cfg.videoSeconds })
      return {
        ...p,
        estimateSec: Math.max(1, Math.round(est.total - est.load)),
        estimateMeasured: est.measured,
        files,
        sizeGB: packSizeGB(p),
        missingGB: packSizeGB({ files: files.filter((f) => !f.present) }),
        installed: installed.has(p.id),
        installing: this.installing.has(p.id)
      }
    })
  }

  async installPack(id: string): Promise<void> {
    const pack = packById(id)
    if (!pack) throw new Error(`Unknown pack ${id}`)
    if (this.installing.has(id)) return
    this.installing.add(id)
    try {
      if (!comfy.isInstalled()) await comfy.install(lastScan()?.gpu?.comfy)
      const dir = comfy.modelsDir()
      await downloadAll(
        id,
        pack.name,
        pack.files.map((f) => ({ url: f.url, dest: path.join(dir, f.dir, f.name), sizeBytes: f.sizeBytes }))
      )
      // A running ComfyUI keeps its old model lists; restart it while nothing is rendering.
      if (comfy.isUp() && this.running === 0 && this.pending === 0) await comfy.restart().catch(() => undefined)
    } finally {
      this.installing.delete(id)
    }
  }

  async removePack(id: string): Promise<void> {
    const pack = packById(id)
    if (!pack) return
    // Keep files that other installed packs still use.
    const keep = new Set(
      PACKS.filter((p) => p.id !== id && this.installedIds().has(p.id)).flatMap((p) => p.files.map((f) => `${f.dir}/${f.name}`))
    )
    for (const f of pack.files) {
      if (keep.has(`${f.dir}/${f.name}`)) continue
      await fs.rm(path.join(comfy.modelsDir(), f.dir, f.name), { force: true })
    }
  }

  private statsFile(): string {
    return path.join(app.getPath('userData'), 'media-stats.json')
  }

  private runs(): Record<string, { work: number; total: number; load: number }[]> {
    if (!this.stats) {
      try {
        this.stats = JSON.parse(readFileSync(this.statsFile(), 'utf8'))
      } catch {
        this.stats = {}
      }
    }
    return this.stats!
  }

  private remember(packId: string, run: { work: number; total: number; load: number }): void {
    const all = this.runs()
    all[packId] = [...(all[packId] ?? []), run].slice(-12)
    try {
      writeFileSync(this.statsFile(), JSON.stringify(all))
    } catch (e) {
      log.warn('media', 'could not save timings', e)
    }
  }

  /** How much work a job is: megapixels times pictures, or seconds of video at the reference size. */
  private work(kind: 'image' | 'video', params: MediaParams): number {
    if (kind === 'image') return Math.max(0.1, ((params.width ?? 1024) * (params.height ?? 1024)) / 1048576) * Math.max(1, params.count ?? 1)
    const secs = params.seconds ?? (params.frames ? params.frames / 24 : 3)
    return Math.max(0.2, secs * (((params.width ?? 1280) * (params.height ?? 704)) / (1280 * 704)))
  }

  /**
   * Seconds a job should take here (without starting the engine): from earlier runs of the same model
   * on this computer when there are some, otherwise from the PC scan, like the setup assistant.
   */
  expectSeconds(packId: string, params: MediaParams): { total: number; load: number; measured: boolean } {
    const pack = packById(packId)
    if (!pack) return { total: 0, load: 0, measured: false }
    const work = this.work(pack.kind, params)
    const runs = this.runs()[packId] ?? []
    const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    if (runs.length) {
      const load = median(runs.map((r) => r.load))
      return { total: median(runs.map((r) => Math.max(0, r.total - r.load) / r.work)) * work + load, load, measured: true }
    }
    const scan = lastScan()
    const placed = scan ? mediaPlacement({ ...pack, sizeGB: packSizeGB(pack), installed: true }, budgetOf(scan), settings.get().engine.processing).speedValue : 0
    const unitSec = placed > 0 ? placed : pack.refSeconds
    const unitWork = pack.kind === 'image' ? 1 : Number(/(\d+)\s*s/.exec(pack.unit)?.[1] ?? 3)
    // Reading the weights from disk into memory.
    const load = 6 + packSizeGB(pack) * 1.1
    return { total: unitSec * (work / unitWork) + load, load, measured: false }
  }

  /** Move a running or waiting job to another installed model: it stops and starts again with that one. */
  switchPack(id: string, packId: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !packById(packId) || !this.installedIds().has(packId)) return
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return
    this.switches.set(id, packId)
    this.cancel(id)
  }

  switchedTo(id: string): string | undefined {
    return this.switches.get(id)
  }

  /** Other installed models that make the same kind of result (for "switch to"). */
  alternatives(job: MediaJob): { packId: string; name: string; tier: 'fast' | 'quality'; faster: boolean }[] {
    const installed = this.installedIds()
    const mine = packById(job.packId)
    if (!mine) return []
    const needsImage = Boolean(job.params.inputImage)
    return PACKS.filter((p) => p.id !== mine.id && p.kind === mine.kind && installed.has(p.id) && (!needsImage || p.supportsImageInput))
      .map((p) => ({ packId: p.id, name: p.name, tier: p.tier, faster: p.refSeconds < mine.refSeconds }))
      .sort((a, b) => Number(b.faster) - Number(a.faster))
  }

  /** The job running now and the time left for it and everything queued after it. */
  busyInfo(): { model?: string; kind: 'image' | 'video'; etaSec?: number; conversationId?: string } | undefined {
    const j = this.jobs.find((x) => x.status === 'running' || x.status === 'preparing')
    if (!j) return undefined
    const queued = this.jobs.filter((x) => x.status === 'queued').reduce((s, x) => s + (x.expectedSec ?? 0), 0)
    const now = j.etaSec ?? j.expectedSec
    return { model: j.model, kind: j.params.kind, etaSec: now === undefined ? undefined : Math.round(now + queued), conversationId: j.params.conversationId }
  }

  /** Stop every picture or video a chat asked for (the chat is being deleted). */
  cancelFor(conversationId: string): number {
    const mine = this.jobs.filter((j) => j.params.conversationId === conversationId && (j.status === 'queued' || j.status === 'preparing' || j.status === 'running'))
    for (const j of mine) this.cancel(j.id)
    return mine.length
  }

  private update(job: MediaJob, patch: Partial<MediaJob>): void {
    Object.assign(job, patch)
    this.changed.emit({ ...job })
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    this.cancelled.add(id)
    if (job.status === 'running' || job.status === 'preparing') void comfy.interrupt()
    if (job.status === 'queued') this.update(job, { status: 'cancelled', finishedAt: Date.now() })
  }

  /** Queue a generation and resolve when it is finished. */
  generate(params: MediaParams, onUpdate?: (job: MediaJob) => void): Promise<MediaJob> {
    const installed = this.installedIds()
    const cfg = settings.get().media
    const { packId, reason } = choosePack(params, installed, monitor.snapshot().busy, cfg.roles)
    // Fill in the person's default sizes; small models keep their own native size.
    if (params.kind === 'image' && params.width === undefined && params.height === undefined && nativeSize(packId) === 1024) {
      params = { ...params, width: cfg.imageWidth, height: cfg.imageHeight }
    }
    if (params.kind === 'video' && params.seconds === undefined && params.frames === undefined) params = { ...params, seconds: cfg.videoSeconds }
    if (params.width && params.height) {
      const [width, height] = fitSize(packId, params.width, params.height)
      if (width !== params.width || height !== params.height) params = { ...params, width, height }
    }
    const job: MediaJob = {
      id: uid(),
      params,
      packId,
      status: 'queued',
      progress: 0,
      results: [],
      createdAt: Date.now(),
      reason,
      model: packById(packId)?.name,
      expectedSec: Math.round(this.expectSeconds(packId, params).total + (comfy.isUp() ? 0 : 75))
    }
    this.jobs.unshift(job)
    if (this.jobs.length > 100) this.jobs.length = 100
    this.changed.emit({ ...job })
    const off = onUpdate ? this.changed.on((j) => j.id === job.id && onUpdate(j)) : undefined
    this.pending++
    const run = this.chain.then(() => this.run(job))
    this.chain = run.catch(() => undefined)
    return run.finally(() => off?.()).then(() => job)
  }

  private async run(job: MediaJob): Promise<void> {
    this.pending--
    if (this.cancelled.has(job.id)) return
    clearTimeout(this.idleTimer)
    this.running++
    const pack = packById(job.packId)!
    let stopWs: (() => void) | undefined
    try {
      const startedAt = Date.now()
      this.update(job, { status: 'preparing', startedAt, step: comfy.isUp() ? 'Preparing' : 'Starting the image engine…', etaSec: job.expectedSec })
      const ticker = setInterval(() => {
        const line = comfy.lastLog().replace(/\s+/g, ' ').slice(0, 90)
        if (!comfy.isUp())
          this.update(job, { step: `Starting the image engine…${line ? ` ${line}` : ''}`, etaSec: Math.max(1, Math.round((job.expectedSec ?? 0) - (Date.now() - startedAt) / 1000)) })
      }, 2000)
      try {
        await comfy.start()
      } finally {
        clearInterval(ticker)
      }
      if (settings.get().media.autoUnloadLlm) {
        this.update(job, { step: 'Freeing GPU memory' })
        const unloaded = await ollama.unloadAll()
        if (unloaded.length) await sleep(800)
      }
      // From here on the engine is up: timings below are the model's own.
      const engineAt = Date.now()
      const expected = this.expectSeconds(job.packId, job.params)
      let firstStepAt = 0
      let eta = { sec: Math.round(expected.total), at: Date.now() }
      const tail = pack.kind === 'video' ? 12 : 2
      let uploaded: string | undefined
      if (job.params.inputImage) {
        this.update(job, { step: 'Uploading image' })
        uploaded = await comfy.upload(job.params.inputImage)
      }
      const built = buildWorkflow(job.packId, job.params, uploaded)
      const samplers = Object.entries(built.workflow)
        .filter(([, n]) => n.class_type.startsWith('KSampler'))
        .map(([id]) => id)
      let promptId = ''
      let finished = false
      let failure: string | undefined
      const doneSamplers = new Set<string>()
      const onWsMessage = (type: string, data: Record<string, unknown>): void => {
        if (data.prompt_id && promptId && data.prompt_id !== promptId) return
        if (type === 'progress') {
          const node = String(data.node ?? '')
          const frac = Number(data.value) / Math.max(1, Number(data.max))
          const idx = Math.max(0, samplers.indexOf(node))
          const p = samplers.length ? (doneSamplers.size + frac) / samplers.length : frac
          if (frac >= 1 && node) doneSamplers.add(node)
          const now = Date.now()
          if (!firstStepAt) firstStepAt = now
          // Time per step so far, for the steps still to come, plus decoding and saving.
          if (p > 0.04) eta = { sec: Math.max(1, Math.round(((now - firstStepAt) / 1000) * ((1 - p) / p) + tail)), at: now }
          this.update(job, {
            progress: Math.min(0.97, p * 0.95),
            step: `${pack.kind === 'video' ? 'Rendering' : 'Drawing'} · step ${data.value} of ${data.max}${samplers.length > 1 ? ` (pass ${idx + 1} of ${samplers.length})` : ''}`,
            etaSec: eta.sec
          })
        } else if (type === 'executing' && data.node === null) {
          finished = true
        } else if (type === 'execution_success') {
          finished = true
        } else if (type === 'execution_error') {
          failure = String(data.exception_message ?? 'ComfyUI error')
          finished = true
        } else if (type === 'execution_interrupted') {
          failure = 'Cancelled'
          finished = true
        }
      }
      stopWs = comfy.connect(onWsMessage)
      await sleep(150)
      try {
        promptId = await comfy.queue(built.workflow)
      } catch (e) {
        // A model installed while ComfyUI was running is not in its cached lists yet.
        if (!/Value not in list/i.test(errMsg(e))) throw e
        this.update(job, { step: 'Reloading ComfyUI so it sees the new model…' })
        stopWs?.()
        await comfy.restart()
        stopWs = comfy.connect(onWsMessage)
        await sleep(150)
        promptId = await comfy.queue(built.workflow)
      }
      this.update(job, { status: 'running', step: `Loading ${pack.name}` })
      const limit = Date.now() + (pack.kind === 'video' ? 90 : 15) * 60000
      let tick = 0
      while (!finished && Date.now() < limit) {
        await sleep(1000)
        // Count down between engine updates so the estimate keeps moving.
        const left = Math.max(1, Math.round(eta.sec - (Date.now() - eta.at) / 1000))
        if (left !== job.etaSec) this.update(job, { etaSec: left })
        if (this.cancelled.has(job.id)) {
          await comfy.interrupt()
          failure = 'Cancelled'
          break
        }
        // Fallback in case a websocket message was missed.
        if (++tick % 5 === 0) {
          const h = await comfy.history(promptId).catch(() => undefined)
          if (h?.status === 'success' || h?.status === 'error') {
            if (h.status === 'error') failure = h.error ?? 'Generation failed'
            finished = true
          }
        }
      }
      if (!finished && !failure) failure = 'Timed out'
      if (failure) throw new Error(failure)
      const h = await comfy.history(promptId)
      if (h.error) throw new Error(h.error)
      const results: MediaResult[] = []
      const day = new Date().toISOString().slice(0, 10)
      const outDir = path.join(this.outputsDir(), day)
      await fs.mkdir(outDir, { recursive: true })
      for (const f of h.files.filter((x) => x.type === 'output')) {
        const src = comfy.outputPath(f)
        const ext = path.extname(f.filename) || (pack.kind === 'video' ? '.mp4' : '.png')
        const dest = path.join(outDir, `maris-${pack.kind}-${Date.now()}-${results.length}${ext}`)
        await fs.copyFile(src, dest)
        const r: MediaResult = {
          id: uid(),
          kind: pack.kind,
          path: dest,
          prompt: job.params.prompt,
          model: pack.name,
          width: built.width,
          height: built.height,
          seed: built.seed,
          frames: built.frames,
          fps: built.fps,
          createdAt: Date.now()
        }
        repo.addMedia(r)
        results.push(r)
      }
      if (!results.length) throw new Error('ComfyUI finished but produced no files')
      const total = (Date.now() - engineAt) / 1000
      this.remember(job.packId, { work: this.work(pack.kind, job.params), total, load: firstStepAt ? (firstStepAt - engineAt) / 1000 : Math.min(total, expected.load) })
      this.update(job, { status: 'done', progress: 1, step: 'Done', results, finishedAt: Date.now(), etaSec: 0 })
    } catch (e) {
      const msg = errMsg(e)
      log.warn('media', msg)
      this.update(job, {
        status: msg === 'Cancelled' ? 'cancelled' : 'error',
        error: msg === 'Cancelled' ? undefined : msg,
        step: undefined,
        finishedAt: Date.now()
      })
    } finally {
      stopWs?.()
      this.running--
      this.cancelled.delete(job.id)
      // Give VRAM back to the language models unless more media work is queued.
      if (this.pending === 0) {
        await comfy.free()
        const idleMin = settings.get().media.stopAfterIdleMin
        if (idleMin > 0) {
          this.idleTimer = setTimeout(() => {
            if (this.running === 0 && this.pending === 0 && comfy.ownsProcess()) comfy.stop()
          }, idleMin * 60000)
        }
      }
    }
  }
}

export const media = new MediaJobs()

monitor.setComfyProbe(async () => ({
  up: comfy.isUp(),
  installed: comfy.isInstalled(),
  busy: media.activeCount > 0,
  queue: media.queuedCount,
  starting: comfy.state().starting,
  vramMB: await comfy.vramMB(),
  activeJobs: media.activeCount,
  job: media.busyInfo()
}))
