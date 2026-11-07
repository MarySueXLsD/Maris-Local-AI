import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as server from '../src/main/link/protocol.ts'
import * as phone from '../src/renderer/remote/crypto.ts'

const handshake = async (serverCode: string, phoneCode: string) => {
  const deviceId = phone.randomId()
  const kp = await phone.phoneKeyPair()
  const srv = server.serverKeyPair()
  const phonePub = Buffer.from(kp.pub)
  const serverKey = server.deriveKey(srv.secret(phonePub), serverCode, deviceId, phonePub, srv.pub)
  const phoneRaw = await phone.deriveSessionKey(kp.privateKey, new Uint8Array(srv.pub), phoneCode, deviceId, kp.pub)
  return { serverKey, phoneRaw, phoneKey: await phone.aesKey(phoneRaw) }
}

test('pairing: both sides derive the same key from ECDH and the code', async () => {
  const code = server.newPairingCode()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  // People type codes loosely: lower case, no dashes, O for 0.
  const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')
  const { serverKey, phoneRaw } = await handshake(code, typed)
  assert.equal(Buffer.from(phoneRaw).toString('hex'), serverKey.toString('hex'))
})

test('pairing: a wrong code gives a different key, so the phone cannot talk to the computer', async () => {
  const { serverKey, phoneKey } = await handshake('AAAA-BBBB-CCCC', 'AAAA-BBBB-CCCD')
  const box = await phone.seal(phoneKey, { ts: Date.now(), n: 'x' })
  assert.throws(() => server.unseal(serverKey, box))
})

test('sealed messages travel both ways and tampering is detected', async () => {
  const { serverKey, phoneKey } = await handshake('K7QM-2XZ4-9PVR', 'K7QM-2XZ4-9PVR')
  const req = await phone.seal(phoneKey, { ...phone.envelope(), ch: 'conv:list', a: [] })
  assert.equal(server.unseal<{ ch: string }>(serverKey, req).ch, 'conv:list')
  const res = server.seal(serverKey, { ok: true, r: ['ünïcode ✓', 42] })
  assert.deepEqual(await phone.unseal(phoneKey, res), { ok: true, r: ['ünïcode ✓', 42] })
  const ct = Buffer.from(req.ct, 'base64url')
  ct[3] ^= 1
  assert.throws(() => server.unseal(serverKey, { iv: req.iv, ct: ct.toString('base64url') }))
  const file = Buffer.from('fake png bytes'.repeat(1000))
  const sealed = server.sealBytes(serverKey, file)
  const back = Buffer.from(await phone.unsealBytes(phoneKey, sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength)))
  assert.ok(back.equals(file))
})

test('only private and local network addresses may connect', () => {
  for (const a of ['192.168.1.20', '::ffff:10.0.0.7', '172.16.5.1', '172.31.255.1', '127.0.0.1', '::1', '100.101.102.103', 'fd12:3456::1', 'fe80::1', '169.254.3.3']) {
    assert.equal(server.isPrivateAddress(a), true, a)
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '::ffff:1.1.1.1', '', undefined]) {
    assert.equal(server.isPrivateAddress(a), false, String(a))
  }
})

test('code normalisation is the same on both sides', () => {
  for (const c of ['abcd-efgh-jkmn', 'O0Il-uv12', ' k7qm 2xz4 9pvr ']) assert.equal(phone.normalizeCode(c), server.normalizeCode(c))
})
