// End-to-end test of the status bar's VRAM details: the biggest programs, and ending one after asking.
// The program list comes from a fixture (MARIS_TEST_GPU_PROGRAMS) whose only program is a dummy Node
// process this test starts, so no real program on the computer is ever ended.
// Usage: node tests/e2e/vram.mjs <shotsDir>   (MARIS_EXE=<Maris.exe> for a packaged build)
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const stamp = Date.now()
const profile = path.join(os.tmpdir(), `maris-vram-${stamp}`)
const work = path.join(os.tmpdir(), `maris-vram-work-${stamp}`)
mkdirSync(work, { recursive: true })

// The "program" to end: a Node process that does nothing.
const script = path.join(work, 'gpu-burner.js')
writeFileSync(script, 'setInterval(() => {}, 1000)\n')
const dummy = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true })
let dummyExited = false
dummy.on('exit', () => (dummyExited = true))
const exe = path.basename(process.execPath)

const fixture = path.join(work, 'gpu.json')
const GB = 2 ** 30
const writeFixture = (withDummy) =>
  writeFileSync(
    fixture,
    JSON.stringify({
      session: 1,
      mem: [...(withDummy ? [{ pid: dummy.pid, bytes: 6 * GB }] : []), { pid: 999991, bytes: 2.5 * GB }, { pid: 999992, bytes: 0.25 * GB }],
      procs: [
        ...(withDummy ? [{ pid: dummy.pid, ppid: 999990, name: exe, path: process.execPath, cmd: `"${process.execPath}" "${script}"`, session: 1, description: 'Node.js JavaScript Runtime' }] : []),
        { pid: 999990, ppid: 0, name: 'WindowsTerminal.exe', session: 1 },
        { pid: 999991, ppid: 0, name: 'dwm.exe', session: 1, path: 'C:\\Windows\\System32\\dwm.exe' },
        { pid: 999992, ppid: 0, name: 'explorer.exe', session: 1, path: 'C:\\Windows\\explorer.exe' }
      ],
      // What the dummy "started": named in the confirmation, since ending it ends them too.
      all: [
        { pid: dummy.pid, ppid: 999990, name: exe, created: 2000 },
        { pid: 999993, ppid: dummy.pid, name: 'ffmpeg.exe', created: 3000 },
        { pid: 999994, ppid: dummy.pid, name: 'conhost.exe', created: 3001 }
      ]
    })
  )
writeFixture(true)

const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: {
    ...process.env,
    MARIS_USER_DATA: profile,
    // A 24 GB card that other programs fill: well over half, whatever Ollama has loaded.
    MARIS_TEST_GPU: JSON.stringify({ name: 'Test GPU', utilization: 4, memUsedMB: 24000, memTotalMB: 24576 }),
    MARIS_TEST_GPU_PROGRAMS: fixture
  },
  timeout: 60000
})
const win = await app.firstWindow()
const logs = []
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

try {
  const box = win.locator('textarea[aria-label="Message Maris"]')
  await box.waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)

  // ---- Pointing at VRAM opens the details without taking the keyboard away from the message box
  const seg = win.getByRole('button', { name: /^Video memory:/ })
  await seg.waitFor({ timeout: 20000 })
  await box.click()
  await box.fill('typing something')
  await seg.hover()
  const details = win.getByRole('dialog', { name: 'Video memory details' })
  await details.waitFor({ timeout: 10000 })
  check(true, 'pointing at VRAM shows the details')
  check(await win.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Message Maris'), 'the message box keeps the keyboard')
  check(await details.getByText(/Other programs fill \d+% of it/).isVisible(), 'it says other programs fill more than half')

  // ---- The biggest program, with what it runs, and the system's share without an end button
  const row = details.getByRole('listitem').filter({ hasText: 'Node.js JavaScript Runtime' })
  await row.waitFor({ timeout: 20000 })
  check(await row.getByText(`${exe} running gpu-burner.js`).isVisible(), 'the program shows its file and script')
  check(/6(\.0)? GB/.test(await row.innerText()), `and its memory (${(await row.innerText()).replace(/\s+/g, ' ')})`)
  check(await details.getByText(/Windows itself uses 2\.\d GB \(dwm\.exe, explorer\.exe\)/).isVisible(), "Windows' own share is shown")
  check((await details.getByRole('button', { name: /^End / }).count()) === 1, 'only the program gets an end button, not Windows')
  await win.screenshot({ path: path.join(shots, 'vram-01-details.png') })

  // ---- Ending asks first; "Keep it running" keeps it
  await seg.hover()
  await row.getByRole('button', { name: 'End Node.js JavaScript Runtime' }).click()
  const ask = win.getByRole('dialog', { name: 'End Node.js JavaScript Runtime?' })
  await ask.waitFor({ timeout: 5000 })
  check(await ask.getByText(/Anything unsaved in it is lost/).isVisible(), 'the confirmation says unsaved work is lost')
  const askText = await ask.innerText()
  check(/It also ends what it started:\s*ffmpeg\.exe/.test(askText) && !/conhost/.test(askText), 'and names the other programs that end with it')
  await win.screenshot({ path: path.join(shots, 'vram-02-confirm.png') })
  await ask.getByRole('button', { name: 'Keep it running' }).click()
  await ask.waitFor({ state: 'detached', timeout: 5000 })
  await win.waitForTimeout(500)
  check(alive(dummy.pid) && !dummyExited, '"Keep it running" leaves it running')

  // ---- Confirming ends it
  await seg.click()
  await details.waitFor({ timeout: 10000 })
  await details.getByRole('button', { name: 'End Node.js JavaScript Runtime' }).click()
  await ask.waitFor({ timeout: 5000 })
  await ask.getByRole('button', { name: /^End / }).click()
  const ended = await details.getByText(/Ended Node\.js JavaScript Runtime/).waitFor({ timeout: 20000 }).then(() => true).catch(() => false)
  writeFixture(false)
  for (let i = 0; i < 20 && alive(dummy.pid); i++) await new Promise((r) => setTimeout(r, 250))
  check(ended && !alive(dummy.pid), 'confirming ends the program and says so')
  await win.screenshot({ path: path.join(shots, 'vram-03-ended.png') })

  // ---- A program that is no longer in the list cannot be ended through the API
  const refused = await win.evaluate((pid) => window.maris.system.endProgram(pid).then(() => 'ended', (e) => String(e.message)), 999991)
  check(/not in the list/.test(refused), `a process the list did not offer is refused (${refused.slice(0, 80)})`)
  await win.keyboard.press('Escape')
  await details.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
  check(!(await details.isVisible().catch(() => false)), 'Escape closes the details')
} catch (e) {
  failures++
  console.error('ERROR', e)
  await win.screenshot({ path: path.join(shots, 'vram-error.png') }).catch(() => undefined)
} finally {
  if (logs.length) console.log(logs.slice(-10).join('\n'))
  await app.close().catch(() => undefined)
  if (alive(dummy.pid)) dummy.kill()
  rmSync(profile, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all VRAM checks passed')
process.exit(failures ? 1 : 0)
