import { ChevronRight, FolderOpen, FolderPlus, Info, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Dialog, DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Conversation, Project } from '@shared/types'
import { api } from '../lib/api'
import { relativeDay } from '../lib/format'
import { PLATFORM, REMOTE } from '../lib/platform'
import { useApp } from '../store'
import { Button, cn, inputCls, Tip } from './ui'

const OPEN_KEY = 'maris.sidebar.openProjects'
const SHOWN = 6

const keyOf = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * Code mode's sidebar: every project with its tasks underneath. Hovering a project shows + (a new task
 * in it) and … (rename, what the project is about, open the folder, remove it).
 */
export function ProjectsTree({ query, renderTask }: { query: string; renderTask: (c: Conversation) => ReactNode }) {
  const conversations = useApp((s) => s.conversations)
  const projects = useApp((s) => s.projects)
  const current = useApp((s) => s.project)
  const currentId = useApp((s) => s.currentId)
  const openProject = useApp((s) => s.openProject)
  const unread = useApp((s) => s.unread)
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  const [all, setAll] = useState<Record<string, boolean>>({})
  const [about, setAbout] = useState<Project>()
  const [removing, setRemoving] = useState<Project>()

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open))
    } catch {
      /* a convenience only */
    }
  }, [open])

  const tasks = useMemo(() => {
    const m = new Map<string, Conversation[]>()
    for (const c of conversations) {
      if (c.mode !== 'code' || !c.projectDir) continue
      const k = keyOf(c.projectDir)
      m.set(k, [...(m.get(k) ?? []), c])
    }
    for (const list of m.values()) list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    return m
  }, [conversations])

  // Registered projects, then folders that only have tasks (removed from the list or moved away).
  const rows = useMemo(() => {
    const known = new Set(projects.map((p) => keyOf(p.path)))
    const extra: Project[] = []
    for (const [k, list] of tasks) {
      if (known.has(k)) continue
      const dir = list[0].projectDir!
      extra.push({ path: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir, lastOpened: list[0].updatedAt, allowedCommands: [] })
    }
    return [...projects, ...extra]
  }, [projects, tasks])

  // The open task's project is always expanded, so the highlighted task is visible.
  const activeProject = conversations.find((c) => c.id === currentId)?.projectDir
  const q = query.trim().toLowerCase()

  const toggle = (p: Project): void => {
    const k = keyOf(p.path)
    setOpen((o) => ({ ...o, [k]: !isOpen(p) }))
    if (current?.path !== p.path) useApp.setState({ project: p })
  }
  const isOpen = (p: Project): boolean => {
    const k = keyOf(p.path)
    return open[k] ?? (current ? keyOf(current.path) === k : false)
  }

  return (
    <div>
      <div className="flex items-center justify-between pr-1 pb-1 pl-2.5">
        <h2 className="text-[0.76rem] font-medium text-text-3">Projects</h2>
        {!REMOTE && (
          <Tip label="Add a project: pick a folder on this computer" side="right">
            <button
              onClick={() => void openProject()}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.76rem] text-text-3 hover:bg-sunken hover:text-text"
              aria-label="Add a project"
            >
              <FolderPlus size={14} /> Add
            </button>
          </Tip>
        )}
      </div>
      {rows.length === 0 && (
        <button onClick={() => void openProject()} className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-3 text-left text-[0.84rem] text-text-2 hover:border-line-strong hover:text-text">
          <FolderPlus size={16} className="text-petal" /> Open a project folder to start
        </button>
      )}
      <div className="space-y-px" role="tree" aria-label="Projects and their tasks">
        {rows.map((p) => {
          const k = keyOf(p.path)
          const list = tasks.get(k) ?? []
          const matches = q ? list.filter((c) => c.title.toLowerCase().includes(q)) : list
          if (q && !matches.length && !p.name.toLowerCase().includes(q)) return null
          const expanded = Boolean(q) || isOpen(p) || (activeProject !== undefined && keyOf(activeProject) === k)
          const shown = all[k] || q ? matches : matches.slice(0, SHOWN)
          const isCurrent = current ? keyOf(current.path) === k : false
          const known = projects.some((x) => keyOf(x.path) === k)
          return (
            <div key={k} role="treeitem" aria-expanded={expanded} aria-selected={isCurrent}>
              <ProjectRow
                p={p}
                count={list.length}
                unread={list.filter((c) => unread[c.id]).length}
                expanded={expanded}
                current={isCurrent}
                known={known}
                onToggle={() => toggle(p)}
                onNew={() => void openProject(p.path)}
                onAbout={() => setAbout(p)}
                onRemove={() => setRemoving(p)}
              />
              {expanded && (
                <div className="mt-px mb-1 ml-[1.15rem] space-y-px border-l border-line pl-1.5" role="group">
                  {shown.map((c) => renderTask(c))}
                  {!q && matches.length > SHOWN && !all[k] && (
                    <button className="w-full rounded-lg px-2.5 py-1 text-left text-[0.8rem] text-text-3 hover:bg-sunken hover:text-text" onClick={() => setAll((a) => ({ ...a, [k]: true }))}>
                      Show {matches.length - SHOWN} more
                    </button>
                  )}
                  {list.length === 0 && (
                    <button className="w-full rounded-lg px-2.5 py-1 text-left text-[0.8rem] text-text-3 hover:bg-sunken hover:text-text" onClick={() => void openProject(p.path)}>
                      No tasks yet. Start one
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {about && <AboutProject p={about} tasks={tasks.get(keyOf(about.path))?.length ?? 0} onClose={() => setAbout(undefined)} />}
      {removing && <RemoveProject p={removing} tasks={tasks.get(keyOf(removing.path)) ?? []} onClose={() => setRemoving(undefined)} />}
    </div>
  )
}

function ProjectRow({
  p,
  count,
  unread,
  expanded,
  current,
  known,
  onToggle,
  onNew,
  onAbout,
  onRemove
}: {
  p: Project
  count: number
  /** Tasks in it with a finished answer the person has not seen. */
  unread: number
  expanded: boolean
  current: boolean
  known: boolean
  onToggle: () => void
  onNew: () => void
  onAbout: () => void
  onRemove: () => void
}) {
  const loadProjects = useApp((s) => s.loadProjects)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(p.name)
  if (renaming) {
    return (
      <input
        autoFocus
        value={name}
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          setRenaming(false)
          if (name.trim() && name !== p.name) void api.project.update(p.path, { name }).then(() => loadProjects())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setName(p.name)
            setRenaming(false)
          }
        }}
        className="w-full rounded-lg border border-petal bg-raised px-2.5 py-1.5 text-[0.88rem] text-text outline-none"
      />
    )
  }
  return (
    <div className={cn('group relative flex items-center rounded-lg', current ? 'bg-sunken/80' : 'hover:bg-sunken')}>
      <button onClick={onToggle} aria-expanded={expanded} title={p.path} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-14 pl-1 text-left">
        <ChevronRight size={13} className={cn('shrink-0 text-text-3 transition-transform', expanded && 'rotate-90')} aria-hidden />
        <FolderOpen size={14} className={cn('shrink-0', current ? 'text-petal' : 'text-text-3')} aria-hidden />
        <span className={cn('truncate text-[0.88rem]', current ? 'font-medium text-text' : 'text-text')}>{p.name}</span>
        {!expanded && (count > 0 || unread > 0) && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-[0.72rem] text-text-3 group-hover:opacity-0">
            {count > 0 && count}
            {unread > 0 && <span className="size-2 rounded-full bg-petal" role="img" aria-label={`${unread} new answer${unread === 1 ? '' : 's'}`} />}
          </span>
        )}
      </button>
      <div className="absolute right-1 flex items-center gap-px opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <Tip label={`New task in ${p.name}`}>
          <button onClick={onNew} aria-label={`New task in ${p.name}`} className="inline-flex size-6 items-center justify-center rounded-md text-text-3 hover:bg-raised hover:text-petal">
            <Plus size={15} />
          </button>
        </Tip>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button aria-label={`Options for ${p.name}`} title="Rename, about, folder" className="inline-flex size-6 items-center justify-center rounded-md text-text-3 hover:bg-raised hover:text-text">
              <MoreHorizontal size={15} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content sideOffset={4} align="start" className="z-50 min-w-48 rounded-xl border border-line bg-raised p-1.5 shadow-float">
              <DropdownMenu.Item className="menu-item" onSelect={onNew}>
                <Plus size={14} /> New task
              </DropdownMenu.Item>
              {known && (
                <DropdownMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
                  <Pencil size={14} /> Rename
                </DropdownMenu.Item>
              )}
              {known && (
                <DropdownMenu.Item className="menu-item" onSelect={onAbout}>
                  <Info size={14} /> About this project…
                </DropdownMenu.Item>
              )}
              {!REMOTE && (
                <DropdownMenu.Item className="menu-item" onSelect={() => void api.shell.openPath(p.path)}>
                  <FolderOpen size={14} /> Open the folder
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item className="menu-item text-danger" onSelect={onRemove}>
                <Trash2 size={14} /> Remove from Maris…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  )
}

/** A new project: Maris makes its folder (or the person opens one they already have). */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const openProject = useApp((s) => s.openProject)
  const loadProjects = useApp((s) => s.loadProjects)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [about, setAbout] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void api.project.suggestLocation().then(setParent)
  }, [])
  const sep = PLATFORM === 'win32' ? '\\' : '/'
  const clean = name.trim().replace(/[<>:"/\\|?*]/g, '')
  const target = parent && clean ? `${parent.replace(/[\\/]+$/, '')}${sep}${clean}` : ''
  const create = async (): Promise<void> => {
    if (!clean || !parent) return
    setBusy(true)
    setError(undefined)
    try {
      const p = await api.project.create(parent, clean, about)
      await loadProjects()
      useApp.setState({ project: p, mode: 'code', currentId: undefined, view: 'chat' })
      useApp.getState().focusComposer()
      onClose()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[min(540px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-raised p-6 shadow-float">
          <div className="flex items-start gap-3">
            <FolderPlus size={20} className="mt-0.5 text-petal" aria-hidden />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[1.1rem] font-semibold text-text">New project</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[0.86rem] text-text-2">Maris makes a folder for it. Every task in the project works inside that folder.</Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 text-text-3 hover:bg-sunken hover:text-text" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label className="mt-5 block">
              <span className="text-[0.88rem] text-text">Name</span>
              <input autoFocus className={cn(inputCls, 'mt-1')} value={name} maxLength={80} placeholder="For example: pixel-platformer" onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="mt-4">
              <span className="text-[0.88rem] text-text">Where</span>
              <div className="mt-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[0.8rem] text-text-2" title={parent}>
                  {parent || '…'}
                </span>
                <Button type="button" variant="outline" onClick={() => void api.settings.pickFolder(parent).then((p) => p && setParent(p))}>
                  Change…
                </Button>
              </div>
            </div>
            <label className="mt-4 block">
              <span className="text-[0.88rem] text-text">What is it about? (optional)</span>
              <span className="block text-[0.8rem] text-text-3">Maris reads this before every task in the project.</span>
              <textarea
                className={cn(inputCls, 'mt-1.5 min-h-[90px] resize-y py-2 leading-relaxed')}
                value={about}
                maxLength={2000}
                placeholder="For example: A small 2D platformer in HaxeFlixel with pixel art. Keep the code simple."
                onChange={(e) => setAbout(e.target.value)}
              />
            </label>
            {target && (
              <p className="mt-3 truncate text-[0.82rem] text-text-3" title={target}>
                New folder: <span className="font-mono text-text-2">{target}</span>
              </p>
            )}
            {error && <p className="mt-2 text-[0.84rem] text-danger">{error}</p>}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onClose()
                  void openProject()
                }}
              >
                <FolderOpen size={14} /> Open a folder I already have
              </Button>
              <div className="flex-1" />
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={busy || !clean || !parent}>
                <FolderPlus size={14} /> {busy ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Name, what the project is about (every task in it sees this), and what Maris knows about it. */
function AboutProject({ p, tasks, onClose }: { p: Project; tasks: number; onClose: () => void }) {
  const loadProjects = useApp((s) => s.loadProjects)
  const [name, setName] = useState(p.name)
  const [about, setAbout] = useState(p.description ?? '')
  const [allowed, setAllowed] = useState(p.allowedCommands)
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.project.update(p.path, { name, description: about })
      await loadProjects()
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-raised p-6 shadow-float">
          <div className="flex items-start gap-3">
            <FolderOpen size={20} className="mt-0.5 text-petal" aria-hidden />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[1.1rem] font-semibold text-text">About this project</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-[0.82rem] text-text-3" title={p.path}>
                {p.path}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 text-text-3 hover:bg-sunken hover:text-text" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          <label className="mt-5 block">
            <span className="text-[0.88rem] text-text">Name in Maris</span>
            <input className={cn(inputCls, 'mt-1')} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="mt-4 block">
            <span className="text-[0.88rem] text-text">What is this project about?</span>
            <span className="block text-[0.8rem] text-text-3">Maris reads this before every task in this project. Say what it is, who it is for, and anything to keep in mind.</span>
            <textarea
              className={cn(inputCls, 'mt-1.5 min-h-[120px] resize-y py-2 leading-relaxed')}
              value={about}
              maxLength={2000}
              placeholder="For example: A pixel-art platformer in HaxeFlixel for a game jam. Keep the 16×16 tile style, target HTML5 first, and keep the code simple."
              onChange={(e) => setAbout(e.target.value)}
            />
          </label>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-sunken/60 px-4 py-3 text-[0.84rem]">
            <dt className="text-text-3">Tools found</dt>
            <dd className="text-text">{p.stack?.length ? p.stack.join(', ') : 'Not detected yet'}</dd>
            <dt className="text-text-3">Tasks</dt>
            <dd className="text-text">{tasks}</dd>
            <dt className="text-text-3">Last opened</dt>
            <dd className="text-text">{p.lastOpened ? relativeDay(p.lastOpened) : 'Never'}</dd>
            <dt className="text-text-3">Always allowed</dt>
            <dd className="text-text">
              {allowed.length === 0 ? (
                <span className="text-text-3">No commands. When Maris asks to run one, “Always approve” can add it here.</span>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {allowed.map((c) => (
                    <li key={c} className="inline-flex items-center gap-1 rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.78rem]">
                      {c}
                      <button
                        aria-label={`Stop always allowing ${c}`}
                        className="rounded text-text-3 hover:text-danger"
                        onClick={() => void api.project.forgetCommand(p.path, c).then((np) => np && setAllowed(np.allowedCommands))}
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
          <div className="mt-5 flex justify-end gap-2">
            {!REMOTE && (
              <Button variant="ghost" onClick={() => void api.shell.openPath(p.path)}>
                <FolderOpen size={14} /> Open the folder
              </Button>
            )}
            <Button variant="primary" disabled={saving || !name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Removing a project takes its tasks with it; the folder and its files stay where they are. */
function RemoveProject({ p, tasks, onClose }: { p: Project; tasks: Conversation[]; onClose: () => void }) {
  const loadProjects = useApp((s) => s.loadProjects)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
          <Dialog.Title className="text-[1.1rem] font-semibold text-text">Remove {p.name} from Maris?</Dialog.Title>
          <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">
            {tasks.length ? `Its ${tasks.length} task${tasks.length === 1 ? '' : 's'} in Maris are deleted too. ` : ''}The folder and every file in it stay as they are; you can add it again
            any time.
          </Dialog.Description>
          {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[0.84rem] text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">Keep it</Button>
            </Dialog.Close>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(undefined)
                void (async () => {
                  try {
                    for (const c of tasks) await api.conv.remove(c.id)
                    await api.project.remove(p.path)
                    await loadProjects()
                    const open = useApp.getState().project
                    if (open && keyOf(open.path) === keyOf(p.path)) useApp.setState({ project: useApp.getState().projects[0] })
                    onClose()
                  } catch (e) {
                    // Without this the dialog would stay greyed out with no way on.
                    setError(`Could not remove it: ${String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')}`)
                    setBusy(false)
                  }
                })()
              }}
            >
              <Trash2 size={14} /> Remove{tasks.length ? ` with ${tasks.length} task${tasks.length === 1 ? '' : 's'}` : ''}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
