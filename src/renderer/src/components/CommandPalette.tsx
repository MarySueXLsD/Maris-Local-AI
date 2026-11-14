// Ctrl+K (⌘K): one box to jump anywhere: chats, pages, settings, help articles, words in old messages,
// and the things people do often. Type to narrow it down, arrows to move, Enter to go.
import {
  Boxes,
  Braces,
  Brain,
  Code2,
  Download,
  FolderOpen,
  LifeBuoy,
  MessageSquare,
  Newspaper,
  PanelLeft,
  Plug,
  Plus,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  TextSearch,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import { ARTICLES } from '../help/articles'
import { api } from '../lib/api'
import { exportChat } from '../lib/chatActions'
import { relativeDay } from '../lib/format'
import { DEVICE, keys, REMOTE } from '../lib/platform'
import { useApp } from '../store'
import { SECTIONS, SETTINGS_SCHEMA } from '../views/settings/schema'
import { cn, Kbd } from './ui'

interface Item {
  id: string
  icon: LucideIcon
  title: string
  detail?: string
  keys?: string
  /** What the typed words are looked for in (besides the title). */
  hay?: string
  run(): void
}

interface Group {
  name: string
  items: Item[]
}

/** Settings sections the phone app does not show. */
const PHONE_HIDDEN = new Set(['phone', 'data'])

const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean)

/** 0: no match. Higher: the title starts with what was typed, then has every word, then only the keywords do. */
function score(item: Item, q: string, ws: string[]): number {
  const title = item.title.toLowerCase()
  if (!ws.length) return 1
  if (title.startsWith(q)) return 4
  if (ws.every((w) => title.includes(w))) return 3
  const hay = `${title} ${item.detail ?? ''} ${item.hay ?? ''}`.toLowerCase()
  return ws.every((w) => hay.includes(w)) ? 1 : 0
}

function pick(items: Item[], q: string, limit: number): Item[] {
  const ws = words(q)
  return items
    .map((item, i) => ({ item, i, s: score(item, q.toLowerCase().trim(), ws) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item)
}

export function CommandPalette() {
  const close = (): void => useApp.setState({ paletteOpen: false })
  const conversations = useApp((s) => s.conversations)
  const currentId = useApp((s) => (s.view === 'chat' ? s.currentId : undefined))
  const running = useApp((s) => Boolean(s.currentId && s.running[s.currentId]))
  const mode = useApp((s) => s.mode)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const showAdmin = useApp((s) => Boolean(s.settings?.updates.admin) && !REMOTE)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [hits, setHits] = useState<{ conversationId: string; messageId: string; snippet: string; title: string }[]>([])
  const q = query.trim()

  // Words in old messages: asked for once typing pauses.
  useEffect(() => {
    if (q.length < 3) {
      setHits([])
      return
    }
    let live = true
    const t = setTimeout(() => {
      void api.conv
        .search(q)
        .then((r) => live && setHits(r))
        .catch(() => undefined)
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])

  const groups = useMemo((): Group[] => {
    const s = useApp.getState()
    const actions: Item[] = [
      { id: 'a:new', icon: Plus, title: 'New chat', keys: keys('N'), hay: 'start conversation fresh', run: () => s.newChat() },
      mode === 'code'
        ? { id: 'a:mode', icon: MessageSquare, title: 'Switch to Chat mode', hay: 'mode chat', run: () => s.setMode('chat') }
        : { id: 'a:mode', icon: Code2, title: 'Switch to Code mode', hay: 'mode code project programming', run: () => s.setMode('code') },
      ...(REMOTE ? [] : [{ id: 'a:project', icon: FolderOpen, title: 'Open a project folder', hay: 'code mode folder project', run: () => void s.openProject() }]),
      ...(currentId && running ? [{ id: 'a:stop', icon: Square, title: 'Stop the answer', hay: 'cancel halt', run: () => s.stop() }] : []),
      ...(currentId
        ? REMOTE
          ? [{ id: 'a:copy', icon: Download, title: 'Copy this chat as Markdown', hay: 'export share text clipboard', run: () => void exportChat(currentId, 'md') }]
          : [
              { id: 'a:md', icon: Download, title: 'Export this chat as Markdown', hay: 'save download file share text', run: () => void exportChat(currentId, 'md') },
              { id: 'a:json', icon: Braces, title: 'Export this chat as JSON', hay: 'save download file backup everything', run: () => void exportChat(currentId, 'json') }
            ]
        : []),
      { id: 'a:sidebar', icon: PanelLeft, title: sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar', keys: keys('B'), hay: 'panel toggle chats list', run: () => s.toggleSidebar() },
      ...(REMOTE ? [] : [{ id: 'a:setup', icon: Wand2, title: 'Run the setup assistant again', hay: `scan ${DEVICE} install engine models first start`, run: () => s.openSetup() }])
    ]
    const pages: Item[] = [
      { id: 'p:memory', icon: Brain, title: 'Memory', detail: 'What Maris remembers about you', run: () => s.setView('memory') },
      { id: 'p:models', icon: Boxes, title: 'Models', detail: `The AI models on this ${DEVICE}`, hay: 'download text pictures video', run: () => s.openModels('text') },
      { id: 'p:api', icon: Boxes, title: 'Models → API', detail: 'Claude, GPT and others with an API key', hay: 'key provider cloud openai anthropic', run: () => s.openModels('api') },
      { id: 'p:skills', icon: Puzzle, title: 'Skills', detail: 'Instructions that teach Maris new kinds of tasks', run: () => s.setView('skills') },
      { id: 'p:connectors', icon: Plug, title: 'Connectors', detail: 'GitHub, Notion, Home Assistant and other services', hay: 'mcp', run: () => s.setView('connectors') },
      { id: 'p:settings', icon: Settings, title: 'Settings', keys: keys(','), hay: 'preferences options', run: () => s.setView('settings') },
      { id: 'p:news', icon: Newspaper, title: 'Updates & news', hay: 'new version release', run: () => s.setView('news') },
      { id: 'p:help', icon: LifeBuoy, title: 'Help', keys: 'F1', hay: 'guide how', run: () => s.openHelp() },
      ...(showAdmin ? [{ id: 'p:admin', icon: Newspaper, title: 'Admin', detail: 'Write and publish posts', run: () => s.setView('admin') }] : [])
    ]
    const chats: Item[] = conversations.map((c) => ({
      id: `c:${c.id}`,
      icon: c.mode === 'code' ? Code2 : MessageSquare,
      title: c.mode === 'code' && c.title === 'New chat' ? 'New task' : c.title,
      detail: `${c.mode === 'code' && c.projectDir ? `${c.projectDir.split(/[\\/]/).pop()} · ` : ''}${relativeDay(c.updatedAt)}`,
      run: () => void s.open(c.id)
    }))
    const sectionTitle = (id: string): string => SECTIONS.find((x) => x.id === id)?.title ?? id
    const settings: Item[] = SETTINGS_SCHEMA.filter((d) => !(REMOTE && PHONE_HIDDEN.has(d.section))).map((d) => ({
      id: `s:${d.path}`,
      icon: SlidersHorizontal,
      title: d.label,
      detail: `Settings → ${sectionTitle(d.section)}`,
      hay: `${d.hint ?? ''} ${d.keywords ?? ''} ${d.group ?? ''}`,
      run: () => s.openSetting(d.section, d.label)
    }))
    const help: Item[] = ARTICLES.map((a) => ({ id: `h:${a.id}`, icon: LifeBuoy, title: a.title, detail: a.summary, hay: a.keywords, run: () => s.openHelp(a.id) }))
    const found: Item[] = hits.map((h) => ({
      id: `m:${h.messageId}`,
      icon: TextSearch,
      title: h.title,
      detail: h.snippet.replace(/[[\]]/g, ''),
      hay: h.snippet,
      run: () => void s.open(h.conversationId)
    }))
    if (!q) {
      return [
        { name: 'Recent chats', items: chats.slice(0, 5) },
        { name: 'Actions', items: actions },
        { name: 'Go to', items: pages }
      ].filter((g) => g.items.length)
    }
    return [
      { name: 'Actions', items: pick(actions, q, 6) },
      { name: 'Go to', items: pick(pages, q, 4) },
      { name: 'Chats', items: pick(chats, q, 8) },
      { name: 'Settings', items: pick(settings, q, 6) },
      { name: 'Help', items: pick(help, q, 5) },
      // The search already matched these; only chats listed above are left out.
      { name: 'In messages', items: found.slice(0, 6) }
    ].filter((g) => g.items.length)
  }, [q, conversations, currentId, running, mode, sidebarOpen, showAdmin, hits])

  const flat = groups.flatMap((g) => g.items)
  const at = Math.min(active, Math.max(0, flat.length - 1))
  const activeId = flat[at]?.id
  useEffect(() => {
    setActive(0)
  }, [q])
  useEffect(() => {
    if (activeId) document.getElementById(`palette-${activeId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const go = (item: Item | undefined): void => {
    if (!item) return
    close()
    item.run()
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[min(640px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-float"
        >
          <Dialog.Title className="sr-only">Go anywhere</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search size={16} className="shrink-0 text-text-3" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                  e.preventDefault()
                  setActive((at + 1) % Math.max(1, flat.length))
                } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                  e.preventDefault()
                  setActive((at - 1 + flat.length) % Math.max(1, flat.length))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  go(flat[at])
                }
              }}
              placeholder="Search chats, settings and help, or type what to do"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={flat[at] ? `palette-${flat[at].id}` : undefined}
              aria-label="Go anywhere"
              className="h-12 min-w-0 flex-1 bg-transparent text-[0.98rem] text-text placeholder:text-text-3 focus:outline-none"
            />
          </div>
          <div id="palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {groups.map((g) => (
              <div key={g.name} role="group" aria-label={g.name} className="pb-1">
                <div aria-hidden className="px-2.5 pt-2 pb-1 text-[0.74rem] font-medium text-text-3">
                  {g.name}
                </div>
                {g.items.map((item) => {
                  const i = flat.indexOf(item)
                  const Icon = item.icon
                  return (
                    <div
                      key={item.id}
                      id={`palette-${item.id}`}
                      role="option"
                      aria-selected={i === at}
                      onMouseMove={() => i !== at && setActive(i)}
                      onClick={() => go(item)}
                      className={cn('flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2', i === at ? 'bg-petal-soft text-text' : 'text-text-2')}
                    >
                      <Icon size={15} className={cn('shrink-0', i === at ? 'text-petal' : 'text-text-3')} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.9rem] text-text">{item.title}</span>
                        {item.detail && <span className="block truncate text-[0.78rem] text-text-3">{item.detail}</span>}
                      </span>
                      {item.keys && <Kbd>{item.keys}</Kbd>}
                    </div>
                  )
                })}
              </div>
            ))}
            {!flat.length && (
              <p className="px-3 py-6 text-center text-[0.88rem] text-text-3" role="status">
                {q.length >= 3 ? 'Nothing matches. Try another word.' : 'Keep typing…'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[0.75rem] text-text-3" aria-hidden>
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
            </span>
            <span>
              <Kbd>Enter</Kbd> to open
            </span>
            <span>
              <Kbd>Esc</Kbd> to close
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
