import {
  Boxes,
  Brain,
  LifeBuoy,
  Code2,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Newspaper,
  PanelLeftClose,
  Pencil,
  PenSquare,
  Pin,
  PinOff,
  Plug,
  Plus,
  Puzzle,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import { Dialog, DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import type { Conversation } from '@shared/types'
import { api } from '../lib/api'
import { relativeDay } from '../lib/format'
import { useApp, type View } from '../store'
import { MarisMark } from './MarisMark'
import { NewProjectDialog, ProjectsTree } from './ProjectsTree'
import { RestartToUpdate } from './UpdateNow'
import { Button, cn, IconButton, Tip } from './ui'
import { DEVICE, keys, REMOTE, TOUCH } from '../lib/platform'

/** Deleting a chat that is still working stops it first, so nothing is made for a chat that is gone. */
function StopAndDelete({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const job = useApp((s) => (s.status?.comfy.job?.conversationId === c.id ? s.status.comfy.job : undefined))
  const [busy, setBusy] = useState(false)
  const what = job ? (job.kind === 'video' ? 'making a video' : 'drawing a picture') : 'still answering'
  const left = job?.etaSec ? ` (about ${job.etaSec < 90 ? `${Math.max(1, job.etaSec)} s` : `${Math.round(job.etaSec / 60)} min`} left)` : ''
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
          <Dialog.Title className="text-[1.1rem] font-semibold text-text">Stop and delete this chat?</Dialog.Title>
          <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">
            Maris is {what} in “{c.title === 'New chat' && c.mode === 'code' ? 'New task' : c.title}”{left}. Deleting stops that first; nothing it was making is kept.
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">Keep working</Button>
            </Dialog.Close>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void api.conv.remove(c.id).finally(onClose)
              }}
            >
              <Trash2 size={14} /> {busy ? 'Stopping…' : 'Stop and delete'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ConversationRow({ c, active }: { c: Conversation; active: boolean }) {
  const open = useApp((s) => s.open)
  const running = useApp((s) => Boolean(s.running[c.id]))
  const unread = useApp((s) => Boolean(s.unread[c.id]))
  const approvals = useApp((s) => s.approvals)
  const waiting = Object.values(approvals).some((a) => a.conversationId === c.id)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(c.title)
  const [confirm, setConfirm] = useState(false)
  if (renaming) {
    return (
      <input
        autoFocus
        value={title}
        aria-label="Chat title"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          setRenaming(false)
          if (title.trim() && title !== c.title) void api.conv.rename(c.id, title)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setTitle(c.title)
            setRenaming(false)
          }
        }}
        className="w-full rounded-lg border border-petal bg-raised px-2.5 py-1.5 text-[0.88rem] text-text outline-none"
      />
    )
  }
  return (
    <div className={cn('group relative flex items-center rounded-lg', active ? 'bg-petal-soft' : 'hover:bg-sunken')}>
      <button
        onClick={() => void open(c.id)}
        aria-current={active ? 'page' : undefined}
        className={cn('min-w-0 flex-1 truncate py-1.5 pr-8 pl-2.5 text-left text-[0.88rem]', active ? 'text-text' : 'text-text-2')}
      >
        {waiting && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-pollen align-middle" aria-label="Needs your approval" />}
        {running && !waiting && <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-pollen align-middle" aria-label="Answering" />}
        {c.origin === 'terminal' && <SquareTerminal size={12} className="mr-1.5 inline-block align-[-1px] text-text-3" aria-label="Started in the terminal" />}
        {c.mode === 'code' && c.title === 'New chat' ? 'New task' : c.title}
      </button>
      {unread && !active && (
        <span className="pointer-events-none absolute right-2.5 size-2 rounded-full bg-petal transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0" role="img" aria-label="New answer" />
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            title="Pin, rename or delete"
            aria-label={`Options for ${c.title}`}
            className="absolute right-1 inline-flex size-6 items-center justify-center rounded-md text-text-3 opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-text focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal size={15} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content sideOffset={4} align="start" className="z-50 min-w-44 rounded-xl border border-line bg-raised p-1.5 shadow-float">
            <DropdownMenu.Item className="menu-item" onSelect={() => void api.conv.pin(c.id, !c.pinned)}>
              {c.pinned ? <PinOff size={14} /> : <Pin size={14} />} {c.pinned ? 'Unpin' : 'Pin'}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
              <Pencil size={14} /> Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item text-danger" onSelect={() => (running ? setConfirm(true) : void api.conv.remove(c.id))}>
              <Trash2 size={14} /> Delete chat
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {confirm && <StopAndDelete c={c} onClose={() => setConfirm(false)} />}
    </div>
  )
}

const NAV: { view: View; label: string; icon: typeof Brain; tip: string }[] = [
  { view: 'skills', label: 'Skills', icon: Puzzle, tip: 'Instructions from git that teach Maris new kinds of tasks' },
  { view: 'connectors', label: 'Connectors', icon: Plug, tip: 'Connect GitHub, Notion, Home Assistant and other services' },
  { view: 'memory', label: 'Memory', icon: Brain, tip: 'What Maris remembers about you; edit or delete anything' },
  { view: 'models', label: 'Models', icon: Boxes, tip: `The AI models on this ${DEVICE} for text, pictures and video: which does what, download more` },
  { view: 'settings', label: 'Settings', icon: Settings, tip: `Themes, behaviour and everything else (${keys(',')})` },
  { view: 'news', label: 'Updates & news', icon: Newspaper, tip: 'New versions of Maris and posts from its maker' },
  { view: 'help', label: 'Help', icon: LifeBuoy, tip: 'Guides and answers in plain language (F1)' }
]

const ADMIN_NAV = { view: 'admin' as View, label: 'Admin', icon: PenSquare, tip: 'Write and publish posts for everyone who uses Maris' }

export function Sidebar() {
  const conversations = useApp((s) => s.conversations)
  const currentId = useApp((s) => s.currentId)
  const view = useApp((s) => s.view)
  const mode = useApp((s) => s.mode)
  const project = useApp((s) => s.project)
  const setMode = useApp((s) => s.setMode)
  const setView = useApp((s) => s.setView)
  const newChat = useApp((s) => s.newChat)
  const open = useApp((s) => s.open)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const showAdmin = useApp((s) => Boolean(s.settings?.updates.admin) && !REMOTE)
  const updateReady = useApp((s) => Boolean(s.updateState?.available))
  const readyVersion = useApp((s) => (s.updateState?.ready ? s.updateState.available?.version : undefined))
  // The version this copy runs (in the phone app: the linked computer's), shown beside the name.
  const version = useApp((s) => s.updateState?.current)
  const newsBadge = useApp((s) => (s.newsState?.unread ?? 0) + (s.updateState?.available ? 1 : 0))
  const unread = useApp((s) => s.unread)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ conversationId: string; snippet: string; title: string }[]>([])
  const [newProject, setNewProject] = useState(false)
  const unreadIn = (m: 'chat' | 'code'): boolean => conversations.some((c) => unread[c.id] && (m === 'code' ? c.mode === 'code' : c.mode !== 'code'))

  useEffect(() => {
    if (query.trim().length < 3) {
      setHits([])
      return
    }
    const t = setTimeout(() => void api.conv.search(query).then(setHits), 250)
    return () => clearTimeout(t)
  }, [query])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const inMode = conversations.filter((c) =>
      mode === 'code' ? c.mode === 'code' && (!project || c.projectDir?.toLowerCase() === project.path.toLowerCase()) : c.mode !== 'code'
    )
    const list = q ? inMode.filter((c) => c.title.toLowerCase().includes(q)) : inMode
    const out = new Map<string, Conversation[]>()
    for (const c of list) {
      const key = c.pinned ? 'Pinned' : relativeDay(c.updatedAt)
      if (!out.has(key)) out.set(key, [])
      out.get(key)!.push(c)
    }
    return [...out.entries()]
  }, [conversations, query, mode, project])

  return (
    <aside className="flex h-full w-[268px] shrink-0 flex-col border-r border-line bg-side" aria-label="Chats and navigation">
      <div className="drag flex h-11 items-center gap-2.5 pr-2" style={{ paddingLeft: 'calc(1rem + var(--chrome-left))' }}>
        <MarisMark size={20} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-display text-[1.05rem] font-semibold tracking-tight text-text">Maris</span>
          {version && (
            <span className="tabular truncate text-[0.72rem] font-medium text-text-3">
              <span aria-hidden>v{version}</span>
              <span className="sr-only">version {version}</span>
            </span>
          )}
        </span>
        <div className="flex-1" />
        <IconButton label={`Hide sidebar (${keys('B')})`} className="no-drag" onClick={toggleSidebar}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>

      <div className="space-y-2 px-3 pt-1 pb-2">
        <div role="radiogroup" aria-label="Mode" className="grid grid-cols-2 rounded-lg border border-line bg-sunken p-0.5">
          {(
            [
              ['chat', 'Chat', MessageSquare, `Ask questions, write, and get things done on your ${DEVICE}`],
              ['code', 'Code', Code2, 'Work on a project folder: Maris reads, changes, builds and tests code']
            ] as const
          ).map(([m, label, Icon, tip]) => (
            <Tip key={m} label={tip} side="bottom">
              <button
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-[0.86rem] font-medium transition-colors',
                  mode === m ? 'bg-raised text-text shadow-sm' : 'text-text-2 hover:text-text'
                )}
              >
                <Icon size={14} /> {label}
                {mode !== m && unreadIn(m) && <span className="size-1.5 rounded-full bg-petal" role="img" aria-label="New answers" />}
              </button>
            </Tip>
          ))}
        </div>
        {mode === 'code' ? (
          !REMOTE && (
            <Tip label="Start a new project in a new folder, or open a folder you already have" side="right">
              <button
                onClick={() => setNewProject(true)}
                className="flex h-9 w-full items-center gap-2 rounded-lg bg-petal-strong px-3 text-[0.9rem] font-medium text-on-petal transition-colors hover:bg-petal"
              >
                <FolderPlus size={16} /> New project
              </button>
            </Tip>
          )
        ) : (
          <Tip label="Start a fresh conversation" side="right">
            <button onClick={newChat} className="flex h-9 w-full items-center gap-2 rounded-lg bg-petal-strong px-3 text-[0.9rem] font-medium text-on-petal transition-colors hover:bg-petal">
              <Plus size={16} /> New chat
              {!TOUCH && <span className="ml-auto text-[0.75rem] font-normal opacity-75">{keys('N')}</span>}
            </button>
          </Tip>
        )}
        {newProject && <NewProjectDialog onClose={() => setNewProject(false)} />}
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 w-full rounded-lg border border-line bg-sunken pr-7 pl-8 text-[0.86rem] text-text placeholder:text-text-3 focus:border-petal focus:outline-none"
          />
          {query && (
            <button aria-label="Clear search" className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-text-3 hover:text-text" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" aria-label="Chats">
        {mode === 'code' && (
          <div className="mb-3">
            <ProjectsTree query={query} renderTask={(c) => <ConversationRow key={c.id} c={c} active={view === 'chat' && c.id === currentId} />} />
          </div>
        )}
        {mode !== 'code' && groups.map(([label, list]) => (
          <div key={label} className="mb-3">
            <h2 className="px-2.5 pb-1 text-[0.76rem] font-medium text-text-3">{label}</h2>
            <div className="space-y-px">
              {list.map((c) => (
                <ConversationRow key={c.id} c={c} active={view === 'chat' && c.id === currentId} />
              ))}
            </div>
          </div>
        ))}
        {hits.length > 0 && (
          <div className="mb-3">
            <h2 className="px-2.5 pb-1 text-[0.76rem] font-medium text-text-3">In messages</h2>
            {hits.map((hit, i) => (
              <button key={i} onClick={() => void open(hit.conversationId)} className="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-sunken">
                <span className="block truncate text-[0.84rem] text-text">{hit.title}</span>
                <span className="line-clamp-2 block text-[0.78rem] text-text-3">{hit.snippet.replace(/[[\]]/g, '')}</span>
              </button>
            ))}
          </div>
        )}
        {mode !== 'code' && groups.length === 0 && hits.length === 0 && <p className="px-2.5 py-2 text-[0.84rem] text-text-3">Your chats will show up here.</p>}
      </nav>

      <div className="space-y-px border-t border-line px-3 py-2">
        {readyVersion && !REMOTE && <RestartToUpdate pill version={readyVersion} />}
        {[...NAV, ...(showAdmin ? [ADMIN_NAV] : [])].map(({ view: v, label, icon: Icon, tip }) => (
          <Tip key={v} label={tip} side="right">
            <button
              onClick={() => setView(v)}
              aria-current={view === v ? 'page' : undefined}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[0.88rem] transition-colors',
                view === v ? 'bg-petal-soft text-text' : 'text-text-2 hover:bg-sunken hover:text-text'
              )}
            >
              <Icon size={16} /> {label}
              {v === 'news' && newsBadge > 0 && (
                <span className="ml-auto rounded-full bg-petal-strong px-1.5 text-[0.7rem] font-medium leading-[1.15rem] text-on-petal" aria-label={`${newsBadge} new`}>
                  {updateReady ? 'New' : newsBadge}
                </span>
              )}
            </button>
          </Tip>
        ))}
      </div>
    </aside>
  )
}
