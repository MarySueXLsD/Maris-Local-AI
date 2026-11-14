// End-to-end test of "Connect from anywhere": the phone app (mobile/www in Edge, as a Pixel 7) pairs and
// works with Maris through the relay, with the home network out of reach. A stand-in relay
// (fixtures/mock-relay.mjs) runs the same room rules as the real one.
// Usage: npm run build && npm run mobile:build && node tests/e2e/link-relay.mjs <shotsDir>
import { chromium, devices } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { launch, makeProfile, removeProfile, root } from './fixtures/app.mjs'
import { startRelay } from './fixtures/mock-relay.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return undefined
    await sleep(step)
  }
}

/** Serve mobile/www like the app's WebView does (http://localhost, a secure context). */
function serveBundle() {
  const www = path.join(root, 'mobile', 'www')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.join(www, rel)
    if (!file.startsWith(www) || !existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://localhost:${server.address().port}/` })))
}

const relay = await startRelay()
// Another port than 7341: the person's own Maris may be running with its phone link on.
const linkPort = 7359
const profile = makeProfile('relay', { link: { enabled: true, port: linkPort, allowApprovals: true, anywhere: true, relayUrl: relay.url } })
const { app, win, logs } = await launch(profile, { MARIS_LINK_HOST: '127.0.0.1' })
const proc = app.process()
let browser
let bundle
try {
  // ---- The computer connects out to the relay by itself.
  const st = await until(async () => {
    const s = await win.evaluate(() => window.maris.link.status())
    return s.relay?.state === 'online' ? s : undefined
  })
  check(Boolean(st), `Maris connected to the relay (${st?.relay?.url})`)
  const rooms = relay.members()
  check(Object.values(rooms).some((tags) => tags.some((t) => t.includes('pc'))), 'the relay has the computer in a room')

  // ---- Pairing code with the relay in it; the home network is made unreachable (port 1).
  const pairing = (await win.evaluate(() => window.maris.link.startPairing())).pairing
  check(/&r=ws/.test(pairing.url) && /&m=[A-Za-z0-9_-]{43}/.test(pairing.url), 'the pairing code carries the relay and room')
  const away = pairing.url.replace(/([?&])h=[^&]*/, '$1h=127.0.0.1').replace(/([?&])p=\d+/, '$1p=1')

  bundle = await serveBundle()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
  page.on('pageerror', (e) => console.log('[phone pageerror]', e.message))
  await page.goto(`${bundle.url}?pair=${encodeURIComponent(away)}`)
  const composer = page.locator('textarea[aria-label="Message Maris"]')
  const paired = await composer.waitFor({ timeout: 90000 }).then(() => true).catch(() => false)
  check(paired, 'the phone paired and opened Maris through the relay')
  await page.screenshot({ path: path.join(shots, 'relay-01-phone.png') })

  const viaRelay = await until(async () => {
    const s = await win.evaluate(() => window.maris.link.status())
    return s.devices.find((d) => d.online && d.via === 'relay')
  })
  check(Boolean(viaRelay), `the computer lists the phone as connected through the relay (${viaRelay?.name})`)
  check(relay.stats.frames > 0, `frames passed the relay (${relay.stats.frames})`)

  // ---- Calls and updates over the relay.
  const density = await page.evaluate(async () => (await window.maris.settings.get()).ui.density)
  check(density === 'comfortable', 'a call from the phone came back through the relay')
  await page.evaluate(() => {
    window.__densities = []
    window.maris.settings.onChange((s) => window.__densities.push(s.ui.density))
  })
  await win.evaluate(() => window.maris.settings.set({ ui: { density: 'compact' } }))
  const got = await until(() => page.evaluate(() => window.__densities.includes('compact')), 10000)
  check(Boolean(got), 'an update from the computer reached the phone through the relay')

  // ---- A picture bigger than one relay message comes over in parts.
  const userData = profile
  const picture = path.join(userData, 'pasted', 'big-relay-test.png')
  mkdirSync(path.dirname(picture), { recursive: true })
  const bytes = Buffer.alloc(1_600_000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255
  writeFileSync(picture, bytes)
  // The phone page's own rules keep blob: addresses out of fetch(), so the picture is saved as a download and compared.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(async (p) => {
      const a = document.createElement('a')
      a.href = await window.maris.mediaBlob(p)
      a.download = 'big-relay-test.png'
      document.body.append(a)
      a.click()
      a.remove()
    }, picture)
  ])
  const received = readFileSync(await download.path())
  check(received.equals(bytes), `a 1.6 MB picture arrived whole in parts (${received.length} bytes, largest relay message ${relay.stats.largest} characters)`)

  // ---- A file from the phone, bigger than one message too.
  const upload = path.join(shots, 'relay-upload.bin')
  writeFileSync(upload, Buffer.alloc(900_000, 7))
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.evaluate(() => void window.maris.files.pick().then((a) => (window.__picked = a)))])
  await chooser.setFiles(upload)
  const picked = await until(() => page.evaluate(() => window.__picked), 30000)
  const savedPath = picked?.[0]?.path
  check(Boolean(savedPath && existsSync(savedPath) && statSync(savedPath).size === 900_000), `a 900 KB file from the phone arrived on the computer (${savedPath ? path.basename(savedPath) : 'nothing'})`)

  // ---- What the phone may not do stays refused through the relay too.
  const refused = await page.evaluate(async () => {
    try {
      await window.maris.app.info()
      return (await window.maris.shell?.reveal?.('C:\\')) ?? 'no reveal'
    } catch (e) {
      return String(e.message ?? e)
    }
  })
  check(/Not available|no reveal|undefined/.test(String(refused)), `desktop-only channels stay refused (${String(refused).slice(0, 60)})`)

  // ---- The relay goes away and comes back: both ends find each other again.
  const port = relay.port
  await relay.close()
  const lost = await until(async () => (await win.evaluate(() => window.maris.link.status())).relay?.state === 'unreachable', 15000)
  check(Boolean(lost), 'the computer notices the relay is gone')
  let relay2
  for (let i = 0; i < 20 && !relay2; i++) relay2 = await startRelay(port).catch(() => sleep(500).then(() => undefined))
  const back = await until(async () => {
    const s = await win.evaluate(() => window.maris.link.status())
    return s.relay?.state === 'online' && s.devices.some((d) => d.online && d.via === 'relay')
  }, 60000, 500)
  check(Boolean(back), 'computer and phone reconnected through the relay by themselves')
  await page.screenshot({ path: path.join(shots, 'relay-02-back.png') })
  await relay2.close()
} catch (e) {
  failures++
  console.log('FAIL', e)
} finally {
  const within = (p, ms) => Promise.race([p.catch(() => undefined), sleep(ms)])
  await within(browser?.close() ?? Promise.resolve(), 15000)
  bundle?.server.close()
  await within(app.close(), 20000)
  if (proc.exitCode === null) proc.kill()
  await within(relay.close(), 5000)
  await sleep(500)
  try {
    removeProfile(profile)
  } catch {
    /* still in use; the temp folder is cleaned up later */
  }
}
if (failures) console.log(logs.slice(-40).join('\n'))
console.log(failures ? `\n${failures} check(s) failed` : '\nAll relay checks passed')
process.exit(failures ? 1 : 0)
