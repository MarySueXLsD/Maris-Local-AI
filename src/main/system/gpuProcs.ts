import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GpuProgramList } from '@shared/types'
import { comfy } from '../media/comfy'
import { runPowerShell } from '../tools/shell'
import { log } from '../util'
import { groupGpuPrograms, parseSmiProcesses, type ProcRow, type RawProc } from './gpuPure'

/**
 * Which programs use the graphics card's memory, for the status bar's VRAM details, and ending one of
 * them when the person confirms it there. Nothing here runs on its own: only on hover and on that click.
 */

interface Reading {
  memMB: Map<number, number>
  procs: Map<number, RawProc>
  mySession?: number
  /** Every process (number, parent, name, start), to say what else ends with a program. */
  all?: ProcRow[]
}

const run = (file: string, args: string[], timeout = 15000): Promise<{ code: number; out: string }> =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` })
    )
  )

// ---------------------------------------------------------------- Windows

/**
 * Per-process video memory comes from the same counters Task Manager shows (through CIM, so it works
 * whatever the language of Windows); processes and their parents from Win32_Process. Only processes
 * with some video memory, and their parents, are written out.
 */
const WIN_PS = (out: string): string => `
$mem = @{}
foreach ($r in Get-CimInstance -ClassName Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop) {
  if ($r.Name -match '^pid_(\\d+)_') { $p = [int]$Matches[1]; $mem[$p] = [int64]$mem[$p] + [int64]$r.DedicatedUsage }
}
$all = @{}
foreach ($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,SessionId,CreationDate) { $all[[int]$p.ProcessId] = $p }
$want = @{}
foreach ($k in @($mem.Keys)) {
  if ($mem[$k] -lt 16MB) { continue }
  $id = $k; $n = 0
  while ($all.ContainsKey($id) -and -not $want.ContainsKey($id) -and $n -lt 12) { $want[$id] = $true; $id = [int]$all[$id].ParentProcessId; $n++ }
}
$procs = foreach ($id in @($want.Keys)) {
  $p = $all[$id]; $desc = $null
  if ($p.ExecutablePath) { try { $desc = [Diagnostics.FileVersionInfo]::GetVersionInfo($p.ExecutablePath).FileDescription } catch {} }
  $cmd = $p.CommandLine; if ($cmd -and $cmd.Length -gt 600) { $cmd = $cmd.Substring(0, 600) }
  [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; path = $p.ExecutablePath; cmd = $cmd; session = [int]$p.SessionId; description = $desc }
}
$memList = foreach ($k in @($mem.Keys)) { if ($mem[$k] -ge 16MB) { [pscustomobject]@{ pid = [int]$k; bytes = [int64]$mem[$k] } } }
$table = foreach ($p in @($all.Values)) {
  $c = 0; if ($p.CreationDate) { $c = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }
  [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; created = $c }
}
$res = [pscustomobject]@{ session = [int](Get-Process -Id $PID).SessionId; mem = @($memList); procs = @($procs); all = @($table) }
[IO.File]::WriteAllText('${out.replace(/'/g, "''")}', ($res | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding $false))
`

async function readWindows(): Promise<Reading> {
  const out = path.join(os.tmpdir(), `maris-gpu-${randomUUID()}.json`)
  try {
    const r = await runPowerShell(WIN_PS(out), { timeoutMs: 45000 })
    let raw: { session?: number; mem?: { pid: number; bytes: number }[]; procs?: RawProc[]; all?: ProcRow[] }
    try {
      raw = JSON.parse(readFileSync(out, 'utf8').replace(/^﻿/, '')) as typeof raw
    } catch {
      throw new Error(r.timedOut ? 'Windows took too long to answer.' : `Windows did not list them${r.stdout.trim() ? `: ${r.stdout.trim().split(/\r?\n/)[0]!.slice(0, 160)}` : '.'}`)
    }
    return {
      memMB: new Map((raw.mem ?? []).map((m) => [m.pid, m.bytes / 2 ** 20])),
      procs: new Map((raw.procs ?? []).map((p) => [p.pid, { ...p, path: p.path ?? undefined, cmd: p.cmd ?? undefined, description: p.description ?? undefined }])),
      mySession: raw.session,
      all: raw.all
    }
  } finally {
    rmSync(out, { force: true })
  }
}

/** The program file of a running process, or undefined when there is no such process. */
async function windowsName(pid: number): Promise<string | undefined> {
  const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 10000)
  const m = /^"([^"]+)","(\d+)"/m.exec(r.out)
  return m && Number(m[2]) === pid ? m[1] : undefined
}

// ---------------------------------------------------------------- Linux

function procInfo(pid: number): RawProc | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name is in parentheses and may itself contain spaces or parentheses.
    const close = stat.lastIndexOf(')')
    const name = stat.slice(stat.indexOf('(') + 1, close)
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    let cmd: string | undefined
    let exe: string | undefined
    let uid: number | undefined
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 600) || undefined
    } catch {
      /* gone or hidden */
    }
    try {
      exe = readlinkSync(`/proc/${pid}/exe`)
    } catch {
      /* another user's process */
    }
    try {
      uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1])
    } catch {
      /* gone */
    }
    return { pid, ppid, name, path: exe, cmd, session: Number.isFinite(uid) ? uid : undefined }
  } catch {
    return undefined
  }
}

async function readLinux(): Promise<Reading | undefined> {
  const r = await run('nvidia-smi', [], 10000)
  if (r.code !== 0 && !/Processes:/.test(r.out)) return undefined
  const rows = parseSmiProcesses(r.out)
  const memMB = new Map<number, number>()
  for (const x of rows) memMB.set(x.pid, (memMB.get(x.pid) ?? 0) + x.mb)
  const procs = new Map<number, RawProc>()
  for (const pid of memMB.keys()) {
    let id = pid
    for (let n = 0; n < 12 && id > 0 && !procs.has(id); n++) {
      const p = procInfo(id)
      if (!p) break
      procs.set(id, p)
      id = p.ppid
    }
  }
  return { memMB, procs, mySession: process.getuid?.(), all: procTable() }
}

/** Every process: number, parent, command name and start time (clock ticks after boot). */
function procTable(): ProcRow[] {
  const out: ProcRow[] = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const f = stat.slice(close + 2).split(' ')
      out.push({ pid: Number(d), ppid: Number(f[1]), name: stat.slice(stat.indexOf('(') + 1, close), created: Number(f[19]) || 0 })
    } catch {
      /* ended meanwhile */
    }
  }
  return out
}

function childrenOf(pid: number): number[] {
  const all = procTable()
  const out: number[] = []
  const queue = [pid]
  while (queue.length) {
    const cur = queue.shift()!
    for (const p of all) {
      if (p.ppid !== cur || out.includes(p.pid)) continue
      out.push(p.pid)
      queue.push(p.pid)
    }
  }
  return out
}

// ---------------------------------------------------------------- tests

/**
 * Tests: MARIS_TEST_GPU_PROGRAMS names a JSON file with the reading to use instead of the system's
 * ({ session, mem: [{ pid, bytes }], procs: [RawProc] }), so a test can list and end a process it started.
 */
function readFixture(file: string): Reading {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { session?: number; mem?: { pid: number; bytes: number }[]; procs?: RawProc[]; all?: ProcRow[] }
  return {
    memMB: new Map((raw.mem ?? []).map((m) => [m.pid, m.bytes / 2 ** 20])),
    procs: new Map((raw.procs ?? []).map((p) => [p.pid, p])),
    mySession: raw.session,
    all: raw.all
  }
}

// ---------------------------------------------------------------- both

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class GpuPrograms {
  private cached?: { at: number; value: GpuProgramList }
  private pending?: Promise<GpuProgramList>
  /** Programs listed recently: only these may be ended, and only while they are still the same program. */
  private listed = new Map<number, { exe: string; at: number }>()

  list(): Promise<GpuProgramList> {
    if (this.cached && Date.now() - this.cached.at < 4000) return Promise.resolve(this.cached.value)
    this.pending ??= this.read().finally(() => (this.pending = undefined))
    return this.pending
  }

  private async read(): Promise<GpuProgramList> {
    const ts = Date.now()
    const fixture = process.env.MARIS_TEST_GPU_PROGRAMS
    if (process.platform === 'darwin' && !fixture) return { supported: false, programs: [], system: { vramMB: 0, names: [] }, ts }
    try {
      const r = fixture ? readFixture(fixture) : process.platform === 'win32' ? await readWindows() : await readLinux()
      if (!r) return { supported: false, programs: [], system: { vramMB: 0, names: [] }, ts }
      const ownPids = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)])
      const own = comfy.pid()
      const g = groupGpuPrograms(r.memMB, r.procs, {
        ownPids,
        mySession: r.mySession,
        enginePaths: [comfy.python()],
        enginePids: own ? [own] : [],
        platform: process.platform
      }, r.all)
      for (const p of g.programs) this.listed.set(p.pid, { exe: p.exe, at: ts })
      for (const [pid, v] of this.listed) if (ts - v.at > 10 * 60_000) this.listed.delete(pid)
      const value: GpuProgramList = { supported: true, programs: g.programs, system: g.system, ts }
      this.cached = { at: Date.now(), value }
      return value
    } catch (e) {
      log.warn('gpu-programs', e)
      return { supported: true, programs: [], system: { vramMB: 0, names: [] }, error: (e as Error).message, ts }
    }
  }

  /**
   * End a program the list showed, with its helper processes (only from the person's confirmed click).
   * Like End task in Task Manager: it closes at once, without a chance to save.
   */
  async end(pid: number): Promise<void> {
    const known = this.listed.get(pid)
    if (!Number.isInteger(pid) || pid <= 4 || !known) throw new Error('That program is not in the list any more. Point at VRAM again to see what is running now.')
    if (pid === process.pid || app.getAppMetrics().some((m) => m.pid === pid)) throw new Error('That is Maris itself.')
    this.cached = undefined
    if (process.platform === 'win32') {
      const now = await windowsName(pid)
      if (!now) return // it already ended
      // A process number can be reused by a new program once the old one ends.
      if (now.toLowerCase() !== known.exe.toLowerCase()) throw new Error(`${known.exe} has already ended.`)
      const r = await run('taskkill', ['/PID', String(pid), '/T', '/F'], 20000)
      for (let i = 0; i < 10 && alive(pid); i++) await sleep(200)
      if (alive(pid)) {
        log.warn('gpu-programs', `taskkill ${pid}: ${r.out.trim()}`)
        throw new Error(/denied/i.test(r.out) ? `Windows did not let Maris end ${known.exe}: it runs with administrator rights. End it from Task Manager instead.` : `${known.exe} did not end: ${r.out.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? `exit code ${r.code}`}`)
      }
      log.info('gpu-programs', `ended ${known.exe} (${pid}) from the VRAM details`)
      return
    }
    const p = procInfo(pid)
    if (!p) return
    if (p.name !== known.exe) throw new Error(`${known.exe} has already ended.`)
    const tree = [...childrenOf(pid).reverse(), pid]
    for (const id of tree) {
      try {
        process.kill(id, 'SIGTERM')
      } catch {
        /* gone, or not ours */
      }
    }
    for (let i = 0; i < 15 && alive(pid); i++) await sleep(200)
    for (const id of tree) {
      if (!alive(id)) continue
      try {
        process.kill(id, 'SIGKILL')
      } catch {
        /* not ours */
      }
    }
    await sleep(200)
    if (alive(pid)) throw new Error(`Maris may not end ${known.exe}: it belongs to another user. Use your system monitor with administrator rights.`)
    log.info('gpu-programs', `ended ${known.exe} (${pid}) from the VRAM details`)
  }
}

export const gpuPrograms = new GpuPrograms()
