import './hostPlatform'
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  Tray
} from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { listModels } from './agent/agent'
import { approvals } from './agent/approvals'
import { closeDb, openDb, repo } from './db'
import { ollama } from './engines/ollama'
import { broadcast, registerIpc } from './ipc'
import { comfy } from './media/comfy'
import { media } from './media/jobs'
import { launchAtLoginActive } from './autostart'
import { cliServer } from './cli/server'
import { link } from './link/server'
import { connectors } from './connectors/connectors'
import { skills } from './skills/skills'
import { feed } from './feed/feed'
import { learner } from './memory/learner'
import { memory } from './memory/store'
import { dbPath, ensureDir, userDir } from './paths'
import { IS_MAC, IS_WIN } from './platform'
import { isLite } from './perf'
import { isClosed, isClosing, requestQuit, setQuitHooks } from './quit'
import { settings } from './settings'
import { monitor } from './system/monitor'
import { log } from './util'
import { agent } from './agent/agent'
import { providers } from './engines/providers'
import { themeScheme } from '@shared/themes'

// Tests (and power users) can point Maris at a separate profile folder.
if (process.env.MARIS_USER_DATA) app.setPath('userData', process.env.MARIS_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'maris-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win: BrowserWindow | undefined
let tray: Tray | undefined
/** Sets how often the status bar's readings are taken (see whenReady); called when the window shows or hides. */
let paceMonitor: (() => void) | undefined
let trayHintShown = false
let freeTimer: NodeJS.Timeout | undefined

/**
 * Maris stays in the tray with its window closed: after a minute without work, let go of the graphics
 * card's memory (models load again the next time they are needed).
 */
function freeGpuWhileHidden(): void {
  clearTimeout(freeTimer)
  freeTimer = setTimeout(() => {
    const hidden = !win || win.isDestroyed() || !win.isVisible()
    const idle = agent.runningIds().length === 0 && media.activeCount === 0 && media.queuedCount === 0 && Date.now() - ollama.lastActiveAt > 45000
    if (!hidden || isClosing()) return
    if (!idle) return freeGpuWhileHidden()
    log.info('main', 'the window has been closed for a while: freeing video memory')
    void ollama.unloadAll()
    if (comfy.isUp()) void comfy.free()
  }, 60000)
}

const resource = (name: string): string =>
  app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '../../resources', name)

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

function allowedRoots(): string[] {
  return [
    media.outputsDir(),
    comfy.outputDir(),
    path.join(userDir(), 'pasted'),
    path.join(userDir(), 'uploads'),
    path.join(userDir(), 'news-cache'),
    // Pictures inside the projects the person opened (the project panel previews them).
    ...repo.listProjects().map((p) => p.path)
  ].map((p) => path.resolve(p).toLowerCase())
}

/** Serve generated media to the renderer (only from Maris's own folders), with range support for video seeking. */
function registerMediaProtocol(): void {
  protocol.handle('maris-media', async (req) => {
    const url = new URL(req.url)
    const file = path.resolve(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
    const lower = file.toLowerCase()
    if (!allowedRoots().some((r) => lower.startsWith(r + path.sep)) || !existsSync(file)) {
      return new Response('Not found', { status: 404 })
    }
    const size = statSync(file).size
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = req.headers.get('range')
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
    const r = await net.fetch(pathToFileURL(file).toString())
    return new Response(r.body, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  })
}

function overlayColors(): { color: string; symbolColor: string; height: number } {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: '#00000000', symbolColor: dark ? '#e7e7f2' : '#1d2030', height: 44 }
}

/** Windows 11 backdrop for Settings → Appearance → Window material. */
function materialOf(m: 'mica' | 'acrylic' | 'solid'): 'mica' | 'acrylic' | 'none' {
  return m === 'solid' ? 'none' : m
}

/** macOS: the same setting as a vibrancy effect (Acrylic is the stronger, more see-through one). */
function vibrancyOf(m: 'mica' | 'acrylic' | 'solid'): 'under-window' | 'hud' | null {
  return m === 'solid' ? null : m === 'acrylic' ? 'hud' : 'under-window'
}

/** Window frame per system: macOS keeps its traffic lights (inset), Windows and Linux draw caption buttons over the page. */
function chromeOptions(): Electron.BrowserWindowConstructorOptions {
  // Low-power mode: a solid window, which an old graphics chip draws without effort.
  const material = isLite() ? 'solid' : settings.get().ui.material
  if (IS_MAC) {
    const vibrancy = vibrancyOf(material)
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 15 },
      ...(vibrancy ? { vibrancy, visualEffectState: 'followWindow' as const } : {}),
      backgroundColor: '#00000000'
    }
  }
  if (IS_WIN) return { titleBarStyle: 'hidden', titleBarOverlay: overlayColors(), backgroundMaterial: materialOf(material), backgroundColor: '#00000000' }
  // Linux: no backdrop materials, so the page paints its own background.
  return { titleBarStyle: 'hidden', titleBarOverlay: overlayColors(), backgroundColor: nativeTheme.shouldUseDarkColors ? '#14121c' : '#fbfaff' }
}

/** macOS needs an application menu for ⌘C/⌘V, ⌘Q and the other standard shortcuts. */
function setAppMenu(): void {
  if (!IS_MAC) return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'Command+,',
            click: () => {
              showWindow()
              broadcast('app:command', 'open-settings')
            }
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: 'Quit Maris', accelerator: 'Command+Q', click: () => void requestQuit() }
        ]
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'New Chat',
            accelerator: 'Command+N',
            click: () => {
              showWindow()
              broadcast('app:command', 'new-chat')
            }
          },
          { type: 'separator' },
          { role: 'close' }
        ]
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Maris Help',
            click: () => {
              showWindow()
              broadcast('app:command', 'open-help')
            }
          }
        ]
      }
    ])
  )
}

/** Started by the maris terminal command (or at login): keep the window hidden until it is asked for. */
let startHidden = process.argv.includes('--background')

/** A folder handed over by Explorer's "Open in Maris" (argument --open-project <folder>). */
function projectArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--open-project')
  const dir = i >= 0 ? argv[i + 1] : undefined
  return dir && existsSync(dir) ? dir : undefined
}

/** Open a folder as a Code project in the window. */
function openProjectFromShell(dir: string): void {
  showWindow()
  const send = (): void => broadcast('app:command', `open-project:${dir}`)
  if (win?.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 400))
  else send()
}

function showWindow(): void {
  startHidden = false
  clearTimeout(freeTimer)
  if (isClosing()) return
  if (!win || win.isDestroyed()) createWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'Maris',
    icon: resource('icon.png'),
    ...chromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  win.on('close', (e) => {
    // Maris is on its way out: let the window go.
    if (isClosing()) return
    e.preventDefault()
    const stay = settings.get().ui.closeToTray
    // macOS apps stay in the Dock when their window closes; ⌘Q closes Maris.
    if (stay || IS_MAC) {
      win?.hide()
      freeGpuWhileHidden()
      if (stay && !trayHintShown && Notification.isSupported()) {
        trayHintShown = true
        const where = IS_MAC ? 'the menu bar' : 'the tray'
        new Notification({ title: 'Maris is still running', body: `Find it in ${where}, or press ${settings.get().ui.hotkey}. It frees the graphics card's memory while its window is closed.`, silent: true }).show()
      }
      return
    }
    // Closing the window closes Maris: ask first if something is still going on, then stop everything
    // and hand the graphics card's memory back.
    void requestQuit()
  })
  win.on('focus', () => win?.flashFrame(false))
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', () => paceMonitor?.())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  // macOS menu bar icons are black "template" images that the system tints for light and dark menu bars.
  const template = resource('trayTemplate.png')
  const icon = nativeImage.createFromPath(IS_MAC && existsSync(template) ? template : resource('tray.png'))
  if (IS_MAC) icon.setTemplateImage(true)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Maris — local AI')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Maris', click: showWindow },
      {
        label: 'New chat',
        click: () => {
          showWindow()
          broadcast('app:command', 'new-chat')
        }
      },
      { type: 'separator' },
      {
        label: 'Free GPU memory',
        click: () => {
          void ollama.unloadAll()
          void comfy.free()
        }
      },
      { type: 'separator' },
      { label: 'Quit Maris', click: () => void requestQuit() }
    ])
  )
  // macOS opens the menu on click; Windows and Linux toggle the window and open the menu on right-click.
  if (!IS_MAC) tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()))
}

let currentHotkey = ''
function registerHotkey(accel: string): void {
  if (currentHotkey) globalShortcut.unregister(currentHotkey)
  currentHotkey = ''
  if (!accel) return
  try {
    const ok = globalShortcut.register(accel, () => {
      if (win?.isVisible() && win.isFocused()) win.hide()
      else {
        showWindow()
        broadcast('app:command', 'focus-composer')
      }
    })
    if (ok) currentHotkey = accel
    else log.warn('main', `hotkey ${accel} is taken by another app`)
  } catch (e) {
    log.warn('main', 'invalid hotkey', accel, e)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const dir = projectArg(argv)
    if (dir) openProjectFromShell(dir)
    else if (!argv.includes('--background')) showWindow()
  })
  // macOS: clicking the Dock icon brings the window back.
  app.on('activate', showWindow)
  if (IS_WIN) app.setAppUserModelId('app.maris.local')

  app.whenReady().then(() => {
    ensureDir(userDir())
    // Console output only with a real terminal: writes to a pipe are synchronous on Windows and
    // can freeze the main thread when the reader stalls. The log file always gets everything.
    log.toConsole = Boolean(process.stdout.isTTY)
    log.setFile(path.join(userDir(), 'logs', 'maris.log'))
    log.info('main', `Maris ${app.getVersion()} starting (Electron ${process.versions.electron})`)
    openDb(dbPath())
    const cfg = settings.load()
    void launchAtLoginActive().then((on) => {
      if (on !== undefined && on !== settings.get().ui.launchAtLogin) settings.update({ ui: { launchAtLogin: on } })
    })
    memory.load()
    nativeTheme.themeSource = themeScheme(cfg.ui.palette, cfg.ui.customTheme, cfg.ui.theme)
    registerMediaProtocol()
    registerIpc()
    setQuitHooks({
      window: () => win,
      closing: () => {
        clearTimeout(freeTimer)
        // Out of sight at once; the engines are stopped behind the scenes.
        if (win && !win.isDestroyed()) win.hide()
        tray?.destroy()
        tray = undefined
        globalShortcut.unregisterAll()
      }
    })
    link.apply()
    cliServer.onShow = (id) => {
      showWindow()
      if (id) broadcast('app:command', `open:${id}`)
    }
    cliServer.start()
    // The installer passes --updated when it starts Maris after an update.
    feed.start({ justUpdated: process.argv.includes('--updated') })
    connectors.startAll()
    void skills.cleanLeftovers()
    // A slow computer samples its load less often: every reading costs it a little of the model's time.
    const monitorMs = (s: typeof cfg): number => Math.max(isLite(s) ? 5 : 1, s.system.monitorIntervalSec) * 1000
    monitor.start(monitorMs(cfg))
    // New models of the API services show up by themselves: their lists are read again about once a day.
    setTimeout(() => providers.refreshStale(), 25000)
    setAppMenu()
    createWindow()
    createTray()
    const firstProject = projectArg(process.argv)
    if (firstProject) openProjectFromShell(firstProject)
    registerHotkey(cfg.ui.hotkey)

    approvals.requested.on((req) => {
      if (win && (!win.isVisible() || !win.isFocused())) {
        win.flashFrame(true)
        if (Notification.isSupported()) {
          const n = new Notification({ title: 'Maris needs your OK', body: req.title, urgency: 'critical' })
          n.on('click', showWindow)
          n.show()
        }
      }
    })

    let lastHotkey = cfg.ui.hotkey
    let lastTheme = themeScheme(cfg.ui.palette, cfg.ui.customTheme, cfg.ui.theme)
    settings.changed.on((s) => {
      const scheme = themeScheme(s.ui.palette, s.ui.customTheme, s.ui.theme)
      if (scheme !== lastTheme) {
        lastTheme = scheme
        nativeTheme.themeSource = scheme
      }
      if (s.ui.hotkey !== lastHotkey) {
        lastHotkey = s.ui.hotkey
        registerHotkey(s.ui.hotkey)
      }
      if (s.ui.material !== lastMaterial) {
        lastMaterial = s.ui.material
        try {
          if (IS_WIN) win?.setBackgroundMaterial(materialOf(s.ui.material))
          else if (IS_MAC) win?.setVibrancy(vibrancyOf(s.ui.material))
        } catch (e) {
          log.warn('main', 'background material', e)
        }
      }
      if (s.updates.intervalHours !== lastUpdates.intervalHours) feed.reschedule()
      if (s.updates.repo !== lastUpdates.repo || (s.updates.check && !lastUpdates.check) || (s.updates.news && !lastUpdates.news)) void feed.refresh()
      lastUpdates = { ...s.updates }
      if (s.extensions.connectors !== lastConnectors) {
        lastConnectors = s.extensions.connectors
        if (lastConnectors) connectors.startAll()
        else void connectors.stopAll()
      }
      if (s.link.enabled !== lastLink.enabled || s.link.port !== lastLink.port || s.link.anywhere !== lastLink.anywhere || s.link.relayUrl !== lastLink.relayUrl) {
        lastLink = { ...s.link }
        link.apply()
      }
      paceMonitor?.()
    })
    let lastMaterial = cfg.ui.material
    let lastLink = { ...cfg.link }
    let lastUpdates = { ...cfg.updates }
    let lastConnectors = cfg.extensions.connectors
    let lastInterval = monitorMs(cfg)
    // Readings are wanted while someone looks: with the window hidden or minimised, no phone connected and
    // nothing running, they are taken every 15 seconds or more. (On laptops with two graphics chips, asking
    // the NVIDIA one every second or two keeps it from going to sleep.)
    paceMonitor = (): void => {
      // Closing stops the monitor; hiding the window on the way out must not start it again.
      if (isClosing()) return
      const s = settings.get()
      const looking =
        Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) ||
        link.status().devices.some((d) => d.online) ||
        agent.runningIds().length > 0 ||
        media.activeCount > 0 ||
        media.queuedCount > 0
      const want = looking ? monitorMs(s) : Math.max(15000, monitorMs(s) * 5)
      if (want === lastInterval) return
      lastInterval = want
      monitor.restart(want)
    }
    setInterval(() => paceMonitor?.(), 10000)
    nativeTheme.on('updated', () => {
      try {
        if (!IS_MAC) win?.setTitleBarOverlay(overlayColors())
      } catch {
        /* ignore */
      }
    })

    void ollama
      .ensureRunning()
      .then((up) => (up ? listModels(true) : undefined))
      .catch((e) => log.warn('main', 'ollama warmup', e))
    learner.catchUp()
    // Settings → Images and video → "Start ComfyUI with Maris" keeps the first picture quick.
    if (cfg.media.autoStart && comfy.isInstalled()) void comfy.start().catch((e) => log.warn('main', 'comfy autostart', e))
  })

  // Every way out (the window's close button, the tray, ⌘Q, an update) goes through requestQuit, which
  // asks when work is still going on and then stops the engines and frees the graphics card's memory.
  app.on('before-quit', (e) => {
    if (isClosed()) return
    e.preventDefault()
    void requestQuit()
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    closeDb()
    log.flush()
  })
  app.on('window-all-closed', () => {
    // macOS apps usually keep running in the Dock when their window closes.
    if (!settings.get().ui.closeToTray && !IS_MAC && !isClosing()) void requestQuit()
  })
}
