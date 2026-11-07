// Hardware facts on macOS and Linux, read without administrator rights (parsers in posixParse.ts).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appleChip, appleGpuBudgetMB } from './gpus'
import { parseCpuinfo, parseDf, parseLspciName, parseMacDisplays, parseMacHardware, parseUdevMemory, type PosixGpu } from './posixParse'

export type { PosixGpu }

export interface PosixRaw {
  cpu: { name?: string; cores?: number; threads?: number }
  mem: { speed?: number; type?: string; sticks?: number }
  gpus: PosixGpu[]
  disks: { root: string; free: number; size: number; fs?: string; label?: string }[]
  laptop: boolean
  brew?: boolean
  /** Apple chips: memory bandwidth, which the CPU shares with the GPU. */
  appleBandwidthGBs?: number
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)))
    } catch {
      resolve('')
    }
  })
}

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- Linux GPUs

const VENDORS: Record<string, string> = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel' }

/** Display adapters under /sys/class/drm with VRAM where the driver reports it (amdgpu, xe/i915). */
async function linuxGpus(): Promise<PosixGpu[]> {
  const base = '/sys/class/drm'
  let cards: string[] = []
  try {
    cards = readdirSync(base).filter((n) => /^card\d+$/.test(n))
  } catch {
    return []
  }
  const gpus: PosixGpu[] = []
  const seen = new Set<string>()
  for (const card of cards) {
    const dev = path.join(base, card, 'device')
    const vendorId = read(path.join(dev, 'vendor'))
    const uevent = read(path.join(dev, 'uevent'))
    const slot = /PCI_SLOT_NAME=(\S+)/.exec(uevent)?.[1]
    const driver = /DRIVER=(\S+)/.exec(uevent)?.[1]
    if (!slot || seen.has(slot)) continue
    seen.add(slot)
    const lspci = slot ? await run('lspci', ['-mm', '-s', slot], 4000) : ''
    const name = parseLspciName(lspci.split('\n')[0] ?? '') ?? `${VENDORS[vendorId] ?? 'Unknown'} GPU`
    let vram = Number(read(path.join(dev, 'mem_info_vram_total'))) // amdgpu, bytes
    if (!vram) vram = Number(read(path.join(base, card, 'lmem_total_bytes'))) // i915 discrete (Arc)
    if (!vram) {
      // xe driver: tile0/vram0/io_size or similar; take the largest number found.
      try {
        const t = path.join(dev, 'tile0', 'vram0')
        if (existsSync(t)) vram = Math.max(...readdirSync(t).map((f) => Number(read(path.join(t, f))) || 0))
      } catch {
        /* none */
      }
    }
    gpus.push({ name, vramMB: vram / 2 ** 20, driver, vendorId })
  }
  return gpus
}

/** Chromium's own GPU name ("AMD Radeon RX 7900 XTX (radeonsi, navi31, …)"), a better name than lspci's chip family. */
async function chromiumRenderer(): Promise<string | undefined> {
  try {
    const { app } = await import('electron')
    const info = (await Promise.race([app.getGPUInfo('complete'), new Promise((r) => setTimeout(() => r(undefined), 4000))])) as
      | { auxAttributes?: { glRenderer?: string } }
      | undefined
    const r = info?.auxAttributes?.glRenderer
    return r && !/swiftshader|llvmpipe|software/i.test(r) ? r.replace(/\s*\(.*$/, '').replace(/^ANGLE\s*\(/, '').trim() : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- scans

async function scanLinux(): Promise<PosixRaw> {
  const [udev, gpus, renderer, df] = await Promise.all([
    run('udevadm', ['info', '--query=property', '--path=/devices/virtual/dmi/id'], 4000),
    linuxGpus(),
    chromiumRenderer(),
    run('df', ['-kP'], 6000)
  ])
  // lspci names a chip family shared by several cards; Chromium names the exact card when the vendor matches.
  if (renderer) {
    const amd = gpus.find((g) => g.vendorId === '0x1002' && /radeon/i.test(renderer))
    if (amd && /rx\s*\d/i.test(renderer)) amd.name = renderer.replace(/^AMD\s*/i, 'AMD ')
  }
  const cpu = parseCpuinfo(read('/proc/cpuinfo'))
  const chassis = Number(read('/sys/class/dmi/id/chassis_type'))
  let battery = false
  try {
    battery = readdirSync('/sys/class/power_supply').some((n) => /^BAT/i.test(n))
  } catch {
    /* none */
  }
  return {
    cpu: { name: cpu.name, cores: cpu.cores, threads: os.cpus().length },
    mem: parseUdevMemory(udev),
    gpus,
    disks: parseDf(df, false),
    laptop: [8, 9, 10, 11, 14, 30, 31, 32].includes(chassis) || battery
  }
}

async function scanMac(): Promise<PosixRaw> {
  const totalMB = Math.round(os.totalmem() / 2 ** 20)
  const [sysctl, displays, hw, df] = await Promise.all([
    run('sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.physicalcpu', 'hw.logicalcpu'], 4000),
    run('system_profiler', ['SPDisplaysDataType', '-json'], 15000),
    run('system_profiler', ['SPHardwareDataType', 'SPMemoryDataType', '-json'], 15000),
    run('df', ['-kP'], 6000)
  ])
  const [brand, phys, logical] = sysctl.split('\n').map((s) => s.trim())
  const gpus = parseMacDisplays(displays, appleGpuBudgetMB(totalMB))
  const hardware = parseMacHardware(hw)
  const apple = gpus.find((g) => /^apple\b/i.test(g.name))
  return {
    cpu: { name: brand || os.cpus()[0]?.model, cores: Number(phys) || undefined, threads: Number(logical) || os.cpus().length },
    mem: { type: hardware.memType, sticks: 1 },
    gpus,
    disks: parseDf(df, true),
    laptop: hardware.laptop,
    brew: existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew'),
    appleBandwidthGBs: apple ? appleChip(apple.name, apple.cores).bandwidthGBs : undefined
  }
}

/** Hardware facts on macOS or Linux. */
export function scanPosix(): Promise<PosixRaw> {
  return process.platform === 'darwin' ? scanMac() : scanLinux()
}
