// End-to-end test of Maris Link (the phone app's connection), against the real app.
// Usage: npm run build && node tests/e2e/link.mjs <shotsDir> [--hold]
//   MARIS_EXE=<Maris.exe> tests the packaged app. --hold keeps the app running after the checks with a
//   fresh pairing code written to <shotsDir>/pairing.json, for pairing a real phone or an emulator
//   (the link listens on 127.0.0.1 only; an Android emulator reaches it at 10.0.2.2). Create
//   <shotsDir>/done to close the app.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as phone from '../../src/renderer/remote/crypto.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
const hold = process.argv.includes('--hold')
mkdirSync(shots, { recursive: true })
rmSync(path.join(shots, 'done'), { force: true })
const profile = path.join(os.tmpdir(), `maris-link-${Date.now()}`)
const port = 7341

const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile, MARIS_LINK_HOST: '127.0.0.1', ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000
})
const win = await app.firstWindow()
const logs = []
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
const shot = async (name) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot', name)
}
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

const base = `http://127.0.0.1:${port}`
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** The phone's pairing steps, with the phone app's own crypto code. */
async function pairPhone(code, name) {
  const deviceId = phone.randomId(18)
  const kp = await phone.phoneKeyPair()
  const start = await post('/api/pair/start', { d: deviceId, name, pub: phone.b64u.enc(kp.pub) })
  const sj = await start.json()
  if (!start.ok) return { ok: false, status: start.status, error: sj.error }
  const raw = await phone.deriveSessionKey(kp.privateKey, phone.b64u.dec(sj.pub), code, deviceId, kp.pub)
  const key = await phone.aesKey(raw)
  const fin = await post('/api/pair/finish', { d: deviceId, ...(await phone.seal(key, { ...phone.envelope(), name })) })
  const fj = await fin.json()
  if (!fin.ok) return { ok: false, status: fin.status, error: fj.error }
  return { ok: true, deviceId, key, info: await phone.unseal(key, fj) }
}

async function call(dev, ch, args = [], box) {
  const sealed = box ?? (await phone.seal(dev.key, { ...phone.envelope(), ch, a: args }))
  const r = await post('/api/invoke', { d: dev.deviceId, ...sealed })
  if (!r.ok) return { status: r.status, sealed }
  return { status: r.status, sealed, out: await phone.unseal(dev.key, await r.json()) }
}

try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)

  // ---- Off by default: nothing listens.
  check(!(await fetch(`${base}/api/hello`).then(() => true).catch(() => false)), 'link is off by default (nothing listening)')

  // ---- Turn it on in Settings → Phone, like a person would.
  await win.keyboard.press('Control+,')
  await win.getByRole('button', { name: 'Phone' }).first().click()
  await win.waitForTimeout(400)
  await win.getByRole('switch', { name: /Allow the phone app to connect/ }).click()
  await win.waitForTimeout(800)
  const hello = await fetch(`${base}/api/hello`).then((r) => r.json()).catch(() => undefined)
  check(hello?.app === 'maris' && hello.pairing === false, `link answers after turning it on (${JSON.stringify(hello)})`)
  check((await post('/api/pair/start', { d: phone.randomId(18), name: 'x', pub: 'AA' })).status === 409, 'pairing is refused until "Pair a phone" is pressed')

  await win.getByRole('button', { name: 'Pair a phone' }).click()
  const codeEl = win.locator('dd.font-mono').last()
  await codeEl.waitFor({ timeout: 5000 })
  const code = (await codeEl.innerText()).trim()
  check(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code), `pairing code shown: ${code}`)
  await shot('link-01-pairing')

  // ---- A wrong code fails and does not pair.
  const wrong = await pairPhone(code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), 'Attacker')
  check(!wrong.ok && wrong.status === 403, `wrong code refused (${wrong.status}: ${wrong.error})`)

  // ---- The right code pairs.
  const dev = await pairPhone(code.toLowerCase(), 'Test phone')
  check(dev.ok && dev.info?.ok === true, `phone paired with the shown code (host ${dev.info?.host}, ${dev.info?.platform})`)
  await win.waitForTimeout(500)
  check(await win.getByText('Test phone').isVisible(), 'paired phone listed in Settings → Phone')
  check(!(await win.locator('dd.font-mono').last().isVisible().catch(() => false)) || (await win.getByRole('button', { name: 'Pair a phone' }).isVisible()), 'the code is used up after pairing')
  await shot('link-02-paired')

  // ---- Calls work and are encrypted both ways.
  const info = await call(dev, 'app:info')
  check(info.out?.ok && typeof info.out.r?.version === 'string', `call app:info → ${info.out?.r?.version}`)
  const convs = await call(dev, 'conv:list')
  check(convs.out?.ok && Array.isArray(convs.out.r), `call conv:list → ${convs.out?.r?.length} conversation(s)`)

  // ---- Replaying a captured request is refused.
  const replay = await call(dev, '', [], info.sealed)
  check(replay.status === 409, `replayed request refused (${replay.status})`)

  // ---- Computer-only and pairing channels are refused.
  for (const ch of ['files:pick', 'shell:openPath', 'link:startPairing', 'setup:apply', 'settings:pickFolder', 'updates:download', 'updates:install', 'skills:pickFolder', 'admin:status', 'admin:setToken', 'admin:publish', 'admin:remove']) {
    const r = await call(dev, ch, [])
    check(r.out && r.out.ok === false, `${ch} refused from the phone (${r.out?.e})`)
  }

  // ---- The phone cannot change the link settings.
  await call(dev, 'settings:set', [{ link: { enabled: false }, ui: { density: 'compact' } }])
  const st = await call(dev, 'settings:get')
  check(st.out?.r?.link?.enabled === true && st.out?.r?.ui?.density === 'compact', 'settings from the phone apply, except link settings')
  await call(dev, 'settings:set', [{ updates: { repo: 'someone/else', admin: true, intervalHours: 12 } }])
  const up = (await call(dev, 'settings:get')).out?.r?.updates
  check(up?.repo !== 'someone/else' && up?.admin === false && up?.intervalHours === 12, 'the phone cannot change where updates come from or open the Admin page')

  // ---- Events arrive over the encrypted stream.
  const evBox = await phone.seal(dev.key, phone.envelope())
  const ctl = new AbortController()
  const events = []
  const evRes = await fetch(`${base}/api/events?${new URLSearchParams({ d: dev.deviceId, iv: evBox.iv, ct: evBox.ct })}`, { signal: ctl.signal })
  check(evRes.ok, 'event stream opened')
  const reader = evRes.body.getReader()
  const dec = new TextDecoder()
  const pump = (async () => {
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
          if (data) events.push(await phone.unseal(dev.key, JSON.parse(data)))
        }
      }
    } catch {
      /* aborted */
    }
  })()
  await win.waitForTimeout(4500)
  check(events.some((e) => e.ch === 'system:status'), `live status events received (${events.length} event(s))`)
  check(!events.some((e) => e.ch.startsWith('link:')), 'link status (with codes) is never sent to phones')
  await shot('link-03-connected')

  // ---- A tampered request is refused.
  const good = await phone.seal(dev.key, { ...phone.envelope(), ch: 'conv:list', a: [] })
  const ct = Buffer.from(good.ct, 'base64url')
  ct[5] ^= 1
  const tampered = await post('/api/invoke', { d: dev.deviceId, iv: good.iv, ct: ct.toString('base64url') })
  check(tampered.status === 401, `tampered request refused (${tampered.status})`)

  // ---- Removing the phone cuts it off.
  ctl.abort()
  await pump
  if (hold) {
    // Pair a real phone or the emulator now.
    await win.getByRole('button', { name: 'Pair a phone' }).click()
    await win.locator('dd.font-mono').last().waitFor({ timeout: 5000 })
    const holdCode = (await win.locator('dd.font-mono').last().innerText()).trim()
    writeFileSync(path.join(shots, 'pairing.json'), JSON.stringify({ code: holdCode, port, emulatorAddress: `10.0.2.2:${port}` }, null, 2))
    console.log(`HOLD pairing code ${holdCode} — create ${path.join(shots, 'done')} to finish`)
    while (!existsSync(path.join(shots, 'done'))) await new Promise((r) => setTimeout(r, 1000))
    await shot('link-05-after-phone')
  }
  await win.getByRole('button', { name: 'Remove Test phone' }).click()
  await win.getByRole('button', { name: 'Remove', exact: true }).click()
  await win.waitForTimeout(400)
  const after = await call(dev, 'conv:list')
  check(after.status === 401, `removed phone can no longer connect (${after.status})`)
  await shot('link-04-removed')
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('link-error').catch(() => undefined)
} finally {
  if (logs.length) console.log(logs.slice(-20).join('\n'))
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all link checks passed')
process.exit(failures ? 1 : 0)
