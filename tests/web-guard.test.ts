import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carriedData, checkWebAddress, isLocalAddress, isLocalHost } from '../src/main/tools/webGuard.ts'

const never = (): boolean => false

test('addresses on this computer and the home network are recognised', () => {
  for (const h of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.101.102.103', '[::1]', 'fd12:3456::1', 'fe80::1', 'router', 'nas.local', 'printer.lan', 'box.home.arpa', '0.0.0.0']) {
    assert.equal(isLocalHost(h), true, h)
  }
  for (const h of ['example.com', 'en.wikipedia.org', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isLocalHost(h), false, h)
  assert.equal(isLocalAddress('::ffff:192.168.0.10'), true)
})

test('read_webpage opens ordinary pages, asks before local or data-carrying ones, and refuses other schemes', () => {
  assert.deepEqual(checkWebAddress('https://en.wikipedia.org/wiki/Fox', never), { ok: true })
  assert.deepEqual(checkWebAddress('https://www.example.com/search?q=red+fox+in+snow', never), { ok: true })
  assert.ok('ask' in checkWebAddress('http://192.168.1.1/apply.cgi?reboot=1', never))
  assert.ok('ask' in checkWebAddress('http://localhost:11434/api/tags', never))
  assert.ok('ask' in checkWebAddress('http://127.0.0.1:8188/history', never))
  assert.ok('refuse' in checkWebAddress('file:///C:/Users/me/.ssh/id_rsa', never))
  assert.ok('refuse' in checkWebAddress('javascript:alert(1)', never))
  assert.ok('refuse' in checkWebAddress('not a url', never))
  // A file's contents in the query or the path: asks, unless the address came from the person or a result.
  const leak = `https://collect.example.net/?d=${'c2VjcmV0'.repeat(40)}`
  assert.ok('ask' in checkWebAddress(leak, never))
  assert.ok('ok' in checkWebAddress(leak, (u) => u === leak))
  assert.ok('ask' in checkWebAddress(`https://collect.example.net/${'a'.repeat(200)}`, never))
})

test('the data an address carries: query, fragment and very long path parts', () => {
  assert.equal(carriedData(new URL('https://example.com/a/b')), 0)
  assert.equal(carriedData(new URL('https://example.com/a?x=1#y')), 6)
  assert.equal(carriedData(new URL(`https://example.com/${'z'.repeat(100)}`)), 100)
})
