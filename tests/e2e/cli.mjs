// End-to-end test of the maris terminal command against a packaged build and a local model.
// Runs bin\maris.exe (the real launcher) with output piped, so approvals are answered in the app window.
// Usage: npm run dist:dir && MARIS_EXE=release\windows\win-unpacked\Maris.exe node tests/e2e/cli.mjs <shotsDir>
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = process.env.MARIS_EXE
if (!exe) {
  console.error('Set MARIS_EXE to a packaged Maris.exe (the command needs bin\\maris.exe next to it).')
  process.exit(2)
}
const launcher = path.join(path.dirname(exe), 'bin', process.platform === 'win32' ? 'maris.exe' : 'maris')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const stamp = Date.now()
const profile = path.join(os.tmpdir(), `maris-cli-${stamp}`)
const coldProfile = path.join(os.tmpdir(), `maris-cli-cold-${stamp}`)
const project = path.join(os.tmpdir(), `maris-cli-project-${stamp}`)
mkdirSync(project, { recursive: true })

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

/** Run the command; resolves with its output and exit code. onStderr sees the progress lines as they come. */
function maris(args, { input, env = {}, timeout = 300000, onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(launcher, args, { env: { ...process.env, MARIS_USER_DATA: profile, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => {
      stderr += d
      onStderr?.(stderr)
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const app = await electron.launch({
  executablePath: exe,
  env: { ...process.env, MARIS_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000
})
const win = await app.firstWindow()
let coldPid

try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.waitForTimeout(500)

  // ---- basics
  const v = await maris(['--version'])
  check(v.code === 0 && /^maris \d+\.\d+\.\d+/.test(v.stdout), `--version: ${v.stdout.trim()}`)
  const h = await maris(['--help'])
  check(h.code === 0 && h.stdout.includes('maris code [folder]'), '--help goes to standard output')
  const bad = await maris(['--nope'])
  check(bad.code === 2 && /Unknown option/.test(bad.stderr), 'unknown options exit with code 2')
  const st = await maris(['status'])
  check(st.code === 0 && /Maris/.test(st.stderr) && /Memory/.test(st.stderr), 'status shows the app, memory and models')

  // ---- one answer, plain text on stdout
  const sum = await maris(['What is 17 + 25? Reply with just the number.', '--no-web', '--no-think'])
  check(sum.code === 0 && /\b42\b/.test(sum.stdout), `one-shot answer on stdout: ${sum.stdout.trim().slice(0, 60)}`)
  check(!/\x1b\[/.test(sum.stdout), 'no colour codes when the output is piped')

  // ---- piped input
  const piped = await maris(['What is the secret word in this text? Reply with the word only.', '--no-web', '--no-think'], { input: 'Notes from today.\nThe secret word is MAGENTA.\n' })
  check(piped.code === 0 && /magenta/i.test(piped.stdout), `piped input is read: ${piped.stdout.trim().slice(0, 60)}`)

  // ---- Code mode: a change waits for approval; this terminal is not interactive, so approve in the window
  let approved = false
  const task = maris(['code', project, 'Create a file named hello.txt that contains exactly: hi from the terminal', '--no-web'], {
    onStderr: (err) => {
      if (approved || !/Maris wants to/.test(err)) return
      approved = true
      void (async () => {
        await win.waitForTimeout(400)
        const pending = await win.evaluate(() => window.maris.chat.approvals())
        check(pending.length > 0 && !existsSync(path.join(project, 'hello.txt')), 'nothing written before approval')
        for (const a of pending) await win.evaluate((id) => window.maris.chat.approve(id, true), a.id)
      })()
    }
  })
  const done = await task
  check(/Approve or deny it in the Maris window/.test(done.stderr), 'the approval is shown in the terminal')
  check(approved, 'the approval reached the app window')
  check(/Allowed in the Maris window/.test(done.stderr), 'the terminal reports the approval from the window')
  const file = path.join(project, 'hello.txt')
  check(existsSync(file) && /hi from the terminal/i.test(readFileSync(file, 'utf8')), 'file created after approval')
  check(done.code === 0, `code task finished (exit ${done.code})`)

  // ---- the chats from the terminal are in the app
  const convs = await win.evaluate(() => window.maris.conv.list())
  const fromTerminal = convs.filter((c) => c.origin === 'terminal')
  check(fromTerminal.length >= 3, `terminal chats are listed in the app (${fromTerminal.length})`)
  const list = await maris(['chats'])
  check(list.code === 0 && list.stderr.includes(fromTerminal[0].id.slice(0, 6)), 'maris chats lists them with ids')
  const codeChat = fromTerminal.find((c) => c.mode === 'code')
  await maris(['open', codeChat.id.slice(0, 6)])
  await win.waitForTimeout(800)
  const current = await win.evaluate(() => window.__marisStore.getState().currentId)
  check(current === codeChat.id, 'maris open shows the chat in the window')
  await win.screenshot({ path: path.join(shots, 'cli-01-opened-in-app.png') })

  // ---- continue the last terminal chat
  const cont = await maris(['-c', 'What file did you just create? Reply with the file name only.', '--no-web', '--no-think'])
  check(cont.code === 0 && /hello\.txt/i.test(cont.stdout), `-c continues the last terminal chat: ${cont.stdout.trim().slice(0, 60)}`)

  // ---- Maris not running: the command starts it in the background
  const cold = await maris(['What is 3 * 3? Reply with just the number.', '--no-web', '--no-think'], { env: { MARIS_USER_DATA: coldProfile }, timeout: 240000 })
  check(/Starting Maris/.test(cold.stderr) || cold.code === 0, 'starts Maris when it is not running')
  check(cold.code === 0 && cold.stdout.trim().length > 0, `answer from the background Maris: ${cold.stdout.trim().slice(0, 40)}`)
  try {
    coldPid = JSON.parse(readFileSync(path.join(coldProfile, 'cli.json'), 'utf8')).pid
  } catch {
    /* no info file */
  }
  // The launcher ends only the command when it closes, not the Maris the command started.
  let alive = false
  try {
    process.kill(coldPid, 0)
    alive = true
  } catch {
    /* gone */
  }
  check(alive, 'the background Maris keeps running after the command ends')
  const t0 = Date.now()
  const again = await maris(['status'], { env: { MARIS_USER_DATA: coldProfile } })
  check(again.code === 0 && Date.now() - t0 < 5000, `the next command connects to it at once (${Date.now() - t0} ms)`)
} catch (e) {
  failures++
  console.error('ERROR', e)
  await win.screenshot({ path: path.join(shots, 'cli-error.png') }).catch(() => undefined)
} finally {
  await app.close().catch(() => undefined)
  // The background Maris this test started for the cold-start check.
  if (coldPid) {
    try {
      process.kill(coldPid)
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 1500))
  for (const p of [profile, coldProfile, project]) rmSync(p, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all terminal command checks passed')
process.exit(failures ? 1 : 0)
