import { app } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { handlers, outbound } from '../bridge'
import { errMsg, log } from '../util'

/**
 * The `maris` terminal command talks to the running app through this local server: a named pipe on
 * Windows, a Unix socket elsewhere. Only the person logged in can reach it (the pipe/socket and the
 * token file live in their own profile), and every connection must present the token from
 * userData/cli.json. The terminal uses the same chat, tools, memory and approvals as the window.
 */

/** What a terminal may call: the chat itself and what the command shows. Settings, setup, dialogs,
 * publishing and the phone link stay in the app window. */
const ALLOWED = new Set([
  'app:info',
  'chat:send',
  'chat:stop',
  'chat:approve',
  'chat:approvals',
  'chat:previewRoute',
  'conv:list',
  'conv:get',
  'conv:rename',
  'conv:running',
  'models:list',
  // What the API models used and cost (maris status).
  'providers:usage',
  'system:status',
  'settings:get',
  'media:generate',
  'media:jobs',
  'media:cancel',
  'media:packs',
  'project:list',
  // Files the person names on the command line (maris "describe this" -f photo.jpg).
  'files:attach',
  'cli:show'
])

/** Events a terminal can subscribe to. */
const EVENTS = new Set(['chat:event', 'media:job', 'system:status'])

interface Client {
  sock: net.Socket
  authed: boolean
  subs: Set<string>
  send: (msg: unknown) => void
}

export function cliInfoPath(): string {
  return path.join(app.getPath('userData'), 'cli.json')
}

/** A new address on every start; the terminal reads it from cli.json, so nothing can hold it already. */
function address(userData: string): string {
  const hash = createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 12)
  const nonce = randomBytes(4).toString('hex')
  if (process.platform === 'win32') return `\\\\.\\pipe\\maris-cli-${hash}-${nonce}`
  // Unix socket paths are limited to about 104 characters.
  const inProfile = path.join(userData, 'cli.sock')
  return inProfile.length < 100 ? inProfile : path.join(os.tmpdir(), `maris-${hash}.sock`)
}

class CliServer {
  private server?: net.Server
  private token = ''
  private addr = ''
  private clients = new Set<Client>()
  /** Called when a terminal asks to show a chat in the window (`maris open`). */
  onShow?: (conversationId?: string) => void

  start(): void {
    if (this.server) return
    this.token = randomBytes(24).toString('hex')
    handlers.set('cli:show', (id?: unknown) => {
      this.onShow?.(typeof id === 'string' ? id : undefined)
      return true
    })
    outbound.on(({ channel, payload }) => {
      if (!EVENTS.has(channel)) return
      for (const c of this.clients) if (c.authed && c.subs.has(channel)) c.send({ t: 'ev', ch: channel, p: payload })
    })
    this.listen(0)
  }

  private listen(attempt: number): void {
    this.addr = address(app.getPath('userData'))
    if (process.platform !== 'win32') rmSync(this.addr, { force: true })
    const server = net.createServer((sock) => this.accept(sock))
    server.on('error', (e: NodeJS.ErrnoException) => {
      log.warn('cli', `terminal server: ${e.code ?? e.message} on ${this.addr}`)
      if (this.server === server) this.server = undefined
      if (e.code === 'EADDRINUSE' && attempt < 2) this.listen(attempt + 1)
    })
    server.listen(this.addr, () => {
      if (process.platform !== 'win32') chmodSync(this.addr, 0o600)
      writeFileSync(cliInfoPath(), JSON.stringify({ address: this.addr, token: this.token, pid: process.pid, version: app.getVersion(), exe: process.execPath }), {
        mode: 0o600
      })
      log.info('cli', `terminal server listening on ${this.addr}`)
    })
    this.server = server
  }

  stop(): void {
    for (const c of this.clients) c.sock.destroy()
    this.server?.close()
    this.server = undefined
    rmSync(cliInfoPath(), { force: true })
    if (process.platform !== 'win32' && this.addr) rmSync(this.addr, { force: true })
  }

  get connected(): number {
    return [...this.clients].filter((c) => c.authed).length
  }

  private accept(sock: net.Socket): void {
    sock.setEncoding('utf8')
    const client: Client = {
      sock,
      authed: false,
      subs: new Set(),
      send: (msg) => {
        if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`)
      }
    }
    this.clients.add(client)
    let buf = ''
    // A connection that does not say hello with the right token within 5 s is dropped.
    const helloTimer = setTimeout(() => !client.authed && sock.destroy(), 5000)
    sock.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > 32 * 2 ** 20) return sock.destroy()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) void this.handle(client, line)
      }
    })
    sock.on('error', () => undefined)
    sock.on('close', () => {
      clearTimeout(helloTimer)
      this.clients.delete(client)
    })
  }

  private async handle(c: Client, line: string): Promise<void> {
    let msg: { t?: string; id?: number; ch?: string; a?: unknown[]; token?: string; subs?: string[] }
    try {
      msg = JSON.parse(line)
    } catch {
      return void c.sock.destroy()
    }
    if (!c.authed) {
      if (msg.t !== 'hello' || typeof msg.token !== 'string' || !sameToken(msg.token, this.token)) {
        c.send({ t: 'hello', ok: false, e: 'Not allowed' })
        return void c.sock.end()
      }
      c.authed = true
      c.send({ t: 'hello', ok: true, app: 'maris', version: app.getVersion(), platform: process.platform })
      return
    }
    if (msg.t === 'sub') {
      for (const ch of msg.subs ?? []) if (EVENTS.has(ch)) c.subs.add(ch)
      return
    }
    if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.ch !== 'string') return
    const fn = ALLOWED.has(msg.ch) ? handlers.get(msg.ch) : undefined
    if (!fn) return c.send({ t: 'ret', id: msg.id, ok: false, e: 'Not available from the terminal' })
    try {
      const r = await fn(...(Array.isArray(msg.a) ? msg.a : []))
      c.send({ t: 'ret', id: msg.id, ok: true, r })
    } catch (e) {
      c.send({ t: 'ret', id: msg.id, ok: false, e: errMsg(e) })
    }
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const cliServer = new CliServer()
