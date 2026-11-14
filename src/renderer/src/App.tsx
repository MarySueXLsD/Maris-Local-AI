import { CircleAlert, PanelLeft, X } from 'lucide-react'
import { Tooltip } from 'radix-ui'
import { useEffect, useState } from 'react'
import { alpha, contrast, cssVars, themeTokens } from '@shared/themes'
import { ChatView } from './components/chat/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { MarisMark } from './components/MarisMark'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { IconButton } from './components/ui'
import { useApp } from './store'
import { MemoryView } from './views/MemoryView'
import { HelpView } from './views/HelpView'
import { ModelsView } from './views/ModelsView'
import { SettingsView } from './views/SettingsView'
import { SetupView } from './views/SetupView'
import { AdminView } from './views/AdminView'
import { ConnectorsView } from './views/ConnectorsView'
import { NewsView } from './views/NewsView'
import { SkillsView } from './views/SkillsView'
import { modKey, PLATFORM, REMOTE } from './lib/platform'

function useAppearance(): void {
  const ui = useApp((s) => s.settings?.ui)
  // Windows 10 and older graphics drivers have no see-through window material.
  const material = useApp((s) => s.appInfo?.material)
  // Low-power mode: a plain, still interface that leaves the processor to the model.
  const lite = useApp((s) => Boolean(s.status?.lite))
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (!ui) return
    const root = document.documentElement
    // Colour theme: presets and custom themes set every colour token; "maris" uses styles.css.
    const tokens = themeTokens(ui.palette || 'maris', ui.customTheme)
    const scheme = tokens ? tokens.scheme : ui.theme === 'system' ? (systemDark ? 'dark' : 'light') : ui.theme
    root.dataset.theme = scheme
    root.dataset.palette = ui.palette || 'maris'
    const vars = tokens ? cssVars(tokens) : {}
    for (const k of Object.keys(cssVars(themeTokens('neon-pink', ui.customTheme)!))) root.style.removeProperty(k)
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    if (tokens && ui.highContrast) {
      // Inline colours win over the stylesheet, so apply high contrast here too.
      root.style.setProperty('--side', tokens.paper)
      root.style.setProperty('--surface', tokens.paper)
      root.style.setProperty('--line', tokens.text3)
      root.style.setProperty('--line-strong', tokens.text2)
      root.style.setProperty('--text-2', tokens.text)
    }
    if (tokens?.glow && !ui.reduceMotion) root.dataset.glow = ''
    else delete root.dataset.glow
    root.style.setProperty('--font-scale', String(ui.fontScale || 1))
    if (ui.highContrast) root.dataset.contrast = 'high'
    else delete root.dataset.contrast
    if (ui.reduceMotion) root.dataset.reduceMotion = ''
    else delete root.dataset.reduceMotion
    root.dataset.density = ui.density
    // Linux, Windows 10 and the phone app have no see-through window material, so the page paints its own background.
    if (ui.material === 'solid' || PLATFORM === 'linux' || REMOTE || material === false || lite) root.dataset.noMica = ''
    else delete root.dataset.noMica
    if (lite && !REMOTE) root.dataset.lite = ''
    else delete root.dataset.lite
    root.dataset.chrome = REMOTE ? 'none' : PLATFORM === 'darwin' ? 'mac' : 'overlay'
    // An accent chosen in Settings overrides the theme's own.
    if (ui.accent) {
      root.style.setProperty('--petal', ui.accent)
      root.style.setProperty('--petal-strong', ui.accent)
      root.style.setProperty('--petal-soft', alpha(ui.accent, scheme === 'dark' ? 0.16 : 0.11))
      root.style.setProperty('--on-petal', contrast(ui.accent, '#ffffff') >= contrast(ui.accent, '#0d0b14') ? '#ffffff' : '#0d0b14')
    }
  }, [ui, systemDark, material, lite])
}

/** Phone-sized window (or the phone app). */
function useNarrow(): boolean {
  const query = '(max-width: 767px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = (): void => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

export default function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const announcement = useApp((s) => s.announcement)
  const error = useApp((s) => s.error)
  const dismissError = useApp((s) => s.dismissError)
  const onboarded = useApp((s) => s.settings?.onboarded ?? true)
  const setupOpen = useApp((s) => s.setupOpen)
  const paletteOpen = useApp((s) => s.paletteOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const narrow = useNarrow()
  const openSetup = useApp((s) => s.openSetup)
  useAppearance()

  // First launch: open the setup assistant and keep it open until the person closes it
  // (finishing the plan marks setup as done while the last step is still on screen).
  useEffect(() => {
    // The phone app cannot install engines or models on the computer; setup runs there.
    if (!onboarded && !REMOTE) openSetup()
  }, [onboarded, openSetup])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useApp.getState()
      if (modKey(e) && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        s.newChat()
      } else if (modKey(e) && e.key === ',') {
        e.preventDefault()
        s.setView('settings')
      } else if (e.key === 'F1') {
        e.preventDefault()
        s.openHelp()
      } else if (modKey(e) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        s.toggleSidebar()
      } else if (modKey(e) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        // Ctrl+K: the box for going anywhere (again: closes it).
        e.preventDefault()
        if (!s.setupOpen) useApp.setState({ paletteOpen: !s.paletteOpen })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <MarisMark size={56} bloom />
      </div>
    )
  }

  return (
    <Tooltip.Provider>
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && !narrow && <Sidebar />}
          {view === 'chat' && <ChatView />}
          {view === 'memory' && <MemoryView />}
          {view === 'models' && <ModelsView />}
          {view === 'settings' && <SettingsView />}
          {view === 'help' && <HelpView />}
          {view === 'news' && <NewsView />}
          {view === 'admin' && <AdminView />}
          {view === 'skills' && <SkillsView />}
          {view === 'connectors' && <ConnectorsView />}
        </div>
        <StatusBar />
      </div>
      {sidebarOpen && narrow && (
        <div className="fixed inset-0 z-30 flex" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
          {/* Opaque behind the sidebar, whose own background is see-through for the desktop window material. */}
          <div className="h-full bg-paper shadow-float">
            <Sidebar />
          </div>
          <button aria-label="Close menu" className="min-w-0 flex-1 bg-black/45" onClick={toggleSidebar} />
        </div>
      )}
      {!sidebarOpen && view !== 'chat' && (
        <IconButton
          label="Show sidebar"
          className="no-drag fixed z-20 bg-surface/80"
          style={{ top: 'calc(0.375rem + var(--safe-top))', left: 'calc(0.5rem + var(--chrome-left) + var(--safe-left))' }}
          onClick={toggleSidebar}
        >
          <PanelLeft size={16} />
        </IconButton>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {error && (
        <div role="alert" className="fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-xl border border-danger/40 bg-raised p-3.5 shadow-float">
          <CircleAlert size={18} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[0.9rem] text-text">{error}</p>
          <button aria-label="Dismiss" onClick={dismissError} className="rounded p-0.5 text-text-3 hover:text-text">
            <X size={15} />
          </button>
        </div>
      )}
      {setupOpen && <SetupView />}
      {paletteOpen && <CommandPalette />}
    </Tooltip.Provider>
  )
}
