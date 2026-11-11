import {
  Activity,
  AppWindow,
  BrainCircuit,
  Clapperboard,
  Cpu,
  Download,
  FolderOpen,
  Globe,
  HardDrive,
  MessageCircle,
  Palette,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Newspaper,
  Puzzle,
  Upload,
  Wand2,
  Waypoints,
  X
} from 'lucide-react'
import { Switch as RSwitch } from 'radix-ui'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { contextLabel } from '@shared/context'
import { DEFAULT_SETTINGS, getPath, patchFor } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { api, type PackInfo } from '../lib/api'
import { bytes, prettyModel } from '../lib/format'
import { useApp } from '../store'
import { Button, cn, inputCls, Segmented, Tip } from '../components/ui'
import { withTerms } from '../components/Term'
import { SECTIONS, SETTINGS_SCHEMA, type SectionId, type SettingDef } from './settings/schema'
import { HexColorControl, ThemePicker } from './settings/ThemePicker'
import { DEVICE, OS_NAME, REMOTE } from '../lib/platform'
import { PhoneLink } from './settings/PhoneLink'
import { TerminalCommand } from './settings/TerminalCommand'

const ICONS: Record<SectionId, typeof Palette> = {
  appearance: Palette,
  assistant: MessageCircle,
  routing: Waypoints,
  generation: SlidersHorizontal,
  engine: Cpu,
  access: ShieldCheck,
  memory: BrainCircuit,
  web: Globe,
  media: Clapperboard,
  status: Activity,
  window: AppWindow,
  updates: Newspaper,
  extensions: Puzzle,
  phone: Smartphone,
  data: HardDrive
}

// In the phone app, settings about this computer's folders and the phone link itself stay on the computer.
const VISIBLE = REMOTE ? SECTIONS.filter((x) => x.id !== 'phone' && x.id !== 'data') : SECTIONS

const ACCENTS = ['#8b7bff', '#5aa9ff', '#3fc5a8', '#f0a840', '#f0728a', '#c58cff']
/** Values chosen for this PC (by setup or by hand) have no meaningful factory default. */
const MACHINE = /^(tiers\.|dataDir$|media\.roles\.)/

type Update = (path: string, value: unknown) => void

// ------------------------------------------------------------------ small controls

function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  return [draft, setDraft]
}

function TextControl({ def, value, onCommit }: { def: SettingDef; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useDraft(value)
  const [show, setShow] = useState(false)
  const commit = (): void => {
    if (v !== value) onCommit(v.trim())
  }
  if (def.type === 'textarea') {
    return (
      <textarea
        aria-label={def.label}
        value={v}
        placeholder={def.placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        className={cn(inputCls, 'min-h-28 resize-y leading-relaxed')}
      />
    )
  }
  return (
    <div className="flex gap-2">
      <input
        aria-label={def.label}
        type={def.type === 'secret' && !show ? 'password' : 'text'}
        value={v}
        placeholder={def.placeholder}
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={cn(inputCls, def.type === 'hotkey' && 'font-mono text-[0.88rem]')}
      />
      {def.type === 'secret' && (
        <Button variant="ghost" size="sm" className="h-10" onClick={() => setShow((s) => !s)}>
          {show ? 'Hide' : 'Show'}
        </Button>
      )}
    </div>
  )
}

function NumberControl({ def, value, onCommit }: { def: SettingDef; value: number | undefined; onCommit: (v: number | undefined) => void }) {
  const [v, setV] = useDraft(value === undefined ? '' : String(value))
  const commit = (): void => {
    const t = v.trim()
    if (t === '') {
      if (def.optional) {
        if (value !== undefined) onCommit(undefined)
      } else setV(value === undefined ? '' : String(value))
      return
    }
    let n = Number(t.replace(',', '.'))
    if (!Number.isFinite(n)) return setV(value === undefined ? '' : String(value))
    if (def.min !== undefined) n = Math.max(def.min, n)
    if (def.max !== undefined) n = Math.min(def.max, n)
    if (def.step && def.step >= 1) n = Math.round(n)
    setV(String(n))
    if (n !== value) onCommit(n)
  }
  return (
    <span className="inline-flex items-center gap-2">
      <input
        aria-label={def.label}
        inputMode="decimal"
        value={v}
        placeholder={def.emptyLabel ?? ''}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const base = Number(v || value || def.min || 0)
            const step = (def.step ?? 1) * (e.shiftKey ? 10 : 1)
            const next = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, base + (e.key === 'ArrowUp' ? step : -step)))
            setV(String(Math.round(next * 1000) / 1000))
          }
        }}
        className={cn(inputCls, 'tabular w-32 py-1.5 text-right')}
      />
      {def.unit && <span className="text-[0.84rem] text-text-2">{def.unit}</span>}
    </span>
  )
}

function SliderControl({ def, value, onCommit }: { def: SettingDef; value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useDraft(value)
  const commit = (): void => {
    if (v !== value) onCommit(v)
  }
  const shown =
    def.format === 'percent' ? `${Math.round(v * 100)}%` : def.format === 'speed' ? (v < 0.35 ? 'Quality' : v > 0.65 ? 'Speed' : 'Balanced') : `${v}${def.unit ? ` ${def.unit}` : ''}`
  return (
    <span className="flex items-center gap-3">
      {def.format === 'speed' && <span className="text-[0.82rem] text-text-3">Quality</span>}
      <input
        type="range"
        aria-label={def.label}
        aria-valuetext={shown}
        min={def.min}
        max={def.max}
        step={def.step}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-56 accent-[var(--petal)]"
      />
      {def.format === 'speed' ? <span className="text-[0.82rem] text-text-3">Speed</span> : <span className="tabular w-16 text-[0.88rem] text-text">{shown}</span>}
    </span>
  )
}

function ColorControl({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const custom = Boolean(value) && !ACCENTS.includes(value.toLowerCase())
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Accent colour">
      <Tip label="Use the colour theme's own accent">
        <button
          role="radio"
          aria-checked={!value}
          aria-label="Theme accent"
          onClick={() => onCommit('')}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border-2 px-2.5 text-[0.8rem] text-text-2 transition-transform hover:scale-105',
            !value ? 'border-text text-text' : 'border-line-strong'
          )}
        >
          <span className="size-3.5 rounded-full" style={{ background: 'var(--petal)' }} aria-hidden /> Theme
        </button>
      </Tip>
      {ACCENTS.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          onClick={() => onCommit(c)}
          className={cn('size-8 rounded-full border-2 transition-transform hover:scale-105', value.toLowerCase() === c ? 'border-text' : 'border-transparent')}
          style={{ background: c }}
        />
      ))}
      <label
        className={cn('relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2', custom ? 'border-text' : 'border-line-strong')}
        style={custom ? { background: value } : { background: 'conic-gradient(#f0728a, #f0a840, #3fc5a8, #5aa9ff, #8b7bff, #f0728a)' }}
        title="Custom colour"
      >
        <input type="color" aria-label="Custom accent colour" value={value || '#8b7bff'} onChange={(e) => onCommit(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  )
}

function FolderControl({ def, value, onCommit }: { def: SettingDef; value: string | undefined; onCommit: (v: string | undefined) => void }) {
  return (
    <div className="flex gap-2">
      <input readOnly value={value ?? ''} placeholder={def.emptyLabel} className={inputCls} aria-label={def.label} />
      <Button
        variant="outline"
        onClick={async () => {
          const p = await api.settings.pickFolder(value)
          if (p) onCommit(p)
        }}
      >
        Change
      </Button>
      {value && (
        <Tip label="Open in Explorer">
          <Button variant="ghost" aria-label={`Open ${def.label}`} onClick={() => void api.shell.openPath(value)}>
            <FolderOpen size={15} />
          </Button>
        </Tip>
      )}
      {value && def.emptyLabel && (
        <Tip label={`Use ${def.emptyLabel}`}>
          <Button variant="ghost" aria-label={`Clear ${def.label}`} onClick={() => onCommit(undefined)}>
            <X size={15} />
          </Button>
        </Tip>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ one row

function Control({ def, s, update, packs }: { def: SettingDef; s: Settings; update: Update; packs: PackInfo[] }) {
  const models = useApp((st) => st.models)
  const value = getPath(s, def.path)
  const set = (v: unknown): void => update(def.path, v)
  switch (def.type) {
    case 'switch':
      return (
        <RSwitch.Root
          checked={Boolean(value)}
          onCheckedChange={set}
          aria-label={def.label}
          className="relative mt-0.5 h-[22px] w-[40px] shrink-0 rounded-full border border-line-strong bg-sunken transition-colors data-[state=checked]:border-petal-strong data-[state=checked]:bg-petal-strong"
        >
          <RSwitch.Thumb className="block size-[14px] translate-x-[3px] rounded-full bg-text-2 transition-transform data-[state=checked]:translate-x-[21px] data-[state=checked]:bg-on-petal" />
        </RSwitch.Root>
      )
    case 'segmented':
      return <Segmented label={def.label} value={String(value)} onChange={set} options={(def.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} />
    case 'select':
      return (
        <select
          aria-label={def.label}
          value={String(value)}
          onChange={(e) => set(typeof def.options?.[0]?.value === 'number' ? Number(e.target.value) : e.target.value)}
          className={cn(inputCls, 'w-auto min-w-36 py-1.5')}
        >
          {/* A value set elsewhere (the context ring offers a model's own limit) is listed too, so it shows as chosen. */}
          {value !== undefined && value !== '' && !def.options?.some((o) => String(o.value) === String(value)) && (
            <option value={String(value)}>{typeof value === 'number' && /ontext/.test(def.path) ? contextLabel(value) : String(value)}</option>
          )}
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'slider':
      return <SliderControl def={def} value={Number(value ?? def.min ?? 0)} onCommit={set} />
    case 'number':
      return <NumberControl def={def} value={value as number | undefined} onCommit={set} />
    case 'text':
    case 'secret':
    case 'textarea':
    case 'hotkey':
      return <TextControl def={def} value={String(value ?? '')} onCommit={set} />
    case 'palette':
      return <ThemePicker s={s} update={update} />
    case 'hexcolor':
      return <HexColorControl label={def.label} value={String(value ?? '#000000')} onCommit={set} />
    case 'color':
      return <ColorControl value={String(value ?? '#8b7bff')} onCommit={set} />
    case 'folder':
      return <FolderControl def={def} value={(value as string | undefined) || undefined} onCommit={set} />
    case 'model': {
      const list = models.filter((m) => (def.role === 'embed' ? m.capabilities.includes('embedding') : !m.capabilities.includes('embedding')))
      const v = String(value ?? '')
      return (
        <select aria-label={`${def.label} model`} value={v} onChange={(e) => set(e.target.value)} className={cn(inputCls, 'w-72 py-1.5')}>
          {def.emptyLabel ? <option value="">{def.emptyLabel}</option> : !v && <option value="">Not set</option>}
          {v && !list.some((m) => m.name === v) && <option value={v}>{prettyModel(v)} (not installed)</option>}
          {list.map((m) => (
            <option key={m.name} value={m.name}>
              {prettyModel(m.name)} ({bytes(m.sizeBytes)})
            </option>
          ))}
        </select>
      )
    }
    case 'pack': {
      const list = packs.filter((p) => p.kind === def.role && p.installed)
      const v = String(value ?? '')
      return (
        <select aria-label={def.label} value={v} onChange={(e) => set(e.target.value)} className={cn(inputCls, 'w-72 py-1.5')}>
          <option value="">{def.emptyLabel ?? 'Automatic'}</option>
          {v && !list.some((p) => p.id === v) && <option value={v}>{packs.find((p) => p.id === v)?.name ?? v} (not installed)</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )
    }
  }
}

const WIDE: SettingDef['type'][] = ['text', 'secret', 'textarea', 'folder', 'hotkey', 'color', 'palette']

function Row({ def, s, update, packs }: { def: SettingDef; s: Settings; update: Update; packs: PackInfo[] }) {
  const value = getPath(s, def.path)
  const fallback = getPath(DEFAULT_SETTINGS, def.path)
  const changed = !MACHINE.test(def.path) && JSON.stringify(value ?? null) !== JSON.stringify(fallback ?? null)
  const wide = WIDE.includes(def.type)
  const reset = changed && (
    <Tip label="Back to default">
      <button
        aria-label={`Reset ${def.label} to default`}
        onClick={() => update(def.path, fallback)}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-sunken hover:text-text"
      >
        <RotateCcw size={13} />
      </button>
    </Tip>
  )
  const label = (
    <span className="min-w-0">
      <span className="flex items-center gap-1.5 text-[0.95rem] text-text">
        {def.label}
        {changed && <span className="size-1.5 rounded-full bg-petal" title="Changed from the default" />}
      </span>
      {def.hint && (
        <span className="mt-0.5 block max-w-[58ch] text-[0.84rem] leading-snug text-text-2">
          {withTerms(def.hint)}
          {def.help && (
            <button onClick={() => useApp.getState().openHelp(def.help)} className="ml-1.5 text-petal underline-offset-2 hover:underline">
              Learn more
            </button>
          )}
        </span>
      )}
    </span>
  )
  return (
    <div className="py-3" data-setting={def.path}>
      {wide ? (
        <>
          <div className="flex items-start justify-between gap-4">
            {label}
            {reset}
          </div>
          <div className="mt-2">
            <Control def={def} s={s} update={update} packs={packs} />
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {label}
          <span className="flex items-center gap-1">
            {reset}
            <Control def={def} s={s} update={update} packs={packs} />
          </span>
        </div>
      )}
    </div>
  )
}

function visible(def: SettingDef, s: Settings): boolean {
  return !def.when || getPath(s, def.when.path) === def.when.equals
}

function Group({ title, defs, s, update, packs }: { title?: string; defs: SettingDef[]; s: Settings; update: Update; packs: PackInfo[] }) {
  const shown = defs.filter((d) => visible(d, s))
  if (!shown.length) return null
  return (
    <div className="mt-5 first:mt-0">
      {title && <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">{title}</h3>}
      <div className="divide-y divide-line rounded-xl border border-line bg-raised/60 px-4">
        {shown.map((d) => (
          <Row key={d.path} def={d} s={s} update={update} packs={packs} />
        ))}
      </div>
    </div>
  )
}

function grouped(defs: SettingDef[]): [string | undefined, SettingDef[]][] {
  const out: [string | undefined, SettingDef[]][] = []
  for (const d of defs) {
    const last = out[out.length - 1]
    if (last && last[0] === d.group) last[1].push(d)
    else out.push([d.group, [d]])
  }
  return out
}

// ------------------------------------------------------------------ the page

export function SettingsView() {
  const s = useApp((st) => st.settings)
  const updateSettings = useApp((st) => st.updateSettings)
  const openSetup = useApp((st) => st.openSetup)
  const announce = useApp((st) => st.announce)
  const [section, setSection] = useState<SectionId>('appearance')
  const [query, setQuery] = useState('')
  const [genRole, setGenRole] = useState<'fast' | 'balanced' | 'max' | 'code'>('max')
  const [packs, setPacks] = useState<PackInfo[]>([])
  const [info, setInfo] = useState<{ version: string; userDir: string; dataDir: string; electron: string }>()
  const [notice, setNotice] = useState<string>()
  const [confirmReset, setConfirmReset] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void api.app.info().then(setInfo)
    void api.media.packs().then(setPacks)
  }, [])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [section])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    const words = q.split(/\s+/)
    return SETTINGS_SCHEMA.filter((d) => {
      const hay = `${d.label} ${d.hint ?? ''} ${d.keywords ?? ''} ${d.group ?? ''} ${SECTIONS.find((x) => x.id === d.section)?.title ?? ''} ${d.path}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [q])

  if (!s) return null
  const update: Update = (path, value) => {
    void updateSettings(patchFor(path, value) as Parameters<typeof updateSettings>[0])
    if (path === 'ui.launchAtLogin') announce(value ? `Maris will start with ${OS_NAME}` : `Maris will not start with ${OS_NAME}`)
  }
  const meta = SECTIONS.find((x) => x.id === section)!
  const defs = SETTINGS_SCHEMA.filter((d) => d.section === section && (section !== 'generation' || d.path.startsWith(`generation.${genRole}.`)))
  const flash = (text: string): void => {
    setNotice(text)
    announce(text)
    setTimeout(() => setNotice(undefined), 4000)
  }
  const resetSection = async (): Promise<void> => {
    const key = section === 'generation' ? 'generation' : undefined
    if (key) {
      await api.settings.reset(key)
    } else {
      // Reset only the keys this section shows (sections mix several settings objects).
      for (const d of SETTINGS_SCHEMA.filter((x) => x.section === section && !MACHINE.test(x.path))) {
        await updateSettings(patchFor(d.path, getPath(DEFAULT_SETTINGS, d.path)) as Parameters<typeof updateSettings>[0])
      }
    }
    flash(`${meta.title} is back to its defaults`)
  }

  return (
    <div className="@container flex h-full min-w-0 flex-1 flex-col bg-surface">
      <div className="drag h-11 shrink-0" />
      <div className="flex min-h-0 flex-1">
        {/* section navigation */}
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto px-3 pb-6 @3xl:flex">
          <h1 className="px-2 pb-3 font-display text-[1.5rem] font-light text-text">Settings</h1>
          {VISIBLE.map((x) => {
            const Icon = ICONS[x.id]
            const active = !q && x.id === section
            return (
              <Tip key={x.id} label={x.description} side="right">
                <button
                  onClick={() => {
                    setQuery('')
                    setSection(x.id)
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.9rem] transition-colors',
                    active ? 'bg-petal-soft text-text' : 'text-text-2 hover:bg-sunken hover:text-text'
                  )}
                >
                  <Icon size={15} className={active ? 'text-petal' : ''} aria-hidden />
                  {x.title}
                </button>
              </Tip>
            )
          })}
        </nav>

        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-6 pb-16 @3xl:px-8">
            <div className="sticky top-0 z-10 -mx-2 bg-surface px-2 pt-1 pb-4">
              <div className="flex items-center gap-2">
                <label className="relative flex-1">
                  <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-3" aria-hidden />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${SETTINGS_SCHEMA.length} settings`}
                    aria-label="Search settings"
                    className={cn(inputCls, 'pl-9')}
                  />
                </label>
                {query && (
                  <Button variant="ghost" onClick={() => setQuery('')}>
                    Clear
                  </Button>
                )}
              </div>
              {/* compact navigation for narrow windows */}
              <div className="mt-3 flex gap-1 overflow-x-auto @3xl:hidden">
                {VISIBLE.map((x) => (
                  <button
                    key={x.id}
                    onClick={() => {
                      setQuery('')
                      setSection(x.id)
                    }}
                    className={cn('shrink-0 rounded-full px-3 py-1 text-[0.82rem]', !q && x.id === section ? 'bg-petal-soft text-text' : 'text-text-2 hover:bg-sunken')}
                  >
                    {x.title}
                  </button>
                ))}
              </div>
            </div>

            {q ? (
              <div>
                <p className="mb-3 text-[0.88rem] text-text-2" aria-live="polite">
                  {results.length ? `${results.length} matching setting${results.length === 1 ? '' : 's'}` : 'Nothing matches. Try another word, such as “VRAM”, “dark” or “timeout”.'}
                </p>
                {VISIBLE.map((sec) => {
                  const hits = results.filter((d) => d.section === sec.id)
                  if (!hits.length) return null
                  return (
                    <section key={sec.id} className="mb-6">
                      <h2 className="mb-2 font-display text-[1.05rem] font-semibold text-text">{sec.title}</h2>
                      {grouped(hits).map(([g, list], i) => (
                        <Group key={`${g}-${i}`} title={g} defs={list} s={s} update={update} packs={packs} />
                      ))}
                    </section>
                  )
                })}
              </div>
            ) : (
              <section aria-labelledby="settings-section-title">
                <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="settings-section-title" className="font-display text-[1.6rem] font-light text-text">
                      {meta.title}
                    </h2>
                    <p className="mt-1 max-w-[62ch] text-[0.9rem] leading-relaxed text-text-2">{meta.description}</p>
                  </div>
                  {section !== 'data' && (
                    <Button variant="ghost" size="sm" onClick={() => void resetSection()}>
                      <RotateCcw size={13} /> Reset section
                    </Button>
                  )}
                </header>

                {section === 'generation' && (
                  <div className="mb-4">
                    <Segmented
                      label="Model role"
                      value={genRole}
                      onChange={setGenRole}
                      options={[
                        { value: 'fast', label: 'Fast' },
                        { value: 'balanced', label: 'Balanced' },
                        { value: 'max', label: 'Max' },
                        { value: 'code', label: 'Code' }
                      ]}
                    />
                  </div>
                )}

                {grouped(defs).map(([g, list], i) => (
                  <Group key={`${g}-${i}`} title={section === 'generation' ? undefined : g} defs={list} s={s} update={update} packs={packs} />
                ))}

                {section === 'phone' && <PhoneLink />}
                {section === 'window' && !REMOTE && <TerminalCommand />}

                {section === 'data' && (
                  <DataActions
                    info={info}
                    onSetup={openSetup}
                    flash={flash}
                    confirmReset={confirmReset}
                    setConfirmReset={setConfirmReset}
                  />
                )}
              </section>
            )}
            {notice && (
              <p role="status" className="fixed right-6 bottom-12 z-20 rounded-lg border border-line bg-raised px-3.5 py-2 text-[0.88rem] text-text shadow-float">
                {notice}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionRow({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <span className="min-w-0">
        <span className="block text-[0.95rem] text-text">{title}</span>
        <span className="mt-0.5 block max-w-[58ch] text-[0.84rem] leading-snug text-text-2">{hint}</span>
      </span>
      <span className="flex gap-2">{children}</span>
    </div>
  )
}

function DataActions({
  info,
  onSetup,
  flash,
  confirmReset,
  setConfirmReset
}: {
  info?: { version: string; userDir: string; dataDir: string; electron: string }
  onSetup: () => void
  flash: (t: string) => void
  confirmReset: boolean
  setConfirmReset: (v: boolean) => void
}) {
  return (
    <>
      <div className="mt-5">
        <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">Setup assistant</h3>
        <div className="divide-y divide-line rounded-xl border border-line bg-raised/60 px-4">
          <ActionRow title="Run setup again" hint={`Scan this ${DEVICE} and get fresh model recommendations, for example after a GPU upgrade.`}>
            <Button variant="primary" size="sm" onClick={onSetup}>
              <Wand2 size={14} /> Run setup
            </Button>
          </ActionRow>
        </div>
      </div>
      <div className="mt-5">
        <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">Backup</h3>
        <div className="divide-y divide-line rounded-xl border border-line bg-raised/60 px-4">
          <ActionRow title="Export settings" hint="Save every preference to a file. API keys are left out.">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const p = await api.settings.exportFile()
                if (p) flash(`Saved to ${p}`)
              }}
            >
              <Download size={14} /> Export
            </Button>
          </ActionRow>
          <ActionRow title="Import settings" hint={`Load preferences from a file. Models and folders chosen for this ${DEVICE} are kept.`}>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  if (await api.settings.importFile()) flash('Settings imported')
                } catch (e) {
                  flash((e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
                }
              }}
            >
              <Upload size={14} /> Import
            </Button>
          </ActionRow>
          <ActionRow title="Reset all settings" hint="Every preference goes back to its default. Your chats, memories, models and folders stay.">
            {confirmReset ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                  Keep my settings
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    await api.settings.reset()
                    setConfirmReset(false)
                    flash('All settings are back to their defaults')
                  }}
                >
                  Reset everything
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={14} /> Reset all
              </Button>
            )}
          </ActionRow>
        </div>
      </div>
      {info && (
        <div className="mt-5">
          <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">About</h3>
          <div className="divide-y divide-line rounded-xl border border-line bg-raised/60 px-4">
            <ActionRow title={`Maris ${info.version}`} hint={`Electron ${info.electron}. Chats, memories and settings are stored in ${info.userDir}.`}>
              <Button variant="ghost" size="sm" onClick={() => void api.shell.openPath(info.userDir)}>
                <FolderOpen size={14} /> Open app data
              </Button>
            </ActionRow>
          </div>
        </div>
      )}
    </>
  )
}
