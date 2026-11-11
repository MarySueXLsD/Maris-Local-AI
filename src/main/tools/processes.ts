import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { IS_WIN, posixShell } from '../platform'
import { uid } from '../util'
import { killTree, POSIX_PRELUDE, psScriptFile } from './shell'

/** Long-running processes the agent started (dev servers, watchers, game builds). */
export interface ManagedProcess {
  id: string
  name: string
  command: string
  cwd: string
  conversationId: string
  pid?: number
  startedAt: number
  exitCode?: number | null
  running: boolean
  lines: string[]
}

const procs = new Map<string, ManagedProcess & { child?: ChildProcess }>()
const MAX_LINES = 4000

function push(p: ManagedProcess, chunk: string): void {
  for (const line of chunk.replace(/\r\n/g, '\n').split('\n')) {
    if (line === '' && p.lines[p.lines.length - 1] === '') continue
    p.lines.push(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  }
  if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES)
}

export const processes = {
  start(command: string, cwd: string, conversationId: string, name?: string): ManagedProcess {
    let child: ChildProcess
    if (IS_WIN) {
      const script = `$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
${command}`
      const { args, file } = psScriptFile(script)
      child = spawn('powershell.exe', args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
      })
      child.on('close', () => rmSync(file, { force: true }))
    } else {
      // Own process group, so stopping it also stops whatever it started (dev servers spawn children).
      child = spawn(posixShell(), ['-lc', `${POSIX_PRELUDE}\n${command}`], { cwd, detached: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' } })
    }
    const p: ManagedProcess & { child?: ChildProcess } = {
      id: uid().slice(0, 8),
      name: name || command.split(/\s+/).slice(0, 3).join(' '),
      command,
      cwd,
      conversationId,
      pid: child.pid,
      startedAt: Date.now(),
      running: true,
      lines: [],
      child
    }
    child.stdout?.on('data', (d: Buffer) => push(p, d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => push(p, d.toString('utf8')))
    child.on('exit', (code) => {
      p.running = false
      p.exitCode = code
      push(p, `[process exited with code ${code ?? 'killed'}]`)
    })
    child.on('error', (e) => {
      p.running = false
      push(p, `[failed to start: ${e.message}]`)
    })
    procs.set(p.id, p)
    return p
  },

  get(id: string): ManagedProcess | undefined {
    return procs.get(id)
  },

  output(id: string, tail = 80): string {
    const p = procs.get(id)
    if (!p) {
      const known = [...procs.values()].map((x) => `${x.id} (${x.name}${x.running ? '' : ', ended'})`)
      return `No process with id ${id}. ${known.length ? `Processes Maris started: ${known.join(', ')}.` : 'Maris has not started any process yet (use start_process).'}`
    }
    const lines = p.lines.slice(-Math.max(1, Math.min(1000, tail)))
    const state = p.running ? `running for ${Math.round((Date.now() - p.startedAt) / 1000)}s` : `exited with code ${p.exitCode ?? '?'}`
    return `[${p.id}] ${p.name} (${state}, pid ${p.pid ?? '?'}) in ${p.cwd}\n${lines.join('\n') || '(no output yet)'}`
  },

  stop(id: string): boolean {
    const p = procs.get(id)
    if (!p) return false
    if (p.running && p.pid) killTree(p.pid)
    p.running = false
    return true
  },

  list(conversationId?: string): ManagedProcess[] {
    return [...procs.values()]
      .filter((p) => !conversationId || p.conversationId === conversationId)
      .map(({ child: _c, ...p }) => ({ ...p, lines: p.lines.slice(-5) }))
  },

  stopAll(): void {
    for (const id of procs.keys()) this.stop(id)
  }
}
