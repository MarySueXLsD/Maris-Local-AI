// The computer's end of the Maris relay: one WebSocket out to the relay, so nothing has to be opened on the
// home router, and phones away from home reach Maris through it. What passes is sealed end to end
// (protocol.ts); the relay only forwards it.
import { FrameJoiner, splitFrame } from '@shared/relay'
import type { RelayState } from '@shared/types'

export interface RelayHandlers {
  /** A whole frame from a phone (parts already joined). */
  frame(dev: string, text: string): void
  /** A phone came into the room or left it. */
  phone(dev: string, here: boolean): void
  state(s: RelayState, error?: string): void
}

export class RelayClient {
  state: RelayState = 'off'
  error?: string
  private ws?: WebSocket
  private url = ''
  private retry?: NodeJS.Timeout
  private ping?: NodeJS.Timeout
  private delay = 1000
  private joiner = new FrameJoiner()

  constructor(private on: RelayHandlers) {}

  /** Connect to a room (and stay connected) until stop(). The same address again changes nothing. */
  start(url: string): void {
    if (this.url === url && this.state !== 'off') return
    this.stop()
    this.url = url
    this.open()
  }

  stop(): void {
    this.url = ''
    clearTimeout(this.retry)
    clearInterval(this.ping)
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close(1000, 'stopped')
    } catch {
      /* not open */
    }
    this.set('off')
  }

  /** Send a frame to one phone, or to all of them with '*'. False while the relay is not connected. */
  send(dev: string, text: string): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    for (const part of splitFrame(text)) ws.send(`${dev}\n${part}`)
    return true
  }

  private set(s: RelayState, error?: string): void {
    if (this.state === s && this.error === error) return
    this.state = s
    this.error = error
    this.on.state(s, error)
  }

  private open(): void {
    if (!this.url) return
    if (this.state !== 'unreachable') this.set('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.set('unreachable', (e as Error).message)
      this.later()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.delay = 1000
      this.set('online')
      clearInterval(this.ping)
      // Some networks drop a connection that stays quiet for a few minutes; the relay answers without waking.
      this.ping = setInterval(() => {
        try {
          ws.send('ping')
        } catch {
          /* closing */
        }
      }, 25000)
    })
    ws.addEventListener('message', (e: MessageEvent) => {
      if (this.ws !== ws || typeof e.data !== 'string' || e.data === 'pong') return
      const text = e.data
      if (text.startsWith('{"relay"')) {
        try {
          const c = JSON.parse(text) as { relay: string; dev?: string }
          if (c.dev && (c.relay === 'phone-joined' || c.relay === 'phone-left')) this.on.phone(c.dev, c.relay === 'phone-joined')
        } catch {
          /* not for us */
        }
        return
      }
      const nl = text.indexOf('\n')
      if (nl < 1) return
      const dev = text.slice(0, nl)
      const whole = this.joiner.take(dev, text.slice(nl + 1))
      if (whole !== undefined) this.on.frame(dev, whole)
    })
    ws.addEventListener('close', (e: CloseEvent) => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearInterval(this.ping)
      this.set('unreachable', e.code === 4000 ? 'Another copy of Maris took over this room.' : undefined)
      this.later()
    })
    // An error is always followed by close, which tries again.
    ws.addEventListener('error', () => undefined)
  }

  private later(): void {
    clearTimeout(this.retry)
    if (!this.url) return
    this.retry = setTimeout(() => this.open(), this.delay + Math.random() * 1000)
    this.delay = Math.min(60000, this.delay * 2)
  }
}
