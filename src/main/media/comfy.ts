import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openAsBlob } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ComfyState, GpuInfo } from '@shared/types'
import { settings } from '../settings'
import { monitor } from '../system/monitor'
import { killTree, runPowerShell } from '../tools/shell'
import { Emitter, log, sleep, uid } from '../util'
import { downloadAll, downloads } from './downloader'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
// Windows: the official portable build. macOS/Linux: ComfyUI's source with a private Python (made by uv).
const FOLDER = IS_WIN ? 'ComfyUI_windows_portable' : 'ComfyUI_maris'

/** PyTorch wheel index per GPU type on Linux (macOS uses the default index, which includes Apple's MPS). */
const TORCH_INDEX: Record<GpuInfo['comfy'], string> = {
  nvidia: 'https://download.pytorch.org/whl/cu128',
  nvidia_cu126: 'https://download.pytorch.org/whl/cu126',
  amd: 'https://download.pytorch.org/whl/rocm6.4',
  intel: 'https://download.pytorch.org/whl/xpu',
  none: 'https://download.pytorch.org/whl/cpu',
  mps: ''
}

function sevenZip(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = (require('7zip-bin') as { path7za: string }).path7za
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

export interface ComfyOutputFile {
  filename: string
  subfolder: string
  type: string
}

class ComfyManager {
  readonly changed = new Emitter<ComfyState>()
  private proc?: ChildProcess
  private logs: string[] = []
  private starting = false
  private installing = false
  private up = false
  readonly clientId = uid()

  root(): string {
    return path.join(settings.get().dataDir, FOLDER)
  }
  python(): string {
    return IS_WIN ? path.join(this.root(), 'python_embeded', 'python.exe') : path.join(this.root(), 'venv', 'bin', 'python')
  }
  comfyDir(): string {
    return path.join(this.root(), 'ComfyUI')
  }
  modelsDir(): string {
    return path.join(this.comfyDir(), 'models')
  }
  outputDir(): string {
    return path.join(this.comfyDir(), 'output')
  }
  base(): string {
    return settings.get().comfyUrl.replace(/\/+$/, '')
  }
  isInstalled(): boolean {
    return existsSync(this.python()) && existsSync(path.join(this.comfyDir(), 'main.py'))
  }
  isUp(): boolean {
    return this.up
  }
  lastLog(): string {
    return this.logs[this.logs.length - 1] ?? ''
  }

  state(): ComfyState {
    return {
      installed: this.isInstalled(),
      dir: this.root(),
      up: this.up,
      starting: this.starting,
      installing: this.installing,
      log: this.logs.slice(-80)
    }
  }

  private emit(): void {
    this.changed.emit(this.state())
  }

  private pushLog(line: string): void {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (!clean) return
    this.logs.push(clean)
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400)
  }

  /**
   * Download and unpack the official ComfyUI portable build for this GPU. `flavor` comes from the
   * PC scan (NVIDIA, NVIDIA with older drivers/cards, AMD, Intel); PCs without a supported GPU get
   * the NVIDIA build, which also runs on the CPU.
   */
  async install(flavor?: GpuInfo['comfy']): Promise<void> {
    if (this.isInstalled()) return
    if (this.installing) throw new Error('Already installing')
    if (!IS_WIN) return this.installPosix(flavor)
    this.installing = true
    this.emit()
    try {
      const gpuName = monitor.snapshot().gpu?.name ?? ''
      const guess: GpuInfo['comfy'] = /nvidia|geforce|rtx|quadro/i.test(gpuName) || !gpuName ? 'nvidia' : /radeon|amd/i.test(gpuName) ? 'amd' : 'intel'
      const want = !flavor || flavor === 'none' ? (flavor === 'none' ? 'nvidia' : guess) : flavor
      const rel = (await (
        await fetch('https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest', {
          headers: { 'User-Agent': 'Maris', Accept: 'application/vnd.github+json' }
        })
      ).json()) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] }
      const asset =
        rel.assets.find((a) => a.name === `ComfyUI_windows_portable_${want}.7z`) ??
        rel.assets.find((a) => a.name === 'ComfyUI_windows_portable_nvidia.7z')
      if (!asset) throw new Error(`No ComfyUI portable build for ${want} in release ${rel.tag_name}`)
      const dataDir = settings.get().dataDir
      await fs.mkdir(dataDir, { recursive: true })
      const archive = path.join(dataDir, 'downloads', asset.name)
      this.pushLog(`Downloading ComfyUI ${rel.tag_name} for ${want} (${Math.round(asset.size / 2 ** 20)} MB)…`)
      await downloadAll('comfyui', `ComfyUI ${rel.tag_name}`, [
        { url: asset.browser_download_url, dest: archive, sizeBytes: asset.size }
      ])
      this.pushLog('Unpacking…')
      this.emit()
      try {
        await this.unpackWithTar(archive, dataDir)
      } catch (e) {
        this.pushLog(`Windows tar could not unpack the archive (${(e as Error).message}); trying 7-Zip…`)
        await this.unpackWith7z(archive, dataDir)
      }
      downloads.emit({ id: 'comfyui', label: 'ComfyUI ready', receivedBytes: 100, totalBytes: 100, done: true })
      await fs.rm(archive, { force: true })
      if (!this.isInstalled()) throw new Error('ComfyUI files are missing after unpacking')
      this.pushLog(`ComfyUI ${rel.tag_name} installed in ${this.root()}`)
    } finally {
      this.installing = false
      this.emit()
    }
  }

  /**
   * macOS and Linux: ComfyUI's release source plus a private Python 3.12 made by uv (a single-file
   * Python manager), with the PyTorch build that fits the GPU. Nothing is installed system-wide.
   */
  private async installPosix(flavor?: GpuInfo['comfy']): Promise<void> {
    if (IS_MAC && process.arch !== 'arm64') throw new Error('Making images and video on a Mac needs an Apple chip (M1 or newer).')
    this.installing = true
    this.emit()
    const stage = (pct: number, label: string): void => {
      this.pushLog(label)
      downloads.emit({ id: 'comfyui', label, receivedBytes: pct, totalBytes: 100 })
      this.emit()
    }
    const root = this.root()
    const dl = path.join(settings.get().dataDir, 'downloads')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: path.join(root, 'python'),
      UV_CACHE_DIR: path.join(dl, 'uv-cache'),
      UV_LINK_MODE: 'copy',
      UV_NO_PROGRESS: '1'
    }
    try {
      const want: GpuInfo['comfy'] = IS_MAC ? 'mps' : flavor ?? 'none'
      const rel = (await (
        await fetch('https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest', { headers: { 'User-Agent': 'Maris', Accept: 'application/vnd.github+json' } })
      ).json()) as { tag_name: string }
      if (!rel.tag_name) throw new Error('Could not look up the latest ComfyUI release')
      await fs.mkdir(dl, { recursive: true })
      const uvTarget = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${IS_MAC ? 'apple-darwin' : 'unknown-linux-gnu'}`
      const uvArchive = path.join(dl, `uv-${uvTarget}.tar.gz`)
      const srcArchive = path.join(dl, `ComfyUI-${rel.tag_name}.tar.gz`)
      this.pushLog(`Downloading ComfyUI ${rel.tag_name} and the Python tools…`)
      await downloadAll('comfyui', `ComfyUI ${rel.tag_name}`, [
        { url: `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvTarget}.tar.gz`, dest: uvArchive },
        { url: `https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/${rel.tag_name}.tar.gz`, dest: srcArchive }
      ])
      stage(5, 'Unpacking ComfyUI…')
      const tools = path.join(root, 'tools')
      await fs.mkdir(tools, { recursive: true })
      await fs.mkdir(this.comfyDir(), { recursive: true })
      await this.exec('tar', ['-xzf', uvArchive, '-C', tools, '--strip-components=1'], env)
      await this.exec('tar', ['-xzf', srcArchive, '-C', this.comfyDir(), '--strip-components=1'], env)
      const uv = path.join(tools, 'uv')
      stage(10, 'Setting up a private Python 3.12…')
      await this.exec(uv, ['venv', '--python', '3.12', path.join(root, 'venv')], env)
      const py = this.python()
      const gpuWord = want === 'mps' ? 'Apple chips' : want === 'none' ? 'the CPU' : want === 'amd' ? 'AMD (ROCm)' : want === 'intel' ? 'Intel Arc' : 'NVIDIA (CUDA)'
      stage(20, `Installing PyTorch for ${gpuWord}. This is a large download and can take a while…`)
      const index = TORCH_INDEX[want] ?? TORCH_INDEX.none
      await this.exec(uv, ['pip', 'install', '--python', py, 'torch', 'torchvision', 'torchaudio', ...(index ? ['--index-url', index] : [])], env)
      stage(80, 'Installing ComfyUI requirements…')
      await this.exec(uv, ['pip', 'install', '--python', py, '-r', path.join(this.comfyDir(), 'requirements.txt')], env)
      stage(97, 'Cleaning up…')
      await Promise.all([uvArchive, srcArchive, path.join(dl, 'uv-cache')].map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)))
      downloads.emit({ id: 'comfyui', label: 'ComfyUI ready', receivedBytes: 100, totalBytes: 100, done: true })
      if (!this.isInstalled()) throw new Error('ComfyUI files are missing after the install')
      this.pushLog(`ComfyUI ${rel.tag_name} installed in ${root}`)
    } finally {
      this.installing = false
      this.emit()
    }
  }

  /** Run a helper program, streaming its output into the ComfyUI log. */
  private exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: this.root(), env })
      const onData = (d: Buffer): void => {
        for (const line of d.toString('utf8').split(/\r?\n/)) this.pushLog(line)
        this.emit()
      }
      p.stdout.on('data', onData)
      p.stderr.on('data', onData)
      p.on('error', reject)
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0]} failed (exit ${code}):\n${this.logs.slice(-6).join('\n')}`))
      )
    })
  }

  /** Windows 10+ ships bsdtar, which reads 7z archives (LZMA2 + BCJ2) without extra tools. */
  private unpackWithTar(archive: string, dest: string): Promise<void> {
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (!existsSync(tar)) return Promise.reject(new Error('tar.exe not found'))
    // The portable build has roughly 70 000 files; tar lists each one as it is written.
    const expected = 70000
    let files = 0
    return new Promise<void>((resolve, reject) => {
      const p = spawn(tar, ['-xvf', archive, '-C', dest], { windowsHide: true })
      const count = (d: Buffer): void => {
        files += d.toString().split('\n').length - 1
        downloads.emit({ id: 'comfyui', label: 'Unpacking ComfyUI', receivedBytes: Math.min(99, Math.round((files / expected) * 100)), totalBytes: 100 })
      }
      p.stdout.on('data', count)
      p.stderr.on('data', count)
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))))
    })
  }

  private unpackWith7z(archive: string, dest: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const p = spawn(sevenZip(), ['x', archive, `-o${dest}`, '-y', '-bsp1'], { windowsHide: true })
      p.stdout.on('data', (d: Buffer) => {
        const m = /(\d+)%/.exec(d.toString())
        if (m) downloads.emit({ id: 'comfyui', label: 'Unpacking ComfyUI', receivedBytes: Number(m[1]), totalBytes: 100 })
      })
      p.stderr.on('data', (d: Buffer) => this.pushLog(d.toString()))
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`7-Zip exited with code ${code}`))))
    })
  }

  /** Launch flags from Settings → Images and video (memory mode and extra arguments). */
  private launchArgs(): string[] {
    const m = settings.get().media
    const mode: Record<string, string | undefined> = { high: '--highvram', normal: '--normalvram', low: '--lowvram', none: '--novram', cpu: '--cpu' }
    const flag = mode[m.vramMode]
    const extra = (m.extraArgs.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''))
    return [...(flag ? [flag] : []), ...extra]
  }

  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base()}/system_stats`, { signal: AbortSignal.timeout(2500) })
      this.up = r.ok
    } catch {
      this.up = false
    }
    return this.up
  }

  async start(): Promise<void> {
    if (await this.ping()) return
    if (!this.isInstalled()) throw new Error('ComfyUI is not installed yet')
    if (this.starting) {
      for (let i = 0; i < 240 && this.starting; i++) await sleep(500)
      if (this.up) return
    }
    this.starting = true
    this.emit()
    try {
      const port = new URL(this.base()).port || '8188'
      this.pushLog('Starting ComfyUI…')
      const p = spawn(
        this.python(),
        [
          '-s',
          path.join('ComfyUI', 'main.py'),
          ...(IS_WIN ? ['--windows-standalone-build'] : []),
          '--listen',
          '127.0.0.1',
          '--port',
          port,
          '--disable-auto-launch',
          '--preview-method',
          'none',
          // ComfyUI would otherwise pin ~40% of system RAM at start-up, which can stall
          // for minutes (or hang) while other programs are using memory.
          '--disable-pinned-memory',
          ...this.launchArgs()
        ],
        {
          cwd: this.root(),
          windowsHide: true,
          // Own process group on macOS/Linux so stop() also ends its worker processes.
          detached: !IS_WIN,
          // On Apple chips, run the few operations MPS lacks on the CPU instead of failing.
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...(IS_MAC ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}) }
        }
      )
      this.proc = p
      const onData = (d: Buffer): void => {
        for (const line of d.toString('utf8').split(/\r?\n/)) this.pushLog(line)
      }
      p.stdout.on('data', onData)
      p.stderr.on('data', onData)
      p.on('exit', (code) => {
        this.pushLog(`ComfyUI exited (${code ?? 'killed'})`)
        this.proc = undefined
        this.up = false
        this.emit()
      })
      // The very first start sets things up (frontend, caches) and can take several minutes.
      const marker = path.join(this.root(), '.maris-started')
      const firstRun = !existsSync(marker)
      const limitMs = (firstRun ? 15 : 5) * 60000
      const t0 = Date.now()
      while (Date.now() - t0 < limitMs) {
        await sleep(500)
        if (!this.proc) throw new Error(`ComfyUI failed to start:\n${this.logs.slice(-12).join('\n')}`)
        if (await this.ping()) break
      }
      if (!this.up) {
        throw new Error(`ComfyUI did not answer within ${limitMs / 60000} minutes. Last output:\n${this.logs.slice(-8).join('\n')}`)
      }
      await fs.writeFile(marker, new Date().toISOString()).catch(() => undefined)
      this.pushLog(`ComfyUI is ready after ${Math.round((Date.now() - t0) / 1000)} s`)
    } finally {
      this.starting = false
      this.emit()
    }
  }

  stop(): void {
    const p = this.proc
    if (p?.pid) killTree(p.pid)
    this.proc = undefined
    this.up = false
    this.emit()
  }

  /**
   * Restart so ComfyUI re-reads its model folders (it caches the lists, and on exFAT drives it
   * does not notice new files). Also stops a stray instance of Maris's own ComfyUI copy.
   */
  async restart(): Promise<void> {
    this.pushLog('Restarting ComfyUI to pick up new models…')
    this.stop()
    if (IS_WIN) {
      const exe = this.python().replace(/'/g, "''")
      await runPowerShell(
        `Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        { timeoutMs: 30000 }
      ).catch(() => undefined)
    } else {
      // Only our own copy: match the full path of Maris's private Python.
      await new Promise<void>((resolve) => {
        const p = spawn('pkill', ['-f', `${this.python()} -s`])
        p.on('error', () => resolve())
        p.on('close', () => resolve())
      })
    }
    for (let i = 0; i < 20 && (await this.ping()); i++) await sleep(500)
    await this.start()
  }

  ownsProcess(): boolean {
    return Boolean(this.proc)
  }

  /** The process id of the ComfyUI that Maris started, if it started one. */
  pid(): number | undefined {
    return this.proc?.pid
  }

  // ------------------------------------------------------------------ API client

  async queue(workflow: unknown): Promise<string> {
    const r = await fetch(`${this.base()}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId })
    })
    const j = (await r.json().catch(() => ({}))) as {
      prompt_id?: string
      error?: { message?: string; details?: string }
      node_errors?: Record<string, { errors?: { message: string; details: string }[]; class_type?: string }>
    }
    if (!r.ok || !j.prompt_id) {
      const nodeErr = Object.values(j.node_errors ?? {})
        .flatMap((n) => (n.errors ?? []).map((e) => `${n.class_type}: ${e.message} ${e.details}`))
        .join('; ')
      throw new Error(`ComfyUI rejected the workflow: ${j.error?.message ?? r.status} ${nodeErr}`.trim())
    }
    return j.prompt_id
  }

  async history(promptId: string): Promise<{ files: ComfyOutputFile[]; status?: string; error?: string }> {
    const r = await fetch(`${this.base()}/history/${promptId}`)
    const j = (await r.json()) as Record<
      string,
      { outputs?: Record<string, Record<string, unknown>>; status?: { status_str?: string; messages?: [string, Record<string, unknown>][] } }
    >
    const h = j[promptId]
    if (!h) return { files: [] }
    const files: ComfyOutputFile[] = []
    for (const out of Object.values(h.outputs ?? {})) {
      for (const v of Object.values(out)) {
        if (!Array.isArray(v)) continue
        for (const item of v) {
          if (item && typeof item === 'object' && 'filename' in item) files.push(item as ComfyOutputFile)
        }
      }
    }
    const errMsg = h.status?.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message
    return { files, status: h.status?.status_str, error: errMsg ? String(errMsg) : undefined }
  }

  outputPath(f: ComfyOutputFile): string {
    const base = f.type === 'input' ? path.join(this.comfyDir(), 'input') : f.type === 'temp' ? path.join(this.comfyDir(), 'temp') : this.outputDir()
    return path.join(base, f.subfolder ?? '', f.filename)
  }

  async upload(filePath: string): Promise<string> {
    const form = new FormData()
    const blob = await openAsBlob(filePath)
    form.append('image', blob, `maris_${Date.now()}${path.extname(filePath) || '.png'}`)
    form.append('overwrite', 'true')
    const r = await fetch(`${this.base()}/upload/image`, { method: 'POST', body: form })
    if (!r.ok) throw new Error(`Image upload failed: HTTP ${r.status}`)
    const j = (await r.json()) as { name: string; subfolder?: string }
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  }

  async free(): Promise<void> {
    try {
      await fetch(`${this.base()}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true })
      })
    } catch (e) {
      log.warn('comfy', 'free failed', e)
    }
  }

  async interrupt(): Promise<void> {
    await fetch(`${this.base()}/interrupt`, { method: 'POST' }).catch(() => undefined)
  }

  async vramMB(): Promise<number> {
    if (!this.up) return 0
    try {
      const r = await fetch(`${this.base()}/system_stats`, { signal: AbortSignal.timeout(2000) })
      const j = (await r.json()) as { devices?: { torch_vram_total?: number }[] }
      return Math.round((j.devices?.[0]?.torch_vram_total ?? 0) / 2 ** 20)
    } catch {
      return 0
    }
  }

  async missingNodes(classes: string[]): Promise<string[]> {
    const missing: string[] = []
    for (const c of new Set(classes)) {
      const r = await fetch(`${this.base()}/object_info/${encodeURIComponent(c)}`).catch(() => undefined)
      const j = r?.ok ? ((await r.json()) as Record<string, unknown>) : {}
      if (!j[c]) missing.push(c)
    }
    return missing
  }

  /** Subscribe to ComfyUI websocket events for this client. */
  connect(onMessage: (type: string, data: Record<string, unknown>) => void): () => void {
    const url = `${this.base().replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`
    const ws = new WebSocket(url)
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const m = JSON.parse(ev.data) as { type: string; data: Record<string, unknown> }
        onMessage(m.type, m.data ?? {})
      } catch {
        /* ignore */
      }
    }
    ws.onerror = () => undefined
    return () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}

export const comfy = new ComfyManager()
