import {
  AlertTriangle,
  Ban,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Cog,
  FilePen,
  FilePlus2,
  FlaskConical,
  GitBranch,
  Globe,
  Hammer,
  Image as ImageIcon,
  ListChecks,
  Package,
  Play,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRequest, ToolCallRecord } from '@shared/types'
import { cn, Spinner, Tip } from '../ui'
import { describeCall, imperative, summarize, type ActKind, type Described } from './describe'
import { MediaProgressCard } from './MediaProgress'
import { ApprovalPanel, DiffView } from './ToolCard'

const ICON: Record<ActKind, LucideIcon> = {
  explore: BookOpen,
  edit: FilePen,
  create: FilePlus2,
  delete: Trash2,
  test: FlaskConical,
  build: Hammer,
  run: Play,
  install: Package,
  git: GitBranch,
  web: Globe,
  process: SquareTerminal,
  look: ImageIcon,
  system: Cog,
  memory: Brain,
  media: Clapperboard,
  plan: ListChecks,
  other: SquareTerminal
}

const live = (c: ToolCallRecord): boolean => c.status === 'running' || c.status === 'pending'

function Details({ call, d }: { call: ToolCallRecord; d: Described }) {
  return (
    <div className="mt-1.5 mb-1 ml-7 space-y-2 border-l border-line pl-3">
      {call.diff && <DiffView diff={call.diff} />}
      {call.preview && <img src={call.preview} alt="What Maris saw" className="max-w-sm rounded-lg border border-line" />}
      {d.command && (
        <pre className="selectable overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[0.78rem] text-text">
          <span className="text-text-3">&gt; </span>
          {d.command}
        </pre>
      )}
      {call.error && <p className="selectable text-[0.84rem] text-danger">{call.error}</p>}
      {call.result && !call.diff && (
        <pre className="selectable max-h-60 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[0.76rem] leading-relaxed whitespace-pre-wrap text-text-2">
          {call.result.replace(/^\$ .*\n/, '')}
        </pre>
      )}
    </div>
  )
}

function Row({ call, approval }: { call: ToolCallRecord; approval?: ApprovalRequest }) {
  const d = describeCall(call)
  const [open, setOpen] = useState(false)
  const Icon = ICON[d.kind]
  const running = live(call)
  const failed = call.status === 'error' || d.ok === false
  const denied = call.status === 'denied'
  const waiting = call.status === 'awaiting-approval'
  const text = denied ? `You said no: ${imperative(d.running)}` : running || waiting ? d.running : call.status === 'error' ? `Could not ${imperative(d.running)}` : d.done
  const hasDetails = Boolean(call.diff || call.result || call.error || call.preview || d.command)
  return (
    <div>
      <div className="flex items-start gap-2.5 px-3 py-1.5">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Spinner className="size-3.5" />
          ) : waiting ? (
            <ShieldAlert size={15} className="text-pollen" aria-label="Waiting for your OK" />
          ) : denied ? (
            <Ban size={14} className="text-text-3" aria-label="You said no" />
          ) : failed ? (
            <CircleAlert size={15} className="text-danger" aria-label="Did not work" />
          ) : (
            <Icon size={15} className={d.important ? 'text-pollen' : 'text-text-2'} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.9rem] leading-snug">
            <span className={cn(running ? 'live' : denied ? 'text-text-3' : 'text-text')}>{text}</span>
            {d.outcome && !running && !denied && (
              <span className={cn('ml-1.5', d.ok === false ? 'text-danger' : d.ok ? 'text-ok' : 'text-text-3')}>
                {d.kind === 'edit' || d.kind === 'create' ? d.outcome : `— ${d.outcome}`}
              </span>
            )}
          </p>
          {d.important && !denied && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {d.command && <code className="selectable max-w-full truncate rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.76rem] text-text">{d.command}</code>}
              {d.why && (
                <Tip label="Shown even in Simple view because it matters. Maris always asks before steps like this.">
                  <span tabIndex={0} className="inline-flex items-center gap-1 rounded-md bg-pollen-soft px-1.5 py-0.5 text-[0.72rem] text-text">
                    <AlertTriangle size={11} className="text-pollen" aria-hidden /> {d.why}
                  </span>
                </Tip>
              )}
            </div>
          )}
          {call.autoApproved && <p className="mt-0.5 text-[0.74rem] text-text-3">{call.autoApproved}</p>}
          {call.note && denied && <p className="selectable mt-0.5 text-[0.78rem] text-text-2">{call.note}</p>}
          {call.media && running && <MediaProgressCard m={call.media} />}
        </div>
        {hasDetails && !waiting && (
          <Tip label={open ? 'Hide details' : d.kind === 'edit' || d.kind === 'create' ? 'See the change' : 'Show the technical details'}>
            <button
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'}
              className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-sunken hover:text-text"
            >
              <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
            </button>
          </Tip>
        )}
      </div>
      {open && <Details call={call} d={d} />}
      {approval && waiting && (
        <div className="px-3 pb-2">
          <ApprovalPanel request={approval} simple described={d} />
        </div>
      )}
    </div>
  )
}

/** Several quiet look-around steps in a row become one line: "Looked through the project". */
function ExploreRow({ calls }: { calls: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false)
  const busy = calls.some(live)
  const ds = calls.map(describeCall)
  const subjects = [...new Set(ds.map((d) => d.subject).filter(Boolean) as string[])]
  const reads = calls.filter((c) => c.name === 'read_file').length
  const searches = calls.filter((c) => c.name === 'grep' || c.name === 'search_files').length
  const bits = [reads && `read ${reads} file${reads > 1 ? 's' : ''}`, searches && `searched ${searches} time${searches > 1 ? 's' : ''}`].filter(Boolean).join(', ')
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left hover:bg-sunken/60">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{busy ? <Spinner className="size-3.5" /> : <BookOpen size={15} className="text-text-2" aria-hidden />}</span>
        <span className="min-w-0 flex-1 text-[0.9rem] leading-snug">
          <span className={busy ? 'live' : 'text-text'}>{busy ? 'Looking through the project' : 'Looked through the project'}</span>
          {bits && <span className="ml-1.5 text-text-3">({bits})</span>}
          {subjects.length > 0 && (
            <span className="mt-0.5 block truncate text-[0.8rem] text-text-3">
              {subjects.slice(0, 4).join(', ')}
              {subjects.length > 4 ? ` and ${subjects.length - 4} more` : ''}
            </span>
          )}
        </span>
        <ChevronRight size={14} className={cn('mt-1 shrink-0 text-text-3 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <ul className="mb-1 ml-10 space-y-0.5 border-l border-line pl-3 text-[0.82rem] text-text-2">
          {ds.map((d, i) => (
            <li key={calls[i].id}>{live(calls[i]) ? d.running : d.done}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Tool steps of one stretch of an answer, described in plain words. */
export function ActivityGroup({ calls, approvals }: { calls: ToolCallRecord[]; approvals: ApprovalRequest[] }) {
  const blocks: ToolCallRecord[][] = []
  for (const c of calls) {
    const quiet = describeCall(c).kind === 'explore' && c.status !== 'awaiting-approval' && c.status !== 'error'
    const last = blocks[blocks.length - 1]
    if (quiet && last && describeCall(last[0]).kind === 'explore' && last[0].status !== 'error') last.push(c)
    else blocks.push([c])
  }
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line bg-sunken/40 py-1" role="list" aria-label="What Maris did">
      {blocks.map((b) => (
        <div role="listitem" key={b[0].id}>
          {b.length > 1 ? <ExploreRow calls={b} /> : <Row call={b[0]} approval={approvals.find((a) => a.toolCallId === b[0].id)} />}
        </div>
      ))}
    </div>
  )
}

export type WorkItem = { kind: 'thought'; text: string; ms?: number; live?: boolean } | { kind: 'step'; call: ToolCallRecord }

function since(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
}

/**
 * Simple view in Code mode, for people who do not program: a stretch of work is one quiet line, like a
 * thought. While Maris works it says what it is doing in plain words; afterwards "Worked for 1 min".
 * Opening it shows Maris's notes and the steps as plain sentences: no commands, no code, no diffs.
 * Questions for the person (approvals) and picture progress always stay visible.
 */
export function WorkLog({ items, approvals }: { items: WorkItem[]; approvals: ApprovalRequest[] }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const calls = items.flatMap((i) => (i.kind === 'step' ? [i.call] : []))
  const running = calls.find(live)
  const waiting = calls.filter((c) => c.status === 'awaiting-approval')
  const thinking = items.some((i) => i.kind === 'thought' && i.live)
  const busy = Boolean(running || thinking || waiting.length)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])
  const failed = calls.filter((c) => c.status === 'error' || describeCall(c).ok === false).length
  const worked = calls.reduce((s, c) => s + (c.startedAt ? (c.endedAt ?? now) - c.startedAt : 0), 0) + items.reduce((s, i) => s + (i.kind === 'thought' ? (i.ms ?? 0) : 0), 0)
  const steps = calls.length
  const headline = waiting.length
    ? 'Waiting for your OK'
    : running
      ? describeCall(running).running
      : thinking
        ? 'Thinking it through…'
        : `Worked for ${since(worked)}`
  const meta = !busy && steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : running?.startedAt ? ` · ${since(now - running.startedAt)}` : ''
  return (
    <div className="my-1.5">
      <Tip label={open ? 'Hide the steps' : 'See what Maris did, step by step, in plain words'}>
        <button className="inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[0.88rem] text-text-2 hover:text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
          {busy ? <Spinner className="size-3.5 shrink-0" /> : <Sparkles size={14} className="shrink-0 text-text-3" aria-hidden />}
          <span className={cn('truncate', busy && 'live', waiting.length > 0 && 'text-pollen')}>{headline}</span>
          <span className="tabular shrink-0 text-text-3">{meta}</span>
          {failed > 0 && !busy && <span className="shrink-0 text-danger"> · {failed === 1 ? 'one step did not work' : `${failed} steps did not work`}</span>}
          <ChevronRight size={13} className={cn('shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
      </Tip>
      {open && (
        <ol className="selectable mt-1 mb-1 max-h-96 space-y-1.5 overflow-y-auto border-l-2 border-line py-0.5 pl-3 text-[0.86rem]" aria-label="Steps">
          {items.map((it, i) =>
            it.kind === 'thought' ? (
              it.text.trim() ? (
                <li key={`t${i}`} className="leading-relaxed whitespace-pre-wrap text-text-3">
                  {it.text.trim()}
                </li>
              ) : null
            ) : (
              <WorkStep key={it.call.id} call={it.call} />
            )
          )}
        </ol>
      )}
      {waiting.map((c) => {
        const a = approvals.find((x) => x.toolCallId === c.id)
        return a ? <ApprovalPanel key={c.id} request={a} simple described={describeCall(c)} /> : null
      })}
      {running?.media && <MediaProgressCard m={running.media} />}
    </div>
  )
}

function WorkStep({ call }: { call: ToolCallRecord }) {
  const d = describeCall(call)
  const failed = call.status === 'error' || d.ok === false
  const denied = call.status === 'denied'
  const text = denied ? `You said no: ${imperative(d.running)}` : live(call) ? d.running : call.status === 'error' ? `Could not ${imperative(d.running)}` : d.done
  return (
    <li className="flex items-start gap-2">
      <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
        {live(call) ? (
          <Spinner className="size-3" />
        ) : denied ? (
          <Ban size={12} className="text-text-3" aria-label="You said no" />
        ) : failed ? (
          <CircleAlert size={13} className="text-danger" aria-label="Did not work" />
        ) : (
          <Check size={13} className="text-ok" aria-hidden />
        )}
      </span>
      <span className={cn(denied ? 'text-text-3' : 'text-text-2')}>
        {text}
        {d.outcome && !live(call) && !denied && <span className={cn('ml-1', d.ok === false ? 'text-danger' : 'text-text-3')}>{d.kind === 'edit' || d.kind === 'create' ? d.outcome : `— ${d.outcome}`}</span>}
        {call.note && denied && <span className="selectable block text-[0.78rem] text-text-2">{call.note}</span>}
      </span>
    </li>
  )
}

/** One line under a finished answer: what changed and whether it works. */
export function TurnSummaryLine({ calls }: { calls: ToolCallRecord[] }) {
  const s = summarize(calls)
  const parts: { text: string; tone?: 'ok' | 'bad' }[] = []
  if (s.changed.length) parts.push({ text: `Changed ${s.changed.length === 1 ? s.changed[0] : `${s.changed.length} files`}` })
  if (s.created.length) parts.push({ text: `Created ${s.created.length === 1 ? s.created[0] : `${s.created.length} files`}` })
  if (s.builds !== undefined) parts.push({ text: s.builds ? 'Builds without errors' : 'Build has errors', tone: s.builds ? 'ok' : 'bad' })
  if (s.tests !== undefined) parts.push({ text: s.tests ? 'Tests pass' : 'Some tests fail', tone: s.tests ? 'ok' : 'bad' })
  if (s.failedSteps) parts.push({ text: `${s.failedSteps} step${s.failedSteps > 1 ? 's' : ''} did not work`, tone: 'bad' })
  if (!parts.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Summary of this answer">
      {parts.map((p) => (
        <span
          key={p.text}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[0.76rem]',
            p.tone === 'ok' ? 'border-ok/40 text-ok' : p.tone === 'bad' ? 'border-danger/40 text-danger' : 'border-line text-text-2'
          )}
        >
          {p.text}
        </span>
      ))}
    </div>
  )
}
