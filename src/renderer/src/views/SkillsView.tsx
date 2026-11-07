import { ChevronRight, Download, FolderOpen, GitBranch, Puzzle, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SkillInfo } from '@shared/extensions'
import { Markdown } from '../components/Markdown'
import { Button, cn, inputCls, PageHeader, RowToggle, Section, Spinner, Switch } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { REMOTE } from '../lib/platform'
import { useApp } from '../store'

const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** Well-known collections to start from. */
const SUGGESTIONS = [{ label: 'Anthropic example skills', source: 'https://github.com/anthropics/skills' }]

/** Skills: instructions from git (a folder with SKILL.md) that teach Maris particular kinds of tasks. */
export function SkillsView() {
  const enabled = useApp((s) => s.settings?.extensions.skills ?? true)
  const update = useApp((s) => s.updateSettings)
  const [list, setList] = useState<SkillInfo[]>()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>()
  const [query, setQuery] = useState('')

  useEffect(() => {
    void api.skills.list().then(setList)
    return api.skills.onChange(setList)
  }, [])

  const install = async (src: string): Promise<void> => {
    if (!src.trim()) return
    setBusy('install')
    setMessage(undefined)
    try {
      const before = new Set((list ?? []).map((s) => s.id))
      const next = await api.skills.install(src)
      setList(next)
      const added = next.filter((s) => !before.has(s.id))
      setMessage({ text: added.length ? `Added ${added.length} skill${added.length === 1 ? '' : 's'}: ${added.map((s) => s.name).join(', ')}.` : 'Updated. No new skills were in it.' })
      setSource('')
    } catch (e) {
      setMessage({ text: clean(e), bad: true })
    } finally {
      setBusy('')
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list ?? []).filter((s) => !q || `${s.name} ${s.description} ${s.source}`.toLowerCase().includes(q))
  }, [list, query])

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[860px] px-5 pb-16 sm:px-8">
        <PageHeader
          title="Skills"
          description="A skill is a folder of instructions (and sometimes helper files) that teaches Maris how to do a particular kind of task, such as filling in PDFs or following your team's style. When a request matches a skill, Maris reads it first."
        />
        <div className="mb-5 rounded-xl border border-line bg-raised/60 px-4">
          <Switch checked={enabled} onChange={(v) => void update({ extensions: { skills: v } })} label="Let Maris use skills" description="Off: skills stay installed but Maris ignores them." />
        </div>

        <Section title="Add skills" description="Paste a link to a git repository (or a folder inside one on GitHub). Every folder in it that has a SKILL.md becomes a skill.">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void install(source)
            }}
          >
            <span className="relative min-w-[16rem] flex-1">
              <GitBranch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-3" aria-hidden />
              <input className={cn(inputCls, 'pl-9')} placeholder="https://github.com/owner/repository" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Git address" />
            </span>
            <Button type="submit" variant="primary" disabled={busy === 'install' || !source.trim()}>
              {busy === 'install' ? <Spinner className="size-3.5" /> : <Download size={15} />} Install
            </Button>
            {!REMOTE && (
              <Button
                type="button"
                variant="outline"
                disabled={busy === 'install'}
                onClick={() => void api.skills.pickFolder().then((p) => p && void install(p))}
              >
                <FolderOpen size={15} /> From a folder
              </Button>
            )}
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.84rem] text-text-2">
            Try:
            {SUGGESTIONS.map((s) => (
              <button key={s.source} className="rounded-full border border-line px-2.5 py-0.5 hover:border-line-strong hover:text-text" onClick={() => void install(s.source)} disabled={busy === 'install'}>
                {s.label}
              </button>
            ))}
          </div>
          {message && <p className={cn('mt-3 rounded-lg px-3 py-2 text-[0.88rem]', message.bad ? 'bg-danger-soft text-danger' : 'bg-petal-soft text-text')}>{message.text}</p>}
          <p className="mt-3 text-[0.8rem] text-text-3">
            Skills are instructions written by other people. Install them from sources you trust; Maris still asks before it changes anything on your computer.
          </p>
        </Section>

        <Section title={`Installed${list ? ` (${list.length})` : ''}`}>
          {list && list.length > 6 && (
            <input className={cn(inputCls, 'mb-3')} placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
          )}
          {!list ? (
            <Spinner className="size-4" />
          ) : list.length === 0 ? (
            <p className="flex items-center gap-2 text-[0.9rem] text-text-2">
              <Puzzle size={16} aria-hidden /> No skills yet.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {shown.map((s) => (
                <SkillRow key={s.id} skill={s} busy={busy} setBusy={setBusy} onMessage={setMessage} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

function SkillRow({
  skill,
  busy,
  setBusy,
  onMessage
}: {
  skill: SkillInfo
  busy: string
  setBusy: (s: string) => void
  onMessage: (m: { text: string; bad?: boolean }) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const [confirm, setConfirm] = useState(false)
  const act = async (key: string, fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(key)
    try {
      await fn()
      onMessage({ text: done })
    } catch (e) {
      onMessage({ text: clean(e), bad: true })
    } finally {
      setBusy('')
    }
  }
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <button
          className="mt-0.5 shrink-0 rounded p-0.5 text-text-3 hover:text-text"
          aria-expanded={open}
          aria-label={open ? `Hide ${skill.name}` : `Show ${skill.name}`}
          onClick={() => {
            if (!open && text === undefined) void api.skills.read(skill.id).then(setText).catch((e) => setText(clean(e)))
            setOpen(!open)
          }}
        >
          <ChevronRight size={16} className={cn('transition-transform', open && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.98rem] font-medium text-text">{skill.name}</span>
          <span className="mt-0.5 line-clamp-2 block text-[0.86rem] text-text-2">{skill.description || 'No description.'}</span>
          <span className="mt-1 block truncate text-[0.76rem] text-text-3">
            {skill.source} · {skill.files ? `${skill.files} more file${skill.files === 1 ? '' : 's'} · ` : ''}
            {skill.updatedAt ? `updated ${timeAgo(skill.updatedAt)}` : `added ${timeAgo(skill.installedAt)}`}
          </span>
        </span>
        <RowToggle checked={skill.enabled} onChange={(v) => api.skills.setEnabled(skill.id, v)} label={`Use ${skill.name}`} />
      </div>
      {open && (
        <div className="mt-3 ml-7">
          <div className="max-h-[420px] overflow-y-auto rounded-xl border border-line bg-surface px-4 py-3">{text === undefined ? <Spinner className="size-4" /> : <Markdown text={text.replace(/^---[\s\S]*?---\s*/, '')} />}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {!skill.source.match(/^[A-Za-z]:[\\/]|^\//) && (
              <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => void act(`update:${skill.id}`, () => api.skills.update(skill.id), `${skill.name} is up to date.`)}>
                {busy === `update:${skill.id}` ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />} Update
              </Button>
            )}
            {confirm ? (
              <>
                <Button size="sm" variant="danger" disabled={busy !== ''} onClick={() => void act(`remove:${skill.id}`, () => api.skills.remove(skill.id), 'Removed.')}>
                  <Trash2 size={14} /> Remove (with all skills from {skill.source.split('/').slice(-1)[0]})
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                <Trash2 size={14} /> Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
