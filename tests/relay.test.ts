import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joined, left, relayed, tagsFor } from '../relay/src/room.mjs'
import { FrameJoiner, relayBase, roomUrl, splitFrame } from '../src/shared/relay.ts'

/** A room with fake sockets that record what they were sent. */
function fakeRoom() {
  const members = new Map<string, { tags: string[]; got: string[]; closed?: string }>()
  const api = {
    withTag: (tag: string) => [...members.entries()].filter(([, m]) => m.tags.includes(tag) && !m.closed).map(([id]) => id),
    tagsOf: (s: string) => members.get(s)?.tags ?? [],
    send: (s: string, text: string) => void members.get(s)?.got.push(text),
    close: (s: string, _code: number, reason: string) => {
      const m = members.get(s)
      if (m) m.closed = reason
    }
  }
  const join = (id: string, tags: string[]): void => {
    members.set(id, { tags, got: [] })
    joined(api, id)
  }
  return { api, members, join }
}

test('the relay admits the computer only with its room key, and phones with a device id', () => {
  assert.deepEqual(tagsFor('pc', null, 0, true), { tags: ['pc'] })
  assert.equal((tagsFor('pc', null, 0, false) as { status: number }).status, 403)
  assert.deepEqual(tagsFor('phone', 'dev_aaaaaaaaaaaaaaaa', 0, false), { tags: ['phone', 'dev:dev_aaaaaaaaaaaaaaaa'] })
  assert.equal((tagsFor('phone', 'x', 0, false) as { status: number }).status, 400)
  assert.equal((tagsFor('phone', 'dev_aaaaaaaaaaaaaaaa', 16, false) as { status: number }).status, 429)
})

test('the relay passes frames between the computer and the right phone, and says who is there', () => {
  const r = fakeRoom()
  const A = 'phoneAAAAAAAAAAAAAAAA'
  const B = 'phoneBBBBBBBBBBBBBBBB'
  r.join('a', ['phone', `dev:${A}`])
  assert.deepEqual(r.members.get('a')!.got, ['{"relay":"pc-offline"}'])
  r.join('pc', ['pc'])
  assert.ok(r.members.get('a')!.got.includes('{"relay":"pc-online"}'))
  assert.ok(r.members.get('pc')!.got.includes(`{"relay":"phone-joined","dev":"${A}"}`))
  r.join('b', ['phone', `dev:${B}`])
  // Phone → computer, with the device it came from.
  relayed(r.api, 'a', '{"id":"1"}')
  assert.equal(r.members.get('pc')!.got.at(-1), `${A}\n{"id":"1"}`)
  // Computer → one phone, and → all.
  relayed(r.api, 'pc', `${B}\n{"id":"1","s":200}`)
  assert.equal(r.members.get('b')!.got.at(-1), '{"id":"1","s":200}')
  assert.notEqual(r.members.get('a')!.got.at(-1), '{"id":"1","s":200}')
  relayed(r.api, 'pc', '*\n{"ev":1}')
  assert.equal(r.members.get('a')!.got.at(-1), '{"ev":1}')
  assert.equal(r.members.get('b')!.got.at(-1), '{"ev":1}')
  // A phone cannot address other phones: whatever it sends goes to the computer only.
  relayed(r.api, 'a', `${B}\nhello`)
  assert.equal(r.members.get('b')!.got.at(-1), '{"ev":1}')
  // The same phone again replaces its old socket; a second computer replaces the first.
  r.join('a2', ['phone', `dev:${A}`])
  assert.equal(r.members.get('a')!.closed, 'This phone connected again')
  r.join('pc2', ['pc'])
  assert.equal(r.members.get('pc')!.closed, 'Another copy of Maris took over this room')
  // Leaving: the other side is told, unless a newer socket of the same one is there.
  left(r.api, 'a')
  assert.ok(!r.members.get('pc2')!.got.some((t) => t.includes('phone-left')))
  r.members.get('a2')!.closed = 'gone'
  left(r.api, 'a2')
  assert.ok(r.members.get('pc2')!.got.includes(`{"relay":"phone-left","dev":"${A}"}`))
})

test('frames longer than a relay message travel in parts and come back whole', () => {
  const big = 'x'.repeat(1_500_000) + '"quoted"'
  const parts = splitFrame(big)
  assert.equal(parts.length, 3)
  assert.ok(parts.every((p) => p.length < 1_000_000))
  const j = new FrameJoiner()
  // Parts may come in any order, and parts of different senders do not mix.
  assert.equal(j.take('pc', parts[2]!), undefined)
  assert.equal(j.take('other', parts[0]!), undefined)
  assert.equal(j.take('pc', parts[0]!), undefined)
  assert.equal(j.take('pc', parts[1]!), big)
  assert.equal(j.take('pc', '{"id":"7"}'), '{"id":"7"}')
  assert.deepEqual(splitFrame('short'), ['short'])
})

test('relay addresses', () => {
  assert.equal(relayBase('https://relay.example.workers.dev/'), 'wss://relay.example.workers.dev')
  assert.equal(relayBase('ws://127.0.0.1:9000'), 'ws://127.0.0.1:9000')
  assert.equal(relayBase('not a url'), '')
  assert.equal(roomUrl('wss://r.example', 'ROOM', 'phone', 'dev1'), 'wss://r.example/v1/room/ROOM?as=phone&dev=dev1')
  assert.equal(roomUrl('wss://r.example', 'ROOM', 'pc', 'k-y'), 'wss://r.example/v1/room/ROOM?as=pc&key=k-y')
})
