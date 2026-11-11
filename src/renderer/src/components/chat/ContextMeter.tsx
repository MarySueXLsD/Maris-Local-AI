import { Minimize2 } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useState } from 'react'
import { contextLabel } from '@shared/context'
import { patchFor } from '@shared/defaults'
import type { ContextSizeOption, ContextSizes, ContextUsage } from '@shared/types'
import { api } from '../../lib/api'
import { prettyModel } from '../../lib/format'
import { useApp } from '../../store'
import { Button, cn, Spinner } from '../ui'

/** One colour per kind of content, the same in the ring's popover bar and its list. */
const COLORS: Record<string, string> = {
  instructions: '#8f89ad',
  tools: '#6f8cff',
  services: '#33b3a6',
  skills: '#a78bfa',
  memory: '#e0a63a',
  project: '#4fb37a',
  custom: '#ec7aa3',
  summary: '#98a2b8',
  messages: 'var(--petal)',
  results: '#e2884a',
  pictures: '#cf68cc'
}

/** Window sizes as the settings name them: 32768 → 32K, 1000000 → 1M. */
const kb = contextLabel

/** A token count: 950, 4.2K, 180K, 1.3M. */
function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n)
}

/** What a window size means and what it costs here, in words. */
function sizeWords(o: ContextSizeOption): { amount: string; cost: string } {
  const words = Math.round((o.tokens * 0.75) / 1000) * 1000
  const amount = `${kb(o.tokens)} tokens: about ${words.toLocaleString('en-US')} words, or ${Math.max(1, Math.round(words / 400)).toLocaleString('en-US')} pages of chat, code and tool results.`
  const cost =
    o.fit === 'gpu'
      ? 'Fits in video memory together with the model: full speed.'
      : o.fit === 'cpu'
        ? 'The model runs on the processor: a bigger window mainly makes reading long prompts slower.'
        : o.fit === 'api'
          ? o.tokens >= 400000
            ? 'The model runs at an API service: this is how much of a long chat is sent with each message before older messages are summarised. A window this full is sent again with every message, and the service bills for all of it (less for what it has cached), so a long chat gets expensive.'
            : 'The model runs at an API service: this is how much of a long chat is sent with each message before older messages are summarised. More keeps more in view and costs more per message.'
          : o.fit === 'none'
            ? `Model and window together need about ${Math.round((o.needMB ?? 0) / 1024)} GB of memory, which is more than this computer has.`
            : `About ${((o.spillMB ?? 0) / 1024).toFixed(1)} GB would not fit in video memory and runs from system memory: writing about ${o.slower}× slower.`
  return { amount, cost }
}

const FIT_DOT: Record<ContextSizeOption['fit'], string> = { gpu: 'bg-ok', spill: 'bg-pollen', cpu: 'bg-text-3', api: 'bg-petal', none: 'bg-danger' }

/** Pick the window size for this chat's model role, with what each size means for speed on this computer. */
function SizePicker({ sizes, onPick }: { sizes: ContextSizes; onPick: (tokens: number) => void }) {
  const [shown, setShown] = useState<number>()
  const focus = sizes.options.find((o) => o.tokens === (shown ?? sizes.current)) ?? sizes.options[0]
  if (!focus) return null
  const w = sizeWords(focus)
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[0.84rem] font-medium text-text">Window size</h4>
        <span className="text-[0.74rem] text-text-3">for {sizes.role}</span>
      </div>
      <div role="radiogroup" aria-label={`Context window size for ${sizes.role}`} className="mt-2 flex flex-wrap gap-1.5" onMouseLeave={() => setShown(undefined)}>
        {sizes.options.map((o) => (
          <button
            key={o.tokens}
            role="radio"
            aria-checked={o.tokens === sizes.current}
            // Too big for this computer: it stays readable (hover says why) but cannot be picked.
            aria-disabled={o.fit === 'none' || undefined}
            onMouseEnter={() => setShown(o.tokens)}
            onFocus={() => setShown(o.tokens)}
            onBlur={() => setShown(undefined)}
            onClick={() => o.fit !== 'none' && onPick(o.tokens)}
            className={cn(
              'tabular inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.8rem] transition-colors',
              o.tokens === sizes.current ? 'border-petal bg-petal-soft font-medium text-text' : 'border-line text-text-2 hover:border-line-strong hover:text-text',
              o.fit === 'none' && o.tokens !== sizes.current && 'cursor-not-allowed opacity-55 hover:border-line hover:text-text-2'
            )}
          >
            <span className={cn('size-1.5 rounded-full', FIT_DOT[o.fit])} aria-hidden />
            {kb(o.tokens)}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[0.78rem] leading-snug text-text" aria-live="polite">
        {w.amount} <span className={focus.fit === 'spill' ? 'text-pollen' : focus.fit === 'none' ? 'text-danger' : 'text-text-2'}>{w.cost}</span>
      </p>
      <p className="mt-1.5 text-[0.74rem] leading-snug text-text-3">
        {focus.fit === 'api'
          ? 'A bigger window keeps more of the conversation, files and results in view before older messages are summarised.'
          : 'A bigger window keeps more of the conversation, files and results in view before older messages are summarised. It needs more memory, and every step takes longer to read.'}
        {sizes.max ? ` This model can use up to ${kb(sizes.max)}${focus.fit === 'api' ? '; Maris stays a little under that, because its token counts are estimates' : ''}.` : ''}
      </p>
    </div>
  )
}

/** The ring: how full this chat's context window is. */
function Ring({ pct }: { pct: number }) {
  const r = 7
  const c = 2 * Math.PI * r
  const tone = pct >= 85 ? 'var(--danger)' : pct >= 65 ? 'var(--pollen)' : 'var(--petal)'
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2.2" />
      <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(Math.min(100, pct) / 100) * c} ${c}`} />
    </svg>
  )
}

/**
 * What fills the chat's context window (the part of the conversation the model can see at once): Maris's
 * instructions, tools, memory, the project, messages and tool results, and how much room is left before
 * older messages are summarised. Opens from a ring next to the send button, in Chat and Code.
 */
export function ContextMeter({ conversationId }: { conversationId?: string }) {
  const mode = useApp((s) => s.mode)
  const project = useApp((s) => s.project)
  const draftModel = useApp((s) => s.draftModel)
  const running = useApp((s) => (conversationId ? Boolean(s.running[conversationId]) : false))
  const count = useApp((s) => (conversationId ? (s.messages[conversationId]?.length ?? 0) : 0))
  const [u, setU] = useState<ContextUsage>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.chat
      .context(conversationId, { mode, projectDir: mode === 'code' ? project?.path : undefined, model: draftModel })
      .then(setU)
      .catch(() => undefined)
  }, [conversationId, mode, project?.path, draftModel])

  // Again after every answer, and whenever the popover opens.
  useEffect(() => {
    if (!running) load()
  }, [load, running, count])
  useEffect(() => {
    if (open) load()
  }, [open, load])

  if (!u) return null
  const pct = Math.round((u.used / u.window) * 100)
  const free = Math.max(0, u.window - u.used - u.reserved)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[0.78rem] text-text-3 transition-colors hover:bg-sunken hover:text-text"
          aria-label={`Context: ${pct}% used. Show what fills it.`}
          title="Context: how much of the conversation the model can still see at once"
        >
          <Ring pct={pct} />
          <span className="tabular">{pct}%</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} className="z-50 w-[360px] rounded-2xl border border-line bg-raised p-4 shadow-float">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[0.95rem] font-semibold text-text">Context</h3>
            <span className="tabular text-[0.8rem] text-text-2">
              {pct}% used · {k(u.used)} of {kb(u.window)} tokens
            </span>
          </div>
          <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
            {u.parts.map((p) => (
              <span key={p.key} style={{ width: `${(p.tokens / u.window) * 100}%`, background: COLORS[p.key] }} className="h-full" />
            ))}
            <span style={{ width: `${(u.reserved / u.window) * 100}%` }} className="ml-auto h-full bg-line-strong/70" />
          </div>
          <ul className="mt-3 space-y-1.5">
            {u.parts.map((p) => (
              <li key={p.key} className="flex items-center gap-2 text-[0.82rem]" title={p.hint}>
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: COLORS[p.key] }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-text">{p.label}</span>
                <span className="tabular w-12 text-right text-text-2">{k(p.tokens)}</span>
                <span className="tabular w-10 text-right text-text-3">{Math.max(p.tokens > 0 ? 0.1 : 0, Math.round((p.tokens / u.window) * 1000) / 10)}%</span>
              </li>
            ))}
            <li className="flex items-center gap-2 border-t border-line pt-1.5 text-[0.82rem]" title="Room left for more messages, files and tool results">
              <span className="size-2.5 shrink-0 rounded-sm border border-line-strong" aria-hidden />
              <span className="flex-1 text-text">Free space</span>
              <span className="tabular w-12 text-right text-text-2">{k(free)}</span>
              <span className="tabular w-10 text-right text-text-3">{Math.round((free / u.window) * 100)}%</span>
            </li>
            <li className="flex items-center gap-2 text-[0.82rem]" title="Always kept free so the answer has room">
              <span className="size-2.5 shrink-0 rounded-sm bg-line-strong/70" aria-hidden />
              <span className="flex-1 text-text">Kept for the answer</span>
              <span className="tabular w-12 text-right text-text-2">{k(u.reserved)}</span>
              <span className="tabular w-10 text-right text-text-3">{Math.round((u.reserved / u.window) * 100)}%</span>
            </li>
          </ul>
          <p className="mt-3 text-[0.8rem] leading-snug text-text-2">
            {u.untilCompact === undefined
              ? 'Automatic summaries are off (Settings): the oldest messages are left out when the window is full.'
              : u.untilCompact > 0
                ? `About ${k(u.untilCompact)} tokens until Maris summarises older messages to make room.`
                : 'The next answer summarises older messages first, to make room.'}
            {u.summarised ? ' Earlier messages are already summarised.' : ''}
          </p>
          {conversationId && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || running || u.messages < 4}
                title={u.messages < 4 ? 'There is not enough conversation to summarise yet' : 'Fold everything but the latest exchange into a short summary'}
                onClick={async () => {
                  setBusy(true)
                  await api.chat.compact(conversationId).catch(() => 0)
                  setBusy(false)
                  load()
                }}
              >
                {busy ? <Spinner /> : <Minimize2 size={13} />} Summarise now
              </Button>
              <span className={cn('min-w-0 flex-1 truncate text-right text-[0.74rem] text-text-3')} title={u.model}>
                {prettyModel(u.model)}, {kb(u.window)} window
              </span>
            </div>
          )}
          {u.sizes && (
            <SizePicker
              sizes={u.sizes}
              onPick={(tokens) => {
                void api.settings.set(patchFor(u.sizes!.path, tokens) as Parameters<typeof api.settings.set>[0]).then(() => load())
              }}
            />
          )}
          <p className="mt-2 text-[0.72rem] text-text-3">Estimates: a token is about ¾ of a word.</p>
          <Popover.Arrow className="fill-[var(--raised)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
