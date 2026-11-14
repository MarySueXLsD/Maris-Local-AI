import { Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { LearningEvent, Memory, MemoryKind } from '@shared/types'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { useApp } from '../store'
import { Button, cn, IconButton, inputCls, PageHeader, Section, Segmented, Switch } from '../components/ui'
import { DEVICE } from '../lib/platform'

const KINDS: { value: MemoryKind; label: string }[] = [
  { value: 'fact', label: 'Fact' },
  { value: 'preference', label: 'Preference' },
  { value: 'instruction', label: 'Instruction' },
  { value: 'project', label: 'Project' },
  { value: 'person', label: 'Person' },
  { value: 'skill', label: 'Skill' }
]
const SOURCE: Record<Memory['source'], string> = { user: 'Saved by you', assistant: 'Saved by Maris in a chat', learned: 'Learned from a chat', feedback: 'From your feedback' }
const CATEGORY: Record<string, string> = {
  quick: 'small talk',
  chat: 'conversation',
  writing: 'writing',
  code: 'coding',
  reasoning: 'reasoning',
  agent: `${DEVICE} tasks`,
  vision: 'image questions',
  web: 'web lookups',
  media: 'media requests'
}

function MemoryRow({ m }: { m: Memory }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.text)
  return (
    <div className="group flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 w-24 shrink-0 text-[0.78rem] text-text-3">{KINDS.find((k) => k.value === m.kind)?.label}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              setEditing(false)
              if (text.trim() && text.trim() !== m.text) void api.memory.update(m.id, { text: text.trim() })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) (e.target as HTMLTextAreaElement).blur()
              if (e.key === 'Escape') {
                setText(m.text)
                setEditing(false)
              }
            }}
            aria-label="Edit memory"
            className={cn(inputCls, 'min-h-16 text-[0.92rem]')}
          />
        ) : (
          <button className="selectable block w-full text-left text-[0.93rem] leading-snug text-text hover:text-petal" onClick={() => setEditing(true)} title="Click to edit">
            {m.text}
          </button>
        )}
        <p className="mt-1 text-[0.76rem] text-text-3">
          {SOURCE[m.source]}, {timeAgo(m.createdAt)}
          {m.uses ? `. Used ${m.uses} time${m.uses === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      <IconButton label={m.pinned ? 'Pinned: always used in chats. Click to use it only when relevant.' : 'Pin: always use this memory in chats, not just when it seems relevant'} active={m.pinned} onClick={() => void api.memory.update(m.id, { pinned: !m.pinned })}>
        {m.pinned ? <Pin size={14} /> : <PinOff size={14} />}
      </IconButton>
      <IconButton label="Forget this: Maris will not remember it any more" onClick={() => void api.memory.remove(m.id)}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

export function MemoryView() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const [items, setItems] = useState<Memory[]>([])
  const [events, setEvents] = useState<LearningEvent[]>([])
  const [stats, setStats] = useState<{ category: string; tier: string; score: number }[]>([])
  const [filter, setFilter] = useState<'all' | MemoryKind>('all')
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<MemoryKind>('fact')

  const reload = (): void => {
    void api.memory.list().then(setItems)
    void api.memory.events().then(setEvents)
    void api.memory.routeStats().then(setStats)
  }
  useEffect(() => {
    reload()
    const offs = [api.memory.onChange(reload), api.memory.onEvent((e) => setEvents((l) => [e, ...l].slice(0, 100)))]
    return () => offs.forEach((o) => o())
  }, [])

  const shown = useMemo(
    () => items.filter((m) => (filter === 'all' || m.kind === filter) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))),
    [items, filter, q]
  )

  const leanings = useMemo(() => {
    const dir: Record<string, number> = { fast: -1, balanced: 0, max: 1 }
    const by = new Map<string, number>()
    for (const s of stats) by.set(s.category, (by.get(s.category) ?? 0) + s.score * (dir[s.tier] ?? 0))
    return [...by.entries()].filter(([, v]) => Math.abs(v) >= 1)
  }, [stats])

  const add = async (): Promise<void> => {
    if (!draft.trim()) return
    await api.memory.add(draft.trim(), kind)
    setDraft('')
  }

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[1040px] px-8 pb-16">
        <PageHeader
          title="Memory"
          description="What Maris knows about you. It learns from your chats and feedback in the background, and you stay in charge of every entry."
        />
        <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
          <div>
            <div className="mb-4 rounded-xl border border-line px-4">
              <Switch
                label="Remember things about me"
                description="Relevant memories are added to each chat so answers fit you."
                checked={settings?.memory.enabled ?? true}
                onChange={(v) => void update({ memory: { enabled: v } })}
              />
              <Switch
                label="Learn automatically"
                description="After a chat goes quiet, a small model notes durable facts, preferences and what worked."
                checked={settings?.memory.autoLearn ?? true}
                disabled={!settings?.memory.enabled}
                onChange={(v) => void update({ memory: { autoLearn: v } })}
              />
            </div>

            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
                placeholder="Tell Maris something to remember, e.g. I prefer short answers"
                aria-label="New memory"
                className={inputCls}
              />
              <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Memory type" title="What kind of memory this is. It helps Maris decide when to use it." className={cn(inputCls, 'w-36')}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={() => void add()} disabled={!draft.trim()}>
                <Plus size={15} /> Add
              </Button>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Segmented
                size="sm"
                label="Filter by type"
                value={filter}
                onChange={setFilter}
                options={[{ value: 'all' as const, label: 'All' }, ...KINDS.map((k) => ({ value: k.value, label: `${k.label}s` }))]}
              />
              <div className="relative ml-auto">
                <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory" aria-label="Search memory" className={cn(inputCls, 'h-8 w-56 py-1 pl-8 text-[0.86rem]')} />
              </div>
            </div>

            <div className="mt-3 divide-y divide-line rounded-xl border border-line">
              {shown.length === 0 && (
                <p className="px-4 py-6 text-[0.9rem] text-text-2">
                  {items.length ? 'Nothing matches that filter.' : 'Nothing remembered yet. Chat for a while, or add something above.'}
                </p>
              )}
              {shown.map((m) => (
                <MemoryRow key={m.id} m={m} />
              ))}
            </div>
          </div>

          <aside className="space-y-8">
            <div>
              <h2 className="text-[0.95rem] font-semibold text-text">Recently learned</h2>
              <ol className="mt-3 space-y-3 border-l border-line pl-4">
                {events.length === 0 && <li className="text-[0.85rem] text-text-3">Learning activity shows up here.</li>}
                {events.slice(0, 14).map((e) => (
                  <li key={e.id} className="relative text-[0.84rem] leading-snug text-text-2">
                    <span className="absolute top-1.5 -left-[19px] size-1.5 rounded-full bg-petal" aria-hidden />
                    {e.text}
                    <span className="block text-[0.74rem] text-text-3">{timeAgo(e.ts)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <Section title="Routing" description="When you re-run an answer with a different model or rate it, Auto adjusts for that kind of task.">
              {leanings.length === 0 ? (
                <p className="text-[0.85rem] text-text-3">No adjustments yet.</p>
              ) : (
                <ul className="space-y-1.5 text-[0.86rem] text-text-2">
                  {leanings.map(([cat, v]) => (
                    <li key={cat}>
                      For {CATEGORY[cat] ?? cat}, Auto leans toward {v > 0 ? 'bigger, slower' : 'smaller, faster'} models.
                    </li>
                  ))}
                </ul>
              )}
              <Button size="sm" variant="ghost" className="mt-3 -ml-3" onClick={() => void api.memory.resetRouting().then(reload)}>
                Reset routing adjustments
              </Button>
            </Section>
          </aside>
        </div>
      </div>
    </div>
  )
}
