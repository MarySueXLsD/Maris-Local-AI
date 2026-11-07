import { ArrowRightLeft, AtSign, Check, ChevronRight, CircleStop, Download, FileDiff, FileMinus2, FilePen, FilePlus2, Folder, FolderOpen, FolderPlus, RefreshCw, RotateCcw, Terminal, TextSelect, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import hljs from 'highlight.js/lib/common'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ChatMessage, FileEntry, ToolCallRecord } from '@shared/types'
import { api, type ManagedProcess, type Toolchain } from '../../lib/api'
import { fileVisual } from '../../lib/fileTypes'
import { bytes, timeAgo } from '../../lib/format'
import { useApp } from '../../store'
import { MediaImg } from '../Media'
import { Button, cn, IconButton, Segmented, Spinner } from '../ui'
import { DEVICE, REMOTE, TRASH } from '../../lib/platform'

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i
const MAX_LINES = 5000

/** Highlighted HTML split into lines, closing and reopening the colour spans that cross a line break. */
function highlightLines(text: string, lang?: string): string[] {
  let html: string
  try {
    html = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(text.slice(0, 20000)).value
  } catch {
    html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  const lines: string[] = []
  const open: string[] = []
  let cur = ''
  for (let i = 0; i < html.length; i++) {
    const ch = html[i]
    if (ch === '<') {
      const end = html.indexOf('>', i)
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('</')) open.pop()
      else open.push(tag)
      cur += tag
      i = end
    } else if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
    } else cur += ch
  }
  lines.push(cur + '</span>'.repeat(open.length))
  return lines
}

interface Selected {
  start: number
  end: number
  text: string
}

/** A file's text with line numbers and colours. Selecting lines reports them (for "Mention selection"). */
function CodeViewer({ text, lang, onSelect }: { text: string; lang?: string; onSelect: (s?: Selected) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const source = useMemo(() => text.split(/\r?\n/), [text])
  const shown = useMemo(() => highlightLines(source.slice(0, MAX_LINES).join('\n'), lang), [source, lang])
  const read = (): void => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || !box.current?.contains(s.anchorNode)) return onSelect(undefined)
    const lineOf = (n: Node | null): number => Number(((n instanceof Element ? n : n?.parentElement)?.closest('[data-line]') as HTMLElement | null)?.dataset.line ?? 0)
    const a = lineOf(s.anchorNode)
    const b = lineOf(s.focusNode)
    if (!a || !b) return onSelect(undefined)
    const start = Math.min(a, b)
    const end = Math.max(a, b)
    const picked = s.toString()
    onSelect({ start, end, text: picked.trim() ? picked : source.slice(start - 1, end).join('\n') })
  }
  const digits = String(shown.length).length
  return (
    <div ref={box} className="selectable font-mono text-[0.82rem] leading-[1.6]" onMouseUp={read} onKeyUp={read} style={{ ['--gutter' as string]: `${digits + 2}ch` }}>
      {shown.map((html, i) => (
        <div
          key={i}
          data-line={i + 1}
          className="code-line flex whitespace-pre before:sticky before:left-0 before:w-[var(--gutter)] before:shrink-0 before:bg-raised before:pr-3 before:text-right before:text-text-3 before:select-none before:content-[attr(data-line)] hover:bg-sunken/60"
        >
          <code className="hljs min-w-0 bg-transparent! p-0!" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
        </div>
      ))}
    </div>
  )
}

/** A file from the project: text with line numbers (select lines to mention them), or the picture itself. */
function FilePreview({ path, onClose }: { path?: string; onClose: () => void }) {
  const [state, setState] = useState<{ text?: string; error?: string; size: number }>()
  const [sel, setSel] = useState<Selected>()
  const attach = useApp((s) => s.attachToComposer)
  const name = path?.split(/[\\/]/).pop() ?? ''
  const v = fileVisual(name)
  const image = Boolean(path && IMAGE.test(path))
  useEffect(() => {
    setState(undefined)
    setSel(undefined)
    if (path && !IMAGE.test(path)) void api.project.readFile(path).then(setState)
  }, [path])
  const lines = state?.text?.split(/\r?\n/).length ?? 0
  const mentionFile = async (): Promise<void> => {
    if (!path) return
    const atts = await api.files.attach([path]).catch(() => [] as Attachment[])
    attach(atts)
    onClose()
  }
  const mentionSelection = (): void => {
    if (!path || !sel) return
    attach([{ id: crypto.randomUUID(), kind: 'snippet', name, mime: 'text/plain', size: sel.text.length, path, text: sel.text, lines: [sel.start, sel.end] }])
    onClose()
  }
  return (
    <Dialog.Root open={Boolean(path)} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex h-[84vh] w-[min(1080px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-raised shadow-float">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <v.Icon size={16} style={{ color: v.color }} aria-hidden />
            <Dialog.Title className="min-w-0 flex-1 truncate font-mono text-[0.84rem] text-text" title={path}>
              {path}
            </Dialog.Title>
            <Dialog.Description className="sr-only">{v.label} file</Dialog.Description>
            {state?.size !== undefined && (
              <span className="text-[0.78rem] text-text-3">
                {v.label} · {bytes(state.size)}
                {lines ? ` · ${lines} lines` : ''}
              </span>
            )}
            {!image && (
              <Button
                size="sm"
                variant={sel ? 'primary' : 'outline'}
                disabled={!sel}
                title={sel ? 'Add these lines to your message as an attachment' : 'Select some lines first'}
                onClick={mentionSelection}
              >
                <TextSelect size={14} /> {sel ? `Mention lines ${sel.start === sel.end ? sel.start : `${sel.start}–${sel.end}`}` : 'Mention selection'}
              </Button>
            )}
            <Button size="sm" variant="outline" title="Attach the whole file to your message" onClick={() => void mentionFile()}>
              <AtSign size={14} /> Mention file
            </Button>
            <Dialog.Close asChild>
              <IconButton label="Close">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-2 pr-4">
            {image && path ? (
              <div className="flex h-full items-center justify-center p-4">
                <MediaImg path={path} alt={name} className="max-h-full max-w-full rounded-lg border border-line object-contain" />
              </div>
            ) : (
              <>
                {!state && <Spinner className="m-6" />}
                {state?.error && <p className="p-6 text-[0.9rem] text-text-2">{state.error === 'Binary file' ? 'This file is not text, so it cannot be shown here.' : state.error}</p>}
                {state?.text !== undefined && <CodeViewer text={state.text} lang={v.lang} onSelect={setSel} />}
                {lines > MAX_LINES && <p className="px-4 pt-2 text-[0.8rem] text-text-3">Showing the first {MAX_LINES} lines.</p>}
              </>
            )}
          </div>
          {!image && state?.text !== undefined && (
            <p className="border-t border-line px-4 py-2 text-[0.76rem] text-text-3">
              Select lines with the mouse, then “Mention lines” adds them to your message, so Maris looks at exactly that part.
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TreeNode({ entry, depth, onOpen, version }: { entry: FileEntry; depth: number; onOpen: (p: string) => void; version: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>()
  // Something in the project changed: an open folder reads its contents again.
  useEffect(() => {
    if (open && entry.dir) void api.project.files(entry.path).then(setChildren)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  const toggle = async (): Promise<void> => {
    if (!entry.dir) return onOpen(entry.path)
    if (!open) setChildren(await api.project.files(entry.path))
    setOpen(!open)
  }
  const v = fileVisual(entry.name)
  return (
    <li>
      <button
        onClick={() => void toggle()}
        aria-expanded={entry.dir ? open : undefined}
        className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[0.83rem] text-text-2 hover:bg-sunken hover:text-text"
        style={{ paddingLeft: 6 + depth * 14 }}
        title={entry.dir ? entry.path : `${entry.path}\n${v.label}${entry.size !== undefined ? `, ${bytes(entry.size)}` : ''}`}
      >
        {entry.dir ? (
          <>
            <ChevronRight size={12} className={cn('shrink-0 text-text-3 transition-transform', open && 'rotate-90')} />
            {open ? <FolderOpen size={14} className="shrink-0 text-petal" /> : <Folder size={14} className="shrink-0 text-petal" />}
          </>
        ) : (
          <v.Icon size={14} className="ml-[18px] shrink-0" style={{ color: v.color }} aria-hidden />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && children && (
        <ul>
          {children.map((c) => (
            <TreeNode key={c.path} entry={c} depth={depth + 1} onOpen={onOpen} version={version} />
          ))}
          {children.length === 0 && (
            <li className="py-0.5 text-[0.78rem] text-text-3" style={{ paddingLeft: 26 + depth * 14 }}>
              empty
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

const CHANGE_TOOLS = new Set(['write_file', 'write_files', 'edit_file', 'multi_edit', 'make_dir', 'copy_path', 'move_path', 'delete_path'])

type ChangeKind = 'added' | 'changed' | 'deleted' | 'moved' | 'folder'

interface Change {
  key: string
  kind: ChangeKind
  path: string
  /** For moves and copies: where it came from. */
  from?: string
  diff?: string
  add: number
  del: number
  call: ToolCallRecord
  /** Only whole-file changes with a backup can be undone. */
  backup?: string
}

const KIND_STYLE: Record<ChangeKind, { label: string; cls: string; Icon: typeof FilePlus2 }> = {
  added: { label: 'Added', cls: 'bg-ok-soft text-ok', Icon: FilePlus2 },
  changed: { label: 'Changed', cls: 'bg-petal-soft text-petal', Icon: FilePen },
  deleted: { label: 'Deleted', cls: 'bg-danger-soft text-danger', Icon: FileMinus2 },
  moved: { label: 'Moved', cls: 'bg-pollen-soft text-pollen', Icon: ArrowRightLeft },
  folder: { label: 'New folder', cls: 'bg-ok-soft text-ok', Icon: FolderPlus }
}

function counts(diff?: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of (diff ?? '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}

/** Every file change in this task, newest first, one entry per file. */
function changesOf(messages: ChatMessage[]): Change[] {
  const out: Change[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool' || !CHANGE_TOOLS.has(p.call.name) || p.call.status !== 'done') continue
      const c = p.call
      const a = c.args ?? {}
      const target = c.targets?.[c.targets.length - 1] ?? String(a.path ?? a.to ?? '')
      if (c.name === 'write_files') {
        const files = Array.isArray(a.files) ? (a.files as { path?: string; content?: string }[]) : []
        const result = c.result ?? ''
        ;(c.targets ?? []).forEach((t, i) => {
          const content = files[i]?.content ?? ''
          const replaced = result.includes(`Replaced ${t}`)
          // A final line break does not make another line.
          const rows = content.replace(/\r?\n$/, '').split(/\r?\n/)
          const diff = content ? `@@ -0,0 +1,${rows.length} @@\n${rows.map((l) => `+${l}`).join('\n')}` : undefined
          const n = counts(diff)
          if (files[i]) out.push({ key: `${c.id}:${i}`, kind: replaced ? 'changed' : 'added', path: t, diff, add: n.add, del: replaced ? 0 : 0, call: c })
        })
        continue
      }
      const n = counts(c.diff)
      const kind: ChangeKind =
        c.name === 'delete_path'
          ? 'deleted'
          : c.name === 'make_dir'
            ? 'folder'
            : c.name === 'move_path'
              ? 'moved'
              : c.name === 'copy_path' || (c.name === 'write_file' && /^Create/.test(c.title ?? ''))
                ? 'added'
                : 'changed'
      out.push({ key: c.id, kind, path: target, from: c.name === 'move_path' || c.name === 'copy_path' ? String(a.from ?? '') : undefined, diff: c.diff, add: n.add, del: n.del, call: c, backup: c.backup })
    }
  }
  return out.reverse()
}

/** A unified diff with old and new line numbers, + and − lines in colour, and the hunks apart. */
function RichDiff({ diff }: { diff: string }) {
  const rows: { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; a?: number; b?: number }[] = []
  let a = 0
  let b = 0
  for (const l of diff.split('\n')) {
    if (/^(Index:|={3,}|--- |\+\+\+ |\\ No newline)/.test(l)) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l)
    if (h) {
      a = Number(h[1])
      b = Number(h[2])
      rows.push({ kind: 'hunk', text: h[3]?.trim() || `Around line ${b || 1}` })
    } else if (l.startsWith('+')) rows.push({ kind: 'add', text: l.slice(1), b: b++ })
    else if (l.startsWith('-')) rows.push({ kind: 'del', text: l.slice(1), a: a++ })
    else if (l.length) rows.push({ kind: 'ctx', text: l.slice(1), a: a++, b: b++ })
  }
  return (
    <div className="selectable max-h-[64vh] overflow-auto rounded-lg border border-line bg-code font-mono text-[0.8rem] leading-[1.55]">
      {rows.map((r, i) =>
        r.kind === 'hunk' ? (
          <div key={i} className="border-y border-line bg-sunken px-3 py-1 text-[0.74rem] text-text-3">
            {r.text}
          </div>
        ) : (
          <div key={i} className={cn('flex whitespace-pre', r.kind === 'add' && 'bg-ok-soft', r.kind === 'del' && 'bg-danger-soft')}>
            <span className="w-11 shrink-0 pr-2 text-right text-text-3 select-none">{r.a ?? ''}</span>
            <span className="w-11 shrink-0 pr-2 text-right text-text-3 select-none">{r.b ?? ''}</span>
            <span className={cn('w-4 shrink-0 select-none', r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-text-3')}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            <span className={cn('pr-3', r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-text-2')}>{r.text || ' '}</span>
          </div>
        )
      )}
    </div>
  )
}

/** The first few added and removed lines of a change, in colour. */
function MiniDiff({ diff }: { diff: string }) {
  const lines = diff
    .split('\n')
    .filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .slice(0, 4)
  if (!lines.length) return null
  return (
    <div className="mt-1.5 overflow-hidden rounded-md border border-line bg-code font-mono text-[0.72rem] leading-[1.5]">
      {lines.map((l, i) => (
        <div key={i} className={cn('truncate px-2', l.startsWith('+') ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
          {l.startsWith('+') ? '+ ' : '− '}
          {l.slice(1) || ' '}
        </div>
      ))}
    </div>
  )
}

function Changes({ messages }: { messages: ChatMessage[] }) {
  const project = useApp((s) => s.project)
  const [diff, setDiff] = useState<Change>()
  const [reverted, setReverted] = useState<Set<string>>(new Set())
  const changes = useMemo(() => changesOf(messages), [messages])
  if (!changes.length) return <p className="px-3 py-4 text-[0.84rem] text-text-3">Files Maris adds, changes or deletes in this task show up here, with what changed and a one-click undo.</p>
  const tally = (k: ChangeKind): number => changes.filter((c) => c.kind === k).length
  const added = changes.reduce((s, c) => s + c.add, 0)
  const removed = changes.reduce((s, c) => s + c.del, 0)
  const rel = (p: string): string => (project && p.toLowerCase().startsWith(project.path.toLowerCase()) ? p.slice(project.path.length).replace(/^[\\/]/, '') : p)
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 text-[0.76rem]">
        {(['added', 'changed', 'deleted', 'moved', 'folder'] as ChangeKind[])
          .filter((k) => tally(k) > 0)
          .map((k) => (
            <span key={k} className={cn('rounded-full px-2 py-0.5 font-medium', KIND_STYLE[k].cls)}>
              {tally(k)} {KIND_STYLE[k].label.toLowerCase()}
            </span>
          ))}
        {(added > 0 || removed > 0) && (
          <span className="tabular ml-auto text-text-3">
            <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span> lines
          </span>
        )}
      </div>
      <ul className="space-y-1.5 p-2">
        {changes.map((c) => {
          const st = KIND_STYLE[c.kind]
          const v = fileVisual(c.path.split(/[\\/]/).pop() ?? '')
          return (
            <li key={c.key} className="rounded-lg border border-line px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.7rem] font-semibold', st.cls)}>
                  <st.Icon size={11} aria-hidden /> {st.label}
                </span>
                {c.kind !== 'folder' && c.kind !== 'deleted' && <v.Icon size={13} style={{ color: v.color }} className="shrink-0" aria-hidden />}
                <span className={cn('min-w-0 flex-1 truncate font-mono text-[0.78rem]', c.kind === 'deleted' ? 'text-text-3 line-through' : 'text-text')} title={c.path}>
                  {c.path.split(/[\\/]/).pop()}
                </span>
                {(c.add > 0 || c.del > 0) && (
                  <span className="tabular shrink-0 text-[0.74rem]">
                    {c.add > 0 && <span className="text-ok">+{c.add}</span>} {c.del > 0 && <span className="text-danger">−{c.del}</span>}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[0.72rem] text-text-3" title={c.from ? `${c.from} → ${c.path}` : c.path}>
                {c.from ? `${rel(c.from)} → ${rel(c.path)}` : rel(c.path)}
                {c.call.endedAt ? ` · ${timeAgo(c.call.endedAt)}` : ''}
                {c.kind === 'deleted' ? ` · in the ${TRASH}` : ''}
              </p>
              {c.diff && <MiniDiff diff={c.diff} />}
              <div className="mt-1.5 flex gap-1">
                {c.diff && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[0.78rem]" title="Before and after, line by line" onClick={() => setDiff(c)}>
                    <FileDiff size={13} /> See the change
                  </Button>
                )}
                {c.backup && !reverted.has(c.key) && !REMOTE && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[0.78rem]"
                    title="Put the file back the way it was before this change"
                    onClick={async () => {
                      await api.project.revert(c.backup!, c.path)
                      setReverted((s) => new Set(s).add(c.key))
                    }}
                  >
                    <RotateCcw size={13} /> Undo
                  </Button>
                )}
                {reverted.has(c.key) && <span className="px-2 text-[0.76rem] text-ok">Undone</span>}
              </div>
            </li>
          )
        })}
      </ul>
      <Dialog.Root open={Boolean(diff)} onOpenChange={(o) => !o && setDiff(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(980px,95vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-4 shadow-float">
            <div className="mb-3 flex items-center gap-2">
              {diff && <span className={cn('rounded-md px-1.5 py-0.5 text-[0.72rem] font-semibold', KIND_STYLE[diff.kind].cls)}>{KIND_STYLE[diff.kind].label}</span>}
              <Dialog.Title className="min-w-0 flex-1 truncate font-mono text-[0.84rem] text-text">{diff?.path}</Dialog.Title>
              {diff && (
                <span className="tabular text-[0.8rem]">
                  <span className="text-ok">+{diff.add}</span> <span className="text-danger">−{diff.del}</span>
                </span>
              )}
              <Dialog.Close asChild>
                <IconButton label="Close">
                  <X size={15} />
                </IconButton>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Green lines were added, red lines removed.</Dialog.Description>
            {diff?.diff && <RichDiff diff={diff.diff} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

function ToolsTab({ conversationId }: { conversationId?: string }) {
  const project = useApp((s) => s.project)
  const loadProjects = useApp((s) => s.loadProjects)
  const [env, setEnv] = useState<{ installed: Record<string, boolean>; toolchains: Toolchain[] }>()
  const [busy, setBusy] = useState<Record<string, 'running' | 'error'>>({})
  const [procs, setProcs] = useState<ManagedProcess[]>([])
  const [shown, setShown] = useState<string>()
  const [output, setOutput] = useState('')

  const refresh = useCallback((force = false) => void api.project.devEnv(force).then(setEnv), [])
  useEffect(() => {
    refresh()
    const off = api.project.onToolchain((e) => {
      setBusy((b) => {
        const next = { ...b }
        if (e.status === 'running') next[e.id] = 'running'
        else if (e.status === 'error') next[e.id] = 'error'
        else delete next[e.id]
        return next
      })
      if (e.status !== 'running') refresh(true)
    })
    return off
  }, [refresh])

  useEffect(() => {
    const tick = (): void => {
      void api.processes.list(conversationId).then(setProcs)
      if (shown) void api.processes.output(shown, 200).then(setOutput)
    }
    tick()
    const t = setInterval(tick, 2000)
    return () => clearInterval(t)
  }, [conversationId, shown])

  return (
    <div className="space-y-5 p-3">
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-[0.84rem] font-semibold text-text">Toolchains</h3>
          <IconButton label="Check again" onClick={() => refresh(true)}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        {!env && <Spinner className="mt-2" />}
        <ul className="mt-1 space-y-1">
          {env?.toolchains.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.82rem] text-text">{t.label}</span>
                <span className="block truncate text-[0.72rem] text-text-3">{t.languages}</span>
              </span>
              {env.installed[t.id] ? (
                <Check size={15} className="text-ok" aria-label="Installed" />
              ) : busy[t.id] === 'running' ? (
                <Spinner />
              ) : (
                <Button size="sm" variant="outline" className="h-7 px-2 text-[0.76rem]" title={`${t.sizeHint}. Runs: ${t.command}`} onClick={() => void api.project.installToolchain(t.id).catch(() => undefined)}>
                  <Download size={12} /> Install
                </Button>
              )}
            </li>
          ))}
        </ul>
        {Object.values(busy).includes('error') && <p className="mt-1 text-[0.76rem] text-danger">An install failed. Try again, or ask Maris to look at the error.</p>}
      </section>

      <section>
        <h3 className="text-[0.84rem] font-semibold text-text">Background processes</h3>
        {procs.length === 0 && <p className="mt-1 text-[0.78rem] text-text-3">Dev servers and watchers Maris starts appear here.</p>}
        <ul className="mt-1 space-y-1">
          {procs.map((p) => (
            <li key={p.id} className="rounded-lg border border-line px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Terminal size={13} className={p.running ? 'text-pollen' : 'text-text-3'} />
                <button className="min-w-0 flex-1 truncate text-left text-[0.8rem] text-text" onClick={() => setShown(shown === p.id ? undefined : p.id)}>
                  {p.name}
                </button>
                <span className="text-[0.72rem] text-text-3">{p.running ? 'running' : `exit ${p.exitCode ?? '?'}`}</span>
                {p.running && (
                  <IconButton label="Stop" onClick={() => void api.processes.stop(p.id)}>
                    <CircleStop size={13} />
                  </IconButton>
                )}
              </div>
              {shown === p.id && <pre className="selectable mt-1.5 max-h-56 overflow-auto rounded bg-code p-2 font-mono text-[0.7rem] whitespace-pre-wrap text-text-2">{output}</pre>}
            </li>
          ))}
        </ul>
      </section>

      {project && project.allowedCommands.length > 0 && (
        <section>
          <h3 className="text-[0.84rem] font-semibold text-text">Always allowed here</h3>
          <ul className="mt-1 space-y-1">
            {project.allowedCommands.map((c) => (
              <li key={c} className="flex items-center gap-2 text-[0.8rem]">
                <code className="min-w-0 flex-1 truncate rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.76rem]">{c}</code>
                <IconButton label={`Stop allowing ${c}`} onClick={() => void api.project.forgetCommand(project.path, c).then(loadProjects)}>
                  <X size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function ProjectPanel({ conversationId, messages }: { conversationId?: string; messages: ChatMessage[] }) {
  const project = useApp((s) => s.project)
  const [tab, setTab] = useState<'files' | 'changes' | 'tools'>('files')
  const [root, setRoot] = useState<FileEntry[]>([])
  const [preview, setPreview] = useState<string>()
  // Bumped whenever anything in the project folder changes, so open folders read their contents again.
  const [version, setVersion] = useState(0)
  const changeCount = useMemo(() => changesOf(messages).length, [messages])

  useEffect(() => {
    if (!project) return
    void api.project.watch(project.path)
    const off = api.project.onChanged((e) => {
      if (e.dir.toLowerCase() === project.path.toLowerCase()) setVersion((v) => v + 1)
    })
    // Back in the window after working elsewhere: look again too.
    const onFocus = (): void => setVersion((v) => v + 1)
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [project])
  useEffect(() => () => void api.project.watch(undefined), [])

  useEffect(() => {
    if (project) void api.project.files(project.path).then(setRoot)
  }, [project, changeCount, version])

  if (!project) return null
  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-line bg-side" aria-label="Project">
      {/* The window's minimise/maximise/close buttons sit over this strip. */}
      <div className="drag h-11 shrink-0" />
      <div className="flex shrink-0 items-center px-3 pb-2">
        <Segmented
          size="sm"
          label="Project panel"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'files', label: 'Files', title: 'Browse and preview the files in this project; it updates by itself when files change' },
            { value: 'changes', label: changeCount ? `Changes ${changeCount}` : 'Changes', title: 'Every file Maris added, changed or deleted in this task, with a one-click undo' },
            { value: 'tools', label: 'Tools', title: `Programming tools on this ${DEVICE}, apps Maris started, and commands you chose to always allow` }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'files' && (
          <ul className="px-1.5 pb-3">
            {root.map((e) => (
              <TreeNode key={e.path} entry={e} depth={0} onOpen={setPreview} version={version} />
            ))}
            {root.length === 0 && <li className="px-2 py-3 text-[0.82rem] text-text-3">This folder is empty. Ask Maris to create a project here.</li>}
          </ul>
        )}
        {tab === 'changes' && <Changes messages={messages} />}
        {tab === 'tools' && <ToolsTab conversationId={conversationId} />}
      </div>
      <FilePreview path={preview} onClose={() => setPreview(undefined)} />
    </aside>
  )
}
