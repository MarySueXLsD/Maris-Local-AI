// Starts Maris for a test with a throwaway profile that already holds the settings the test wants,
// so nothing depends on (or touches) the real profile, the real Ollama or any model service.
// Used with fixtures/mock-llm.mjs, which stands in for the engines.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * A new profile folder with settings in place (merged over the defaults when Maris starts).
 * By default the setup assistant is done, nothing is checked online, and closing never stops the
 * Ollama server of the computer the test runs on.
 */
export function makeProfile(name, settings = {}) {
  const dir = path.join(os.tmpdir(), `maris-e2e-${name}-${Date.now()}`)
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const merged = {
    onboarded: true,
    dataDir: path.join(dir, 'data'),
    updates: { check: false, news: false },
    memory: { autoLearn: false },
    ...settings,
    engine: { stopOllamaOnQuit: false, ...(settings.engine ?? {}) }
  }
  const db = new DatabaseSync(path.join(dir, 'maris.db'))
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const put = db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)')
  put.run('settings', JSON.stringify(merged))
  put.run('settings-migrations', JSON.stringify(['steps-unlimited', 'context-32k', 'close-quits']))
  db.close()
  return dir
}

export const removeProfile = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })

/** MARIS_EXE=<path to Maris.exe> tests the packaged app instead of the development build. */
export async function launch(profile, env = {}) {
  const packaged = process.env.MARIS_EXE
  const app = await electron.launch({
    executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
    args: packaged ? [] : [root],
    env: { ...process.env, MARIS_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '1', ...env },
    timeout: 90000
  })
  const logs = []
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[renderer] ${m.text()}`)
  })
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 60000 })
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  const exited = new Promise((resolve) => app.process().once('exit', (code) => resolve(code ?? 0)))
  return { app, win, logs, exited }
}

/** The usual moves in the chat. */
export function driver(win, shots) {
  const composer = () => win.locator('textarea[aria-label="Message Maris"]')
  return {
    composer,
    shot: async (name) => {
      mkdirSync(shots, { recursive: true })
      await win.screenshot({ path: path.join(shots, `${name}.png`) })
      console.log('shot', name)
    },
    send: async (text) => {
      await composer().fill(text)
      await composer().press('Enter')
    },
    waitDone: async (timeout = 60000) => {
      await win.locator('button[aria-label="Stop"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
      await win.locator('button[aria-label="Stop"]').waitFor({ state: 'detached', timeout })
      await win.waitForTimeout(350)
    },
    lastAnswer: async () => (await win.locator('.prose-maris').last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim(),
    newChat: async () => {
      await win.keyboard.press('Control+n')
      await win.waitForTimeout(300)
    },
    /** Choose who answers in this chat, by the name shown in the model menu. */
    pickModel: async (name) => {
      await win.locator('button[aria-label^="Model:"]').click()
      await win.getByRole('menuitem', { name, exact: false }).first().click()
      await win.waitForTimeout(200)
    },
    setSettings: (patch) => win.evaluate((p) => window.__marisStore.getState().updateSettings(p), patch)
  }
}

export function checker() {
  let failures = 0
  return {
    check: (ok, what) => {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
      if (!ok) failures++
      return Boolean(ok)
    },
    get failures() {
      return failures
    }
  }
}
