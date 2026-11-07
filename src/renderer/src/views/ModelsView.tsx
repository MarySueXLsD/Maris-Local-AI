import { Clapperboard, Download, ExternalLink, Eye, Hammer, Image as ImageIcon, Lightbulb, MessageSquareText, Power, Trash2, Wand2, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'
import type { CatalogModel, ModelDetails, ModelInfo, PcScan, PullProgress, Tier } from '@shared/types'
import { budgetOf, llmPlacement } from '@shared/recommend'
import { api } from '../lib/api'
import { bytes, prettyModel } from '../lib/format'
import { useApp } from '../store'
import { Button, cn, inputCls, PageHeader, Progress, Section, Spinner } from '../components/ui'
import { Term, withTerms } from '../components/Term'
import { DEVICE, REMOTE } from '../lib/platform'
import { MediaTab } from './MediaModels'

const ROLES: { key: Tier | 'embed' | 'code'; label: string; hint: string }[] = [
  { key: 'fast', label: 'Fast', hint: 'Small talk and quick answers' },
  { key: 'balanced', label: 'Balanced', hint: 'Everyday questions, writing and lighter tasks' },
  { key: 'max', label: 'Max', hint: `Coding, reasoning and multi-step work on your ${DEVICE}` },
  { key: 'code', label: 'Code', hint: 'Optional dedicated coding model for Code mode (otherwise Max is used)' },
  { key: 'tiny', label: 'Helper', hint: 'Runs on the CPU for routing, titles and memory upkeep' },
  { key: 'embed', label: 'Memory search', hint: 'Embedding model used to find relevant memories' }
]

function Caps({ caps }: { caps: string[] }) {
  if (caps.includes('embedding')) {
    return <span className="inline-flex items-center rounded-md bg-sunken px-1.5 py-0.5 text-[0.72rem] text-text-2">Embeddings for memory search</span>
  }
  const all: [string, string, typeof Eye][] = [
    ['vision', 'Sees images', Eye],
    ['tools', 'Uses tools', Hammer],
    ['thinking', 'Can think first', Lightbulb]
  ]
  return (
    <span className="flex flex-wrap gap-1">
      {all
        .filter(([c]) => caps.includes(c))
        .map(([c, label, Icon]) => (
          <span key={c} title={label} className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[0.72rem] text-text-2">
            <Icon size={11} aria-hidden /> {label}
          </span>
        ))}
    </span>
  )
}

/** Things each kind of model is good at, to try with one click. */
const TRY: Record<'fast' | 'balanced' | 'max', string[]> = {
  fast: ['What can I cook tonight with eggs, spinach and feta?', 'Rewrite this so it sounds friendlier: "Send me the report by Friday."'],
  balanced: ['Explain how a heat pump works, in simple words.', 'Plan a relaxed three-day trip to Lisbon on a small budget.'],
  max: [
    'Write a Python script that finds duplicate photos in a folder by comparing their contents.',
    'Compare SQLite and PostgreSQL for a small web app: pros, cons and what you would pick.'
  ]
}

function tryPrompts(c?: CatalogModel, m?: ModelInfo): string[] {
  if (m?.capabilities.includes('embedding') || c?.roles?.includes('embed')) return []
  const tier = c?.tier ?? (m && Number(/([\d.]+)b/i.exec(m.name)?.[1] ?? 0) >= 20 ? 'max' : 'fast')
  if (tier === 'tiny') return []
  return TRY[tier === 'max' ? 'max' : tier === 'balanced' ? 'balanced' : 'fast']
}

/** Open a new chat with this model picked and the prompt in the message box. */
function tryModel(name: string, prompt: string): void {
  const s = useApp.getState()
  if (s.mode !== 'chat') s.setMode('chat')
  s.newChat()
  useApp.setState({ draftModel: name })
  s.setComposerMedia('text')
  s.insertIntoComposer(prompt, true)
}

function TryIt({ name, prompts }: { name: string; prompts: string[] }) {
  if (!prompts.length) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.8rem]">
      <span className="text-text-3">Try it:</span>
      {prompts.map((t) => (
        <button
          key={t}
          title="Opens a new chat with this model and this prompt. Nothing is sent until you press Enter."
          className="max-w-full truncate rounded-full border border-line px-2.5 py-0.5 text-text-2 hover:border-petal hover:text-text"
          onClick={() => tryModel(name, t)}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

const MAKERS: [RegExp, string][] = [
  [/qwen/i, 'Qwen team (Alibaba)'],
  [/gemma/i, 'Google DeepMind'],
  [/gpt-oss/i, 'OpenAI'],
  [/llama/i, 'Meta'],
  [/mistral|magistral|devstral|ministral/i, 'Mistral AI'],
  [/phi/i, 'Microsoft'],
  [/deepseek/i, 'DeepSeek'],
  [/granite/i, 'IBM'],
  [/glm/i, 'Zhipu AI']
]
const makerOf = (name: string, family?: string): string | undefined => MAKERS.find(([rx]) => rx.test(family ?? '') || rx.test(name))?.[1]

const ROLE_WORDS: Record<string, string> = {
  tiny: 'background helper jobs (routing, titles, memory)',
  fast: 'quick answers and small talk',
  balanced: 'everyday questions and writing',
  max: 'hard questions, reasoning and multi-step work',
  code: 'programming in Code mode',
  embed: 'finding memories that fit a question'
}

function params(b: number | undefined, active?: number): string | undefined {
  if (!b) return undefined
  const words = (n: number): string => (n >= 1 ? `${Math.round(n * 10) / 10} billion` : `${Math.round(n * 1000)} million`)
  return active ? `${words(b)} in total, of which ${words(active)} work on each word (a mixture of experts, so it runs like a much smaller model)` : words(b)
}

function quantWords(q?: string): string | undefined {
  if (!q) return undefined
  const bits = /Q(\d)/i.exec(q)?.[1] ?? (/F16|BF16/i.test(q) ? '16' : /F32/i.test(q) ? '32' : /MXFP4/i.test(q) ? '4' : undefined)
  return bits ? `${q}: about ${bits} bits per weight${Number(bits) <= 4 ? ', which makes it smaller and faster with a small loss in precision' : ''}` : q
}

function Rating({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null
  return (
    <span className="flex items-center gap-2">
      <span className="w-16 text-text-3">{label}</span>
      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken" aria-hidden>
        <span className="block h-full rounded-full bg-petal" style={{ width: `${value}%` }} />
      </span>
      <span className="tabular text-text-2">{value}/100</span>
    </span>
  )
}

const pageOf = (name: string): string => (name.startsWith('hf.co/') ? `https://huggingface.co/${name.slice(6).split(':')[0]}` : `https://ollama.com/library/${name.split(':')[0]}`)

/** The long description of a language model: what the model says about itself plus what Maris knows. */
function MoreAbout({ name, c, installed, speed }: { name: string; c?: CatalogModel; installed: boolean; speed?: string }) {
  const [d, setD] = useState<ModelDetails>()
  const [open, setOpen] = useState(false)
  const ctxUsed = useApp((s) => s.settings?.routing.contextByTier)
  useEffect(() => {
    if (open && installed && !d) void api.models.details(name).then(setD).catch(() => setD({ defaults: {} }))
  }, [open, installed, name, d])
  const maker = makerOf(name, c?.family ?? d?.architecture)
  const roles = (c?.roles ?? []).map((r) => ROLE_WORDS[r]).filter(Boolean)
  return (
    <details className="mt-2 rounded-lg border border-line px-3 py-2" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="text-[0.84rem] font-medium text-text">More about this model</summary>
      {open && installed && !d ? (
        <Spinner className="my-2" />
      ) : (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.84rem]">
          {maker && (
            <>
              <dt className="text-text-3">Made by</dt>
              <dd className="text-text">
                {maker}
                {c?.family ? `, ${c.family} family` : ''}
              </dd>
            </>
          )}
          {(d?.parameters || c?.paramsB) && (
            <>
              <dt className="text-text-3">Size</dt>
              <dd className="text-text">{params(d?.parameters ? d.parameters / 1e9 : c!.paramsB!, c?.activeB)} parameters</dd>
            </>
          )}
          {d?.contextLength && (
            <>
              <dt className="text-text-3">Memory span</dt>
              <dd className="text-text">
                Up to {Math.round(d.contextLength / 1024)}K tokens (about {Math.round((d.contextLength * 0.75) / 1000)} thousand words) at once. Maris uses{' '}
                {ctxUsed ? `${Math.round(Math.min(...Object.values(ctxUsed)) / 1024)}–${Math.round(Math.max(...Object.values(ctxUsed)) / 1024)}K` : 'less'} here, so it stays fast on your {DEVICE}.
              </dd>
            </>
          )}
          {d?.quantization && (
            <>
              <dt className="text-text-3">Stored as</dt>
              <dd className="text-text">{quantWords(d.quantization)}</dd>
            </>
          )}
          {d?.architecture && (
            <>
              <dt className="text-text-3">Architecture</dt>
              <dd className="font-mono text-[0.8rem] text-text">{d.architecture}</dd>
            </>
          )}
          {roles.length > 0 && (
            <>
              <dt className="text-text-3">Good for</dt>
              <dd className="text-text">{roles.join('; ')}</dd>
            </>
          )}
          {speed && (
            <>
              <dt className="text-text-3">On your {DEVICE}</dt>
              <dd className="text-text">{speed}</dd>
            </>
          )}
          {(c?.quality !== undefined || c?.coding !== undefined) && (
            <>
              <dt className="text-text-3">Rough rating</dt>
              <dd className="space-y-1 text-[0.8rem]">
                <Rating label="Overall" value={c?.quality} />
                <Rating label="Coding" value={c?.coding} />
              </dd>
            </>
          )}
          {d?.license && (
            <>
              <dt className="text-text-3">Licence</dt>
              <dd className="text-text">{d.license}</dd>
            </>
          )}
          {d && Object.keys(d.defaults).length > 0 && (
            <>
              <dt className="text-text-3">Its defaults</dt>
              <dd className="font-mono text-[0.78rem] text-text-2">
                {Object.entries(d.defaults)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
              </dd>
            </>
          )}
          {d?.modifiedAt && (
            <>
              <dt className="text-text-3">Installed</dt>
              <dd className="text-text">{new Date(d.modifiedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</dd>
            </>
          )}
          <dt className="text-text-3">Page</dt>
          <dd>
            <button className="inline-flex items-center gap-1 text-petal hover:underline" onClick={() => void api.shell.openExternal(pageOf(name))}>
              <ExternalLink size={12} /> {pageOf(name).replace(/^https:\/\//, '')}
            </button>
          </dd>
        </dl>
      )}
    </details>
  )
}

function TextTab() {
  const models = useApp((s) => s.models)
  const settings = useApp((s) => s.settings)
  const status = useApp((s) => s.status)
  const refresh = useApp((s) => s.refreshModels)
  const update = useApp((s) => s.updateSettings)
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [pulls, setPulls] = useState<Record<string, PullProgress>>({})
  const [custom, setCustom] = useState('')
  const [confirm, setConfirm] = useState<string>()
  const [scan, setScan] = useState<PcScan>()

  useEffect(() => {
    void api.models.catalog().then(setCatalog)
    // The speed estimates need a PC scan; one is made here when setup has not run yet.
    void api.setup
      .lastScan()
      .then((sc) => sc ?? api.setup.scan())
      .then(setScan)
      .catch(() => undefined)
    void refresh(true)
    return api.models.onPull((p) => setPulls((s) => ({ ...s, [p.model]: p })))
  }, [refresh])

  const loaded = new Map(status?.ollama.loaded.map((m) => [m.name, m]) ?? [])
  const budget = scan ? budgetOf(scan) : undefined
  /** How fast a model answers on this computer, from the PC scan (the same estimate setup uses). */
  const speedHere = (c?: CatalogModel): string | undefined => {
    if (!c || !budget || !settings || c.roles?.includes('embed')) return undefined
    const pl = llmPlacement(c, budget, settings.engine.processing, 8192)
    if (!pl.fits) return pl.note ?? 'Too big for this computer'
    return `${pl.speed} here, ${pl.where === 'gpu' ? 'fully on the graphics card' : pl.where === 'cpu' ? 'on the processor' : 'partly in system memory'}`
  }
  const installed = new Set(models.map((m) => m.name))
  const pull = (name: string): void => {
    setPulls((s) => ({ ...s, [name]: { model: name, status: 'starting' } }))
    void api.models.pull(name).catch(() => undefined)
  }

  return (
    <>
      <Section title="Roles" description="Which installed model plays each part. Maris fills these in automatically when you install models.">
        <div className="divide-y divide-line rounded-xl border border-line">
          {ROLES.map((r) => {
            const options = models.filter((m) => (r.key === 'embed' ? m.capabilities.includes('embedding') : !m.capabilities.includes('embedding')))
            const value = settings?.tiers[r.key] ?? ''
            return (
              <div key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <p className="text-[0.95rem] text-text">{r.label}</p>
                  <p className="text-[0.82rem] text-text-2">{r.hint}</p>
                </div>
                <select aria-label={`${r.label} model`} value={value} onChange={(e) => void update({ tiers: { [r.key]: e.target.value } })} className={cn(inputCls, 'w-64')}>
                  {r.key === 'code' ? <option value="">Same as Max</option> : !value && <option value="">Not set</option>}
                  {options.map((m) => (
                    <option key={m.name} value={m.name}>
                      {prettyModel(m.name)} ({bytes(m.sizeBytes)})
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Installed" description="Loaded models stay in memory for 30 minutes after their last use, so follow-up questions start instantly.">
        <div className="divide-y divide-line rounded-xl border border-line">
          {models.length === 0 && <p className="px-4 py-4 text-[0.9rem] text-text-2">No models yet. Install one below.</p>}
          {models.map((m) => {
            const l = loaded.get(m.name)
            const gpuPct = l && l.sizeBytes ? Math.round((l.vramBytes / l.sizeBytes) * 100) : 0
            const c = catalog.find((x) => x.name === m.name)
            const usedFor = (Object.entries(settings?.tiers ?? {}) as [string, string | undefined][]).filter(([, v]) => v === m.name).map(([k]) => ROLES.find((r) => r.key === k)?.label ?? k)
            return (
              <div key={m.name} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.98rem] font-medium text-text">
                      {c?.label ?? prettyModel(m.name)} <span className="text-[0.8rem] font-normal text-text-3">{m.name}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.8rem] text-text-2">
                      <span>{bytes(m.sizeBytes)}</span>
                      {m.quantization && <span>{m.quantization}</span>}
                      <Caps caps={m.capabilities} />
                      {usedFor.length > 0 && <span className="rounded-md bg-petal-soft px-1.5 py-0.5 text-[0.72rem] text-text">Used as {usedFor.join(', ')}</span>}
                    </div>
                  </div>
                  {l && <span className="text-[0.8rem] text-pollen">In memory, {gpuPct >= 99 ? 'fully on the GPU' : gpuPct === 0 ? 'on the CPU' : `${gpuPct}% on the GPU`}</span>}
                  {l && (
                    <Button size="sm" variant="ghost" title="Free the memory it uses now. It loads again the next time it is needed." onClick={() => void api.models.unload(m.name)}>
                      Unload
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" title={`Delete this model from your ${DEVICE} (you can download it again later)`} aria-label={`Delete ${m.name}`} onClick={() => setConfirm(m.name)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
                {c?.description && <p className="mt-1.5 text-[0.86rem] text-text-2">{withTerms(c.description)}</p>}
                {speedHere(c) && <p className="mt-0.5 text-[0.8rem] text-text-3">{speedHere(c)}</p>}
                <TryIt name={m.name} prompts={tryPrompts(c, m)} />
                <MoreAbout name={m.name} c={c} installed speed={speedHere(c)} />
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Get more models" description="Downloads come from the Ollama library or Hugging Face. Sizes are what lands on disk.">
        <div className="divide-y divide-line rounded-xl border border-line">
          {catalog
            .filter((c) => !installed.has(c.name))
            .map((c) => {
              const p = pulls[c.name]
              const active = p && !p.done
              return (
                <div key={c.name} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.98rem] font-medium text-text">
                        {c.label} {c.recommended && <span className="ml-1 text-[0.78rem] font-normal text-petal">Recommended</span>}
                      </p>
                      <p className="text-[0.86rem] text-text-2">{withTerms(c.description)}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.8rem]">
                        <Caps caps={c.caps ?? []} />
                        {speedHere(c) && <span className="text-text-3">{speedHere(c)}</span>}
                      </div>
                    </div>
                    <span className="tabular text-[0.82rem] text-text-3">{c.sizeGB} GB</span>
                    {active ? (
                      <Button size="sm" variant="ghost" onClick={() => void api.models.cancelPull(c.name)}>
                        <X size={14} /> Cancel
                      </Button>
                    ) : (
                      !REMOTE && (
                        <Button size="sm" variant="outline" title={`Download ${c.label} (${c.sizeGB} GB)`} onClick={() => pull(c.name)}>
                          <Download size={14} /> Install
                        </Button>
                      )
                    )}
                  </div>
                  <MoreAbout name={c.name} c={c} installed={false} speed={speedHere(c)} />
                  {p && !p.done && (
                    <div className="mt-2 space-y-1">
                      <Progress value={p.total ? (p.completed ?? 0) / p.total : 0} label={`Downloading ${c.label}`} />
                      <p className="tabular text-[0.76rem] text-text-3">
                        {p.status}
                        {p.total ? ` ${bytes(p.completed)} of ${bytes(p.total)}` : ''}
                      </p>
                    </div>
                  )}
                  {p?.error && <p className="mt-1 text-[0.82rem] text-danger">{p.error}</p>}
                </div>
              )
            })}
        </div>
        {!REMOTE && (
          <div className="mt-4 flex gap-2">
            <input className={inputCls} placeholder="Any Ollama tag, e.g. gemma4:12b, or hf.co/user/repo:Q4_K_M" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Model to download" />
            <Button variant="primary" disabled={!custom.trim()} onClick={() => (pull(custom.trim()), setCustom(''))}>
              Download
            </Button>
          </div>
        )}
        {Object.values(pulls)
          .filter((p) => !catalog.some((c) => c.name === p.model))
          .map((p) => (
            <div key={p.model} className="mt-3 space-y-1">
              <p className="text-[0.84rem] text-text">{p.model}</p>
              {!p.done && <Progress value={p.total ? (p.completed ?? 0) / p.total : 0} label={`Downloading ${p.model}`} />}
              <p className={cn('text-[0.78rem]', p.error ? 'text-danger' : 'text-text-3')}>{p.error ?? (p.done ? 'Installed' : p.status)}</p>
            </div>
          ))}
      </Section>

      <Dialog.Root open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
            <Dialog.Title className="text-[1.1rem] font-semibold text-text">Delete {prettyModel(confirm)}?</Dialog.Title>
            <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">The model files are removed from Ollama. You can download it again later.</Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(undefined)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (confirm) await api.models.remove(confirm)
                  setConfirm(undefined)
                  void refresh(true)
                }}
              >
                Delete model
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

const TABS = [
  { value: 'text', label: 'Text', icon: MessageSquareText, hint: 'Language models that chat, write and code' },
  { value: 'image', label: 'Pictures', icon: ImageIcon, hint: 'Models that draw pictures from a description' },
  { value: 'video', label: 'Videos', icon: Clapperboard, hint: 'Models that make short clips, or animate a picture' }
] as const

export function ModelsView() {
  const status = useApp((s) => s.status)
  const openSetup = useApp((s) => s.openSetup)
  const tab = useApp((s) => s.modelsTab)
  const setTab = (t: (typeof TABS)[number]['value']): void => useApp.setState({ modelsTab: t })

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[920px] px-8 pb-16">
        <PageHeader
          title="Models"
          description={
            tab === 'text' ? (
              <>
                The AI models on this {DEVICE}. <Term id="tier">Auto</Term> chooses between your Fast, Balanced and Max models for every message, based on the task and how busy your {DEVICE} is. Language
                models run in <Term id="ollama">Ollama</Term>.
              </>
            ) : tab === 'image' ? (
              `Models that draw pictures on your own graphics card. Pick one in the message box (Image) or let Maris choose; chats keep working on the processor while a picture renders.`
            ) : (
              `Models that make short clips, from a description or from one of your pictures. Video takes minutes; chats keep working on the processor meanwhile.`
            )
          }
        >
          {tab === 'text' && (
            <>
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8rem]', status?.ollama.up ? 'border-ok/40 text-ok' : 'border-danger/40 text-danger')}>
                <span className={cn('size-1.5 rounded-full', status?.ollama.up ? 'bg-ok' : 'bg-danger')} />
                {status?.ollama.up ? `Ollama ${status.ollama.version ?? ''} running` : 'Ollama stopped'}
              </span>
              {!status?.ollama.up && (
                <Button size="sm" variant="primary" onClick={() => void api.models.ensureOllama()}>
                  <Power size={14} /> Start
                </Button>
              )}
            </>
          )}
          {!REMOTE && (
            <Button size="sm" variant="outline" onClick={openSetup}>
              <Wand2 size={14} /> Recommend for this {DEVICE}
            </Button>
          )}
        </PageHeader>

        <div role="tablist" aria-label="Kinds of models" className="mt-2 flex gap-1 border-b border-line">
          {TABS.map(({ value, label, icon: Icon, hint }) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              title={hint}
              onClick={() => setTab(value)}
              className={cn(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-3.5 py-2 text-[0.92rem] font-medium transition-colors',
                tab === value ? 'border-petal text-text' : 'border-transparent text-text-2 hover:text-text'
              )}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === 'text' ? <TextTab /> : <MediaTab key={tab} kind={tab} />}
      </div>
    </div>
  )
}
