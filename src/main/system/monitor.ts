import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { powerMonitor } from 'electron'
import type { BusyLevel, GpuStatus, SystemStatus } from '@shared/types'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { Emitter, log } from '../util'
import { parseIoreg } from './posixParse'

export interface ComfyProbe {
  up: boolean
  installed: boolean
  busy: boolean
  queue: number
  starting: boolean
  vramMB: number
  activeJobs: number
  job?: { model?: string; kind: 'image' | 'video'; etaSec?: number }
}

class SystemMonitor {
  readonly changed = new Emitter<SystemStatus>()
  private gpu?: GpuStatus
  private smi?: ChildProcess
  private timer?: NodeJS.Timeout
  private prevCpu = os.cpus()
  private extUtil = 0
  private lastMediaAt = 0
  private ollamaVersion?: string
  private comfyProbe: () => Promise<ComfyProbe> = async () => ({
    up: false,
    installed: false,
    busy: false,
    queue: 0,
    starting: false,
    vramMB: 0,
    activeJobs: 0
  })
  private last: SystemStatus = {
    ts: Date.now(),
    cpuLoad: 0,
    ramUsedMB: 0,
    ramTotalMB: Math.round(os.totalmem() / 2 ** 20),
    onBattery: false,
    ollama: { up: false, loaded: [] },
    comfy: { up: false, installed: false, busy: false, queue: 0, starting: false },
    external: { gpuUtil: 0, vramMB: 0 },
    busy: 'idle',
    activeJobs: { llm: 0, media: 0 }
  }

  setComfyProbe(fn: () => Promise<ComfyProbe>): void {
    this.comfyProbe = fn
  }

  snapshot(): SystemStatus {
    return this.last
  }

  /** Restart sampling at a new interval (Settings → Advanced). */
  restart(intervalMs: number): void {
    this.stop()
    this.smi?.removeAllListeners('exit')
    this.smi = undefined
    this.start(intervalMs)
  }

  start(intervalMs = 2000): void {
    this.stopped = false
    this.startSmi(intervalMs)
    const tick = async (): Promise<void> => {
      try {
        this.last = await this.sample()
        this.changed.emit(this.last)
      } catch (e) {
        log.warn('monitor', e)
      }
    }
    void tick()
    this.timer = setInterval(tick, intervalMs)
  }

  private stopped = false

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const p of [this.smi, this.counters]) {
      p?.removeAllListeners('exit')
      p?.kill()
    }
    this.smi = undefined
    this.counters = undefined
    if (this.posixTimer) clearInterval(this.posixTimer)
    this.posixTimer = undefined
  }

  /** GPU readings without nvidia-smi: Windows performance counters, Linux sysfs or macOS IOKit. */
  private startFallback(intervalMs: number): void {
    if (process.platform === 'win32') this.startCounters(intervalMs)
    else this.startPosixGpu(intervalMs)
  }

  private posixTimer?: NodeJS.Timeout

  /**
   * Linux (AMD amdgpu): gpu_busy_percent and VRAM from sysfs. macOS: "Device Utilization %" and
   * GPU memory in use from `ioreg`, which needs no administrator rights. Other GPUs show no live load.
   */
  private startPosixGpu(intervalMs: number): void {
    if (this.stopped || this.posixTimer) return
    let info: { name: string; totalMB: number } | undefined
    void import('./scan')
      .then(async (m) => m.lastScan() ?? (await m.scanPc()))
      .then((s) => {
        if (s.gpu) info = { name: s.gpu.name, totalMB: s.gpu.vramMB }
      })
      .catch(() => undefined)
    const num = (f: string): number | undefined => {
      try {
        const n = Number(readFileSync(f, 'utf8').trim())
        return Number.isFinite(n) ? n : undefined
      } catch {
        return undefined
      }
    }
    if (process.platform === 'darwin') {
      const poll = (): void => {
        execFile('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (_err, out) => {
          const r = parseIoreg(String(out ?? ''))
          if (!r) return
          this.gpu = { name: info?.name ?? 'GPU', utilization: r.util, memUsedMB: Math.round(r.usedBytes / 2 ** 20), memTotalMB: info?.totalMB ?? 0 }
        })
      }
      poll()
      this.posixTimer = setInterval(poll, intervalMs)
      return
    }
    // Linux: the first card whose driver reports a busy percentage (amdgpu does).
    let dev: string | undefined
    try {
      dev = readdirSync('/sys/class/drm')
        .filter((n) => /^card\d+$/.test(n))
        .map((n) => path.join('/sys/class/drm', n, 'device'))
        .find((d) => existsSync(path.join(d, 'gpu_busy_percent')))
    } catch {
      dev = undefined
    }
    if (!dev) return
    let hwmon: string | undefined
    try {
      const h = path.join(dev, 'hwmon')
      hwmon = readdirSync(h).map((n) => path.join(h, n))[0]
    } catch {
      hwmon = undefined
    }
    const poll = (): void => {
      const used = num(path.join(dev!, 'mem_info_vram_used')) ?? 0
      const total = num(path.join(dev!, 'mem_info_vram_total')) ?? (info?.totalMB ?? 0) * 2 ** 20
      const temp = hwmon ? num(path.join(hwmon, 'temp1_input')) : undefined
      const power = hwmon ? (num(path.join(hwmon, 'power1_average')) ?? num(path.join(hwmon, 'power1_input'))) : undefined
      this.gpu = {
        name: info?.name ?? 'GPU',
        utilization: num(path.join(dev!, 'gpu_busy_percent')) ?? 0,
        memUsedMB: Math.round(used / 2 ** 20),
        memTotalMB: Math.round(total / 2 ** 20),
        temperatureC: temp !== undefined ? Math.round(temp / 1000) : undefined,
        powerW: power !== undefined ? Math.round(power / 1e6) : undefined
      }
    }
    poll()
    this.posixTimer = setInterval(poll, intervalMs)
  }

  private startSmi(intervalMs: number): void {
    if (this.stopped) return
    try {
      const p = spawn(
        'nvidia-smi',
        [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
          '--format=csv,noheader,nounits',
          `-lms`,
          String(intervalMs)
        ],
        { windowsHide: true }
      )
      this.smi = p
      let buf = ''
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const [name, util, used, total, temp, power] = line.split(',').map((s) => s.trim())
          const num = (s?: string): number | undefined => {
            const n = Number(s)
            return Number.isFinite(n) ? n : undefined
          }
          this.gpu = {
            name,
            utilization: num(util) ?? 0,
            memUsedMB: num(used) ?? 0,
            memTotalMB: num(total) ?? 0,
            temperatureC: num(temp),
            powerW: num(power)
          }
        }
      })
      let gotData = false
      p.stdout.once('data', () => (gotData = true))
      p.on('error', () => {
        this.smi = undefined
        // No NVIDIA driver tools: read the system's own GPU counters instead.
        this.startFallback(intervalMs)
      })
      p.on('exit', () => {
        this.smi = undefined
        if (!gotData && !this.gpu) this.startFallback(intervalMs)
        // Retry later; the driver may be updating.
        else setTimeout(() => this.startSmi(intervalMs), 15000)
      })
    } catch {
      this.startFallback(intervalMs)
    }
  }

  private counters?: ChildProcess
  private counterGpu?: { name: string; totalMB: number }

  /**
   * GPU load and VRAM from Windows performance counters via typeperf, for GPUs without nvidia-smi.
   * Per-process engine counters are fixed when typeperf starts, so it restarts every minute to see new apps.
   */
  private startCounters(intervalMs: number): void {
    if (this.stopped || this.counters) return
    if (!this.counterGpu) {
      void import('./scan')
        .then(async (m) => m.lastScan() ?? (await m.scanPc()))
        .then((s) => {
          if (s.gpu) this.counterGpu = { name: s.gpu.name, totalMB: s.gpu.vramMB }
        })
        .catch(() => undefined)
    }
    try {
      const sec = String(Math.max(1, Math.round(intervalMs / 1000)))
      const p = spawn('typeperf', ['\\GPU Engine(*engtype_3D)\\Utilization Percentage', '\\GPU Adapter Memory(*)\\Dedicated Usage', '-si', sec], { windowsHide: true })
      this.counters = p
      let header: string[] | undefined
      let buf = ''
      const cells = (line: string): string[] => line.replace(/^"|"$/g, '').split('","')
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('"')) continue
          const row = cells(line)
          if (!header) {
            header = row
            continue
          }
          let util = 0
          let usedBytes = 0
          row.forEach((v, i) => {
            const n = Number(v)
            if (!Number.isFinite(n) || i === 0) return
            const h = header?.[i] ?? ''
            if (/Utilization Percentage/i.test(h)) util += n
            else if (/Dedicated Usage/i.test(h)) usedBytes = Math.max(usedBytes, n)
          })
          this.gpu = {
            name: this.counterGpu?.name ?? 'GPU',
            utilization: Math.round(Math.min(100, util)),
            memUsedMB: Math.round(usedBytes / 2 ** 20),
            memTotalMB: this.counterGpu?.totalMB ?? 0
          }
        }
      })
      const refresh = setTimeout(() => p.kill(), 60000)
      p.on('error', () => clearTimeout(refresh))
      p.on('exit', () => {
        clearTimeout(refresh)
        this.counters = undefined
        if (!this.stopped) setTimeout(() => this.startCounters(intervalMs), 500)
      })
    } catch (e) {
      log.warn('monitor', 'GPU counters unavailable', e)
    }
  }

  private cpuLoad(): number {
    const cur = os.cpus()
    let idle = 0
    let total = 0
    cur.forEach((c, i) => {
      const p = this.prevCpu[i]
      if (!p) return
      const t = (k: keyof typeof c.times): number => c.times[k] - p.times[k]
      const tot = t('user') + t('nice') + t('sys') + t('idle') + t('irq')
      idle += t('idle')
      total += tot
    })
    this.prevCpu = cur
    return total > 0 ? 1 - idle / total : 0
  }

  private async sample(): Promise<SystemStatus> {
    const [loaded, comfy] = await Promise.all([ollama.ps(), this.comfyProbe().catch(() => undefined)])
    if (!this.ollamaVersion || loaded.length === 0) this.ollamaVersion = await ollama.version()
    const up = Boolean(this.ollamaVersion)
    const cpu = this.cpuLoad()
    const gpu = this.gpu
    const ourVramMB = loaded.reduce((s, m) => s + m.vramBytes, 0) / 2 ** 20 + (comfy?.vramMB ?? 0)
    const llmActive = ollama.activeCalls
    const mediaActive = comfy?.activeJobs ?? 0
    // GPU utilisation can only be attributed to other programs while our engines are idle
    // (and a few seconds after, because nvidia-smi readings lag behind).
    if (mediaActive || comfy?.busy) this.lastMediaAt = Date.now()
    const quiet = Date.now() - Math.max(ollama.lastActiveAt, this.lastMediaAt) > 6000
    if (gpu && llmActive === 0 && mediaActive === 0 && !comfy?.busy && quiet) {
      this.extUtil = this.extUtil * 0.5 + gpu.utilization * 0.5
    }
    const extVram = gpu ? Math.max(0, gpu.memUsedMB - ourVramMB) : 0
    const busy = this.level(this.extUtil, extVram, cpu)
    let onBattery = false
    try {
      onBattery = powerMonitor.isOnBatteryPower()
    } catch {
      /* not ready */
    }
    return {
      ts: Date.now(),
      gpu,
      cpuLoad: cpu,
      ramUsedMB: Math.round((os.totalmem() - os.freemem()) / 2 ** 20),
      ramTotalMB: Math.round(os.totalmem() / 2 ** 20),
      onBattery,
      ollama: { up, version: this.ollamaVersion, loaded },
      comfy: {
        up: comfy?.up ?? false,
        installed: comfy?.installed ?? false,
        busy: comfy?.busy ?? false,
        queue: comfy?.queue ?? 0,
        starting: comfy?.starting ?? false,
        job: comfy?.job
      },
      external: { gpuUtil: Math.round(this.extUtil), vramMB: Math.round(extVram) },
      busy,
      activeJobs: { llm: llmActive, media: mediaActive }
    }
  }

  /** Thresholds come from Settings → Auto model choice ("counts as heavy load"). */
  private level(extUtil: number, extVramMB: number, cpu: number): BusyLevel {
    const r = settings.get().routing
    const gpuPct = Math.max(5, r.busyGpuPercent)
    const vram = Math.max(1, r.busyVramGB) * 1024
    if (extUtil >= gpuPct || extVramMB >= vram || cpu >= 0.92) return 'heavy'
    if (extUtil >= gpuPct / 2 || extVramMB >= vram * 0.67 || cpu >= 0.75) return 'busy'
    if (extUtil >= gpuPct / 6 || cpu >= 0.45) return 'light'
    return 'idle'
  }
}

export const monitor = new SystemMonitor()
