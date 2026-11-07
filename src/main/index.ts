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
import { settings } from './settings'
import { monitor } from './system/monitor'
import { processes } from './tools/processes'
import { log } from './util'
import { themeScheme } from '@shared/themes'

// Tests (and power users) can point Maris at a separate profile folder.
if (process.env.MARIS_USER_DATA) app.setPath('userData', process.env.MARIS_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'maris-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
let trayHintShown = false

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
  const material = settings.get().ui.material
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
          {
            label: 'Quit Maris',
            accelerator: 'Command+Q',
            click: () => {
              quitting = true
              app.quit()
            }
          }
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
    if (!quitting && settings.get().ui.closeToTray) {
      e.preventDefault()
      win?.hide()
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true
        const where = IS_MAC ? 'the menu bar' : 'the tray'
        new Notification({ title: 'Maris is still running', body: `Find it in ${where}, or press ${settings.get().ui.hotkey}.`, silent: true }).show()
      }
    }
  })
  win.on('focus', () => win?.flashFrame(false))
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
      {
        label: 'Quit Maris',
        click: () => {
          quitting = true
          app.quit()
        }
      }
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
    monitor.start(Math.max(1, cfg.system.monitorIntervalSec) * 1000)
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
      if (s.link.enabled !== lastLink.enabled || s.link.port !== lastLink.port) {
        lastLink = { ...s.link }
        link.apply()
      }
      if (s.system.monitorIntervalSec !== lastInterval) {
        lastInterval = s.system.monitorIntervalSec
        monitor.restart(Math.max(1, lastInterval) * 1000)
      }
    })
    let lastMaterial = cfg.ui.material
    let lastLink = { ...cfg.link }
    let lastUpdates = { ...cfg.updates }
    let lastConnectors = cfg.extensions.connectors
    let lastInterval = cfg.system.monitorIntervalSec
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

  app.on('before-quit', () => {
    quitting = true
    cliServer.stop()
    learner.cancelAll()
    processes.stopAll()
    if (comfy.ownsProcess()) comfy.stop()
    link.stop()
    void connectors.stopAll()
    monitor.stop()
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    closeDb()
  })
  app.on('window-all-closed', () => {
    // macOS apps usually keep running in the Dock when their window closes.
    if (!settings.get().ui.closeToTray && !IS_MAC) app.quit()
  })
}
