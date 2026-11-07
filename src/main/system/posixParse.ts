// Parsers for macOS and Linux system tools. Pure functions without imports, so the unit tests can
// run them on any system with sample output.
import path from 'node:path'

export interface PosixGpu {
  name: string
  vramMB: number
  driver?: string
  cores?: number
  /** PCI vendor id, e.g. 0x10de for NVIDIA. */
  vendorId?: string
}

/** Physical cores from /proc/cpuinfo (unique physical id + core id pairs). */
export function parseCpuinfo(text: string): { name?: string; cores?: number } {
  const pairs = new Set<string>()
  let name: string | undefined
  let phys = '0'
  for (const line of text.split('\n')) {
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, v] = m
    if (k === 'model name' && !name) name = v.trim()
    else if (k === 'physical id') phys = v.trim()
    else if (k === 'core id') pairs.add(`${phys}:${v.trim()}`)
  }
  return { name, cores: pairs.size || undefined }
}

/** Memory type, speed and stick count from `udevadm info` on the DMI device (systemd 248+). */
export function parseUdevMemory(text: string): { type?: string; speed?: number; sticks?: number } {
  const dev = new Map<string, Record<string, string>>()
  for (const line of text.split('\n')) {
    const m = /MEMORY_DEVICE_(\d+)_([A-Z_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    const d = dev.get(m[1]) ?? {}
    d[m[2]] = m[3].trim()
    dev.set(m[1], d)
  }
  const sticks = [...dev.values()].filter((d) => Number(d.SIZE ?? 0) > 0)
  if (!sticks.length) return {}
  const type = sticks.map((d) => d.TYPE).find((t) => t && !/unknown|other/i.test(t))
  const speed = Math.max(0, ...sticks.map((d) => Number(d.CONFIGURED_SPEED_MTS || d.SPEED_MTS || 0)))
  return { type, speed: speed || undefined, sticks: sticks.length }
}

/** `lspci -mm` line → device name, preferring the marketing name in brackets. */
export function parseLspciName(line: string): string | undefined {
  // 03:00.0 "VGA compatible controller" "NVIDIA Corporation" "AD104 [GeForce RTX 4070]" -r00 "Gigabyte" "Device 40c6"
  const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  if (cells.length < 3) return undefined
  const vendor = cells[1]
  const device = cells[2]
  const bracket = /\[([^\]]+)\]/.exec(device)?.[1]
  // Several models share a chip: "Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M" — keep the first.
  const model = (bracket ?? device).split('/')[0].trim()
  const brand = /nvidia/i.test(vendor) ? 'NVIDIA' : /amd|ati/i.test(vendor) ? 'AMD' : /intel/i.test(vendor) ? 'Intel' : vendor.split(/\s/)[0]
  return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`
}

/** Mount points from `df -kP`, without system and virtual file systems. */
export function parseDf(text: string, mac: boolean): { root: string; free: number; size: number; label?: string }[] {
  const out: { root: string; free: number; size: number; label?: string }[] = []
  for (const line of text.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/)
    if (c.length < 6 || !c[0].startsWith('/dev/')) continue
    const mount = c.slice(5).join(' ')
    if (/^\/(boot|efi|snap|sys|proc|run|dev)\b/.test(mount)) continue
    if (mac && mount !== '/' && !mount.startsWith('/Volumes/')) continue
    const size = Number(c[1]) * 1024
    if (!(size > 2e9)) continue
    out.push({ root: mount, free: Number(c[3]) * 1024, size, label: mac ? (mount === '/' ? 'Macintosh HD' : path.basename(mount)) : undefined })
  }
  return out
}

interface SpDisplay {
  sppci_model?: string
  sppci_cores?: string
  spdisplays_vram?: string
  spdisplays_vram_shared?: string
  sppci_vendor?: string
  spdisplays_vendor?: string
}

/** GPUs from `system_profiler SPDisplaysDataType -json`. Apple chips get `budgetMB`, their unified-memory share. */
export function parseMacDisplays(json: string, budgetMB: number): PosixGpu[] {
  let data: { SPDisplaysDataType?: SpDisplay[] } = {}
  try {
    data = JSON.parse(json) as typeof data
  } catch {
    return []
  }
  const sizeMB = (s?: string): number => {
    const m = /([\d.]+)\s*(GB|MB)/i.exec(s ?? '')
    return m ? Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : 1) : 0
  }
  return (data.SPDisplaysDataType ?? [])
    .filter((d) => d.sppci_model)
    .map((d) => {
      const name = d.sppci_model!.trim()
      const apple = /^apple\b/i.test(name)
      return {
        name,
        vramMB: apple ? budgetMB : sizeMB(d.spdisplays_vram) || sizeMB(d.spdisplays_vram_shared),
        cores: Number(d.sppci_cores) || undefined
      }
    })
}

/** Laptop or desktop, and memory type, from `system_profiler SPHardwareDataType SPMemoryDataType -json`. */
export function parseMacHardware(json: string): { laptop: boolean; memType?: string } {
  try {
    const d = JSON.parse(json) as { SPHardwareDataType?: { machine_name?: string }[]; SPMemoryDataType?: { dimm_type?: string; _items?: { dimm_type?: string }[] }[] }
    const machine = d.SPHardwareDataType?.[0]?.machine_name ?? ''
    const mem = d.SPMemoryDataType?.[0]
    const memType = mem?.dimm_type ?? mem?._items?.find((i) => i.dimm_type && !/empty/i.test(i.dimm_type))?.dimm_type
    return { laptop: /macbook/i.test(machine), memType: memType || undefined }
  } catch {
    return { laptop: false }
  }
}

/** "Device Utilization %" and used memory from `ioreg -r -d 1 -w 0 -c IOAccelerator`. */
export function parseIoreg(text: string): { util: number; usedBytes: number } | undefined {
  const util = /"Device Utilization %"\s*=\s*(\d+)/.exec(text)
  if (!util) return undefined
  const used = /"In use system memory"\s*=\s*(\d+)/.exec(text) ?? /"vramUsedBytes"\s*=\s*(\d+)/.exec(text)
  return { util: Number(util[1]), usedBytes: used ? Number(used[1]) : 0 }
}

