// Finds the running Maris (or starts it in the background) and talks to it over its local pipe/socket.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

interface Info {
  address: string
  token: string
  pid: number
  version: string
  exe?: string
}

/** Maris's profile folder (the app's userData); MARIS_USER_DATA points tests at their own profile. */
export function profileDir(): string {
  if (process.env.MARIS_USER_DATA) return process.env.MARIS_USER_DATA
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Maris')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Maris')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Maris')
}

function readInfo(): Info | undefined {
  try {
    const info = JSON.parse(readFileSync(path.join(profileDir(), 'cli.json'), 'utf8')) as Info
    return info.address && info.token ? info : undefined
  } catch {
    return undefined
  }
}

/** The Maris program: when this script runs inside Maris (ELECTRON_RUN_AS_NODE), that is us. */
function appExecutable(info?: Info): string | undefined {
  if (process.versions.electron) return process.execPath
  return info?.exe && existsSync(info.exe) ? info.exe : undefined
}

export class Rpc extends EventEmitter {
  private seq = 0
  private waits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  closed = false
  version = ''
  platform = ''

  constructor(private sock: net.Socket) {
    super()
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (line.trim()) this.message(JSON.parse(line))
      }
    })
    sock.on('close', () => {
      this.closed = true
      for (const w of this.waits.values()) w.reject(new Error('Maris closed the connection.'))
      this.waits.clear()
      this.emit('closed')
    })
    sock.on('error', () => undefined)
  }

  private message(msg: { t: string; id?: number; ok?: boolean; r?: unknown; e?: string; ch?: string; p?: unknown; version?: string; platform?: string }): void {
    if (msg.t === 'ret' && msg.id !== undefined) {
      const w = this.waits.get(msg.id)
      this.waits.delete(msg.id)
      if (msg.ok) w?.resolve(msg.r)
      else w?.reject(new Error(msg.e ?? 'Failed'))
    } else if (msg.t === 'ev' && msg.ch) {
      this.emit(msg.ch, msg.p)
    } else if (msg.t === 'hello') {
      this.emit('hello', msg)
    }
  }

  send(msg: unknown): void {
    if (!this.closed) this.sock.write(`${JSON.stringify(msg)}\n`)
  }

  call<T = unknown>(ch: string, ...a: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Maris closed the connection.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.waits.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ t: 'call', id, ch, a })
    })
  }

  subscribe(chs: string[]): void {
    this.send({ t: 'sub', subs: chs })
  }

  close(): void {
    this.sock.end()
  }
}

function open(info: Info): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(info.address)
    const fail = (e: Error): void => {
      sock.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new Error('Maris did not answer.')), 6000)
    sock.once('error', (e) => {
      clearTimeout(timer)
      fail(e)
    })
    sock.once('connect', () => {
      const rpc = new Rpc(sock)
      rpc.once('hello', (m: { ok: boolean; version: string; platform: string; e?: string }) => {
        clearTimeout(timer)
        if (!m.ok) return fail(new Error(m.e ?? 'Maris refused the connection.'))
        rpc.version = m.version
        rpc.platform = m.platform
        resolve(rpc)
      })
      rpc.send({ t: 'hello', token: info.token, v: 1 })
    })
  })
}

/**
 * Connect to Maris. If it is not running, start it in the background (no window) and wait for it.
 * onWait is called once if that takes a moment, to show a status.
 */
export async function connect(onWait?: (what: string) => void, start = true): Promise<Rpc> {
  const first = readInfo()
  if (first) {
    try {
      return await open(first)
    } catch {
      /* stale file from a closed Maris; start it below */
    }
  }
  const exe = appExecutable(first)
  if (!start || !exe) throw new Error('Maris is not running. Open it, then try again.')
  onWait?.('Starting Maris…')
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.MARIS_TTY
  const started = Date.now()
  // A copy that quits right away found Maris already running (one copy per profile).
  let quickExit = false
  if (process.platform === 'win32') {
    // Through the launcher's helper mode: a program started straight from here would inherit this
    // command's pipes and keep them open, so "maris … | more" would wait for Maris to quit.
    const launcher = process.env.MARIS_CLI_LAUNCHER && existsSync(process.env.MARIS_CLI_LAUNCHER) ? process.env.MARIS_CLI_LAUNCHER : path.join(path.dirname(exe), 'bin', 'maris.exe')
    if (existsSync(launcher)) {
      const helper = spawn(launcher, ['--maris-start', exe, '--background'], { stdio: 'ignore', env: childEnv, windowsHide: true })
      helper.once('exit', (code) => {
        if (code === 9) quickExit = true
      })
    } else {
      // A development copy without the launcher: start it directly.
      const child = spawn(exe, ['--background'], { detached: true, stdio: 'ignore', env: childEnv, windowsHide: true })
      child.once('exit', () => {
        if (Date.now() - started < 8000) quickExit = true
      })
      child.unref()
    }
  } else {
    const child = spawn(exe, ['--background'], { detached: true, stdio: 'ignore', env: childEnv })
    child.once('exit', () => {
      if (Date.now() - started < 8000) quickExit = true
    })
    child.unref()
  }
  const deadline = Date.now() + 60000
  let last: Error | undefined
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 350))
    const info = readInfo()
    const fresh = info && !(first && info.token === first.token)
    if (!fresh) {
      if (quickExit && Date.now() - started > 4000) {
        throw new Error('Maris is running but is not taking terminal connections. Quit Maris from its tray icon, start it again, and try once more.')
      }
      continue
    }
    try {
      return await open(info)
    } catch (e) {
      last = e as Error
    }
  }
  throw new Error(`Maris did not start${last ? ` (${last.message})` : ''}. Open it from the Start menu and try again.`)
}
