import { Brain, ChevronRight, Cloud, Coins, ExternalLink, Eye, Hammer, KeyRound, Pencil, Plus, RefreshCw, Search, Server, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { priceLabel, priceWords, usd, type PriceSource, type UsageSummary, type UsageTotals } from '@shared/pricing'
import { looksLikeChatModel, type ProviderInfo, type ProviderModel, type ProviderPreset } from '@shared/providers'
import { Button, cn, inputCls, RowToggle, Section, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { REMOTE } from '../lib/platform'
import { useApp } from '../store'

// The main process's wording, without the wrapper and without sending the person to the page they are on.
const clean = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
    .replace(' Check it in Models → API.', '')

const STATUS: Record<ProviderInfo['status'], { word: string; cls: string }> = {
  off: { word: 'Off', cls: 'bg-text-3' },
  checking: { word: 'Reading its models…', cls: 'bg-pollen' },
  ready: { word: 'Ready', cls: 'bg-ok' },
  error: { word: 'Problem', cls: 'bg-danger' }
}

const kTokens = (n: number): string => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

/** Where a price comes from, as a sentence. */
const PRICE_FROM: Record<PriceSource, string> = {
  yours: 'This is the price you set.',
  service: 'The service itself gives this price.',
  list: 'From the public list of the makers’ prices.'
}

/** A sum of use in one tile: what it cost, and the tokens and requests behind it. */
function UsageTile({ title, t }: { title: string; t: UsageTotals }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-line bg-raised/60 px-3.5 py-2.5">
      <p className="text-[0.76rem] text-text-3">{title}</p>
      <p className="tabular text-[1.25rem] leading-tight font-semibold text-text">{t.requests ? usd(t.cost) : '$0'}</p>
      <p className="tabular truncate text-[0.78rem] text-text-2">
        {t.requests ? `${kTokens(t.input + t.output)} tokens · ${t.requests.toLocaleString('en-US')} request${t.requests === 1 ? '' : 's'}` : 'nothing yet'}
      </p>
    </div>
  )
}

/**
 * What the models at API services used and cost. The token counts are the services' own; the costs
 * are worked out from each model's price, so they are an estimate of the bill, not the bill.
 */
function UsagePanel({ list }: { list: ProviderInfo[] }) {
  const [u, setU] = useState<UsageSummary>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  // Read again when a service changes and whenever an answer finishes.
  const answering = useApp((s) => Object.values(s.running).filter(Boolean).length)
  const openSettings = useApp((s) => s.setView)
  useEffect(() => {
    void api.providers.usage().then(setU).catch(() => undefined)
  }, [list, answering])
  if (!u || (!u.all.requests && !list.some((p) => !p.local))) return null
  const names = new Map(list.flatMap((p) => p.models.map((m) => [`${p.id}\n${m.id}`, m.label ?? m.id] as [string, string])))
  const over = u.budget > 0 ? u.month.cost / u.budget : 0
  return (
    <Section title="Use and cost" description="What your API models used and what that comes to at their prices. Models on this computer cost nothing per message and are not counted.">
      {!u.tracking ? (
        <p className="text-[0.88rem] text-text-2">
          The record is turned off.{' '}
          <button className="text-petal underline" onClick={() => openSettings('settings')}>
            Settings → Engine
          </button>{' '}
          turns it on.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2.5">
            <UsageTile title="Today" t={u.today} />
            <UsageTile title="This month" t={u.month} />
            <UsageTile title="In all" t={u.all} />
          </div>
          {u.budget > 0 && (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
                <div className={cn('h-full rounded-full', over >= 1 ? 'bg-danger' : over >= 0.8 ? 'bg-pollen' : 'bg-petal')} style={{ width: `${Math.min(100, over * 100)}%` }} />
              </div>
              <p className="mt-1 text-[0.8rem] text-text-2">
                {usd(u.month.cost)} of the ${u.budget} you set as a monthly guide{over >= 1 ? ': over it' : ''}.
              </p>
            </div>
          )}
          {u.month.unpriced > 0 && (
            <p className="mt-2 text-[0.8rem] text-pollen">
              {u.month.unpriced} request{u.month.unpriced === 1 ? '' : 's'} this month went to a model without a known price: counted in tokens, not in dollars. Set its price in the service’s model list
              below.
            </p>
          )}
          {u.models.length > 0 && (
            <div className="mt-3">
              <button className="inline-flex items-center gap-1 text-[0.84rem] text-text-2 hover:text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
                <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} /> By model, this month
              </button>
              {open && (
                <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-left text-[0.82rem]">
                    <thead className="text-[0.74rem] text-text-3">
                      <tr className="border-b border-line">
                        <th className="px-3 py-1.5 font-normal">Model</th>
                        <th className="px-3 py-1.5 text-right font-normal">Requests</th>
                        <th className="px-3 py-1.5 text-right font-normal">Read</th>
                        <th className="px-3 py-1.5 text-right font-normal">Written</th>
                        <th className="px-3 py-1.5 text-right font-normal">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="tabular divide-y divide-line">
                      {u.models.map((m) => (
                        <tr key={`${m.provider}/${m.model}`}>
                          <td className="max-w-64 truncate px-3 py-1.5 text-text" title={`${m.model} at ${m.providerName}`}>
                            {names.get(`${m.provider}\n${m.model}`) ?? m.model} <span className="text-text-3">{m.providerName}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-2">{m.requests.toLocaleString('en-US')}</td>
                          <td className="px-3 py-1.5 text-right text-text-2" title={m.cacheRead ? `${m.input.toLocaleString('en-US')} tokens, ${m.cacheRead.toLocaleString('en-US')} of them from the service's cache (cheaper)` : `${m.input.toLocaleString('en-US')} tokens`}>
                            {kTokens(m.input)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text-2" title={`${m.output.toLocaleString('en-US')} tokens`}>
                            {kTokens(m.output)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-text">{m.unpriced >= m.requests ? <span className="text-text-3">no price</span> : `${m.unpriced ? 'over ' : ''}${usd(m.cost)}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.78rem] text-text-3">
            <span className="min-w-0 flex-1 basis-80">
              The token counts are the services’ own. The costs are an estimate from each model’s price ({u.prices.count} list prices, looked up {u.prices.updated}); what the service bills you is what counts.
            </span>
            {!REMOTE && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  title="Read the makers' current prices from the public list again"
                  onClick={() => {
                    setBusy(true)
                    void api.providers
                      .refreshPrices()
                      .then(setU)
                      .finally(() => setBusy(false))
                  }}
                >
                  {busy ? <Spinner className="size-3.5" /> : <RefreshCw size={13} />} Update prices
                </Button>
                {u.all.requests > 0 &&
                  (sure ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => void api.providers.clearUsage().then(setU).finally(() => setSure(false))}>
                        Clear the record
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
                        Keep it
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setSure(true)}>
                      <Trash2 size={13} /> Clear
                    </Button>
                  ))}
              </>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

/** Your own price for a model: dollars per million tokens read and written. */
function PriceEditor({ p, modelId, onClose }: { p: ProviderInfo; modelId: string; onClose: () => void }) {
  const eff = p.priced[modelId]
  const [pin, setPin] = useState(eff ? String(eff.price.in) : '')
  const [pout, setPout] = useState(eff ? String(eff.price.out) : '')
  const [error, setError] = useState('')
  const act = (price?: { in: number; out: number } | null): void => {
    setError('')
    void api.providers.setPrice(p.id, modelId, price).then(onClose, (e) => setError(clean(e)))
  }
  const field = cn(inputCls, 'tabular h-7 w-24 px-2 py-0 text-[0.82rem]')
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken/60 px-3 py-2 text-[0.8rem] text-text-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (pin.trim() === '' || pout.trim() === '') return setError('Fill in both prices.')
        act({ in: Number(pin), out: Number(pout) })
      }}
    >
      <Coins size={14} className="text-text-3" aria-hidden />
      <span>Dollars per million tokens:</span>
      <label className="inline-flex items-center gap-1.5">
        read
        <input className={field} type="number" min={0} step="any" inputMode="decimal" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Price per million tokens read, in dollars" autoFocus />
      </label>
      <label className="inline-flex items-center gap-1.5">
        written
        <input className={field} type="number" min={0} step="any" inputMode="decimal" value={pout} onChange={(e) => setPout(e.target.value)} aria-label="Price per million tokens written, in dollars" />
      </label>
      <Button size="sm" type="submit" variant="primary">
        Save
      </Button>
      {eff?.source === 'yours' && (
        <Button size="sm" type="button" variant="ghost" onClick={() => act(null)}>
          Forget my price
        </Button>
      )}
      <Button size="sm" type="button" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {error && <span className="basis-full text-danger">{error}</span>}
    </form>
  )
}

/** What a service says a model can do, as small badges (nothing shown where it does not say). */
function Abilities({ m }: { m: ProviderModel }) {
  const all: [boolean | undefined, string, typeof Eye][] = [
    [m.vision, 'Sees images', Eye],
    [m.tools, 'Uses tools', Hammer],
    [m.thinking, 'Can think first', Brain]
  ]
  return (
    <>
      {all
        .filter(([on]) => on)
        .map(([, label, Icon]) => (
          <span key={label} title={label} className="inline-flex items-center text-text-3">
            <Icon size={12} aria-label={label} />
          </span>
        ))}
    </>
  )
}

/**
 * Models that run somewhere else: Claude, GPT, Gemini and others through their API, or another
 * program on this computer. The services and their keys live here; which of their models show up in
 * Maris is ticked per service, and the lists are read from the services themselves.
 */
export function ApiTab() {
  const [list, setList] = useState<ProviderInfo[]>()
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [form, setForm] = useState<{ preset: ProviderPreset; edit?: ProviderInfo }>()
  const [opened, setOpened] = useState<string>()
  const top = useRef<HTMLDivElement>(null)
  const openForm = (f: { preset: ProviderPreset; edit?: ProviderInfo }): void => {
    setForm(f)
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    void api.providers.list().then(setList)
    void api.providers.presets().then(setPresets)
    return api.providers.onChange(setList)
  }, [])

  // A service that is set up leaves the list of ones to add; your own addresses can be added again.
  const available = presets.filter((p) => p.custom || !(list ?? []).some((c) => c.preset === p.id))

  return (
    <>
      <div ref={top} />
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-line bg-raised/60 px-4 py-3">
        <Cloud size={18} className="mt-0.5 shrink-0 text-petal" aria-hidden />
        <p className="text-[0.88rem] leading-relaxed text-text-2">
          <b className="font-medium text-text">Messages you send to one of these models leave this computer</b> and go to the service you chose, together with what Maris reads for the task (files,
          tool results, the memories that fit). The service bills your account for them. Maris uses such a model only when you pick it for a chat or give it a role, or when no model is installed on
          this computer at all; everything else keeps running here. Services marked <span className="whitespace-nowrap">“on this computer”</span> stay local.
        </p>
      </div>

      {form && (
        <ProviderForm
          key={`${form.preset.id}:${form.edit?.id ?? 'new'}`}
          preset={form.preset}
          edit={form.edit}
          onClose={() => setForm(undefined)}
          onSaved={(id) => {
            setForm(undefined)
            setOpened(id)
          }}
        />
      )}

      {list && <UsagePanel list={list} />}

      <Section title="Your services">
        {!list ? (
          <Spinner className="size-4" />
        ) : list.length === 0 ? (
          <p className="flex items-center gap-2 text-[0.9rem] text-text-2">
            <KeyRound size={16} aria-hidden /> None yet. Add one below: you need an account with the service and its API key.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {list.map((p) => (
              <ProviderRow
                key={p.id}
                p={p}
                open={opened === p.id}
                onToggle={() => setOpened(opened === p.id ? undefined : p.id)}
                onEdit={() => {
                  const preset = presets.find((x) => x.id === p.preset)
                  if (preset) openForm({ preset, edit: p })
                }}
              />
            ))}
          </ul>
        )}
        {list && list.length > 0 && (
          <p className="mt-3 text-[0.82rem] text-text-3">
            Ticked models appear in the model menu of every chat. To let <b className="font-medium text-text-2">Auto</b> use one, give it a role on the Text tab (Roles).
          </p>
        )}
      </Section>

      {!REMOTE && (
        <Section
          title="Add a service"
          description="Maris reads each service's models from the service itself, so new models show up here without a new version of Maris. Anything with an OpenAI-compatible address works under “Other service”."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {available.map((p) => (
              <button
                key={p.id}
                onClick={() => openForm({ preset: p })}
                aria-pressed={form?.preset.id === p.id && !form.edit}
                className={cn(
                  'flex cursor-pointer flex-col items-start gap-1 rounded-xl border bg-raised/60 p-3.5 text-left transition-colors hover:border-petal/60 hover:bg-raised',
                  form?.preset.id === p.id && !form.edit ? 'border-petal' : 'border-line'
                )}
              >
                <span className="flex w-full items-center gap-2 text-[0.98rem] font-medium text-text">
                  {p.local ? <Server size={15} className="text-text-3" aria-hidden /> : <Cloud size={15} className="text-text-3" aria-hidden />}
                  {p.name}
                  {p.local && <span className="ml-auto rounded-full bg-ok-soft px-2 py-0.5 text-[0.72rem] font-normal text-text-2">On this computer</span>}
                </span>
                <span className="text-[0.84rem] leading-snug text-text-2">{p.description}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[0.8rem] text-text-3">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden /> Keys are stored on this computer with the system keychain, are sent only to their own service, and are never shown again.
          </p>
        </Section>
      )}
    </>
  )
}

function ProviderRow({ p, open, onToggle, onEdit }: { p: ProviderInfo; open: boolean; onToggle: () => void; onEdit: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [extra, setExtra] = useState('')
  /** The model whose price is being set. */
  const [pricing, setPricing] = useState<string>()
  const st = STATUS[p.status]
  const picked = useMemo(() => new Set(p.picked), [p.picked])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = p.models.filter((m) => looksLikeChatModel(m.id) || picked.has(m.id))
    const hit = q ? all.filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q)) : all
    // Ticked first, then the newest.
    return [...hit].sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
  }, [p.models, picked, query])
  const toggle = (id: string, on: boolean): void => {
    void api.providers.setPicked(p.id, on ? [...p.picked, id] : p.picked.filter((x) => x !== id))
  }
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded p-0.5 text-text-3 hover:text-text" aria-expanded={open} aria-label={open ? `Hide the models of ${p.name}` : `Show the models of ${p.name}`} onClick={onToggle}>
          <ChevronRight size={16} className={cn('transition-transform', open && 'rotate-90')} />
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <span className="flex items-center gap-2 text-[0.98rem] font-medium text-text">
            {p.local ? <Server size={14} className="text-text-3" aria-hidden /> : <Cloud size={14} className="text-text-3" aria-hidden />}
            {p.name}
            {p.local && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[0.72rem] font-normal text-text-2">On this computer</span>}
          </span>
          <span className="flex items-center gap-1.5 text-[0.8rem] text-text-2">
            <span className={cn('size-1.5 rounded-full', st.cls)} aria-hidden />
            {st.word}
            {p.status !== 'off' && ` · ${p.picked.length} of ${p.models.length} models in Maris`}
          </span>
        </button>
        <RowToggle checked={p.enabled} onChange={(v) => api.providers.setEnabled(p.id, v)} label={`Use ${p.name}`} />
      </div>
      {p.status === 'error' && p.error && <p className="mt-2 ml-8 rounded-lg bg-danger-soft px-3 py-2 text-[0.84rem] text-danger">{p.error}</p>}
      {open && (
        <div className="mt-3 ml-8">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-52 flex-1">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-3" aria-hidden />
              <input className={cn(inputCls, 'h-8 py-0 pl-8 text-[0.88rem]')} placeholder={`Search ${p.models.length} models`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={`Search the models of ${p.name}`} />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              title="Read the service's models again: new ones appear, withdrawn ones go"
              onClick={() => {
                setBusy(true)
                void api.providers.refresh(p.id).finally(() => setBusy(false))
              }}
            >
              {busy ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />} Refresh
            </Button>
          </div>
          <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label={`Models of ${p.name}`}>
            {shown.length === 0 && <li className="px-3 py-2 text-[0.84rem] text-text-2">No model matches.</li>}
            {shown.map((m) => (
              <li key={m.id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[0.86rem] hover:bg-sunken">
                  <input type="checkbox" className="size-4 shrink-0 accent-petal" checked={picked.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                  <span className="min-w-0 flex-1 truncate text-text" title={m.id}>
                    {m.label ?? m.id}
                    {m.label && m.label !== m.id && <span className="ml-2 text-[0.78rem] text-text-3">{m.id}</span>}
                  </span>
                  <Abilities m={m} />
                  {m.contextLength ? <span className="tabular shrink-0 text-[0.76rem] text-text-3">{kTokens(m.contextLength)} context</span> : null}
                  {/* What it costs per million tokens read / written; a click sets your own price. */}
                  {!p.local && (p.priced[m.id] || picked.has(m.id)) && (
                    <button
                      type="button"
                      disabled={REMOTE}
                      onClick={(e) => {
                        e.preventDefault()
                        setPricing(pricing === m.id ? undefined : m.id)
                      }}
                      title={
                        p.priced[m.id]
                          ? `${priceWords(p.priced[m.id]!.price)}. ${PRICE_FROM[p.priced[m.id]!.source]}${REMOTE ? '' : ' Click to set your own.'}`
                          : 'No price is known for this model, so Maris cannot show what it costs. Click to set one.'
                      }
                      aria-label={p.priced[m.id] ? `Price of ${m.label ?? m.id}: ${priceLabel(p.priced[m.id]!.price)} per million tokens read and written` : `Set a price for ${m.label ?? m.id}`}
                      className={cn(
                        'tabular w-24 shrink-0 rounded px-1.5 py-0.5 text-right text-[0.76rem] hover:bg-raised',
                        p.priced[m.id] ? (p.priced[m.id]!.source === 'yours' ? 'text-petal' : 'text-text-2') : 'text-text-3 underline decoration-dotted'
                      )}
                    >
                      {p.priced[m.id] ? priceLabel(p.priced[m.id]!.price) : 'set price'}
                    </button>
                  )}
                </label>
                {pricing === m.id && <PriceEditor p={p} modelId={m.id} onClose={() => setPricing(undefined)} />}
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const id = extra.trim()
              if (!id) return
              void api.providers.setPicked(p.id, [...p.picked, id])
              setExtra('')
            }}
          >
            <input className={cn(inputCls, 'h-8 py-0 text-[0.86rem]')} placeholder="A model the list does not show? Type its id" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Model id to add" />
            <Button size="sm" type="submit" variant="ghost" disabled={!extra.trim()}>
              <Plus size={14} /> Add
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {!REMOTE && (
              <Button size="sm" variant="ghost" onClick={onEdit}>
                <Pencil size={14} /> Change the key or address
              </Button>
            )}
            {!REMOTE &&
              (confirm ? (
                <>
                  <Button size="sm" variant="danger" onClick={() => void api.providers.remove(p.id)}>
                    <Trash2 size={14} /> Remove and forget the key
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                  <Trash2 size={14} /> Remove
                </Button>
              ))}
            <span className="ml-auto self-center truncate text-[0.76rem] text-text-3" title={p.baseUrl}>
              {p.baseUrl.replace(/^https?:\/\//, '')}
            </span>
          </div>
        </div>
      )}
    </li>
  )
}

function ProviderForm({ preset, edit, onClose, onSaved }: { preset: ProviderPreset; edit?: ProviderInfo; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(edit?.name ?? preset.name)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(edit?.baseUrl ?? preset.baseUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ownAddress = Boolean(preset.custom || preset.local)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const values = { key: key.trim() || undefined, name: name.trim() || undefined, baseUrl: ownAddress ? baseUrl : undefined }
      const list = edit ? await api.providers.edit(edit.id, values) : await api.providers.add(preset.id, values)
      onSaved(edit?.id ?? list[list.length - 1]?.id ?? '')
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="my-5 rounded-2xl border border-petal/50 bg-raised p-4 shadow-float" aria-label={`${edit ? 'Edit' : 'Add'} ${preset.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[1.1rem] font-semibold text-text">
            {edit ? 'Edit' : 'Add'} {preset.name}
          </h2>
          <p className="text-[0.86rem] text-text-2">{preset.description}</p>
        </div>
        <button className="rounded p-1 text-text-3 hover:text-text" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="block">
          <span className="mb-1 block text-[0.86rem] text-text-2">
            API key{(preset.local || preset.custom) && <span className="text-text-3"> (leave empty if the server needs none)</span>}
          </span>
          <input
            className={cn(inputCls, 'font-mono')}
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={edit?.hasKey ? 'Saved. Type to replace it.' : (preset.keyPlaceholder ?? '')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="API key"
          />
        </label>
        {ownAddress && (
          <label className="block">
            <span className="mb-1 block text-[0.86rem] text-text-2">Address</span>
            <input className={cn(inputCls, 'font-mono')} placeholder="https://example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Address of the service" autoComplete="off" />
            <span className="mt-1 block text-[0.8rem] text-text-3">The part before “/chat/completions”; it usually ends in /v1.</span>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[0.86rem] text-text-2">Name in Maris</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name in Maris" />
        </label>
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[0.86rem] text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner className="size-3.5" /> : <KeyRound size={15} />} {busy ? 'Reading its models…' : edit ? 'Save and check' : 'Connect'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {preset.keyUrl && (
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-[0.84rem] text-petal underline" onClick={() => void api.shell.openExternal(preset.keyUrl!)}>
              <ExternalLink size={13} /> Where do I get a key?
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
