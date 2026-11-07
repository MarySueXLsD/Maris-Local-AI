import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetOf, makePlan, planToSettings } from '../src/shared/recommend.ts'
import { LLM_CATALOG } from '../src/shared/models.ts'
import { PACKS, packSizeGB } from '../src/main/media/catalog.ts'

type Scan = Parameters<typeof makePlan>[0]['scan']
type Gpu = NonNullable<Scan['gpu']>

const gpu = (name: string, vramGB: number, bw: number, perf: number, extra: Partial<Gpu> = {}): Gpu => ({
  name,
  vendor: 'nvidia',
  vramMB: vramGB * 1024,
  integrated: false,
  bandwidthGBs: bw,
  perf,
  llm: 'cuda',
  comfy: 'nvidia',
  ...extra
})

const pc = (opts: { gpu?: Gpu; ramGB: number; ramBW: number; cores: number; models?: string[] }): Scan => ({
  ts: 0,
  os: 'Windows 11',
  cpu: { name: 'Test CPU', cores: opts.cores, threads: opts.cores * 2, avx2: true, avx512: false },
  ram: { totalMB: opts.ramGB * 1024, freeMB: opts.ramGB * 512, bandwidthGBs: opts.ramBW },
  gpus: opts.gpu ? [opts.gpu] : [],
  gpu: opts.gpu,
  disks: [
    { root: 'C:\\', freeGB: 300, totalGB: 1000 },
    { root: 'H:\\', freeGB: 600, totalGB: 2000 }
  ],
  laptop: false,
  ollama: { installed: true, running: true, models: opts.models ?? [], modelsDir: 'C:\\Users\\me\\.ollama\\models' },
  comfy: { installed: true, dir: 'H:\\MarisData\\ComfyUI_windows_portable' },
  winget: true,
  notes: []
})

const packs = (installed: string[] = []) =>
  PACKS.map((p) => ({ ...p, sizeGB: packSizeGB(p), installed: installed.includes(p.id), files: p.files.map((f) => ({ ...f, present: installed.includes(p.id) })) }))

const pick = (plan: ReturnType<typeof makePlan>, role: string) => plan.items.find((i) => i.role === role)

test('16 GB RTX 5070 Ti, GPU only: the Q3 27B fits fully and is Max; Code reuses it', () => {
  const installed = ['qwen3.5:0.8b', 'qwen3.5:4b', 'qwen3.5:9b', 'qwen3.8:27b-q3', 'qwen3-embedding:0.6b']
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 5070 Ti', 15.92, 896, 1, { computeCap: '12.0' }), ramGB: 62, ramBW: 96, cores: 8, models: installed })
  const plan = makePlan({
    scan,
    llms: LLM_CATALOG,
    packs: packs(['image-fast', 'image-quality', 'video-fast', 'video-quality', 'video-quality-i2v']),
    installed,
    prefs: { processing: 'gpu', images: true, video: true, dataDir: 'H:\\MarisData' }
  })
  const max = pick(plan, 'max')!
  assert.equal(max.pick, 'qwen3.8:27b-q3')
  const opt = max.options.find((o) => o.id === max.pick)!
  assert.equal(opt.placement.where, 'gpu')
  assert.ok(opt.placement.speedValue > 30 && opt.placement.speedValue < 45, `speed ${opt.placement.speedValue}`)
  assert.equal(max.numCtx, 16384)
  assert.equal(pick(plan, 'code')!.enabled, false, 'Code mode should use Max')
  assert.equal(pick(plan, 'balanced')!.pick, 'qwen3.5:9b')
  assert.equal(pick(plan, 'fast')!.pick, 'qwen3.5:4b')
  assert.equal(pick(plan, 'tiny')!.pick, 'qwen3.5:0.8b')
  assert.equal(pick(plan, 'embed')!.pick, 'qwen3-embedding:0.6b')
  assert.equal(pick(plan, 'imageFast')!.pick, 'image-fast')
  assert.equal(pick(plan, 'imageQuality')!.pick, 'image-quality')
  assert.equal(pick(plan, 'videoFast')!.pick, 'video-fast')
  assert.equal(pick(plan, 'videoQuality')!.pick, 'video-quality')
  assert.equal(plan.downloadGB, 0, 'everything is installed already')
  const s = planToSettings(plan)
  assert.equal(s.tiers.code, '')
  assert.equal(s.tiers.max, 'qwen3.8:27b-q3')
  assert.equal(s.mediaRoles.imageFast, 'image-fast')
})

test('8 GB RTX 4060 with 16 GB RAM, GPU only: everything fits on the card', () => {
  // Real "8 GB" cards report 8188 MiB.
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 4060', 8188 / 1024, 272, 0.42), ramGB: 16, ramBW: 51, cores: 6 })
  const plan = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed: [], prefs: { processing: 'gpu', images: true, video: true, dataDir: 'H:\\MarisData' } })
  for (const i of plan.items.filter((x) => x.kind === 'llm' && x.pick)) {
    const o = i.options.find((x) => x.id === i.pick)!
    assert.ok(o.placement.fits, `${i.role} → ${i.pick} should fit`)
    if (i.role !== 'tiny' && i.role !== 'embed') assert.equal(o.placement.where, 'gpu', `${i.role} should be fully on the GPU`)
  }
  assert.equal(pick(plan, 'max')!.pick, 'qwen3.5:9b')
  assert.notEqual(pick(plan, 'fast')!.pick, 'qwen3.5:0.8b', 'Fast should be better than the tiny helper')
  assert.equal(pick(plan, 'imageFast')!.pick, 'image-lite', 'the 8-bit Z-Image fits 8 GB')
  assert.equal(pick(plan, 'videoFast')!.pick, 'video-lite', 'the 1.3B Wan fits 8 GB')
  assert.ok(plan.downloadGB > 10)
})

test('24 GB RTX 4090: the Q4 27B fits fully', () => {
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 4090', 24, 1008, 1.9), ramGB: 64, ramBW: 96, cores: 16 })
  const plan = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed: [], prefs: { processing: 'gpu', images: true, video: true, dataDir: 'H:\\MarisData' } })
  const max = pick(plan, 'max')!
  assert.equal(max.pick, 'qwen3.8:27b')
  assert.equal(max.options.find((o) => o.id === max.pick)!.placement.where, 'gpu')
})

test('no graphics card: CPU-only plan with the CPU image model and no video', () => {
  const scan = pc({ ramGB: 32, ramBW: 51, cores: 8 })
  const b = budgetOf(scan)
  assert.equal(b.llmGpu, false)
  const plan = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed: [], prefs: { processing: 'gpu', images: true, video: true, dataDir: 'C:\\MarisData' } })
  assert.equal(plan.prefs.processing, 'cpu')
  for (const i of plan.items.filter((x) => x.kind === 'llm' && x.pick)) {
    assert.equal(i.options.find((x) => x.id === i.pick)!.placement.where, 'cpu', `${i.role} runs on the CPU`)
  }
  assert.equal(pick(plan, 'imageFast')!.pick, 'image-sd15')
  assert.equal(pick(plan, 'videoFast')!.enabled, false)
  const bal = LLM_CATALOG.find((m) => m.name === pick(plan, 'balanced')!.pick)!
  assert.ok(bal.sizeGB <= 10, `Balanced on a CPU should stay light, got ${bal.name}`)
  assert.ok(plan.warnings.some((w) => /CPU/.test(w)))
})

test('GPU + CPU on an 8 GB card with 32 GB RAM lets a larger model overflow into RAM', () => {
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 4060', 8, 272, 0.42), ramGB: 32, ramBW: 83, cores: 8 })
  const gpuOnly = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed: [], prefs: { processing: 'gpu', images: true, video: true, dataDir: 'H:\\MarisData' } })
  const hybrid = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed: [], prefs: { processing: 'hybrid', images: true, video: true, dataDir: 'H:\\MarisData' } })
  const m1 = pick(gpuOnly, 'max')!
  const m2 = pick(hybrid, 'max')!
  const big = LLM_CATALOG.find((m) => m.name === m2.pick)!
  const small = LLM_CATALOG.find((m) => m.name === m1.pick)!
  assert.ok((big.quality ?? 0) > (small.quality ?? 0), `${m2.pick} should beat ${m1.pick}`)
  const place = m2.options.find((o) => o.id === m2.pick)!.placement
  assert.equal(place.where, 'hybrid')
  assert.ok(place.speedValue >= 6, `still usable: ${place.speedValue} tokens/s`)
})

test('overrides: leaving Code on Max and choosing another Fast model', () => {
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 5070 Ti', 15.92, 896, 1), ramGB: 62, ramBW: 96, cores: 8 })
  const plan = makePlan({
    scan,
    llms: LLM_CATALOG,
    packs: packs(),
    installed: [],
    prefs: { processing: 'gpu', images: false, video: false, dataDir: 'H:\\MarisData' },
    overrides: { fast: 'qwen3.5:2b', code: null }
  })
  assert.equal(pick(plan, 'fast')!.pick, 'qwen3.5:2b')
  assert.equal(pick(plan, 'code')!.enabled, false)
  assert.equal(pick(plan, 'imageFast')!.enabled, false)
  const s = planToSettings(plan)
  assert.equal(s.tiers.fast, 'qwen3.5:2b')
  assert.equal(s.tiers.code, '')
  assert.deepEqual(s.mediaRoles, {})
})

test('on the 16 GB PC each mode offers something different for Max', () => {
  const installed = ['qwen3.5:0.8b', 'qwen3.5:4b', 'qwen3.5:9b', 'qwen3.8:27b-q3', 'qwen3-embedding:0.6b']
  const scan = pc({ gpu: gpu('NVIDIA GeForce RTX 5070 Ti', 15.92, 896, 1), ramGB: 62, ramBW: 90, cores: 8, models: installed })
  const maxFor = (processing: 'gpu' | 'hybrid' | 'cpu') => {
    const plan = makePlan({ scan, llms: LLM_CATALOG, packs: packs(), installed, prefs: { processing, images: false, video: false, dataDir: 'H:\MarisData' } })
    const m = pick(plan, 'max')!
    return { id: m.pick, place: m.options.find((o) => o.id === m.pick)!.placement }
  }
  const g = maxFor('gpu')
  const h = maxFor('hybrid')
  const c = maxFor('cpu')
  assert.equal(g.id, 'qwen3.8:27b-q3')
  assert.notEqual(h.id, g.id, 'GPU + CPU should offer a larger model')
  assert.equal(h.place.where, 'hybrid')
  assert.equal(c.place.where, 'cpu')
  assert.ok(c.place.speedValue >= 5, `CPU Max should stay usable, got ${c.place.speedValue.toFixed(1)} tokens/s with ${c.id}`)
  assert.ok(LLM_CATALOG.find((m) => m.name === c.id)!.activeB, 'CPU Max should be a mixture-of-experts model')
})
