// A stand-in for the Maris relay (relay/src/index.mjs) in tests: the same room rules (relay/src/room.mjs) on
// a plain Node HTTP server, with just enough of the WebSocket protocol (RFC 6455) for Maris and a browser.
// Usage: const relay = await startRelay(); … relay.url (ws://127.0.0.1:<port>) … await relay.close()
import { createHash } from 'node:crypto'
import http from 'node:http'
import { joined, left, relayed, tagsFor, KEY_RX, MAX_FRAME, ROOM_RX } from '../../../relay/src/room.mjs'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function header(op, len) {
  if (len < 126) return Buffer.from([0x80 | op, len])
  if (len < 65536) {
    const h = Buffer.alloc(4)
    h[0] = 0x80 | op
    h[1] = 126
    h.writeUInt16BE(len, 2)
    return h
  }
  const h = Buffer.alloc(10)
  h[0] = 0x80 | op
  h[1] = 127
  h.writeBigUInt64BE(BigInt(len), 2)
  return h
}

/** A server-side WebSocket on a raw socket: text frames, ping and close. */
function wrap(socket) {
  let buf = Buffer.alloc(0)
  let fragments = []
  const ws = {
    closed: false,
    onText: () => undefined,
    onClose: () => undefined,
    send(text) {
      if (ws.closed) return
      const data = Buffer.from(text, 'utf8')
      socket.write(Buffer.concat([header(0x1, data.length), data]))
    },
    close(code = 1000, reason = '') {
      if (ws.closed) return
      const r = Buffer.from(reason, 'utf8')
      const p = Buffer.alloc(2 + r.length)
      p.writeUInt16BE(code, 0)
      r.copy(p, 2)
      socket.write(Buffer.concat([header(0x8, p.length), p]))
      ws.closed = true
      socket.end()
      ws.onClose()
    }
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const op = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      const maskAt = off
      if (masked) off += 4
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i % 4)]
      buf = buf.subarray(off + len)
      if (op === 0x8) {
        if (!ws.closed) {
          ws.closed = true
          socket.end()
          ws.onClose()
        }
        return
      }
      if (op === 0x9) socket.write(Buffer.concat([header(0xa, payload.length), payload]))
      else if (op === 0x1 || op === 0x0) {
        fragments.push(payload)
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8')
          fragments = []
          ws.onText(text)
        }
      }
    }
  })
  socket.on('close', () => {
    if (!ws.closed) {
      ws.closed = true
      ws.onClose()
    }
  })
  socket.on('error', () => undefined)
  return ws
}

/** Start the stand-in relay. `stats` counts frames passed, per room, for the test to look at. */
export async function startRelay(port = 0) {
  const rooms = new Map()
  const stats = { frames: 0, largest: 0 }
  const server = http.createServer((_req, res) => res.writeHead(426).end('Expected a WebSocket'))
  const sockets = new Set()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://relay')
    const fail = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    const m = /^\/v1\/room\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
    if (!m || !ROOM_RX.test(m[1])) return fail(404, 'Not Found')
    const room = m[1]
    const role = url.searchParams.get('as')
    const key = url.searchParams.get('key')
    const keyOk = role === 'pc' && !!key && KEY_RX.test(key) && createHash('sha256').update(`maris-relay-room:${key}`).digest('base64url') === room
    let members = rooms.get(room)
    if (!members) rooms.set(room, (members = new Map()))
    const phonesNow = [...members.values()].filter((t) => t.includes('phone')).length
    const t = tagsFor(role, url.searchParams.get('dev'), phonesNow, keyOk)
    if ('error' in t) return fail(t.status, t.error)
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const ws = wrap(socket)
    members.set(ws, t.tags)
    const api = {
      withTag: (tag) => [...members.entries()].filter(([, tags]) => tags.includes(tag)).map(([s]) => s),
      tagsOf: (s) => members.get(s) ?? [],
      send: (s, text) => s.send(text),
      close: (s, code, reason) => s.close(code, reason)
    }
    ws.onText = (text) => {
      // What Cloudflare's setWebSocketAutoResponse does for the real relay.
      if (text === 'ping') return ws.send('pong')
      if (text.length > MAX_FRAME) return
      stats.frames++
      stats.largest = Math.max(stats.largest, text.length)
      relayed(api, ws, text)
    }
    ws.onClose = () => {
      if (!members.has(ws)) return
      left(api, ws)
      members.delete(ws)
    }
    joined(api, ws)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actual = server.address().port
  return {
    port: actual,
    url: `ws://127.0.0.1:${actual}`,
    stats,
    /** Who is in each room: tags of every socket. */
    members: () => Object.fromEntries([...rooms.entries()].map(([id, ms]) => [id, [...ms.values()]])),
    close: () =>
      new Promise((resolve) => {
        for (const ms of rooms.values()) for (const ws of ms.keys()) ws.close(1001, 'relay going away')
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      })
  }
}
