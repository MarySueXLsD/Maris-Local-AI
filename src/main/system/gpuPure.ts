import type { GpuProgram } from '@shared/types'

/** A process as the system lists it. */
export interface RawProc {
  pid: number
  ppid: number
  /** File name with extension on Windows (chrome.exe), the command name on Linux. */
  name: string
  path?: string
  cmd?: string
  /** Windows session (0 = services); on Linux, the user id. */
  session?: number
  /** The program's own description of itself (FileDescription on Windows). */
  description?: string
}

/** One row of the whole process table: enough to know what a program started. */
export interface ProcRow {
  pid: number
  ppid: number
  name: string
  /** When it started (any clock, the same for all rows); 0 when unknown. */
  created?: number
}

/** Processes every program has around it, not worth naming. */
const NOISE = new Set(['conhost.exe', 'crashpad_handler.exe', 'crashpad_handler', 'werfault.exe', 'openconsole.exe'])

/**
 * The other programs that end together with a program's main process (its process tree), by file name.
 * A "child" that started before its parent belongs to an earlier process whose number was reused, so it
 * is left out, as are helpers with the program's own name.
 */
export function alsoEndsFor(rootPid: number, all: ProcRow[]): string[] {
  const byPid = new Map(all.map((r) => [r.pid, r]))
  const root = byPid.get(rootPid)
  if (!root) return []
  const kids = new Map<number, ProcRow[]>()
  for (const r of all) {
    if (r.pid === r.ppid) continue
    const list = kids.get(r.ppid) ?? []
    list.push(r)
    kids.set(r.ppid, list)
  }
  const names = new Map<string, string>()
  const seen = new Set([rootPid])
  const queue = [root]
  while (queue.length) {
    const cur = queue.shift()!
    for (const k of kids.get(cur.pid) ?? []) {
      if (seen.has(k.pid)) continue
      if (cur.created && k.created && k.created < cur.created) continue
      seen.add(k.pid)
      queue.push(k)
      const n = lower(k.name)
      if (n !== lower(root.name) && !NOISE.has(n)) names.set(n, k.name)
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}

export interface GroupOptions {
  /** Maris's own processes (its windows and helpers). */
  ownPids: Set<number>
  /** The session (Windows) or user id (Linux) Maris runs in: other sessions belong to the system. */
  mySession?: number
  /** Program files of Maris's engines (ComfyUI's Python): they count as Maris. */
  enginePaths?: string[]
  /** Engine processes Maris started. */
  enginePids?: number[]
  platform: NodeJS.Platform
}

export interface Grouped {
  programs: GpuProgram[]
  system: { vramMB: number; names: string[] }
  /** Video memory of Maris itself (its window, Ollama's model runners, ComfyUI). */
  marisMB: number
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/** Parts of Windows and of graphics drivers: ending them logs you out, blanks the screen or does nothing useful. */
const SYSTEM_WIN = new Set(
  [
    'system',
    'registry',
    'idle',
    'system idle process',
    'secure system',
    'memory compression',
    'smss.exe',
    'csrss.exe',
    'wininit.exe',
    'winlogon.exe',
    'services.exe',
    'lsass.exe',
    'svchost.exe',
    'dwm.exe',
    'explorer.exe',
    'fontdrvhost.exe',
    'sihost.exe',
    'ctfmon.exe',
    'dllhost.exe',
    'audiodg.exe',
    'runtimebroker.exe',
    'applicationframehost.exe',
    'shellexperiencehost.exe',
    'shellhost.exe',
    'startmenuexperiencehost.exe',
    'searchhost.exe',
    'searchapp.exe',
    'textinputhost.exe',
    'lockapp.exe',
    'logonui.exe',
    'widgets.exe',
    'widgetservice.exe',
    'nvcontainer.exe',
    'nvdisplay.container.exe',
    'atiesrxx.exe',
    'atieclxx.exe',
    'igfxem.exe'
  ].map(lower)
)

/** Desktop shells and display servers on Linux: ending them ends the session. */
const SYSTEM_LINUX = new Set(['xorg', 'xwayland', 'gnome-shell', 'kwin_x11', 'kwin_wayland', 'kwin', 'mutter', 'plasmashell', 'sway', 'hyprland', 'weston', 'gdm', 'gdm-x-session', 'gdm-wayland-session', 'sddm', 'lightdm', 'cinnamon', 'xfwm4', 'marco', 'muffin', 'gamescope'])

/** Helpers that belong to whichever app embeds them (a web view inside Teams, for example). */
const HOSTED = new Set(['msedgewebview2.exe', 'qtwebengineprocess.exe', 'qtwebengineprocess', 'cefsharp.browsersubprocess.exe', 'webkitwebprocess', 'webkitnetworkprocess'])

/** Runtimes that run many different programs: the script tells them apart. */
const RUNTIMES = /^(python[\d.]*w?|py|node|deno|bun|java|javaw|ruby|perl|php|rscript|julia|dotnet|pwsh|powershell|cmd|wscript|cscript|bash|sh|zsh|lua|blender)(\.exe)?$/i

function isOllama(name: string): boolean {
  return /^ollama( app)?(\.exe)?$/i.test(name)
}

/** The process and its parents, nearest first (stops at loops and after a few levels). */
function chain(pid: number, procs: Map<number, RawProc>, max = 12): RawProc[] {
  const out: RawProc[] = []
  const seen = new Set<number>()
  let p = procs.get(pid)
  while (p && !seen.has(p.pid) && out.length < max) {
    out.push(p)
    seen.add(p.pid)
    // A parent id can be reused by an unrelated process that started later; such a "parent" is not one.
    p = p.ppid && p.ppid !== p.pid ? procs.get(p.ppid) : undefined
  }
  return out
}

/** True for processes that are part of the system rather than programs a person runs. */
export function isSystemProcess(p: RawProc, opts: Pick<GroupOptions, 'mySession' | 'platform'>): boolean {
  const n = lower(p.name)
  if (opts.platform === 'win32') {
    if (SYSTEM_WIN.has(n)) return true
    if (p.session === 0) return true
    if (opts.mySession !== undefined && p.session !== undefined && p.session !== opts.mySession) return true
    const path = lower(p.path)
    if (/^[a-z]:\\windows\\(system32|syswow64|systemapps)\\/.test(path)) return true
    return false
  }
  if (SYSTEM_LINUX.has(n)) return true
  // Another user's processes (including root's) are not this person's to end.
  return opts.mySession !== undefined && p.session !== undefined && p.session !== opts.mySession
}

/** What a runtime runs: "gen_pistol.py" for "python.exe -u gen_pistol.py --seed 4". */
export function scriptOf(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined
  const parts = cmd.match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? []
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i]!
    if (a === '-m' && parts[i + 1]) return `-m ${parts[i + 1]}`
    if (a === '-jar' && parts[i + 1]) return parts[i + 1]!.split(/[\\/]/).pop()
    if (a.startsWith('-')) continue
    if (/\.(py|pyw|js|mjs|cjs|ts|jar|rb|pl|php|ps1|bat|cmd|sh|lua|r|jl|blend)$/i.test(a)) return a.split(/[\\/]/).pop()
  }
  return undefined
}

/** A short name for a program: its description when it has a sensible one, else its file name. */
export function displayName(p: RawProc): string {
  const d = (p.description ?? '').trim()
  const stem = p.name.replace(/\.exe$/i, '')
  // Some programs describe themselves with a whole sentence or a version string; the file name reads better then.
  if (d && d.length <= 40 && !/^\d/.test(d) && !/^(n\/a|none|-)$/i.test(d)) return d
  return stem
}

/**
 * Group per-process video memory into programs: a browser's GPU helper counts toward the browser, a web
 * view toward the app that shows it. Maris's own processes and the system's are kept out of the list.
 * memMB maps a process id to its video memory in MB.
 */
export function groupGpuPrograms(memMB: Map<number, number>, procs: Map<number, RawProc>, opts: GroupOptions, all?: ProcRow[]): Grouped {
  const engines = (opts.enginePaths ?? []).map(lower).filter(Boolean)
  const enginePids = new Set(opts.enginePids ?? [])
  const groups = new Map<number, { root: RawProc; mb: number; members: RawProc[] }>()
  const system = new Map<string, number>()
  let marisMB = 0
  for (const [pid, mb] of memMB) {
    if (!(mb > 0)) continue
    const c = chain(pid, procs)
    const self = c[0]
    if (!self) continue // it ended since the reading
    // Maris: its own processes, Ollama and its model runners, ComfyUI.
    if (
      opts.ownPids.has(pid) ||
      c.some((x) => isOllama(x.name) || enginePids.has(x.pid) || (x.path && engines.includes(lower(x.path)))) ||
      (opts.ownPids.size && c.slice(1).some((x) => opts.ownPids.has(x.pid)) && /comfyui[\\/]main\.py/i.test(self.cmd ?? ''))
    ) {
      marisMB += mb
      continue
    }
    if (isSystemProcess(self, opts)) {
      system.set(self.name, (system.get(self.name) ?? 0) + mb)
      continue
    }
    // Walk up to the program's main process: parents with the same file name are the same program.
    // Not for runtimes such as Python: a Python parent is usually a different program (a launcher, a notebook).
    let i = 0
    if (!RUNTIMES.test(self.name)) while (c[i + 1] && lower(c[i + 1]!.name) === lower(c[i]!.name) && !isSystemProcess(c[i + 1]!, opts)) i++
    // A web view belongs to the app around it.
    if (HOSTED.has(lower(c[i]!.name)) && c[i + 1] && !isSystemProcess(c[i + 1]!, opts) && !opts.ownPids.has(c[i + 1]!.pid)) {
      i++
      while (c[i + 1] && lower(c[i + 1]!.name) === lower(c[i]!.name) && !isSystemProcess(c[i + 1]!, opts)) i++
    }
    const root = c[i]!
    const g = groups.get(root.pid) ?? { root, mb: 0, members: [] }
    g.mb += mb
    g.members.push(self)
    groups.set(root.pid, g)
  }
  const programs: GpuProgram[] = [...groups.values()]
    .map(({ root, mb, members }) => {
      const runtime = RUNTIMES.test(root.name)
      const detail = runtime ? (scriptOf(root.cmd) ?? members.map((m) => scriptOf(m.cmd)).find(Boolean)) : undefined
      const also = all ? alsoEndsFor(root.pid, all) : []
      return { pid: root.pid, name: displayName(root), exe: root.name, ...(detail ? { detail } : {}), vramMB: Math.round(mb), ...(also.length ? { alsoEnds: also } : {}) }
    })
    .filter((p) => p.vramMB >= 1)
    .sort((a, b) => b.vramMB - a.vramMB)
  const sys = [...system.entries()].sort((a, b) => b[1] - a[1])
  return {
    programs,
    system: { vramMB: Math.round(sys.reduce((n, [, mb]) => n + mb, 0)), names: sys.map(([n]) => n) },
    marisMB: Math.round(marisMB)
  }
}

/**
 * Processes in the "Processes" table of plain `nvidia-smi` output (Linux; on Windows the memory column
 * says N/A for most programs). Older drivers have no GI/CI columns.
 */
export function parseSmiProcesses(text: string): { pid: number; name: string; mb: number }[] {
  const out: { pid: number; name: string; mb: number }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s+\d+\s+(?:\S+\s+\S+\s+)?(\d+)\s+(?:C\+G|M\+C|C|G|M)\s+(.+?)\s+(\d+)\s*MiB\s*\|\s*$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), name: m[2]!.trim(), mb: Number(m[3]) })
  }
  return out
}

/** Windows performance-counter instance names carry the process id: pid_1234_luid_0x…_phys_0. */
export function pidFromInstance(name: string): number | undefined {
  const m = /^pid_(\d+)_/i.exec(name)
  return m ? Number(m[1]) : undefined
}
