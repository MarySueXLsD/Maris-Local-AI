import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetOf, cpuTokensPerSec, defaultPrefs, isLitePc, makePlan, mediaPlacement, planToSettings } from '../src/shared/recommend.ts'
import { LLM_CATALOG } from '../src/shared/models.ts'
import { guessCpuFlags } from '../src/main/system/cpuFlags.ts'
import { PACKS, packSizeGB } from '../src/main/media/catalog.ts'

type Scan = Parameters<typeof makePlan>[0]['scan']
type Gpu = NonNullable<Scan['gpu']>

const pc = (o: { ramGB: number; ramBW: number; cores: number; avx2?: boolean; gpu?: Gpu; name?: string }): Scan => ({
  ts: 0,
  os: 'Windows 10',
  cpu: { name: o.name ?? 'Test CPU', cores: o.cores, threads: o.cores * 2, avx2: o.avx2 ?? true, avx512: false },
  ram: { totalMB: o.ramGB * 1024, freeMB: o.ramGB * 400, bandwidthGBs: o.ramBW },
  gpus: o.gpu ? [o.gpu] : [],
  gpu: o.gpu,
  disks: [{ root: 'C:\\', freeGB: 80, totalGB: 240 }],
  laptop: true,
  ollama: { installed: false, running: false, models: [], modelsDir: 'C:\\Users\\me\\.ollama\\models' },
  comfy: { installed: false },
  winget: true,
  notes: []
})

const packs = PACKS.map((p) => ({ ...p, sizeGB: packSizeGB(p), installed: false, files: p.files.map((f) => ({ ...f, present: false })) }))
const plan = (scan: Scan) => makePlan({ scan, llms: LLM_CATALOG, packs, installed: [], prefs: { processing: 'gpu', images: false, video: false, dataDir: 'C:\\MarisData' } })
const pick = (p: ReturnType<typeof makePlan>, role: string) => p.items.find((i) => i.role === role)!
const model = (name?: string) => LLM_CATALOG.find((m) => m.name === name)!

// A 2012 laptop: two cores without AVX2, 4 GB, DDR3.
const OLD_LAPTOP = pc({ ramGB: 4, ramBW: 21, cores: 2, avx2: false, name: 'Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz' })
// A 2018 office laptop: four cores with AVX2, 8 GB, no graphics card.
const OFFICE_LAPTOP = pc({ ramGB: 8, ramBW: 38, cores: 4 })

test('a slow computer is recognised, a workstation is not', () => {
  assert.equal(isLitePc(OLD_LAPTOP), true)
  assert.equal(isLitePc(OFFICE_LAPTOP), true)
  assert.equal(isLitePc(pc({ ramGB: 32, ramBW: 51, cores: 8 })), false, 'plenty of memory and cores')
  assert.equal(isLitePc(pc({ ramGB: 16, ramBW: 40, cores: 4, avx2: false })), true, 'four old cores')
  const card: Gpu = { name: 'NVIDIA GeForce GTX 1050', vendor: 'nvidia', vramMB: 2048, integrated: false, bandwidthGBs: 112, perf: 0.05, llm: 'cuda', comfy: 'nvidia_cu126' }
  assert.equal(isLitePc(pc({ ramGB: 8, ramBW: 38, cores: 4, gpu: card })), false, 'a small graphics card runs small models quickly')
})

test('an old processor is slow for what it computes, not only for its memory', () => {
  const small = model('qwen3:0.6b')
  const old = cpuTokensPerSec(small, budgetOf(OLD_LAPTOP))
  const newer = cpuTokensPerSec(small, budgetOf(OFFICE_LAPTOP))
  assert.ok(old >= 5 && old <= 14, `0.6B on a 2012 dual-core: ${old.toFixed(1)} tokens/s`)
  assert.ok(newer > old * 2, `AVX2 and four cores are several times faster: ${newer.toFixed(1)} vs ${old.toFixed(1)}`)
  const four = cpuTokensPerSec(model('qwen3.5:4b'), budgetOf(OLD_LAPTOP))
  assert.ok(four < 2, `a 4B model crawls on the old laptop: ${four.toFixed(1)} tokens/s`)
})

test('the old laptop gets one small model for everything, at a pace that is usable', () => {
  const p = plan(OLD_LAPTOP)
  assert.equal(p.prefs.processing, 'cpu')
  const max = pick(p, 'max')
  const m = model(max.pick)
  assert.ok(m, 'something was picked')
  assert.ok(m.sizeGB <= 1.4, `small enough for 4 GB: ${m.name} (${m.sizeGB} GB)`)
  const place = max.options.find((o) => o.id === max.pick)!.placement
  assert.equal(place.fits, true)
  assert.ok(place.speedValue >= 4, `usable pace: ${place.speedValue.toFixed(1)} tokens/s with ${m.name}`)
  // One model plays every part, so nothing is loaded twice and nothing is swapped.
  for (const role of ['balanced', 'fast', 'tiny']) assert.equal(pick(p, role).pick, max.pick, role)
  assert.equal(pick(p, 'code').enabled, false)
  // No second model in memory for memory search with only 4 GB.
  assert.equal(pick(p, 'embed').enabled, false)
  assert.equal(max.numCtx, 4096, 'a small window: less to read and less memory')
  assert.ok(p.warnings.some((w) => /low-power mode/i.test(w)))
  const s = planToSettings(p)
  assert.equal(s.tiers.fast, s.tiers.max)
  assert.equal(s.contexts.max, 4096)
  assert.ok(p.downloadGB < 3, `a small download: ${p.downloadGB} GB`)
})

test('the office laptop gets a better small model, and a tiny one for memory search', () => {
  const p = plan(OFFICE_LAPTOP)
  const max = pick(p, 'max')
  const m = model(max.pick)
  const place = max.options.find((o) => o.id === max.pick)!.placement
  assert.ok((m.quality ?? 0) >= 38, `more capable than on the old laptop: ${m.name}`)
  assert.ok(m.sizeGB <= 3.5, `fits in 8 GB next to Windows: ${m.name}`)
  assert.ok(place.speedValue >= 6, `${place.speedValue.toFixed(1)} tokens/s with ${m.name}`)
  assert.equal(max.numCtx, 8192)
  assert.equal(pick(p, 'fast').pick, max.pick)
  assert.equal(pick(p, 'embed').pick, 'all-minilm')
  // Every chat model is on offer for every role, the ones that fit first.
  assert.ok(max.options.length > 10)
  assert.equal(max.options[0]!.placement.fits, true)
})

test('the person can still choose another model for a role on a slow computer', () => {
  const p = makePlan({ scan: OFFICE_LAPTOP, llms: LLM_CATALOG, packs, installed: [], prefs: { processing: 'cpu', images: false, video: false, dataDir: 'C:\\MarisData' }, overrides: { max: 'qwen3:0.6b', fast: 'gemma3:270m', embed: null } })
  assert.equal(pick(p, 'max').pick, 'qwen3:0.6b')
  assert.equal(pick(p, 'balanced').pick, 'qwen3:0.6b')
  assert.equal(pick(p, 'fast').pick, 'gemma3:270m')
  assert.equal(pick(p, 'embed').enabled, false)
})

test('a 2 GB graphics card is used for a small model instead of the processor', () => {
  const card: Gpu = { name: 'NVIDIA GeForce GTX 1050', vendor: 'nvidia', vramMB: 2048, integrated: false, bandwidthGBs: 112, perf: 0.05, llm: 'cuda', comfy: 'nvidia_cu126' }
  const p = plan(pc({ ramGB: 8, ramBW: 38, cores: 4, gpu: card }))
  assert.equal(p.prefs.processing, 'gpu')
  const max = pick(p, 'max')
  const place = max.options.find((o) => o.id === max.pick)!.placement
  assert.equal(place.where, 'gpu', `${max.pick} runs on the card`)
  assert.ok(model(max.pick).sizeGB < 1.5)
})

test('ordinary computers are not handed the small models by themselves', () => {
  const p = plan(pc({ ramGB: 32, ramBW: 51, cores: 8 }))
  for (const role of ['max', 'balanced', 'fast', 'tiny', 'embed']) {
    const chosen = model(pick(p, role).pick)
    assert.ok(chosen && !chosen.light, `${role} → ${chosen?.name}`)
  }
  // Without a graphics card, Max is picked for pace: a model that crawls is not "the most capable".
  const cpuOnly = plan(pc({ ramGB: 16, ramBW: 42, cores: 4 }))
  const max = pick(cpuOnly, 'max')
  assert.ok(max.options.find((o) => o.id === max.pick)!.placement.speedValue >= 4, `${max.pick} keeps a usable pace`)
})

test('every catalogue entry is complete enough to be recommended', () => {
  const names = new Set<string>()
  for (const m of LLM_CATALOG) {
    assert.ok(!names.has(m.name), `duplicate ${m.name}`)
    names.add(m.name)
    assert.ok(m.sizeGB > 0 && m.paramsB && m.paramsB > 0, `${m.name} has a size`)
    assert.ok(m.roles?.length, `${m.name} has roles`)
    assert.ok(m.description.length > 20, `${m.name} is described`)
    if (m.light) assert.ok(m.sizeGB <= 2.6, `${m.name} is marked small but is ${m.sizeGB} GB`)
  }
})

test('AVX2 is told from the processor when the system does not say', () => {
  const yes = [
    ['Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', 'Intel64 Family 6 Model 142 Stepping 10, GenuineIntel'],
    ['AMD Ryzen 5 3600 6-Core Processor', 'AMD64 Family 23 Model 113 Stepping 0, AuthenticAMD'],
    ['Intel(R) N100', 'Intel64 Family 6 Model 190 Stepping 0, GenuineIntel'],
    ['Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz', ''],
    ['12th Gen Intel(R) Core(TM) i7-12700K', ''],
    ['Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', ''],
    ['AMD Athlon Gold 3150U with Radeon Graphics', ''],
    ['Apple M2', ''],
    ['Snapdragon(R) X Elite', '']
  ]
  const no = [
    ['Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz', 'Intel64 Family 6 Model 58 Stepping 9, GenuineIntel'],
    ['Intel(R) Core(TM) i7-2600K CPU @ 3.40GHz', 'Intel64 Family 6 Model 42 Stepping 7, GenuineIntel'],
    ['Intel(R) Celeron(R) CPU N3350 @ 1.10GHz', 'Intel64 Family 6 Model 92 Stepping 9, GenuineIntel'],
    ['Intel(R) Pentium(R) Gold G5400 CPU @ 3.70GHz', 'Intel64 Family 6 Model 158 Stepping 10, GenuineIntel'],
    ['AMD FX(tm)-8350 Eight-Core Processor', 'AMD64 Family 21 Model 2 Stepping 0, AuthenticAMD'],
    ['Intel(R) Core(TM)2 Duo CPU E8400 @ 3.00GHz', ''],
    ['Intel(R) Core(TM) i7 CPU 920 @ 2.67GHz', ''],
    ['Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz', ''],
    ['AMD Phenom(tm) II X6 1090T Processor', ''],
    ['AMD A10-7850K Radeon R7, 12 Compute Cores 4C+8G', ''],
    ['Intel(R) Atom(TM) x5-Z8350 CPU @ 1.44GHz', ''],
    ['Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz', ''],
    ['Intel(R) Xeon(R) CPU X5650 @ 2.67GHz', ''],
    ['Intel(R) Celeron(R) N4020 CPU @ 1.10GHz', '']
  ]
  for (const [name, id] of yes) assert.equal(guessCpuFlags(name!, id).avx2, true, `${name} has AVX2`)
  for (const [name, id] of no) assert.equal(guessCpuFlags(name!, id).avx2, false, `${name} has no AVX2`)
  assert.equal(guessCpuFlags('AMD Ryzen 7 9800X3D 8-Core Processor', 'AMD64 Family 26 Model 68 Stepping 0, AuthenticAMD').avx512, true)
  assert.equal(guessCpuFlags('Intel(R) Core(TM) i7-1065G7 CPU @ 1.30GHz', '').avx512, true)
  assert.equal(guessCpuFlags('Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', '').avx512, false)
})

test('pictures on the processor are only offered where there is memory for them', () => {
  // SD 1.5 runs without a graphics card, but its whole model then sits in system memory.
  const sd = packs.find((p) => p.cpuOk)!
  assert.ok(sd, 'a picture model that runs on the processor exists')
  assert.equal(defaultPrefs(OLD_LAPTOP, 'C:\MarisData').images, false, '4 GB: not offered')
  assert.equal(mediaPlacement(sd, budgetOf(OLD_LAPTOP), 'cpu').fits, false)
  assert.equal(defaultPrefs(OFFICE_LAPTOP, 'C:\MarisData').images, true, '8 GB: offered')
  assert.equal(mediaPlacement(sd, budgetOf(OFFICE_LAPTOP), 'cpu').fits, true)
})
