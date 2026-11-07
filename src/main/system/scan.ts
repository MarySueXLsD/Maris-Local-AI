import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiskInfo, GpuInfo, PcScan } from '@shared/types'
import { ollama } from '../engines/ollama'
import { comfy } from '../media/comfy'
import { IS_MAC, IS_WIN, osDescription } from '../platform'
import { runPowerShell } from '../tools/shell'
import { log } from '../util'
import { describeGpu, IGNORE_GPU } from './gpus'
import { scanPosix, type PosixGpu } from './scanPosix'

interface RawScan {
  cpu?: { name?: string; cores?: number; threads?: number }
  mem?: { speed?: number; type?: number; sticks?: number }
  gpus?: { name?: string; vram?: number; driver?: string }[]
  vc?: { name?: string; ram?: number; driver?: string }[]
  disks?: { root: string; free: number; size: number; fs?: string; label?: string }[]
  os?: string
  laptop?: boolean
  winget?: boolean
  // macOS and Linux
  memTypeName?: string
  posixGpus?: PosixGpu[]
  brew?: boolean
  appleBandwidthGBs?: number
}

/** Windows: one PowerShell pass over CIM and the display-adapter registry keys. */
async function windowsRaw(): Promise<RawScan> {
  const out = path.join(os.tmpdir(), `maris-scan-${randomUUID()}.json`)
  const res = await runPowerShell(SCAN_PS(out), { timeoutMs: 60000 }).catch((e) => {
    log.warn('scan', e)
    return undefined
  })
  try {
    return JSON.parse(readFileSync(out, 'utf8').replace(/^﻿/, '')) as RawScan
  } catch (e) {
    log.warn('scan', 'no scan output', res?.stdout.slice(0, 400), e)
    return {}
  } finally {
    rmSync(out, { force: true })
  }
}

async function posixRaw(): Promise<RawScan> {
  try {
    const r = await scanPosix()
    return {
      cpu: r.cpu,
      mem: { speed: r.mem.speed, sticks: r.mem.sticks },
      memTypeName: r.mem.type,
      posixGpus: r.gpus,
      disks: r.disks,
      laptop: r.laptop,
      brew: r.brew,
      appleBandwidthGBs: r.appleBandwidthGBs
    }
  } catch (e) {
    log.warn('scan', e)
    return {}
  }
}

const SCAN_PS = (out: string): string => `
$o = [ordered]@{}
try {
  $c = Get-CimInstance Win32_Processor | Select-Object -First 1
  $o.cpu = @{ name = "$($c.Name)".Trim(); cores = [int]$c.NumberOfCores; threads = [int]$c.NumberOfLogicalProcessors }
} catch {}
try {
  $m = @(Get-CimInstance Win32_PhysicalMemory)
  $o.mem = @{ speed = [int](($m | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum); type = [int]($m | Select-Object -First 1).SMBIOSMemoryType; sticks = $m.Count }
} catch {}
$g = @()
try {
  Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^\\d{4}$' } | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p.DriverDesc) {
        $q = $p.'HardwareInformation.qwMemorySize'
        $s = $p.'HardwareInformation.MemorySize'
        $b = [int64]0
        if ($q) { $b = [int64]$q } elseif ($s -is [byte[]]) { $b = [int64][BitConverter]::ToUInt32($s, 0) } elseif ($s) { $b = [int64]$s }
        $g += @{ name = "$($p.DriverDesc)"; vram = $b; driver = "$($p.DriverVersion)" }
      }
    }
} catch {}
$o.gpus = $g
try { $o.vc = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = "$($_.Name)"; ram = [int64]$_.AdapterRAM; driver = "$($_.DriverVersion)" } }) } catch {}
try { $o.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ root = "$($_.DeviceID)"; free = [int64]$_.FreeSpace; size = [int64]$_.Size; fs = "$($_.FileSystem)"; label = "$($_.VolumeName)" } }) } catch {}
try { $w = Get-CimInstance Win32_OperatingSystem; $o.os = "$($w.Caption) (build $($w.BuildNumber))" } catch {}
try {
  $ch = @((Get-CimInstance Win32_SystemEnclosure).ChassisTypes)
  $o.laptop = (@($ch | Where-Object { $_ -in 8,9,10,11,12,14,18,21,30,31,32 }).Count -gt 0) -or [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
} catch { $o.laptop = $false }
$o.winget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
$o | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath '${out.replace(/'/g, "''")}' -Encoding UTF8
`

function nvidiaSmi(): Promise<{ name: string; vramMB: number; driver: string; computeCap?: string }[]> {
  const run = (fields: string): Promise<string> =>
    new Promise((resolve) => {
      try {
        const p = spawn('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'], { windowsHide: true })
        let out = ''
        p.stdout.on('data', (d: Buffer) => (out += d.toString()))
        p.on('error', () => resolve(''))
        p.on('close', (code) => resolve(code === 0 ? out : ''))
        setTimeout(() => {
          p.kill()
          resolve(out)
        }, 8000)
      } catch {
        resolve('')
      }
    })
  return (async () => {
    let text = await run('name,memory.total,driver_version,compute_cap')
    let withCap = true
    if (!text.trim()) {
      text = await run('name,memory.total,driver_version')
      withCap = false
    }
    return text
      .split(/\r?\n/)
      .map((l) => l.split(',').map((s) => s.trim()))
      .filter((p) => p[0] && Number(p[1]) > 0)
      .map((p) => ({ name: p[0], vramMB: Number(p[1]), driver: p[2], computeCap: withCap ? p[3] : undefined }))
  })()
}

let last: PcScan | undefined

export function lastScan(): PcScan | undefined {
  return last
}

/** Look at this PC: CPU, memory, GPUs, disks, and what Maris's engines already have. */
export async function scanPc(): Promise<PcScan> {
  // Tests can stand in another PC (tests/e2e/setup-pcs.mjs) to check the assistant on other hardware.
  if (process.env.MARIS_FAKE_SCAN) {
    last = { ...(JSON.parse(readFileSync(process.env.MARIS_FAKE_SCAN, 'utf8')) as PcScan), ts: Date.now() }
    return last
  }
  const [raw, smi, ollamaVersion] = await Promise.all([IS_WIN ? windowsRaw() : posixRaw(), nvidiaSmi(), ollama.version()])
  const notes: string[] = []

  // ---- GPUs: nvidia-smi is exact for NVIDIA; the registry (Windows) or sysfs (Linux) has VRAM sizes for the others.
  const gpus: GpuInfo[] = []
  for (const n of smi) gpus.push(describeGpu(n))
  for (const g of raw.posixGpus ?? []) {
    if (IGNORE_GPU.test(g.name)) continue
    if (g.vendorId === '0x10de' && smi.length) continue
    if (g.vendorId === '0x10de') notes.push(`${g.name} needs the NVIDIA driver (with nvidia-smi) before Maris can use it.`)
    gpus.push(describeGpu(g))
  }
  const regGpus = (raw.gpus ?? []).filter((g) => g.name && !IGNORE_GPU.test(g.name))
  for (const g of regGpus) {
    const name = g.name!.trim()
    if (gpus.some((x) => x.name.toLowerCase() === name.toLowerCase() || (x.vendor === 'nvidia' && /nvidia|geforce|rtx|gtx/i.test(name)))) continue
    const vc = raw.vc?.find((v) => v.name?.trim().toLowerCase() === name.toLowerCase())
    const bytes = Math.max(Number(g.vram ?? 0), Number(vc?.ram ?? 0))
    gpus.push(describeGpu({ name, vramMB: bytes / 2 ** 20, driver: g.driver || vc?.driver }))
  }
  if (!gpus.length && IS_WIN) {
    for (const v of raw.vc ?? []) {
      if (!v.name || IGNORE_GPU.test(v.name)) continue
      gpus.push(describeGpu({ name: v.name, vramMB: Number(v.ram ?? 0) / 2 ** 20, driver: v.driver }))
    }
  }
  const dedicated = gpus.filter((g) => !g.integrated).sort((a, b) => b.vramMB - a.vramMB)
  const gpu = dedicated[0] ?? gpus.sort((a, b) => b.vramMB - a.vramMB)[0]
  if (IS_WIN && gpu?.vendor === 'nvidia' && !smi.length) notes.push('The NVIDIA driver tools (nvidia-smi) did not answer; VRAM comes from Windows instead.')
  if (IS_MAC && gpu && !gpu.unified) notes.push('Macs with Intel processors run language models on the CPU; image and video generation needs an Apple chip.')

  // ---- CPU and memory
  const cpus = os.cpus()
  const cpuName = (raw.cpu?.name || cpus[0]?.model || 'Unknown CPU').replace(/\s+/g, ' ').trim()
  const threads = raw.cpu?.threads || cpus.length
  const cores = raw.cpu?.cores || Math.max(1, Math.round(threads / 2))
  const old = /atom|celeron|pentium|core\(tm\)2|phenom|athlon ii|core\(tm\) i[357]-[2-3]\d{3}/i.test(cpuName)
  const avx512 = /ryzen.*\b(7|8|9)\d{3}|ryzen ai|epyc|threadripper (7|9)\d{3}|xeon|i[579]-1[01]\d{2}/i.test(cpuName)
  const smbios: Record<number, string> = { 24: 'DDR3', 26: 'DDR4', 34: 'DDR5', 35: 'LPDDR5' }
  const memType = raw.memTypeName || (typeof raw.mem?.type === 'number' ? smbios[raw.mem.type] : undefined)
  const speed = raw.mem?.speed || (/DDR5/i.test(memType ?? '') ? 5200 : memType === 'DDR4' ? 3200 : 2400)
  const channels = /^LPDDR/i.test(memType ?? '') ? 2 : Math.min(2, Math.max(1, raw.mem?.sticks ?? 2))
  // Apple chips: the CPU reaches roughly half of the chip's memory bandwidth.
  const bandwidthGBs = raw.appleBandwidthGBs ? Math.round(raw.appleBandwidthGBs * 0.5) : Math.round((speed * 8 * channels) / 1000)

  // ---- disks, engines
  const disks: DiskInfo[] = (raw.disks ?? [])
    .filter((d) => d.size > 0)
    .map((d) => ({ root: IS_WIN ? `${d.root}\\` : d.root, label: d.label || undefined, freeGB: d.free / 1e9, totalGB: d.size / 1e9, fs: d.fs || undefined }))
  let models: string[] = []
  if (ollamaVersion) models = await ollama.list().then((l) => l.map((m) => m.name)).catch(() => [])
  const modelsDir = ollama.modelsDir()

  last = {
    ts: Date.now(),
    platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
    os: raw.os || osDescription(),
    cpu: { name: cpuName, cores, threads, avx2: !old, avx512 },
    ram: { totalMB: Math.round(os.totalmem() / 2 ** 20), freeMB: Math.round(os.freemem() / 2 ** 20), speedMTs: raw.mem?.speed || undefined, type: memType, bandwidthGBs },
    gpus,
    gpu,
    disks,
    laptop: Boolean(raw.laptop),
    ollama: { installed: ollama.isInstalled() || Boolean(ollamaVersion), running: Boolean(ollamaVersion), version: ollamaVersion, models, modelsDir },
    comfy: { installed: comfy.isInstalled(), dir: comfy.root() },
    winget: IS_WIN && raw.winget !== false,
    brew: raw.brew,
    notes
  }
  log.info('scan', `${cpuName}, ${Math.round(last.ram.totalMB / 1024)} GB RAM, GPU: ${gpu ? `${gpu.name} ${Math.round(gpu.vramMB / 1024)} GB (${gpu.llm}/${gpu.comfy})` : 'none'}`)
  return last
}
