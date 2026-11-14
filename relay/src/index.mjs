// The Maris relay on Cloudflare: one Durable Object per room, holding the computer's WebSocket and its
// phones' (see room.mjs for what it does and does not see). WebSocket hibernation keeps an idle room from
// costing anything, and keep-alive pings are answered without waking it. Deploy: relay/README.md.
import { joined, left, relayed, tagsFor, KEY_RX, MAX_FRAME, ROOM_RX } from './room.mjs'

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The room a key opens: what the computer sends is checked against the room id in the address. */
async function roomOf(key) {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`maris-relay-room:${key}`)))
}

export default {
  /** @param {Request} req @param {{ ROOMS: DurableObjectNamespace }} env */
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/v1') {
      return new Response('Maris relay. It passes encrypted messages between Maris on a computer and its phone app; it cannot read them.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
    const m = /^\/v1\/room\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
    if (!m || !ROOM_RX.test(m[1])) return new Response('Not found', { status: 404 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req)
  }
}

export class Room {
  /** @param {DurableObjectState} state */
  constructor(state) {
    this.state = state
    // Keep-alive pings from Maris and the phone are answered here, without waking the room.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  sockets() {
    return {
      withTag: (tag) => this.state.getWebSockets(tag),
      tagsOf: (s) => this.state.getTags(s),
      send: (s, text) => {
        try {
          s.send(text)
        } catch {
          /* closing */
        }
      },
      close: (s, code, reason) => {
        try {
          s.close(code, reason)
        } catch {
          /* closed */
        }
      }
    }
  }

  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url)
    const room = url.pathname.split('/').pop()
    const role = url.searchParams.get('as')
    const key = url.searchParams.get('key')
    const keyOk = role === 'pc' && !!key && KEY_RX.test(key) && (await roomOf(key)) === room
    const t = tagsFor(role, url.searchParams.get('dev'), this.state.getWebSockets('phone').length, keyOk)
    if ('error' in t) return new Response(t.error, { status: t.status })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server, t.tags)
    joined(this.sockets(), server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** @param {WebSocket} ws @param {string | ArrayBuffer} message */
  async webSocketMessage(ws, message) {
    if (typeof message === 'string' && message.length <= MAX_FRAME) relayed(this.sockets(), ws, message)
  }

  /** @param {WebSocket} ws @param {number} code */
  async webSocketClose(ws, code) {
    left(this.sockets(), ws)
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed')
    } catch {
      /* already closed */
    }
  }

  /** @param {WebSocket} ws */
  async webSocketError(ws) {
    left(this.sockets(), ws)
  }
}
