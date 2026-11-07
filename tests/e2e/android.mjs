// Drives the Maris phone app on an Android emulator (or a USB phone) and pairs it with a running Maris.
// 1. node tests/e2e/link.mjs <shotsDir> --hold      (desktop app, waits with a pairing code)
// 2. node tests/e2e/android.mjs <shotsDir> [address] (this script; default address 10.0.2.2:7341)
// The app's WebView is reached through Chrome DevTools (debug builds allow it); screenshots come from
// the device itself, so they show the real system bars.
// --browser runs the same phone bundle (mobile/www) in Edge with Android phone emulation instead,
// for machines where the emulator cannot run; the address then defaults to 127.0.0.1:7341.
import { chromium, devices } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const browserMode = process.argv.includes('--browser')
const shots = path.resolve(positional[0] ?? path.join(os.tmpdir(), 'maris-shots'))
const address = positional[1] ?? (browserMode ? '127.0.0.1:7341' : '10.0.2.2:7341')
mkdirSync(shots, { recursive: true })
const sdk = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Android', 'Sdk')
const adbPath = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
const adb = (...args) => execFileSync(adbPath, args, { encoding: 'utf8', timeout: 120000 })
const apk = path.join(root, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
let page
const deviceShot = async (name) => {
  if (browserMode) await page.screenshot({ path: path.join(shots, `${name}.png`) })
  else writeFileSync(path.join(shots, `${name}.png`), execFileSync(adbPath, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 2 ** 20, timeout: 30000 }))
  console.log('shot', name)
}

/** Serve mobile/www like the app's WebView does (http://localhost, a secure context). */
function serveBundle() {
  const www = path.join(root, 'mobile', 'www')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.join(www, rel)
    if (!file.startsWith(www) || !existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://localhost:${server.address().port}/` })))
}

const pairing = JSON.parse(readFileSync(path.join(shots, 'pairing.json'), 'utf8'))
const work = path.join(shots, 'work')
mkdirSync(work, { recursive: true })

let browser
let bundle
try {
  if (browserMode) {
    bundle = await serveBundle()
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const ctx = await browser.newContext({ ...devices['Pixel 7'] })
    page = await ctx.newPage()
    await page.goto(bundle.url)
  } else {
    adb('install', '-r', apk)
    adb('shell', 'pm', 'clear', 'app.maris.remote')
    adb('shell', 'am', 'start', '-n', 'app.maris.remote/.MainActivity')
    // The WebView's DevTools socket appears once the page has loaded.
    let socket
    for (let i = 0; i < 60 && !socket; i++) {
      await sleep(1000)
      socket = /@(webview_devtools_remote_\d+)/.exec(adb('shell', 'cat', '/proc/net/unix'))?.[1]
    }
    if (!socket) throw new Error('WebView DevTools socket not found (is this a debug build?)')
    adb('forward', 'tcp:9333', `localabstract:${socket}`)
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
    page = browser.contexts()[0].pages()[0]
  }
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  // ---- Pairing screen
  await page.getByRole('heading', { name: 'Connect to your computer' }).waitFor({ timeout: 30000 })
  await sleep(800)
  await deviceShot('phone-01-pair')
  await page.getByPlaceholder('192.168.1.20:7341').fill(address)
  await page.getByPlaceholder('XXXX-XXXX-XXXX').fill(pairing.code)
  await page.getByRole('button', { name: 'Connect' }).click()

  // ---- Connected: the normal interface over the link
  const composer = page.locator('textarea[aria-label="Message Maris"]')
  await composer.waitFor({ timeout: 60000 })
  await sleep(1500)
  check(true, 'paired and the interface loaded over the encrypted link')
  await deviceShot('phone-02-chat')

  // Sidebar slides over the page on a phone.
  await page.getByRole('button', { name: 'Show sidebar' }).first().click()
  await sleep(600)
  await deviceShot('phone-03-sidebar')
  await page.getByRole('button', { name: /Settings/ }).first().click()
  await sleep(800)
  check(!(await page.getByRole('button', { name: 'Close menu' }).isVisible().catch(() => false)), 'menu closes after choosing a page')
  await deviceShot('phone-04-settings')
  check(!(await page.getByRole('button', { name: 'Phone', exact: true }).isVisible().catch(() => false)), 'the Phone settings section is hidden in the phone app')

  // Back to chat and ask something.
  await page.getByRole('button', { name: 'Show sidebar' }).first().click()
  await sleep(400)
  await page.getByRole('button', { name: /New chat/ }).first().click()
  await composer.waitFor()
  await composer.fill('Hi! In one short sentence, who are you?')
  await composer.press('Enter')
  await page.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined)
  await page.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 300000 })
  await sleep(800)
  const answer = (await page.locator('.prose-maris').last().innerText().catch(() => '')).trim()
  check(answer.length > 5, `answer streamed to the phone: ${answer.replace(/\s+/g, ' ').slice(0, 100)}`)
  await deviceShot('phone-05-answer')

  // ---- A change on the computer, approved from the phone.
  const target = path.join(work, 'from-phone.txt')
  rmSync(target, { force: true })
  await page.getByRole('button', { name: 'Show sidebar' }).first().click()
  await sleep(400)
  await page.getByRole('button', { name: /New chat/ }).first().click()
  await composer.fill(`Create a text file at ${target} containing exactly this text: Hello from the phone`)
  await composer.press('Enter')
  const panel = page.locator('[role="group"][aria-label^="Approval needed"]')
  await panel.waitFor({ timeout: 300000 })
  await sleep(600)
  check(!existsSync(target), 'nothing changes on the computer before approval')
  await deviceShot('phone-06-approval')
  await panel.getByRole('button', { name: /^Approve/ }).first().click()
  await page.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 300000 })
  await sleep(800)
  check(existsSync(target) && /Hello from the phone/.test(readFileSync(target, 'utf8')), 'file created on the computer after approving on the phone')
  await deviceShot('phone-07-approved')
} catch (e) {
  failures++
  console.error('ERROR', e)
  try {
    await deviceShot('phone-error')
  } catch {
    /* no device */
  }
} finally {
  await browser?.close().catch(() => undefined)
  bundle?.server.close()
  writeFileSync(path.join(shots, 'done'), '')
}
console.log(failures ? `${failures} check(s) failed` : 'all phone checks passed')
process.exit(failures ? 1 : 0)
