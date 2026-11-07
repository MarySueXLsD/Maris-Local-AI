import type {
  CatalogModel,
  DiskInfo,
  LlmRole,
  MediaPack,
  MediaRole,
  PcScan,
  Placement,
  PlanItem,
  PlanOption,
  Processing,
  SetupPlan,
  SetupPrefs,
  SetupRole
} from './types'

// Pure recommendation logic shared by the main process (applying a plan) and the setup screen
// (recomputing live while the person changes options). Estimates are deliberately simple:
// language models are limited by memory bandwidth, image/video models by GPU compute.

const MIB_PER_GB = 1e9 / 2 ** 20
/** Share of theoretical bandwidth Ollama reaches (calibrated: RTX 5070 Ti, 14.1 GB model, 38 tokens/s). */
const GPU_EFF = 0.6
const CPU_EFF = 0.55
const OVERHEAD_MB = 350

export const LLM_ROLES: LlmRole[] = ['fast', 'balanced', 'max', 'code', 'tiny', 'embed']
export const MEDIA_ROLES: MediaRole[] = ['imageFast', 'imageQuality', 'videoFast', 'videoQuality']

export const ROLE_TEXT: Record<SetupRole, { title: string; hint: string }> = {
  fast: { title: 'Fast', hint: 'Small talk and quick answers' },
  balanced: { title: 'Balanced', hint: 'Everyday questions and writing' },
  max: { title: 'Max', hint: 'Reasoning, research and hard problems' },
  code: { title: 'Code', hint: 'Code mode and work on your PC' },
  tiny: { title: 'Helper', hint: 'Routing, titles and memory upkeep' },
  embed: { title: 'Memory search', hint: 'Finds relevant memories' },
  imageFast: { title: 'Images, fast', hint: 'Quick pictures and drafts' },
  imageQuality: { title: 'Images, quality', hint: 'Detailed final pictures' },
  videoFast: { title: 'Video, fast', hint: 'Short clips' },
  videoQuality: { title: 'Video, quality', hint: 'Cinematic clips' }
}

export interface Budget {
  llmGpu: boolean
  mediaGpu: boolean
  /** Apple chips: GPU and CPU share one memory pool, so a model split between them still needs it all. */
  unified: boolean
  /** VRAM one model may use (MiB). */
  vramMB: number
  /** RAM a model may use (MiB). */
  ramMB: number
  vramGB: number
  gpuBW: number
  cpuBW: number
  perf: number
  /** CPU compute relative to the reference GPU. */
  cpuPerf: number
}

export function budgetOf(scan: PcScan): Budget {
  const g = scan.gpu
  const usable = Boolean(g && (g.unified ? g.vramMB >= 3000 : !g.integrated && g.vramMB >= 3500))
  return {
    llmGpu: usable && g!.llm !== 'none',
    mediaGpu: usable && g!.comfy !== 'none',
    unified: Boolean(g?.unified),
    vramMB: usable ? Math.max(0, g!.vramMB * 0.94 - 400) : 0,
    ramMB: Math.max(2048, scan.ram.totalMB * 0.78 - 2560),
    vramGB: usable ? g!.vramMB / 1024 : 0,
    gpuBW: g?.bandwidthGBs ?? 0,
    cpuBW: Math.max(20, scan.ram.bandwidthGBs || 50),
    perf: usable ? Math.max(0.03, g!.perf) : 0,
    cpuPerf: Math.max(0.004, scan.cpu.cores * 0.004)
  }
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '?'
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`
}

const tokLabel = (t: number): string => `≈${t >= 10 ? Math.round(t) : t.toFixed(1)} tokens/s`

/** Where a language model would run and how fast, for a given context window. */
export function llmPlacement(m: CatalogModel, b: Budget, processing: Processing, ctx: number, forceCpu = false): Placement {
  const sizeMB = m.sizeGB * MIB_PER_GB
  const needMB = Math.round(sizeMB + (m.kvPer16kMB ?? sizeMB * 0.06) * (ctx / 16384) + OVERHEAD_MB)
  const perTokGB = m.activeB && m.paramsB ? m.sizeGB * Math.min(1, (m.activeB / m.paramsB) * 1.15) : m.sizeGB
  const cpuSpeed = (CPU_EFF * b.cpuBW) / perTokGB
  if (forceCpu || processing === 'cpu' || !b.llmGpu) {
    const fits = needMB <= b.ramMB
    return { where: fits ? 'cpu' : 'none', gpuShare: 0, needMB, speedValue: cpuSpeed, speed: tokLabel(cpuSpeed), fits, note: fits ? undefined : 'Needs more memory than this PC can spare' }
  }
  const gpuSpeed = (GPU_EFF * b.gpuBW) / perTokGB
  if (needMB <= b.vramMB) {
    return { where: 'gpu', gpuShare: 1, needMB, speedValue: gpuSpeed, speed: tokLabel(gpuSpeed), fits: true }
  }
  const share = Math.max(0, Math.min(1, b.vramMB / needMB))
  const t = (perTokGB * share) / (GPU_EFF * b.gpuBW) + (perTokGB * (1 - share)) / (CPU_EFF * b.cpuBW)
  const speed = 1 / t
  const roomy = b.unified ? needMB <= b.ramMB : needMB - b.vramMB <= b.ramMB
  if (!roomy) return { where: 'none', gpuShare: share, needMB, speedValue: speed, speed: tokLabel(speed), fits: false, note: 'Too large for this GPU and RAM together' }
  return {
    where: 'hybrid',
    gpuShare: share,
    needMB,
    speedValue: speed,
    speed: tokLabel(speed),
    fits: processing === 'hybrid',
    note: processing === 'gpu' ? `Needs ${(needMB / 1024).toFixed(1)} GB; ${Math.round(share * 100)}% would fit on the GPU` : `${Math.round(share * 100)}% on the GPU, the rest from RAM`
  }
}

/** Where an image/video pack would run and how long one result takes. */
export function mediaPlacement(p: MediaPack, b: Budget, processing: Processing): Placement {
  const needMB = Math.round(p.vramGB * 1024)
  if (processing === 'cpu' || !b.mediaGpu) {
    const sec = p.refSeconds / b.cpuPerf
    return {
      where: p.cpuOk ? 'cpu' : 'none',
      gpuShare: 0,
      needMB,
      speedValue: sec,
      speed: p.cpuOk ? `≈${fmtDuration(sec)} per ${p.unit}` : 'Needs a graphics card',
      fits: p.cpuOk,
      note: p.cpuOk ? 'Runs on the CPU' : 'Not practical without a supported GPU'
    }
  }
  const gpuSec = p.refSeconds / b.perf
  if (b.vramGB >= p.vramGB) {
    return { where: 'gpu', gpuShare: 1, needMB, speedValue: gpuSec, speed: `≈${fmtDuration(gpuSec)} per ${p.unit}`, fits: true }
  }
  if (b.vramGB >= p.vramMinGB) {
    const sec = gpuSec * 2.2
    return {
      where: 'hybrid',
      gpuShare: b.vramGB / p.vramGB,
      needMB,
      speedValue: sec,
      speed: `≈${fmtDuration(sec)} per ${p.unit}`,
      fits: processing === 'hybrid',
      note: processing === 'gpu' ? `Needs ${p.vramGB} GB of VRAM to stay on the GPU` : 'Parts of the model are swapped in from RAM'
    }
  }
  return { where: 'none', gpuShare: 0, needMB, speedValue: 0, speed: 'Too large', fits: false, note: `Needs at least ${p.vramMinGB} GB of VRAM` }
}

const CTX_TRY: Record<LlmRole, number[]> = {
  fast: [16384, 8192],
  balanced: [16384, 8192],
  max: [16384, 8192],
  code: [32768, 24576, 16384],
  tiny: [8192],
  embed: [2048]
}
const MIN_SPEED: Record<'gpu' | 'cpu', Record<LlmRole, number>> = {
  gpu: { fast: 30, balanced: 15, max: 6, code: 8, tiny: 0, embed: 0 },
  // On a CPU a mixture-of-experts model (few active parameters) beats a dense one that crawls.
  cpu: { fast: 10, balanced: 6, max: 5, code: 5, tiny: 0, embed: 0 }
}

interface Scored {
  m: CatalogModel
  place: Placement
  ctx: number
  utility: number
}

export interface PlanInput {
  scan: PcScan
  llms: CatalogModel[]
  packs: (MediaPack & { files: (MediaPack['files'][number] & { present?: boolean })[] })[]
  installed: string[]
  prefs: SetupPrefs
  /** The person's own picks: a model/pack id, or null to leave the role out. */
  overrides?: Partial<Record<SetupRole, string | null>>
}

export function defaultPrefs(scan: PcScan, dataDir: string): SetupPrefs {
  const b = budgetOf(scan)
  return {
    processing: b.llmGpu ? 'gpu' : 'cpu',
    images: true,
    video: b.mediaGpu && b.vramGB >= 5.5,
    dataDir
  }
}

/** The disk a folder is on: its drive letter on Windows, the longest mount point that holds it elsewhere. */
export function diskFor(disks: DiskInfo[], p: string): DiskInfo | undefined {
  if (!p) return undefined
  if (/^[a-z]:/i.test(p)) {
    const letter = p.slice(0, 2).toUpperCase()
    return disks.find((d) => d.root.toUpperCase().startsWith(letter))
  }
  return disks
    .filter((d) => d.root === '/' || p === d.root || p.startsWith(d.root.endsWith('/') ? d.root : `${d.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0]
}

/** "C:" on Windows; the volume name or mount point elsewhere. */
/** "C:", "Macintosh HD", and on Linux words instead of mount points: "/" reads as a fraction, not a drive. */
export function diskName(d: DiskInfo): string {
  if (/^[a-z]:/i.test(d.root)) return d.root.slice(0, 2).toUpperCase()
  if (d.label) return d.label
  if (d.root === '/') return 'System'
  if (d.root === '/home') return 'Home'
  return d.root.split('/').filter(Boolean).pop() ?? d.root
}

export function makePlan(input: PlanInput): SetupPlan {
  const { scan, llms, packs, prefs } = input
  const overrides = input.overrides ?? {}
  const b = budgetOf(scan)
  const processing: Processing = prefs.processing === 'cpu' || !b.llmGpu ? 'cpu' : prefs.processing
  const mediaProcessing: Processing = prefs.processing === 'cpu' || !b.mediaGpu ? 'cpu' : prefs.processing
  const installed = new Set(input.installed)
  const speedKey = processing === 'cpu' ? 'cpu' : 'gpu'
  const warnings: string[] = []
  const items: PlanItem[] = []

  // ------------------------------------------------------------- language models
  const score = (m: CatalogModel, role: LlmRole): Scored => {
    const forceCpu = role === 'tiny' || role === 'embed'
    let place = llmPlacement(m, b, processing, CTX_TRY[role][0], forceCpu)
    let ctx = CTX_TRY[role][0]
    if (!forceCpu && place.where !== 'gpu') {
      // Prefer a smaller window that keeps the whole model on the GPU.
      for (const c of CTX_TRY[role].slice(1)) {
        const p = llmPlacement(m, b, processing, c)
        if (p.where === 'gpu') {
          place = p
          ctx = c
          break
        }
      }
    }
    const base = role === 'code' ? (m.coding ?? m.quality ?? 0) : (m.quality ?? 0)
    // "GPU + CPU" is chosen for bigger, smarter models: for Max and Code, quality comes first there.
    const qualityFirst = processing === 'hybrid' && (role === 'max' || role === 'code')
    const speedWeight = qualityFirst ? 1 : 6
    const utility = base + speedWeight * Math.log10(Math.max(0.5, place.speedValue)) + (installed.has(m.name) ? (qualityFirst ? 1 : 3) : 0)
    if (role === 'embed') place = { ...place, speed: place.fits ? 'Light, on the CPU' : place.speed }
    return { m, place, ctx, utility }
  }
  const optionOf = (s: Scored): PlanOption => ({
    id: s.m.name,
    label: s.m.label,
    sizeGB: s.m.sizeGB,
    placement: s.place,
    installed: installed.has(s.m.name),
    quality: s.m.quality ?? 0,
    description: s.m.description
  })
  const candidates = (role: LlmRole): Scored[] =>
    llms
      .filter((m) => (role === 'embed' ? m.caps?.includes('embedding') : !m.caps?.includes('embedding')) && (m.roles?.includes(role) ?? m.tier === role))
      .filter((m) => !(m.minVramGB && b.vramGB < m.minVramGB) && !(m.maxVramGB && b.vramGB > m.maxVramGB))
      .map((m) => score(m, role))
  const usable = (s: Scored, role: LlmRole): boolean => s.place.fits && s.place.speedValue >= MIN_SPEED[speedKey][role]
  const best = (list: Scored[]): Scored | undefined => [...list].sort((x, y) => y.utility - x.utility)[0]

  const picked: Partial<Record<LlmRole, Scored>> = {}
  const choose = (role: LlmRole, pool: Scored[], auto: () => Scored | undefined): Scored | undefined => {
    const o = overrides[role]
    if (o === null) return undefined
    if (o) {
      const m = llms.find((x) => x.name === o)
      if (m) return score(m, role)
    }
    return auto() ?? best(pool.filter((s) => s.place.fits))
  }

  const maxPool = candidates('max')
  picked.max = choose('max', maxPool, () => best(maxPool.filter((s) => usable(s, 'max'))))
  const maxSize = picked.max?.m.sizeGB ?? Infinity
  // On the CPU, Balanced should load quickly and leave room in RAM for the helper models.
  const balCap = processing === 'cpu' ? Math.min(maxSize * 0.75, (b.ramMB / 1024) * 0.4) : maxSize * 0.75
  const balPool = candidates('balanced')
  picked.balanced = choose('balanced', balPool, () =>
    best(balPool.filter((s) => usable(s, 'balanced') && s.m.sizeGB <= balCap && (s.m.quality ?? 0) <= (picked.max?.m.quality ?? 100)))
  ) ?? picked.max
  const balSize = picked.balanced?.m.sizeGB ?? maxSize
  const fastPool = candidates('fast')
  picked.fast = choose('fast', fastPool, () => best(fastPool.filter((s) => usable(s, 'fast') && s.m.sizeGB <= Math.max(1.5, balSize * 0.85)))) ?? picked.balanced
  const codePool = candidates('code')
  picked.code = choose('code', codePool, () => best(codePool.filter((s) => usable(s, 'code'))))
  const tinyPool = candidates('tiny')
  picked.tiny = choose('tiny', tinyPool, () => [...tinyPool].filter((s) => s.place.fits).sort((x, y) => x.m.sizeGB - y.m.sizeGB || y.utility - x.utility)[0])
  const embedPool = candidates('embed')
  picked.embed = choose('embed', embedPool, () => best(embedPool.filter((s) => s.place.fits)))

  // Code mode falls back to Max when Max is also the best coder, or so close that a separate download
  // is not worth it (the "Code" slot then stays empty).
  const codeSameAsMax =
    overrides.code === undefined &&
    picked.code &&
    picked.max &&
    (picked.code.m.name === picked.max.m.name || (picked.code.m.coding ?? 0) - (picked.max.m.coding ?? picked.max.m.quality ?? 0) < 5)
  // Code mode on the Max model still gets the largest context that fits (code reads whole files).
  const codeCtx = picked.code?.ctx ?? (picked.max ? score(picked.max.m, 'code').ctx : undefined)
  if (codeSameAsMax) picked.code = undefined

  const gpuName = scan.gpu?.name ?? 'your GPU'
  const reasonFor = (role: LlmRole, s?: Scored): string => {
    if (!s) {
      if (role === 'code') return codeSameAsMax ? 'Max is also the best coder that fits, so Code mode uses it.' : 'Code mode will use the Max model.'
      return 'Nothing in the catalog fits this role on this PC.'
    }
    const p = s.place
    const where =
      p.where === 'gpu'
        ? `Fits fully on ${gpuName}`
        : p.where === 'hybrid'
          ? `${Math.round(p.gpuShare * 100)}% on the GPU, the rest from RAM`
          : p.where === 'cpu'
            ? `Runs on the ${scan.cpu.cores}-core CPU`
            : 'Does not fit this PC'
    const why: Record<LlmRole, string> = {
      max: 'the most capable model that fits',
      balanced: 'lighter than Max, so everyday answers come back quickly',
      fast: 'answers small talk almost instantly',
      code: 'the strongest coder that fits',
      tiny: 'it keeps routing and memory upkeep off the GPU',
      embed: 'it powers memory search'
    }
    const ctxNote = role !== 'embed' && role !== 'tiny' ? ` with a ${s.ctx / 1024}K context` : ''
    return `${where}${ctxNote}: ${why[role]}.`
  }

  for (const role of LLM_ROLES) {
    const pool = (role === 'tiny' ? tinyPool : role === 'embed' ? embedPool : role === 'code' ? codePool : role === 'max' ? maxPool : role === 'balanced' ? balPool : fastPool)
      .slice()
      .sort((x, y) => Number(y.place.fits) - Number(x.place.fits) || y.utility - x.utility)
    const s = picked[role]
    // Make sure an override that is not in the role's pool still shows up as an option.
    if (s && !pool.some((x) => x.m.name === s.m.name)) pool.unshift(s)
    items.push({
      role,
      kind: 'llm',
      pick: s?.m.name,
      options: pool.map(optionOf),
      reason: reasonFor(role, s),
      enabled: Boolean(s),
      numCtx: s?.ctx ?? (role === 'code' ? codeCtx : undefined)
    })
  }

  // ------------------------------------------------------------- images and video
  const mediaRole = (role: MediaRole, kind: 'image' | 'video', wantFast: boolean, enabledByPref: boolean): void => {
    const pool = packs
      .filter((p) => p.kind === kind && p.id !== 'video-quality-i2v')
      .map((p) => {
        const place = mediaPlacement(p, b, mediaProcessing)
        const speedPenalty = (wantFast ? 8 : 2) * Math.log10(Math.max(1, place.speedValue))
        return { p, place, utility: p.quality - speedPenalty + (p.installed ? 3 : 0) }
      })
      .sort((x, y) => Number(y.place.fits) - Number(x.place.fits) || y.utility - x.utility)
    const o = overrides[role]
    let pick: (typeof pool)[number] | undefined
    if (o) pick = pool.find((x) => x.p.id === o)
    else if (o !== null) {
      const fitting = pool.filter((x) => x.place.fits && (!wantFast || x.p.tier === 'fast'))
      pick = fitting[0]
    }
    const fastTwin = role === 'imageQuality' ? 'imageFast' : role === 'videoQuality' ? 'videoFast' : undefined
    const twin = fastTwin ? items.find((i) => i.role === fastTwin) : undefined
    const sameAsFast = Boolean(!o && pick && twin?.pick === pick.p.id)
    if (sameAsFast) pick = undefined
    const enabled = enabledByPref && Boolean(pick) && o !== null
    const reason = !enabledByPref
      ? kind === 'image'
        ? 'Images are switched off.'
        : 'Video is switched off.'
      : sameAsFast
        ? 'The fast model is also the best one that fits, so it covers this too.'
        : !pick
          ? o === null
            ? 'Left out.'
            : kind === 'video' && mediaProcessing === 'cpu'
              ? 'Video generation needs a supported graphics card.'
              : 'Nothing fits this PC for this role.'
          : pick.place.where === 'gpu'
            ? `Runs fully on the GPU${wantFast ? ', the quickest that fits' : ', the best quality that fits'}.`
            : pick.place.where === 'hybrid'
              ? 'Larger than your VRAM, so ComfyUI swaps parts in from RAM. Slower, but it works.'
              : 'Runs on the CPU. Small pictures only, and each one takes a while.'
    items.push({
      role,
      kind: 'media',
      pick: enabled ? pick?.p.id : undefined,
      options: pool.map((x) => ({
        id: x.p.id,
        label: x.p.name,
        sizeGB: x.p.sizeGB,
        placement: x.place,
        installed: x.p.installed,
        quality: x.p.quality,
        description: x.p.description
      })),
      reason,
      enabled
    })
  }
  mediaRole('imageFast', 'image', true, prefs.images)
  mediaRole('imageQuality', 'image', false, prefs.images)
  mediaRole('videoFast', 'video', true, prefs.video)
  mediaRole('videoQuality', 'video', false, prefs.video)

  // ------------------------------------------------------------- downloads and disk space
  const llmNames = new Set(items.filter((i) => i.kind === 'llm' && i.enabled && i.pick && !installed.has(i.pick)).map((i) => i.pick!))
  const llmGB = [...llmNames].reduce((s, n) => s + (llms.find((m) => m.name === n)?.sizeGB ?? 0), 0)
  const files = new Map<string, number>()
  for (const i of items.filter((x) => x.kind === 'media' && x.enabled && x.pick)) {
    const p = packs.find((x) => x.id === i.pick)
    if (!p || p.installed) continue
    for (const f of p.files) if (!f.present) files.set(`${f.dir}/${f.name}`, (f.sizeBytes ?? 0) / 1e9)
  }
  let mediaGB = [...files.values()].reduce((s, v) => s + v, 0)
  if (files.size && !scan.comfy.installed) mediaGB += 2
  const downloadGB = Math.round((llmGB + mediaGB + (scan.ollama.installed ? 0 : 1.2)) * 10) / 10

  const dataDisk = diskFor(scan.disks, prefs.dataDir)
  const freeGB = dataDisk?.freeGB ?? 0
  if (dataDisk && mediaGB > dataDisk.freeGB * 0.92) {
    warnings.push(`${diskName(dataDisk)} has ${Math.round(dataDisk.freeGB)} GB free but images and video need about ${Math.round(mediaGB)} GB. Pick another data folder or fewer models.`)
  }
  const sys = diskFor(scan.disks, scan.ollama.modelsDir) ?? diskFor(scan.disks, 'C:')
  if (sys && llmGB > sys.freeGB * 0.92) {
    warnings.push(`Ollama stores language models on ${diskName(sys)}, which has ${Math.round(sys.freeGB)} GB free; the chosen models need about ${Math.round(llmGB)} GB.`)
  }
  if (!b.llmGpu) {
    warnings.push(
      scan.gpu?.integrated || !scan.gpu
        ? 'No dedicated graphics card was found, so language models run on the CPU. Answers will be slower.'
        : `${scan.gpu.name} is not supported for language models yet, so they run on the CPU.`
    )
  }
  if (scan.gpu?.vendor === 'amd' || scan.gpu?.vendor === 'intel') {
    warnings.push(`Speed estimates for ${scan.gpu.name} are rough; NVIDIA drivers are the best supported.`)
  }
  return { prefs: { ...prefs, processing }, items, downloadGB, freeGB, warnings }
}

/** Settings that a finished plan writes (model roles, context windows, processing mode). */
export function planToSettings(plan: SetupPlan): {
  tiers: Record<string, string>
  contexts: { fast?: number; balanced?: number; max?: number; code?: number }
  mediaRoles: Partial<Record<MediaRole, string>>
} {
  const pick = (r: SetupRole): PlanItem | undefined => plan.items.find((i) => i.role === r)
  const tiers: Record<string, string> = {}
  for (const r of LLM_ROLES) {
    const i = pick(r)
    if (i?.enabled && i.pick) tiers[r] = i.pick
  }
  if (!tiers.code) tiers.code = ''
  const ctx = (r: LlmRole): number | undefined => pick(r)?.numCtx
  const mediaRoles: Partial<Record<MediaRole, string>> = {}
  for (const r of MEDIA_ROLES) {
    const i = pick(r)
    if (i?.enabled && i.pick) mediaRoles[r] = i.pick
  }
  // Roles left on "same as fast" use the fast pack.
  if (!mediaRoles.imageQuality && mediaRoles.imageFast && plan.prefs.images) mediaRoles.imageQuality = mediaRoles.imageFast
  if (!mediaRoles.videoQuality && mediaRoles.videoFast && plan.prefs.video) mediaRoles.videoQuality = mediaRoles.videoFast
  return { tiers, contexts: { fast: ctx('fast'), balanced: ctx('balanced'), max: ctx('max'), code: ctx('code') ?? ctx('max') }, mediaRoles }
}
