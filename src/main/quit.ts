// Closing Maris. If an answer, a picture, a video or a download is still going, Maris asks before it
// closes. Then it closes completely: what it started is stopped, its models are unloaded and (unless
// turned off in Settings → Engine) the Ollama server is stopped too, so nothing of Maris keeps using
// the graphics card's memory after the window is gone.
import { app, dialog, type BrowserWindow } from 'electron'
import { agent } from './agent/agent'
import { activeInstalls } from './catalog'
import { cliServer } from './cli/server'
import { connectors } from './connectors/connectors'
import { ollama } from './engines/ollama'
import { link } from './link/server'
import { comfy } from './media/comfy'
import { activeDownloads } from './media/downloader'
import { media } from './media/jobs'
import { learner } from './memory/learner'
import { cancelBackground } from './memory/utility'
import { settings } from './settings'
import { setup } from './setup'
import { monitor } from './system/monitor'
import { processes } from './tools/processes'
import { log, sleep } from './util'

type State = 'running' | 'asking' | 'closing' | 'closed'
let state: State = 'running'

interface Hooks {
  window: () => BrowserWindow | undefined
  /** Closing has begun: hide the window and the tray icon so it feels instant. */
  closing: () => void
}
let hooks: Hooks = { window: () => undefined, closing: () => undefined }

export function setQuitHooks(h: Hooks): void {
  hooks = h
}

/** Maris is on its way out: windows may close for real. */
export const isClosing = (): boolean => state === 'closing' || state === 'closed'
/** Everything is stopped; the app may exit. */
export const isClosed = (): boolean => state === 'closed'

const count = (n: number, one: string, many: string): string => (n === 1 ? one : many.replace('#', String(n)))

/** What is still going on, as sentences for the "close anyway?" question. Empty when nothing is. */
export function pendingWork(): string[] {
  const out: string[] = []
  const { answers, media: making } = agent.runningWork()
  if (answers) out.push(count(answers, 'An answer is still being written', '# answers are still being written'))
  const queued = Math.max(making, media.activeCount + media.queuedCount)
  if (queued) out.push(count(queued, 'A picture or video is still being made', '# pictures or videos are still being made or waiting'))
  const downloads = new Set([...activeInstalls(), ...activeDownloads()])
  if (setup.progress().running) out.push('The setup assistant is still downloading and installing')
  else if (downloads.size) out.push(count(downloads.size, 'A download is still running', '# downloads are still running'))
  const started = processes.list().filter((p) => p.running).length
  if (started) out.push(count(started, 'A program Maris started for a project is still running', '# programs Maris started for projects are still running'))
  return out
}

/**
 * A second copy of Maris with its own profile folder (MARIS_USER_DATA: tests, power users) shares the
 * engines with the main copy. It lets go of what it loaded itself and leaves the servers alone, so
 * closing it never pulls Ollama away from under the copy someone is working in.
 */
const guestCopy = (): boolean => Boolean(process.env.MARIS_USER_DATA) && !process.env.MARIS_TEST_OLLAMA_IMAGES

/** Stop everything Maris started and hand the graphics card's memory back. */
async function shutdown(restarting: boolean): Promise<void> {
  const cfg = settings.get()
  const guest = guestCopy()
  try {
    cliServer.stop()
    learner.cancelAll()
    cancelBackground()
    for (const id of agent.runningIds()) agent.stop(id)
    // A stopped answer is saved as far as it got; give that the moment it takes.
    for (let i = 0; i < 30 && agent.runningIds().length; i++) await sleep(50)
    media.cancelAll()
    setup.cancel()
    processes.stopAll()
    link.stop()
    void connectors.stopAll()
    monitor.stop()
    // Pictures and video: Maris's own ComfyUI is stopped. One it did not start (it was already running,
    // or was left over from an earlier session) only lets go of its models.
    if (comfy.ownsProcess()) comfy.stop()
    else if (comfy.isUp() || (!guest && comfy.isInstalled() && (await comfy.ping()))) await Promise.race([comfy.free(), sleep(2500)])
    // Language models: always unloaded; the server itself is stopped unless Maris is about to start again.
    await ollama.shutdown(cfg.engine.stopOllamaOnQuit && !restarting && !guest, guest)
  } catch (e) {
    log.warn('quit', e)
  }
}

/**
 * Close Maris. Asks first when something is still going on (unless `force`), and resolves false when
 * the person chose to keep it open. `restarting`: Maris starts again right away (an update), so the
 * Ollama server is left running.
 */
/**
 * When work is still going on, ask whether to close anyway. True when Maris may close (nothing is
 * going on, or the person said so).
 */
export function confirmQuit(): boolean {
  if (state !== 'running') return state !== 'asking'
  const work = pendingWork()
  if (!work.length) return true
  // Started by a test harness (those start Maris with a debugging port): nobody is there to answer,
  // and a question would hang the run. tests/e2e/quit.mjs asks for the question on purpose.
  if (app.commandLine.hasSwitch('remote-debugging-port') && !process.env.MARIS_TEST_QUIT_PROMPT) return true
  state = 'asking'
  try {
    const w = hooks.window()
    const alive = w && !w.isDestroyed() ? w : undefined
    if (alive) {
      if (alive.isMinimized()) alive.restore()
      alive.show()
      alive.focus()
    }
    const box = {
      type: 'question' as const,
      title: 'Close Maris?',
      message: 'Maris is still working',
      detail: `${work.join('.\n')}.\n\nClosing Maris now stops this.`,
      buttons: ['Keep Maris open', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    return (alive ? dialog.showMessageBoxSync(alive, box) : dialog.showMessageBoxSync(box)) === 1
  } finally {
    state = 'running'
  }
}

export async function requestQuit(opts: { force?: boolean; restarting?: boolean } = {}): Promise<boolean> {
  if (state !== 'running') return state !== 'asking'
  if (!opts.force && !confirmQuit()) return false
  state = 'closing'
  log.info('quit', 'closing Maris')
  try {
    hooks.closing()
  } catch (e) {
    log.warn('quit', e)
  }
  // Never hang on the way out: a stuck engine does not keep Maris from closing.
  await Promise.race([shutdown(Boolean(opts.restarting)), sleep(9000)])
  state = 'closed'
  app.quit()
  return true
}
