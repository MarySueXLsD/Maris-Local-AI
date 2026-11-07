// Shows the setup assistant as other PCs would see it, using simulated scans (MARIS_FAKE_SCAN).
// Usage: npm run build && node tests/e2e/setup-pcs.mjs <shotsDir>
// Nothing is installed: each run stops on the models step and quits.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })

const base = {
  ts: 0,
  os: 'Windows 11 Home (build 26100)',
  disks: [{ root: 'C:\\', freeGB: 180, totalGB: 512, fs: 'NTFS' }],
  laptop: false,
  ollama: { installed: false, running: false, models: [], modelsDir: 'C:\\Users\\you\\.ollama\\models' },
  comfy: { installed: false },
  winget: true,
  notes: []
}
const PCS = {
  'no-gpu-laptop': {
    ...base,
    laptop: true,
    cpu: { name: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16, threads: 22, avx2: true, avx512: false },
    ram: { totalMB: 32 * 1024, freeMB: 18 * 1024, speedMTs: 7467, type: 'LPDDR5', bandwidthGBs: 119 },
    gpus: [{ name: 'Intel(R) Arc(TM) Graphics', vendor: 'intel', vramMB: 128, integrated: true, bandwidthGBs: 60, perf: 0.05, llm: 'none', comfy: 'none' }],
    gpu: { name: 'Intel(R) Arc(TM) Graphics', vendor: 'intel', vramMB: 128, integrated: true, bandwidthGBs: 60, perf: 0.05, llm: 'none', comfy: 'none' }
  },
  'rtx-4060-8gb': {
    ...base,
    cpu: { name: 'AMD Ryzen 5 7600', cores: 6, threads: 12, avx2: true, avx512: true },
    ram: { totalMB: 32 * 1024, freeMB: 20 * 1024, speedMTs: 6000, type: 'DDR5', bandwidthGBs: 96 },
    disks: [{ root: 'C:\\', freeGB: 420, totalGB: 1000, fs: 'NTFS' }],
    gpus: [{ name: 'NVIDIA GeForce RTX 4060', vendor: 'nvidia', vramMB: 8188, integrated: false, computeCap: '8.9', driver: '581.57', bandwidthGBs: 272, perf: 0.42, llm: 'cuda', comfy: 'nvidia' }],
    gpu: { name: 'NVIDIA GeForce RTX 4060', vendor: 'nvidia', vramMB: 8188, integrated: false, computeCap: '8.9', driver: '581.57', bandwidthGBs: 272, perf: 0.42, llm: 'cuda', comfy: 'nvidia' }
  },
  'rx-7900xtx-24gb': {
    ...base,
    cpu: { name: 'AMD Ryzen 9 7950X 16-Core Processor', cores: 16, threads: 32, avx2: true, avx512: true },
    ram: { totalMB: 64 * 1024, freeMB: 40 * 1024, speedMTs: 6000, type: 'DDR5', bandwidthGBs: 96 },
    disks: [{ root: 'C:\\', freeGB: 900, totalGB: 2000, fs: 'NTFS' }],
    gpus: [{ name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', vramMB: 24560, integrated: false, bandwidthGBs: 960, perf: 0.8, llm: 'rocm', comfy: 'amd' }],
    gpu: { name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', vramMB: 24560, integrated: false, bandwidthGBs: 960, perf: 0.8, llm: 'rocm', comfy: 'amd' }
  }
}

let failed = 0
for (const [name, scan] of Object.entries(PCS)) {
  const file = path.join(os.tmpdir(), `maris-fake-scan-${name}.json`)
  writeFileSync(file, JSON.stringify(scan))
  const app = await electron.launch({
    executablePath: process.env.MARIS_EXE ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
    args: process.env.MARIS_EXE ? [] : [root],
    env: { ...process.env, MARIS_USER_DATA: path.join(os.tmpdir(), `maris-e2e-pc-${name}-${Date.now()}`), MARIS_FAKE_SCAN: file },
    timeout: 90000
  })
  app.process().stdout?.on('data', () => undefined)
  app.process().stderr?.on('data', () => undefined)
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await win.getByRole('heading', { name: 'Here is what this PC has' }).waitFor({ timeout: 90000 })
    const cont = win.getByRole('button', { name: 'Continue' })
    for (let i = 0; i < 40 && !(await cont.isEnabled()); i++) await win.waitForTimeout(250)
    await win.screenshot({ path: path.join(shots, `pc-${name}-1-scan.png`) })
    await cont.click()
    await win.getByRole('heading', { name: 'Where should models run?' }).waitFor()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(shots, `pc-${name}-2-where.png`) })
    await win.getByRole('button', { name: 'See recommended models' }).click()
    await win.getByRole('heading', { name: 'Recommended for this PC' }).waitFor()
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(shots, `pc-${name}-3-models.png`) })
    const picks = await win.evaluate(() =>
      [...document.querySelectorAll('select[aria-label$=" model"]')].map((s) => `${s.getAttribute('aria-label').replace(' model', '')}: ${s.selectedOptions[0]?.textContent ?? '?'}`)
    )
    const total = await win.evaluate(() => document.querySelector('[aria-label="Set up Maris"] .tabular.font-medium')?.textContent ?? '0')
    console.log(`\n${name} (${total} to download)`)
    console.log(picks.map((p) => `  ${p}`).join('\n'))
    if (errors.length) throw new Error(errors.join('\n'))
  } catch (e) {
    failed++
    console.error(`✗ ${name}: ${e.message}`)
  }
  await app.close()
}
process.exit(failed ? 1 : 0)
