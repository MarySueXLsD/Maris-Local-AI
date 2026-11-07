import { MonitorCog, X } from 'lucide-react'
import { Dialog, Popover } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { GpuProgram, GpuProgramList, GpuStatus, SystemStatus } from '@shared/types'
import { api } from '../lib/api'
import { gb } from '../lib/format'
import { IS_WIN } from '../lib/platform'
import { Button, cn, Spinner } from './ui'

const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** Other programs must fill at least this share of video memory before Maris lists them. */
const HEAVY_SHARE = 0.5
/** Programs smaller than this are not worth ending for memory. */
const MIN_MB = 50

const what = (p: GpuProgram): string => (p.detail ? `${p.exe} running ${p.detail}` : p.exe)

function EndProgramDialog({ p, onClose, onEnded }: { p: GpuProgram; onClose: () => void; onEnded: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
          <Dialog.Title className="text-[1.1rem] font-semibold text-text">End {p.name}?</Dialog.Title>
          <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">
            {p.name} ({what(p)}) is using {gb(p.vramMB)} of video memory. Maris ends it now, with its helper processes, {IS_WIN ? 'like End task in Task Manager' : 'like a force quit'}. Anything unsaved in it is lost.
          </Dialog.Description>
          {p.alsoEnds?.length ? (
            <p className="mt-3 rounded-lg border border-line bg-sunken px-3 py-2 text-[0.86rem] text-text">
              It also ends what it started:{' '}
              <span className="font-medium">
                {p.alsoEnds.slice(0, 5).join(', ')}
                {p.alsoEnds.length > 5 ? ` and ${p.alsoEnds.length - 5} more` : ''}
              </span>
              .
            </p>
          ) : null}
          {error && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[0.86rem] text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={busy}>
                Keep it running
              </Button>
            </Dialog.Close>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(undefined)
                try {
                  await api.system.endProgram(p.pid)
                  onEnded()
                } catch (e) {
                  setError(clean(e))
                  setBusy(false)
                }
              }}
            >
              <X size={14} /> {busy ? 'Ending…' : `End ${p.name.length > 24 ? 'it' : p.name}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The status bar's VRAM reading. Pointing at it (or clicking it) shows how the memory is shared; when
 * other programs fill half of it or more, it also lists the three biggest with a button to end each,
 * which asks first.
 */
export function VramSeg({ s, g, bar }: { s: SystemStatus; g: GpuStatus; bar: ReactNode }) {
  const total = g.memTotalMB || 1
  const used = g.memUsedMB
  const other = Math.min(used, s.external.vramMB)
  const ours = Math.max(0, used - other)
  const heavy = other >= total * HEAVY_SHARE
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<GpuProgramList>()
  const [loading, setLoading] = useState(false)
  const [ending, setEnding] = useState<GpuProgram>()
  const [note, setNote] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Opened by pointing: it must not take the keyboard away from the message box.
  const byHover = useRef(false)
  const content = useRef<HTMLDivElement>(null)

  const later = (fn: () => void, ms: number): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(fn, ms)
  }
  const load = (): void => {
    setLoading(true)
    void api.system
      .gpuPrograms()
      .then(setList)
      .catch((e) => setList({ supported: true, programs: [], system: { vramMB: 0, names: [] }, error: clean(e), ts: Date.now() }))
      .finally(() => setLoading(false))
  }

  // The first reading takes Windows a few seconds, so it starts as soon as other programs fill half the memory.
  useEffect(() => {
    if (heavy) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heavy])
  useEffect(() => {
    if (!open || !heavy) return
    load()
    // Each reading starts a short PowerShell query on Windows, so not too often.
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, heavy])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(undefined), 8000)
    return () => clearTimeout(t)
  }, [note])
  useEffect(() => () => clearTimeout(timer.current), [])

  const programs = (list?.programs ?? []).filter((p) => p.vramMB >= MIN_MB).slice(0, 3)
  const free = Math.max(0, total - used)
  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) byHover.current = false
        }}
      >
        <Popover.Anchor asChild>
          <button
            className={cn('tabular inline-flex h-full items-center gap-1.5 px-2.5 text-[0.76rem] whitespace-nowrap text-text-2 hover:bg-sunken', heavy && 'text-pollen')}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Video memory: ${gb(used)} of ${gb(total)} in use. Show what uses it.`}
            onPointerEnter={(e) => {
              if (e.pointerType === 'touch') return
              later(() => {
                if (!open) byHover.current = true
                setOpen(true)
              }, 300)
            }}
            onPointerLeave={() => {
              if (byHover.current) later(() => setOpen(false), 250)
              else clearTimeout(timer.current)
            }}
            onClick={() => {
              clearTimeout(timer.current)
              // A click keeps it open; a second click closes it.
              if (open && !byHover.current) setOpen(false)
              else {
                byHover.current = false
                setOpen(true)
                requestAnimationFrame(() => content.current?.focus())
              }
            }}
          >
            <MonitorCog size={12} aria-hidden />
            VRAM {gb(used)} / {gb(total)}
            {bar}
          </button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            ref={content}
            tabIndex={-1}
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={() => {
              if (byHover.current) later(() => setOpen(false), 300)
            }}
            className="z-50 w-[340px] rounded-xl border border-line bg-raised p-3.5 text-[0.8rem] leading-snug text-text shadow-float outline-none"
            aria-label="Video memory details"
          >
            <p className="font-medium">Video memory (VRAM) on the graphics card</p>
            <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
              <dt className="flex items-center gap-1.5 text-text-2">
                <span className="size-2 rounded-sm bg-petal" aria-hidden /> Maris models
              </dt>
              <dd className="tabular text-right">{gb(ours)}</dd>
              <dt className="flex items-center gap-1.5 text-text-2">
                <span className="size-2 rounded-sm bg-text-3/60" aria-hidden /> Other programs
              </dt>
              <dd className="tabular text-right">{gb(other)}</dd>
              <dt className="flex items-center gap-1.5 text-text-2">
                <span className="size-2 rounded-sm border border-line-strong" aria-hidden /> Free
              </dt>
              <dd className="tabular text-right">{gb(free)}</dd>
            </dl>
            {note && (
              <p className="mt-2 rounded-md bg-petal-soft px-2 py-1 text-text" role="status">
                {note}
              </p>
            )}
            {heavy && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                <p className="text-text-2">
                  Other programs fill {Math.round((other / total) * 100)}% of it, so Maris has to use smaller models. The biggest:
                </p>
                {list?.supported === false ? (
                  <p className="mt-1.5 text-text-3">This system does not say which program uses how much.</p>
                ) : programs.length ? (
                  <ul className="mt-1.5 space-y-0.5" aria-label="Programs using the most video memory">
                    {programs.map((p) => (
                      <li key={p.pid} className="flex items-center gap-2 rounded-md py-1 pl-1">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-text" title={p.name}>
                            {p.name}
                          </span>
                          <span className="block truncate text-[0.72rem] text-text-3" title={what(p)}>
                            {what(p)}
                          </span>
                        </span>
                        <span className="tabular shrink-0 text-text-2">{gb(p.vramMB)}</span>
                        <button
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:bg-danger-soft focus-visible:text-danger"
                          aria-label={`End ${p.name}`}
                          title={IS_WIN ? 'End task' : 'End it'}
                          onClick={() => setEnding(p)}
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : list?.error ? (
                  <p className="mt-1.5 text-danger">Could not list them: {list.error}</p>
                ) : loading || !list ? (
                  <p className="mt-1.5 flex items-center gap-2 text-text-3">
                    <Spinner className="size-3" /> Looking at what uses it…
                  </p>
                ) : (
                  <p className="mt-1.5 text-text-3">No single program uses much of it.</p>
                )}
                {list && list.system.vramMB >= 200 && (
                  <p className="mt-1.5 text-[0.74rem] text-text-3">
                    {IS_WIN ? 'Windows itself' : 'The desktop'} uses {gb(list.system.vramMB)} ({list.system.names.slice(0, 3).join(', ')}); Maris leaves that alone.
                  </p>
                )}
              </div>
            )}
            <Popover.Arrow className="fill-[var(--raised)]" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {ending && (
        <EndProgramDialog
          p={ending}
          onClose={() => setEnding(undefined)}
          onEnded={() => {
            setNote(`Ended ${ending.name}. Its memory is free again in a moment.`)
            setEnding(undefined)
            byHover.current = false
            setOpen(true)
            load()
          }}
        />
      )}
    </>
  )
}
