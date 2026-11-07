// Code-mode end-to-end test: a tiny Python project with a bug and a failing test.
// Maris must run the tests, fix the bug and re-run them. Usage: node tests/e2e/code.mjs <shotsDir>
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
const proj = path.join(shots, 'calc-project')
rmSync(proj, { recursive: true, force: true })
mkdirSync(proj, { recursive: true })
writeFileSync(path.join(proj, 'calc.py'), 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n')
writeFileSync(
  path.join(proj, 'test_calc.py'),
  'import unittest\nfrom calc import add, mul\n\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n    def test_mul(self):\n        self.assertEqual(mul(4, 5), 20)\n\n\nif __name__ == "__main__":\n    unittest.main()\n'
)
writeFileSync(path.join(proj, 'requirements.txt'), '\n')

const profile = path.join(os.tmpdir(), `maris-code-${Date.now()}`)
const app = await electron.launch({
  executablePath: process.env.MARIS_EXE ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: process.env.MARIS_EXE ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile },
  timeout: 90000
})
// Always drain the app's stdout/stderr: on Windows a full pipe blocks the app's main thread.
const drainOutput = (s) => s?.on('data', () => undefined)
drainOutput(app.process().stdout)
drainOutput(app.process().stderr)
const win = await app.firstWindow()
const logs = []
win.on('pageerror', (e) => logs.push(e.message))
const shot = (n) => win.screenshot({ path: path.join(shots, `${n}.png`) }).then(() => console.log('shot', n))
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  // A fresh profile opens the setup assistant; skip it.
  const skipSetup = win.getByRole('button', { name: 'Skip setup for now' })
  await skipSetup.waitFor({ timeout: 30000 }).then(() => skipSetup.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
  await win.getByRole('radio', { name: 'Code' }).click()
  await win.waitForTimeout(400)
  await shot('c1-code-empty')
  await win.evaluate((dir) => window.__marisStore.getState().openProject(dir), proj)
  await win.waitForTimeout(1200)
  await shot('c2-project-open')
  await win.getByRole('switch', { name: 'Auto-approve file edits in this project' }).click()
  const box = win.locator('textarea[aria-label="Message Maris"]')
  await box.fill('Run the tests with: python -m unittest -v   Then fix the bug so that all tests pass, and run the tests again to confirm.')
  await box.press('Enter')

  // Approve test commands with "Always allow" whenever asked; everything else in the project is auto-approved.
  const t0 = Date.now()
  let approvals = 0
  while (Date.now() - t0 < 15 * 60000) {
    const panel = win.locator('[role="group"][aria-label^="Approval needed"]').first()
    if (await panel.isVisible().catch(() => false)) {
      approvals++
      const always = panel.getByRole('button', { name: /Always allow/ })
      if (approvals === 1) await shot('c3-approval')
      if (await always.isVisible().catch(() => false)) await always.click()
      else await panel.getByRole('button', { name: 'Approve' }).click()
      await win.waitForTimeout(800)
      continue
    }
    const busy = await win.locator('button[aria-label="Stop"]').isVisible().catch(() => false)
    if (!busy && Date.now() - t0 > 8000) break
    await win.waitForTimeout(1000)
  }
  console.log(`agent finished in ${Math.round((Date.now() - t0) / 1000)}s after ${approvals} approval prompt(s)`)
  await win.waitForTimeout(800)
  await shot('c4-done')
  // The same answer in Detailed view, then back to Simple.
  await win.getByRole('radio', { name: 'Detailed' }).click()
  await win.waitForTimeout(500)
  await shot('c4b-detailed')
  await win.getByRole('radio', { name: 'Simple' }).click()
  await win.waitForTimeout(300)
  const fixed = readFileSync(path.join(proj, 'calc.py'), 'utf8')
  check(/return\s+a\s*\+\s*b/.test(fixed), 'calc.add was fixed')
  let testsPass = false
  try {
    execFileSync('python', ['-m', 'unittest'], { cwd: proj, stdio: 'pipe' })
    testsPass = true
  } catch {
    testsPass = false
  }
  check(testsPass, 'tests pass after the fix')
  const answer = await win.locator('.prose-maris').last().innerText().catch(() => '')
  console.log('final answer:', answer.replace(/\s+/g, ' ').slice(0, 300))
  await win.getByRole('radio', { name: /^Changes/ }).click()
  await win.waitForTimeout(500)
  await shot('c5-changes')
  await win.getByRole('radio', { name: 'Tools' }).click()
  await win.waitForTimeout(2500)
  await shot('c6-tools')
} catch (e) {
  failures++
  console.log('ERROR', e.message)
  await shot('c9-error').catch(() => undefined)
} finally {
  if (logs.length) console.log('page errors:', logs.slice(-5).join('\n'))
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exit(failures ? 1 : 0)
}
