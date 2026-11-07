import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LlmRole, SetupPlan, SetupProgress, SetupTask } from '@shared/types'
import { planToSettings } from '@shared/recommend'
import { invalidateModels } from './agent/agent'
import { cancelInstall, CATALOG, installModel, pulls } from './catalog'
import { ollama } from './engines/ollama'
import { comfy } from './media/comfy'
import { cancelDownload, downloadAll, downloads } from './media/downloader'
import { media } from './media/jobs'
import { packById } from './media/catalog'
import { settings } from './settings'
import { lastScan } from './system/scan'
import { Emitter, errMsg, log } from './util'

/** Runs the downloads a setup plan needs, one at a time, and reports progress to the setup screen. */
class SetupRunner {
  readonly changed = new Emitter<SetupProgress>()
  private state: SetupProgress = { running: false, done: false, tasks: [] }
  private cancelled = false
  private current?: SetupTask

  progress(): SetupProgress {
    return this.state
  }

  private emit(): void {
    this.changed.emit({ ...this.state, tasks: this.state.tasks.map((t) => ({ ...t })) })
  }

  private set(task: SetupTask, patch: Partial<SetupTask>): void {
    Object.assign(task, patch)
    this.emit()
  }

  cancel(): void {
    this.cancelled = true
    const t = this.current
    if (!t) return
    if (t.kind === 'llm') cancelInstall(t.id.slice(4))
    if (t.kind === 'pack') cancelDownload(t.id.slice(5))
    if (t.kind === 'comfy') cancelDownload('comfyui')
    if (t.kind === 'ollama') cancelDownload('ollama')
  }

  /**
   * Save the plan's choices and download what is missing. Roles point at a new model only once
   * it is installed, so Maris keeps working with what it already has while downloads run.
   */
  async apply(plan: SetupPlan): Promise<void> {
    if (this.state.running) throw new Error('Setup is already running')
    this.cancelled = false
    const scan = lastScan()
    const { tiers, contexts, mediaRoles } = planToSettings(plan)
    const installedLlms = new Set(scan?.ollama.models ?? [])
    const llmPicks = [...new Set(Object.entries(tiers).filter(([, v]) => v).map(([, v]) => v))]
    const missingLlms = llmPicks.filter((n) => !installedLlms.has(n))
    const installedPacks = media.installedIds()
    const packPicks = [...new Set(Object.values(mediaRoles).filter(Boolean) as string[])]
    const missingPacks = packPicks.filter((id) => !installedPacks.has(id))
    const needOllama = !ollama.isInstalled() && !(await ollama.version())

    const tasks: SetupTask[] = [{ id: 'settings', label: 'Save your choices', kind: 'settings', status: 'queued' }]
    if (needOllama) tasks.push({ id: 'ollama', label: 'Install Ollama (runs the language models)', kind: 'ollama', status: 'queued' })
    for (const n of missingLlms) {
      const m = CATALOG.find((c) => c.name === n)
      tasks.push({ id: `llm:${n}`, label: m?.label ?? n, kind: 'llm', status: 'queued', total: m ? m.sizeGB * 1e9 : undefined })
    }
    if (missingPacks.length && !comfy.isInstalled()) tasks.push({ id: 'comfy', label: 'Install ComfyUI (runs image and video models)', kind: 'comfy', status: 'queued' })
    for (const id of missingPacks) tasks.push({ id: `pack:${id}`, label: packById(id)?.name ?? id, kind: 'pack', status: 'queued' })
    this.state = { running: true, done: false, tasks }
    this.emit()

    const roleOf = (name: string): LlmRole[] => (Object.entries(tiers) as [LlmRole, string][]).filter(([, v]) => v === name).map(([k]) => k)
    try {
      // ---- 1. settings that do not depend on downloads
      const t0 = tasks[0]
      this.current = t0
      this.set(t0, { status: 'running' })
      const cur = settings.get()
      const readyTiers = Object.fromEntries(Object.entries(tiers).filter(([, v]) => !v || installedLlms.has(v)))
      settings.replace({
        ...cur,
        dataDir: plan.prefs.dataDir || cur.dataDir,
        tiers: { ...cur.tiers, ...readyTiers },
        engine: { ...cur.engine, processing: plan.prefs.processing },
        routing: {
          ...cur.routing,
          contextByTier: {
            ...cur.routing.contextByTier,
            ...(contexts.fast ? { fast: contexts.fast } : {}),
            ...(contexts.balanced ? { balanced: contexts.balanced } : {}),
            ...(contexts.max ? { max: contexts.max } : {})
          },
          codeContext: contexts.code ?? cur.routing.codeContext
        },
        media: {
          ...cur.media,
          roles: Object.fromEntries(Object.entries(mediaRoles).filter(([, id]) => installedPacks.has(id))),
          vramMode: plan.prefs.processing === 'cpu' ? 'cpu' : cur.media.vramMode === 'cpu' ? 'auto' : cur.media.vramMode
        },
        onboarded: true
      })
      this.set(t0, { status: 'done' })

      // ---- 2. Ollama
      const tOllama = tasks.find((t) => t.kind === 'ollama')
      let ollamaOk = !needOllama
      if (tOllama && !this.cancelled) {
        this.current = tOllama
        this.set(tOllama, { status: 'running', detail: 'Starting the installer…' })
        try {
          await this.installOllama(tOllama, scan?.winget ?? true)
          ollamaOk = await ollama.ensureRunning()
          if (!ollamaOk) throw new Error(`Ollama was installed but did not start. Start it from ${process.platform === 'win32' ? 'the Start menu' : process.platform === 'darwin' ? 'your Applications folder' : 'a terminal with "ollama serve"'} and run setup again.`)
          this.set(tOllama, { status: 'done', detail: undefined })
        } catch (e) {
          this.set(tOllama, { status: 'error', error: errMsg(e) })
        }
      } else if (!needOllama) {
        ollamaOk = await ollama.ensureRunning()
      }

      // ---- 3. language models
      for (const t of tasks.filter((x) => x.kind === 'llm')) {
        if (this.cancelled || !ollamaOk) {
          this.set(t, { status: 'skipped', detail: this.cancelled ? 'Cancelled' : 'Ollama is not available' })
          continue
        }
        const name = t.id.slice(4)
        this.current = t
        this.set(t, { status: 'running', detail: 'Starting download…' })
        const off = pulls.on((p) => {
          if (p.model !== name) return
          if (p.total) this.set(t, { received: p.completed ?? 0, total: p.total, detail: p.status })
          else this.set(t, { detail: p.status })
        })
        try {
          await installModel(name)
          invalidateModels()
          const roles = roleOf(name)
          if (roles.length) settings.update({ tiers: Object.fromEntries(roles.map((r) => [r, name])) })
          this.set(t, { status: 'done', detail: undefined, received: t.total })
        } catch (e) {
          this.set(t, { status: this.cancelled ? 'skipped' : 'error', error: this.cancelled ? undefined : errMsg(e) })
        } finally {
          off()
        }
      }

      // ---- 4. ComfyUI and media packs
      const tComfy = tasks.find((t) => t.kind === 'comfy')
      let comfyOk = comfy.isInstalled()
      const watch = (task: SetupTask, id: string) =>
        downloads.on((d) => {
          if (d.id !== id) return
          if (d.totalBytes) this.set(task, { received: d.receivedBytes, total: d.totalBytes, detail: d.label })
        })
      if (tComfy) {
        if (this.cancelled) this.set(tComfy, { status: 'skipped', detail: 'Cancelled' })
        else {
          this.current = tComfy
          this.set(tComfy, { status: 'running', detail: 'Downloading…' })
          const off = watch(tComfy, 'comfyui')
          try {
            await comfy.install(scan?.gpu?.comfy)
            comfyOk = true
            this.set(tComfy, { status: 'done', detail: undefined })
          } catch (e) {
            this.set(tComfy, { status: 'error', error: errMsg(e) })
          } finally {
            off()
          }
        }
      }
      for (const t of tasks.filter((x) => x.kind === 'pack')) {
        if (this.cancelled || !comfyOk) {
          this.set(t, { status: 'skipped', detail: this.cancelled ? 'Cancelled' : 'ComfyUI is not available' })
          continue
        }
        const id = t.id.slice(5)
        this.current = t
        this.set(t, { status: 'running', detail: 'Downloading…' })
        const off = watch(t, id)
        try {
          await media.installPack(id)
          const roles = Object.entries(mediaRoles).filter(([, v]) => v === id)
          if (roles.length) {
            const cur2 = settings.get()
            settings.replace({ ...cur2, media: { ...cur2.media, roles: { ...cur2.media.roles, ...Object.fromEntries(roles) } } })
          }
          this.set(t, { status: 'done', detail: undefined })
        } catch (e) {
          this.set(t, { status: this.cancelled ? 'skipped' : 'error', error: this.cancelled ? undefined : errMsg(e) })
        } finally {
          off()
        }
      }
      const failed = tasks.filter((t) => t.status === 'error')
      this.state = {
        running: false,
        done: true,
        tasks,
        error: failed.length ? `${failed.length} step${failed.length > 1 ? 's' : ''} did not finish. You can retry from Settings → Run setup again.` : undefined
      }
      this.emit()
    } catch (e) {
      log.warn('setup', e)
      this.state = { running: false, done: true, tasks, error: errMsg(e) }
      this.emit()
    } finally {
      this.current = undefined
    }
  }

  /** macOS: the official app goes into ~/Applications (no administrator password needed). */
  private async installOllamaMac(task: SetupTask): Promise<void> {
    const dir = path.join(settings.get().dataDir, 'downloads')
    await fs.mkdir(dir, { recursive: true })
    const zip = path.join(dir, 'Ollama-darwin.zip')
    const off = downloads.on((d) => {
      if (d.id === 'ollama' && d.totalBytes) this.set(task, { received: d.receivedBytes, total: d.totalBytes, detail: 'Downloading Ollama…' })
    })
    try {
      await downloadAll('ollama', 'Ollama', [{ url: 'https://ollama.com/download/Ollama-darwin.zip', dest: zip }])
    } finally {
      off()
    }
    this.set(task, { detail: 'Unpacking…', received: undefined, total: undefined })
    const apps = path.join(os.homedir(), 'Applications')
    await fs.mkdir(apps, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      // ditto keeps the app's code signature intact, which unzip does not always do.
      const p = spawn('ditto', ['-x', '-k', zip, apps])
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking Ollama failed (exit ${code})`))))
    })
    await fs.rm(zip, { force: true }).catch(() => undefined)
    if (!ollama.isInstalled()) throw new Error('Ollama did not install. Download it from ollama.com and run setup again.')
  }

  /**
   * Linux: the official install script, which also sets up GPU libraries and a background service.
   * It needs administrator rights, so the desktop's own password prompt (pkexec) appears.
   */
  private async installOllamaLinux(task: SetupTask): Promise<void> {
    this.set(task, { detail: 'Installing — enter your password in the window that opens…' })
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const p = spawn('pkexec', ['sh', '-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } })
      let text = ''
      const onData = (d: Buffer): void => {
        text = (text + d.toString()).slice(-4000)
        const line = text.trim().split('\n').pop()?.replace(/[#=\s]+$/, '').trim()
        if (line) this.set(task, { detail: line.slice(0, 120) })
      }
      p.stdout.on('data', onData)
      p.stderr.on('data', onData)
      p.on('error', () => resolve({ code: -1, text: 'pkexec is not available' }))
      p.on('close', (code) => resolve({ code, text }))
    })
    if (ollama.isInstalled()) return
    if (out.code === 126 || out.code === 127) throw new Error('Installing Ollama needs your password. Run setup again and enter it, or install Ollama from ollama.com.')
    throw new Error(`Ollama did not install (${out.text.trim().split('\n').pop() || `exit ${out.code}`}). In a terminal run: curl -fsSL https://ollama.com/install.sh | sh`)
  }

  /** Install Ollama for this user: winget when present, otherwise the official installer. */
  private async installOllama(task: SetupTask, winget: boolean): Promise<void> {
    if (process.platform === 'darwin') return this.installOllamaMac(task)
    if (process.platform === 'linux') return this.installOllamaLinux(task)
    if (winget) {
      this.set(task, { detail: 'Installing with winget…' })
      const code = await new Promise<number | null>((resolve) => {
        const p = spawn(
          'winget',
          ['install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
          { windowsHide: true }
        )
        p.on('error', () => resolve(-1))
        p.on('close', resolve)
      })
      if (ollama.isInstalled()) return
      log.warn('setup', `winget install Ollama exited with ${code}; falling back to the installer`)
    }
    const dir = path.join(settings.get().dataDir, 'downloads')
    await fs.mkdir(dir, { recursive: true })
    const exe = path.join(dir, 'OllamaSetup.exe')
    const off = downloads.on((d) => {
      if (d.id === 'ollama' && d.totalBytes) this.set(task, { received: d.receivedBytes, total: d.totalBytes, detail: 'Downloading the installer…' })
    })
    try {
      await downloadAll('ollama', 'Ollama', [{ url: 'https://ollama.com/download/OllamaSetup.exe', dest: exe }])
    } finally {
      off()
    }
    this.set(task, { detail: 'Running the installer…', received: undefined, total: undefined })
    await new Promise<void>((resolve, reject) => {
      const p = spawn(exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], { windowsHide: true })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`The Ollama installer exited with code ${code}`))))
    })
    await fs.rm(exe, { force: true }).catch(() => undefined)
    if (!ollama.isInstalled() && !existsSync(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama'))) {
      throw new Error('Ollama did not install. Download it from ollama.com and run setup again.')
    }
  }
}

export const setup = new SetupRunner()
