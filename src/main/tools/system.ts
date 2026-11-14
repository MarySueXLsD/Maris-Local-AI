import { app, clipboard, desktopCapturer, screen, shell } from 'electron'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { monitor } from '../system/monitor'
import { formatBytes } from '../util'
import { resolvePath } from './paths'
import { IS_MAC, IS_WIN, OS_LABEL, osDescription } from '../platform'
import { runPowerShell, runShell } from './shell'
import { num, schema, str, ToolError, type PreparedCall, type ToolContext, type ToolDef } from './types'

/** Chats in which the person already let a screenshot or the clipboard go to the cloud service (until Maris closes). */
const sharedWithService = new Set<string>()

/**
 * Reading the screen or the clipboard is free while the model runs on this computer. When it runs at a
 * service on the internet, what the tool returns is sent there, and a screen or a clipboard can hold
 * anything (a password just copied, a bank page): Maris asks once per chat.
 */
function privateRead(ctx: ToolContext, tool: string, what: string): PreparedCall | undefined {
  if (!ctx.away || sharedWithService.has(`${ctx.conversationId}:${tool}`)) return undefined
  return {
    risk: 'change',
    title: `Send ${what} to ${ctx.away}`,
    detail: `This chat is answered by a model at ${ctx.away}, so ${what} would be sent there. Maris asks once per chat.`
  }
}

const sharedOnce = (ctx: ToolContext, tool: string): void => {
  if (ctx.away) sharedWithService.add(`${ctx.conversationId}:${tool}`)
}

async function psJson<T>(script: string): Promise<T | undefined> {
  const r = await runPowerShell(`${script} | ConvertTo-Json -Depth 3 -Compress`, { timeoutMs: 30000 })
  try {
    const v = JSON.parse(r.stdout) as T | T[]
    return v as T
  } catch {
    return undefined
  }
}

/** Disks with free space: "C: …" on Windows, mount points elsewhere. */
async function diskLines(): Promise<string[]> {
  if (IS_WIN) {
    const disks =
      (await psJson<{ DeviceID: string; VolumeName: string; FileSystem: string; Size: number; FreeSpace: number }[]>(
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, VolumeName, FileSystem, Size, FreeSpace'
      )) ?? []
    const list = Array.isArray(disks) ? disks : [disks]
    return list
      .filter(Boolean)
      .map((d) => `${d.DeviceID} ${d.VolumeName ? `"${d.VolumeName}" ` : ''}${d.FileSystem} — ${formatBytes(d.FreeSpace)} free of ${formatBytes(d.Size)}`)
  }
  const r = await runShell('df -kP', { timeoutMs: 15000 })
  return r.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && /^\//.test(c[0] ?? '') && !/^\/(dev|sys|proc|run|snap)\b|^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)/.test(c[5] ?? ''))
    .map((c) => `${c.slice(5).join(' ')} — ${formatBytes(Number(c[3]) * 1024)} free of ${formatBytes(Number(c[1]) * 1024)}`)
}

export const systemTools: ToolDef[] = [
  {
    name: 'system_info',
    risk: 'read',
    description: `Get an overview of the user's ${OS_LABEL} computer: OS version, CPU, RAM, GPU usage, disks with free space, user folders, uptime and local time.`,
    parameters: schema({}),
    async prepare() {
      return { risk: 'read', title: 'Read system information' }
    },
    async run() {
      const s = monitor.snapshot()
      const disks = await diskLines()
      const folders = ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music'] as const
      const cpu = os.cpus()
      const lines = [
        `OS: ${osDescription()} (${os.version()}), ${os.arch()}`,
        `Computer: ${os.hostname()}, user: ${os.userInfo().username}`,
        `CPU: ${cpu[0]?.model.trim()} (${cpu.length} threads), load ${(s.cpuLoad * 100).toFixed(0)}%`,
        `RAM: ${formatBytes(os.totalmem() - os.freemem())} used of ${formatBytes(os.totalmem())}`,
        s.gpu
          ? `GPU: ${s.gpu.name}, ${s.gpu.utilization}% busy, VRAM ${s.gpu.memUsedMB} / ${s.gpu.memTotalMB} MB, ${s.gpu.temperatureC ?? '?'}°C`
          : 'GPU: not detected',
        `Disks: ${disks.join('; ')}`,
        `Folders: ${folders.map((f) => `${f}=${app.getPath(f)}`).join(', ')}`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
        `Local time: ${new Date().toString()}`,
        `On battery: ${s.onBattery ? 'yes' : 'no'}`
      ]
      return lines.join('\n')
    }
  },
  {
    name: 'list_processes',
    risk: 'read',
    description: 'List running programs/processes with memory and CPU time. Optionally filter by name.',
    parameters: schema({
      filter: { type: 'string', description: 'Only processes whose name contains this text' },
      sort: { type: 'string', description: 'memory or cpu (default memory)', enum: ['memory', 'cpu'] },
      limit: { type: 'integer', description: 'Max rows (default 25)' }
    }),
    async prepare() {
      return { risk: 'read', title: 'List running processes' }
    },
    async run(args, ctx) {
      const limit = Math.max(1, Math.min(100, num(args.limit, 25)))
      if (!IS_WIN) {
        // ps is the same on macOS and Linux for these columns; sort in Node for portability.
        const r = await runShell('ps -axo pid=,rss=,time=,comm=', { timeoutMs: 15000 })
        const want = str(args.filter, 'filter', false).toLowerCase()
        const cpuSec = (t: string): number => t.split(/[-:]/).reduce((s, v) => s * 60 + Number.parseFloat(v || '0'), 0)
        const rows = r.stdout
          .split('\n')
          .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(l))
          .filter((m): m is RegExpExecArray => Boolean(m))
          .map((m) => ({ pid: Number(m[1]), memMB: Math.round(Number(m[2]) / 1024), cpu: cpuSec(m[3]), name: m[4].split('/').pop() ?? m[4] }))
          .filter((p) => !want || p.name.toLowerCase().includes(want))
          .sort((a, b) => (args.sort === 'cpu' ? b.cpu - a.cpu : b.memMB - a.memMB))
          .slice(0, limit)
        return rows.length ? rows.map((p) => `${p.name} (pid ${p.pid}) — ${p.memMB} MB, CPU ${Math.round(p.cpu)}s`).join('\n') : 'No matching processes.'
      }
      const filter = str(args.filter, 'filter', false).replace(/'/g, "''")
      const sortKey = args.sort === 'cpu' ? 'CPU' : 'WorkingSet64'
      const rows =
        (await psJson<{ Name: string; Id: number; MemMB: number; CPUsec: number; Title: string }[]>(
          `Get-Process ${filter ? `| Where-Object { $_.Name -like '*${filter}*' }` : ''} | Sort-Object ${sortKey} -Descending | Select-Object -First ${limit} Name, Id, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}}, @{n='CPUsec';e={[math]::Round($_.CPU,1)}}, @{n='Title';e={$_.MainWindowTitle}}`
        )) ?? []
      const list = Array.isArray(rows) ? rows : [rows]
      if (!list.length) return 'No matching processes.'
      return list
        .map((p) => `${p.Name} (pid ${p.Id}) — ${p.MemMB} MB, CPU ${p.CPUsec ?? 0}s${p.Title ? ` — "${p.Title}"` : ''}`)
        .join('\n')
    }
  },
  {
    name: 'kill_process',
    risk: 'system',
    description: 'Close a running program by process id or name. The user must approve.',
    parameters: schema({
      pid: { type: 'integer', description: 'Process id' },
      name: { type: 'string', description: 'Process name, e.g. notepad' }
    }),
    async prepare(args, ctx) {
      if (!args.pid && !args.name) throw new ToolError('Give either pid or name')
      const target = args.pid ? `process ${args.pid}` : `all "${args.name}" processes`
      return { risk: 'system', title: `Close ${target}`, detail: 'Unsaved work in that program may be lost.' }
    },
    async run(args, ctx) {
      if (!IS_WIN) {
        const name = String(args.name ?? '').replace(/[^\w .+-]/g, '')
        const r = await runShell(args.pid ? `kill ${Number(args.pid)} && echo 'Stopped process ${Number(args.pid)}'` : `pkill -x '${name}' && echo 'Stopped'`, { timeoutMs: 20000 })
        if (r.code) throw new ToolError(r.stderr || `No process matched (exit ${r.code})`)
        return r.stdout || 'Done'
      }
      const script = args.pid
        ? `Stop-Process -Id ${Number(args.pid)} -ErrorAction Stop; 'Stopped process ${Number(args.pid)}'`
        : `Stop-Process -Name '${String(args.name).replace(/'/g, "''").replace(/\.exe$/i, '')}' -ErrorAction Stop; 'Stopped'`
      const r = await runPowerShell(script, { timeoutMs: 20000 })
      return r.stdout || r.stderr || 'Done'
    }
  },
  {
    name: 'open_target',
    risk: 'system',
    description:
      'Open a file, folder, program or URL on the user PC (like double-clicking it). The user must approve.',
    parameters: schema({ target: { type: 'string', description: 'Path, program name (e.g. notepad) or https:// URL' } }, ['target']),
    async prepare(args, ctx) {
      const t = str(args.target, 'target')
      return { risk: 'system', title: `Open ${t}`, preview: { kind: 'list', items: [t] } }
    },
    async run(args, ctx) {
      const t = str(args.target, 'target')
      if (/^https?:\/\//i.test(t)) {
        await shell.openExternal(t)
        return `Opened ${t} in the default browser`
      }
      const p = resolvePath(t, ctx.cwd)
      if (existsSync(p)) {
        const err = await shell.openPath(p)
        if (err) throw new ToolError(err)
        return `Opened ${p}`
      }
      if (!IS_WIN) {
        // A program name: "open -a Name" on macOS, launch it detached on Linux.
        const safe = t.replace(/'/g, `'\\''`)
        const r = await runShell(IS_MAC ? `open -a '${safe}'` : `nohup '${safe}' >/dev/null 2>&1 &`, { timeoutMs: 20000 })
        if (r.code) throw new ToolError(r.stderr || `Could not open ${t}`)
        return `Started ${t}`
      }
      const r = await runPowerShell(`Start-Process '${t.replace(/'/g, "''")}'`, { timeoutMs: 20000 })
      if (r.stdout.trim() || r.code) throw new ToolError(r.stdout || `Could not open ${t}`)
      return `Started ${t}`
    }
  },
  {
    name: 'get_clipboard',
    risk: 'read',
    description: 'Read the text currently on the user clipboard.',
    parameters: schema({}),
    async prepare(_args, ctx) {
      return privateRead(ctx, 'get_clipboard', 'what is on the clipboard') ?? { risk: 'read', title: 'Read clipboard' }
    },
    async run(_args, ctx) {
      sharedOnce(ctx, 'get_clipboard')
      const t = await clipboard.readText()
      return t ? t.slice(0, 20000) : '(clipboard has no text)'
    }
  },
  {
    name: 'set_clipboard',
    risk: 'change',
    description: 'Put text on the user clipboard. The user must approve.',
    parameters: schema({ text: { type: 'string', description: 'Text to copy' } }, ['text']),
    async prepare(args, ctx) {
      const t = str(args.text, 'text')
      return { risk: 'change', title: 'Copy text to clipboard', preview: { kind: 'text', text: t.slice(0, 4000) } }
    },
    async run(args, ctx) {
      await clipboard.writeText(str(args.text, 'text'))
      return 'Copied to clipboard'
    }
  },
  {
    name: 'take_screenshot',
    risk: 'read',
    description:
      'Capture the user screen so you can see what is on it (requires a vision-capable model). Use when the user asks about something on their screen.',
    parameters: schema({}),
    async prepare(_args, ctx) {
      return privateRead(ctx, 'take_screenshot', 'a picture of your screen') ?? { risk: 'read', title: 'Take a screenshot' }
    },
    async run(_args, ctx) {
      sharedOnce(ctx, 'take_screenshot')
      const d = screen.getPrimaryDisplay()
      const scale = Math.min(1, 1600 / (d.size.width * d.scaleFactor))
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(d.size.width * d.scaleFactor * scale),
          height: Math.round(d.size.height * d.scaleFactor * scale)
        }
      })
      const img = sources[0]?.thumbnail
      if (!img || img.isEmpty()) throw new ToolError('Could not capture the screen')
      const jpeg = img.toJPEG(80)
      ctx.setPreview(`data:image/jpeg;base64,${img.resize({ width: 480 }).toJPEG(70).toString('base64')}`)
      if (!ctx.modelSupportsVision) return 'Screenshot captured, but the current model cannot see images. Ask the user to switch to a vision model.'
      ctx.attachImageForModel(jpeg.toString('base64'), 'Screenshot of the user screen')
      return `Screenshot captured (${img.getSize().width}x${img.getSize().height}). It is attached for you to look at.`
    }
  }
]
