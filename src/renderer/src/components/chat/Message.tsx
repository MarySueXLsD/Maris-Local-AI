import {
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Cpu,
  FileCode2,
  FileText,
  FolderOpen,
  Gauge,
  Image as ImageIcon,
  ImagePlay,
  Mountain,
  Pencil,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Zap
} from 'lucide-react'
import { DropdownMenu, Popover } from 'radix-ui'
import { memo, useEffect, useRef, useState } from 'react'
import type { ApprovalRequest, ChatMessage, MediaResult, MessageActivity, Part, RouteDecision, Tier, ToolCallRecord } from '@shared/types'
import { api } from '../../lib/api'
import { REMOTE } from '../../lib/platform'
import { useMediaSrc } from '../Media'
import { duration, prettyModel } from '../../lib/format'
import { useApp } from '../../store'
import { Markdown } from '../Markdown'
import { Button, cn, IconButton, inputCls, Spinner, Tip } from '../ui'
import { ActivityGroup, TurnSummaryLine, WorkLog, type WorkItem } from './Activity'
import { FullControlPrompt } from './FullControlPrompt'
import { ToolCard } from './ToolCard'

const TIER_ICON: Record<string, typeof Zap> = { fast: Zap, balanced: Gauge, max: Mountain, tiny: Sparkles, custom: Sparkles }
const TIER_NAME: Record<string, string> = { fast: 'Fast', balanced: 'Balanced', max: 'Max', tiny: 'Tiny', custom: 'Chosen model' }

export function RouteChip({ route, model, live }: { route?: RouteDecision; model?: string; live?: boolean }) {
  const explain = useApp((s) => s.settings?.ui.showRouteReason ?? true)
  if (!route && !model) return null
  // Pictures and videos from the message box's Image and Video modes: no language model, no context.
  const made = route?.category === 'media' && route.numCtx === 0
  const Icon = made ? ImagePlay : (TIER_ICON[route?.tier ?? 'custom'] ?? Sparkles)
  return (
    <Tip
      label={
        <span className="block space-y-1">
          <span className="block font-medium">{prettyModel(route?.model ?? model)}</span>
          {explain && route?.reason && <span className="block text-text-2">{route.reason}</span>}
          {route && !made && (
            <span className="block text-text-3">
              {route.think ? 'Thinking on' : 'Thinking off'}, {Math.round(route.numCtx / 1024)}K context{route.cpuOnly ? ', on the CPU' : ', on the GPU'}
            </span>
          )}
          {made && <span className="block text-text-3">Made on your graphics card</span>}
        </span>
      }
    >
      <span
        tabIndex={0}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-[0.78rem] text-text-2',
          live && 'border-pollen/50'
        )}
      >
        <Icon size={12} className={live ? 'text-pollen' : 'text-petal'} aria-hidden />
        <span>{made ? (route?.auto ? 'Auto' : 'Your pick') : route?.auto ? `Auto: ${TIER_NAME[route.tier]}` : TIER_NAME[route?.tier ?? 'custom']}</span>
        <span className="text-text-3">{prettyModel(route?.model ?? model)}</span>
        {route?.cpuOnly && <Cpu size={12} aria-label="Running on CPU" />}
      </span>
    </Tip>
  )
}

function Thinking({ part, live, show }: { part: Extract<Part, { type: 'thinking' }>; live: boolean; show: boolean }) {
  const [open, setOpen] = useState(false)
  const done = part.durationMs !== undefined
  return (
    <div className="my-1">
      <button
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-[0.86rem] text-text-2 hover:text-text"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={14} className={done ? 'text-text-3' : 'text-pollen'} aria-hidden />
        <span className={!done && live ? 'live' : ''}>{done ? `Thought for ${duration(part.durationMs)}` : 'Thinking…'}</span>
        <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {(open || (!done && live && show)) && (
        <div className="selectable mt-1 max-h-64 overflow-auto border-l-2 border-line pl-3 text-[0.86rem] leading-relaxed whitespace-pre-wrap text-text-3">
          {part.text.trim()}
        </div>
      )}
    </div>
  )
}

export function MediaCard({ media }: { media: MediaResult }) {
  const src = useMediaSrc(media.path)
  return (
    <figure className="my-2 max-w-[560px]">
      {media.kind === 'image' ? (
        <button
          className="block overflow-hidden rounded-xl border border-line"
          onClick={() => (REMOTE ? src && window.open(src, '_blank') : void api.shell.openPath(media.path))}
          aria-label="Open image"
        >
          {src ? <img src={src} alt={media.prompt} className="block h-auto w-full" loading="lazy" /> : <span className="block aspect-square w-64 animate-pulse bg-sunken" />}
        </button>
      ) : src ? (
        <video src={src} controls loop playsInline className="block w-full rounded-xl border border-line" aria-label={media.prompt} />
      ) : (
        <span className="block aspect-video w-full animate-pulse rounded-xl bg-sunken" />
      )}
      <figcaption className="mt-1.5 flex items-center gap-2 text-[0.78rem] text-text-3">
        <span className="truncate">
          {media.model}, {media.width}×{media.height}
          {media.frames ? `, ${(media.frames / (media.fps ?? 16)).toFixed(1)} s` : ''}
        </span>
        {!REMOTE && (
          <button className="ml-auto inline-flex items-center gap-1 hover:text-text" onClick={() => void api.shell.showInFolder(media.path)}>
            <FolderOpen size={12} /> Show in folder
          </button>
        )}
      </figcaption>
    </figure>
  )
}

function UserBubble({ m }: { m: ChatMessage }) {
  const [editing, setEditing] = useState(false)
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const [draft, setDraft] = useState(text)
  const busy = useApp((s) => s.running[m.conversationId])
  return (
    <div className="group flex flex-col items-end gap-1.5">
      {m.media && (
        <span className="inline-flex items-center gap-1.5 text-[0.76rem] text-text-3">
          {m.media.kind === 'video' ? <Clapperboard size={12} aria-hidden /> : <ImageIcon size={12} aria-hidden />}
          {m.media.kind === 'video' ? (m.media.startImage ? 'Video from a picture' : 'Video') : m.media.count && m.media.count > 1 ? `${m.media.count} pictures` : 'Picture'}
          {m.media.aspect ? `, ${m.media.aspect}` : ''}
          {m.media.kind === 'video' && m.media.seconds ? `, ${m.media.seconds} s` : ''}
          {m.media.quality && m.media.quality !== 'auto' ? `, ${m.media.quality === 'quality' ? 'best quality' : 'fast'}` : ''}
        </span>
      )}
      {m.attachments && m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {m.attachments.map((a) =>
            a.kind === 'image' && a.dataUrl ? (
              <img key={a.id} src={a.dataUrl} alt={a.name} className="max-h-48 rounded-xl border border-line" />
            ) : a.kind === 'snippet' ? (
              <details key={a.id} className="max-w-full rounded-lg border border-line bg-surface text-[0.82rem] text-text-2">
                <summary className="flex items-center gap-1.5 px-2.5 py-1" title={a.path}>
                  <FileCode2 size={13} className="text-petal" /> {a.name}
                  {a.lines && <span className="text-text-3">· lines {a.lines[0] === a.lines[1] ? a.lines[0] : `${a.lines[0]}–${a.lines[1]}`}</span>}
                </summary>
                <pre className="selectable max-h-60 max-w-[min(640px,80vw)] overflow-auto border-t border-line px-3 py-2 font-mono text-[0.76rem] text-text">{a.text}</pre>
              </details>
            ) : (
              <span key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[0.82rem] text-text-2" title={a.path}>
                <FileText size={13} /> {a.name}
              </span>
            )
          )}
        </div>
      )}
      {editing ? (
        <div className="w-full max-w-[85%] space-y-2">
          <textarea
            className={cn(inputCls, 'min-h-24 resize-y')}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit your message"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false)
                void api.chat.edit(m.id, draft.trim())
              }}
            >
              Send edited message
            </Button>
          </div>
        </div>
      ) : (
        <div className="selectable max-w-[85%] rounded-[18px] rounded-br-md bg-petal-soft px-4 py-2.5 text-[1rem] leading-relaxed whitespace-pre-wrap text-text">
          {text}
        </div>
      )}
      {!editing && (
        <div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={text} />
          {!busy && (
            <IconButton label="Edit and resend" onClick={() => setEditing(true)}>
              <Pencil size={14} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <IconButton
      label={ok ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setOk(true)
        setTimeout(() => setOk(false), 1400)
      }}
    >
      {ok ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  )
}

function RegenerateMenu({ m }: { m: ChatMessage }) {
  const settings = useApp((s) => s.settings)
  const models = useApp((s) => s.models)
  const tiers: Tier[] = ['fast', 'balanced', 'max']
  const chat = models.filter((x) => !x.capabilities.includes('embedding'))
  return (
    <DropdownMenu.Root>
      <Tip label="Regenerate">
        <DropdownMenu.Trigger asChild>
          <button aria-label="Regenerate" className="inline-flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-sunken hover:text-text">
            <RefreshCw size={14} />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="start" className="z-50 min-w-60 rounded-xl border border-line bg-raised p-1.5 shadow-float">
          <DropdownMenu.Item className="menu-item" onSelect={() => void api.chat.regenerate(m.id)}>
            <RefreshCw size={14} /> Try again
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void api.chat.regenerate(m.id, undefined, 'on')}>
            <Sparkles size={14} /> Try again, thinking harder
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Label className="px-2 py-1 text-[0.75rem] text-text-3">Try again with</DropdownMenu.Label>
          {tiers.map((t) => {
            const name = settings?.tiers[t]
            if (!name || name === m.model) return null
            const Icon = TIER_ICON[t]
            return (
              <DropdownMenu.Item key={t} className="menu-item" onSelect={() => void api.chat.regenerate(m.id, name)}>
                <Icon size={14} /> {TIER_NAME[t]} <span className="ml-auto text-text-3">{prettyModel(name)}</span>
              </DropdownMenu.Item>
            )
          })}
          {chat
            .filter((x) => !tiers.some((t) => settings?.tiers[t] === x.name) && x.name !== settings?.tiers.tiny)
            .map((x) => (
              <DropdownMenu.Item key={x.name} className="menu-item" onSelect={() => void api.chat.regenerate(m.id, x.name)}>
                {prettyModel(x.name)}
              </DropdownMenu.Item>
            ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Feedback({ m }: { m: ChatMessage }) {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="Good answer" active={m.feedback === 1} onClick={() => void api.chat.feedback(m.id, m.feedback === 1 ? 0 : 1)}>
        <ThumbsUp size={14} />
      </IconButton>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            aria-label="Bad answer"
            aria-pressed={m.feedback === -1}
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-sunken hover:text-text',
              m.feedback === -1 && 'bg-petal-soft text-petal'
            )}
          >
            <ThumbsDown size={14} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content sideOffset={6} className="z-50 w-80 space-y-2 rounded-xl border border-line bg-raised p-3 shadow-float">
            <p className="text-[0.88rem] text-text">What should Maris do differently?</p>
            <textarea
              className={cn(inputCls, 'min-h-20 text-[0.88rem]')}
              placeholder="Optional. Maris remembers this for next time."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  void api.chat.feedback(m.id, -1, note.trim() || undefined)
                  setOpen(false)
                }}
              >
                Send feedback
              </Button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  )
}

/**
 * Parts with consecutive tool calls folded into one group (plans keep their own card). In between,
 * finished "thinking" blocks that only lead to the next step are folded in too, so a run of steps
 * reads as one list instead of being broken up by "Thought for 0.7 s" lines.
 */
function groupParts(parts: Part[], live: boolean): ({ kind: 'part'; part: Part; index: number } | { kind: 'tools'; calls: ToolCallRecord[]; index: number })[] {
  const out: ({ kind: 'part'; part: Part; index: number } | { kind: 'tools'; calls: ToolCallRecord[]; index: number })[] = []
  parts.forEach((p, index) => {
    // Finished thinking is shown once, combined, at the top of the answer (see CombinedThinking).
    const finishedThought = p.type === 'thinking' && p.durationMs !== undefined && !(live && index === parts.length - 1)
    if (finishedThought) return
    if (p.type === 'tool' && p.call.name !== 'update_plan') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.calls.push(p.call)
      else out.push({ kind: 'tools', calls: [p.call], index })
    } else out.push({ kind: 'part', part: p, index })
  })
  return out
}

/** Simple view in Code mode: thinking and steps between the messages to the person become one work log each. */
function groupWork(parts: Part[], live: boolean): ({ kind: 'part'; part: Part; index: number } | { kind: 'work'; items: WorkItem[]; index: number })[] {
  const out: ({ kind: 'part'; part: Part; index: number } | { kind: 'work'; items: WorkItem[]; index: number })[] = []
  parts.forEach((p, index) => {
    const item: WorkItem | undefined =
      p.type === 'thinking'
        ? { kind: 'thought', text: p.text, ms: p.durationMs, live: live && p.durationMs === undefined && index === parts.length - 1 }
        : p.type === 'tool' && p.call.name !== 'update_plan'
          ? { kind: 'step', call: p.call }
          : undefined
    if (!item) {
      out.push({ kind: 'part', part: p, index })
      return
    }
    const last = out[out.length - 1]
    if (last?.kind === 'work') last.items.push(item)
    else out.push({ kind: 'work', items: [item], index })
  })
  return out
}

/** Simple view: all of an answer's finished thinking as one line ("Thought for 3.2 s"), expandable. */
function CombinedThinking({ parts }: { parts: Extract<Part, { type: 'thinking' }>[] }) {
  const [open, setOpen] = useState(false)
  const total = parts.reduce((s, p) => s + (p.durationMs ?? 0), 0)
  if (!parts.length) return null
  return (
    <div className="my-1">
      <Tip label="Maris reasoned step by step before acting. Click to read its notes.">
        <button className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-[0.86rem] text-text-2 hover:text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Sparkles size={14} className="text-text-3" aria-hidden />
          Thought for {duration(total)}
          <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
      </Tip>
      {open && (
        <div className="selectable mt-1 max-h-72 overflow-auto border-l-2 border-line pl-3 text-[0.86rem] leading-relaxed whitespace-pre-wrap text-text-3">
          {parts.map((p) => p.text.trim()).join('\n\n')}
        </div>
      )}
    </div>
  )
}

/**
 * Between steps (a tool finished, the model reads the result and decides what to do next) nothing
 * streams for a while; this keeps it visible that Maris is still working.
 */
function NextStepIndicator({ since, activity }: { since: number; activity?: MessageActivity }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // What the model is doing (loading, reading, thinking) when Maris knows; otherwise how long it has been.
  const from = activity?.since ?? since
  const s = Math.max(0, Math.floor((now - from) / 1000))
  const text = activity?.text ?? (s < 10 ? 'Reading the results…' : s < 60 ? 'Working on the next step…' : 'Still working on the next step…')
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-[0.88rem]" role="status">
      <Spinner className="size-3.5 shrink-0" />
      <span className={cn('live min-w-0 truncate', activity?.text.startsWith('Thinking') && 'text-text-2 italic')} title={text}>
        {text}
      </span>
      {s >= 3 && <span className="tabular shrink-0 text-[0.8rem] text-text-3">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</span>}
    </div>
  )
}

/** When the answer is between steps (the last part is finished, nothing streams yet): a key for that moment. */
function idleKey(m: ChatMessage, live: boolean): string | undefined {
  if (!live || m.status !== 'streaming') return undefined
  const last = m.parts[m.parts.length - 1]
  if (!last) return undefined
  if (last.type === 'tool') {
    const c = last.call
    return c.status === 'done' || c.status === 'error' || c.status === 'denied' ? `${m.parts.length}:${c.id}` : undefined
  }
  if (last.type === 'notice' || last.type === 'media') return `${m.parts.length}:${last.type}`
  return undefined
}

function AssistantMessage({ m, approvals }: { m: ChatMessage; approvals: ApprovalRequest[] }) {
  const showThinking = useApp((s) => s.settings?.ui.showThinking ?? true)
  const simple = useApp((s) => (s.settings?.ui.activityView ?? 'simple') === 'simple')
  const codeChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.mode === 'code')
  const live = m.status === 'streaming' || m.status === 'waiting'
  const lastTextIdx = m.parts.map((p) => p.type).lastIndexOf('text')
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n')
  const empty = m.parts.length === 0
  const calls = m.parts.flatMap((p) => (p.type === 'tool' ? [p.call] : []))
  // Maris asked for full control of the PC: the card with the button shows however steps are grouped.
  const fullAsk = [...calls].reverse().find((c) => c.name === 'request_full_control' && c.status === 'done')
  const isLast = useApp((s) => {
    const list = s.messages[m.conversationId]
    return list?.[list.length - 1]?.id === m.id
  })
  // When the current pause began (kept across re-renders so the timer does not restart).
  const pause = useRef<{ key: string; since: number }>(undefined)
  const key = idleKey(m, live)
  if (key && pause.current?.key !== key) {
    const last = m.parts[m.parts.length - 1]
    pause.current = { key, since: last?.type === 'tool' && last.call.endedAt ? last.call.endedAt : Date.now() }
  }
  const idle = key ? pause.current?.since : undefined
  const renderPart = (p: Part, i: number): React.ReactNode => {
    if (p.type === 'text')
      return p.text ? <Markdown key={i} text={p.text} streaming={live && i === lastTextIdx && i === m.parts.length - 1} collapseCode={simple && codeChat} /> : null
    if (p.type === 'thinking') return <Thinking key={i} part={p} live={live} show={showThinking} />
    if (p.type === 'tool') return <ToolCard key={i} call={p.call} approval={approvals.find((a) => a.toolCallId === p.call.id)} />
    if (p.type === 'media') return <MediaCard key={i} media={p.media} />
    return (
      <p key={i} className={cn('rounded-lg px-3 py-2 text-[0.86rem]', p.tone === 'warn' ? 'bg-pollen-soft text-text' : 'bg-sunken text-text-2')}>
        {p.text}
        {p.conversationId && (
          <>
            {' '}
            <button className="font-medium text-petal underline-offset-2 hover:underline" onClick={() => void useApp.getState().open(p.conversationId!)}>
              Open that chat
            </button>
          </>
        )}
      </p>
    )
  }
  return (
    <div className="group space-y-1">
      {empty && live &&
        (m.activity ? (
          <NextStepIndicator since={m.activity.since} activity={m.activity} />
        ) : (
          <div className="flex items-center gap-2 py-1 text-[0.9rem]">
            <span className="live">{m.route ? `${prettyModel(m.route.model)} is getting ready…` : 'Choosing a model…'}</span>
          </div>
        ))}
      {/* The detailed view already streams the thinking itself. */}
      {!empty && live && idle === undefined && m.activity && !(m.parts[m.parts.length - 1]?.type === 'thinking' && !simple && showThinking) && (
        <NextStepIndicator since={m.activity.since} activity={m.activity} />
      )}
      {simple && !codeChat && (
        <CombinedThinking
          parts={m.parts.filter(
            (p, i): p is Extract<Part, { type: 'thinking' }> => p.type === 'thinking' && p.durationMs !== undefined && !(live && i === m.parts.length - 1)
          )}
        />
      )}
      {simple && codeChat
        ? groupWork(m.parts, live).map((g) => (g.kind === 'work' ? <WorkLog key={`w${g.index}`} items={g.items} approvals={approvals} /> : renderPart(g.part, g.index)))
        : simple
          ? groupParts(m.parts, live).map((g) => (g.kind === 'tools' ? <ActivityGroup key={`t${g.index}`} calls={g.calls} approvals={approvals} /> : renderPart(g.part, g.index)))
          : m.parts.map((p, i) => renderPart(p, i))}
      {idle !== undefined && <NextStepIndicator key={`${m.parts.length}`} since={idle} activity={m.activity} />}
      {fullAsk && <FullControlPrompt reason={String(fullAsk.args?.reason ?? 'For this task.')} latest={isLast} />}
      {simple && !live && calls.length > 0 && <TurnSummaryLine calls={calls} />}
      {m.status === 'error' && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[0.9rem] text-text">
          <p className="font-medium text-danger">The answer stopped with an error</p>
          <p className="selectable mt-0.5 text-text-2">{m.error}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void api.chat.regenerate(m.id)}>
            <RefreshCw size={14} /> Try again
          </Button>
        </div>
      )}
      {m.status === 'stopped' && <p className="text-[0.82rem] text-text-3">Stopped.</p>}
      <div className={cn('flex flex-wrap items-center gap-1 pt-1', live ? 'opacity-100' : 'opacity-70 group-hover:opacity-100 group-focus-within:opacity-100')}>
        <RouteChip route={m.route} model={m.model} live={live} />
        {!live && (
          <>
            {m.stats?.tokensPerSec && (
              <Tip
                label={`Written at ${m.stats.tokensPerSec} tokens per second (a token is about ¾ of a word): ${m.stats.outputTokens ?? 0} tokens out, ${m.stats.promptTokens ?? 0} read${m.stats.loadMs ? `, ${duration(m.stats.loadMs)} to load the model` : ''}.`}
              >
                <span tabIndex={0} className="tabular px-2 text-[0.76rem] text-text-3">
                  {simple ? `Answered in ${duration(m.stats.durationMs)}` : `${m.stats.tokensPerSec} tok/s in ${duration(m.stats.durationMs)}`}
                </span>
              </Tip>
            )}
            <span className="ml-auto flex items-center gap-0.5">
              {text && <CopyButton text={text} />}
              <RegenerateMenu m={m} />
              <Feedback m={m} />
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export const MessageView = memo(function MessageView({ m, approvals }: { m: ChatMessage; approvals: ApprovalRequest[] }) {
  return m.role === 'user' ? <UserBubble m={m} /> : <AssistantMessage m={m} approvals={approvals} />
})
