import { ChevronRight, ExternalLink, Pencil, Plug, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ConnectorInfo, ConnectorPreset } from '@shared/extensions'
import { Button, cn, inputCls, PageHeader, RowToggle, Section, Spinner, Switch } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../store'

const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

const STATUS: Record<ConnectorInfo['status'], { word: string; cls: string }> = {
  off: { word: 'Off', cls: 'bg-text-3' },
  connecting: { word: 'Connecting…', cls: 'bg-pollen' },
  ready: { word: 'Connected', cls: 'bg-ok' },
  error: { word: 'Problem', cls: 'bg-danger' }
}

/** Connectors: outside services Maris can use, through the Model Context Protocol. */
export function ConnectorsView() {
  const enabled = useApp((s) => s.settings?.extensions.connectors ?? true)
  const update = useApp((s) => s.updateSettings)
  const [list, setList] = useState<ConnectorInfo[]>()
  const [presets, setPresets] = useState<ConnectorPreset[]>([])
  const [form, setForm] = useState<{ preset: ConnectorPreset; edit?: ConnectorInfo }>()
  const page = useRef<HTMLDivElement>(null)
  /** The form opens at the top of the page: bring it into view. */
  const openForm = (f: { preset: ConnectorPreset; edit?: ConnectorInfo }): void => {
    setForm(f)
    page.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }
  // Services you already connected leave the list (edit them above); your own servers can be added again and again.
  const available = presets.filter((p) => p.id.startsWith('custom') || !(list ?? []).some((c) => c.preset === p.id))

  useEffect(() => {
    void api.connectors.list().then(setList)
    void api.connectors.presets().then(setPresets)
    return api.connectors.onChange(setList)
  }, [])

  return (
    <div ref={page} className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[920px] px-5 pb-16 sm:px-8">
        <PageHeader
          title="Connectors"
          description="Let Maris work with services you use, such as GitHub, Notion or Home Assistant. Looking things up runs freely; anything that changes something in a service waits for your approval."
        />
        <div className="mb-5 rounded-xl border border-line bg-raised/60 px-4">
          <Switch checked={enabled} onChange={(v) => void update({ extensions: { connectors: v } })} label="Let Maris use connectors" description="Off: all connectors disconnect, and their keys stay saved." />
        </div>

        {form && <ConnectorForm key={`${form.preset.id}:${form.edit?.id ?? 'new'}`} preset={form.preset} edit={form.edit} onClose={() => setForm(undefined)} />}

        <Section title="Your connectors">
          {!list ? (
            <Spinner className="size-4" />
          ) : list.length === 0 ? (
            <p className="flex items-center gap-2 text-[0.9rem] text-text-2">
              <Plug size={16} aria-hidden /> None yet. Add one below.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {list.map((c) => (
                <ConnectorRow key={c.id} c={c} onEdit={() => openForm({ preset: presets.find((p) => p.id === c.preset)!, edit: c })} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Add a connector" description="Hosted services only need a key. Those marked “Needs Node.js” run a small program on this computer (install Node.js from nodejs.org first).">
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
                  {p.name}
                  {p.needsNode && <span className="ml-auto rounded-full bg-sunken px-2 py-0.5 text-[0.72rem] font-normal text-text-2">Needs Node.js</span>}
                </span>
                <span className="text-[0.84rem] leading-snug text-text-2">{p.description}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[0.8rem] text-text-3">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden /> Keys are stored on this computer with the system keychain and are never shown again. Give each service only the access you
            want Maris to have.
          </p>
        </Section>
      </div>
    </div>
  )
}

function ConnectorRow({ c, onEdit }: { c: ConnectorInfo; onEdit: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const st = STATUS[c.status]
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button className="rounded p-0.5 text-text-3 hover:text-text" aria-expanded={open} aria-label={open ? `Hide tools of ${c.name}` : `Show tools of ${c.name}`} onClick={() => setOpen(!open)}>
          <ChevronRight size={16} className={cn('transition-transform', open && 'rotate-90')} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.98rem] font-medium text-text">{c.name}</span>
          <span className="flex items-center gap-1.5 text-[0.8rem] text-text-2">
            <span className={cn('size-1.5 rounded-full', st.cls)} aria-hidden />
            {st.word}
            {c.status === 'ready' && ` · ${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`}
          </span>
        </span>
        <RowToggle checked={c.enabled} onChange={(v) => api.connectors.setEnabled(c.id, v)} label={`Use ${c.name}`} />
      </div>
      {c.status === 'error' && c.error && <p className="mt-2 ml-8 rounded-lg bg-danger-soft px-3 py-2 text-[0.84rem] text-danger">{c.error}</p>}
      {open && (
        <div className="mt-2 ml-8">
          {c.tools.length > 0 ? (
            <ul className="space-y-1 text-[0.84rem]">
              {c.tools.map((t) => (
                <li key={t.name} className="flex gap-2">
                  <span className={cn('shrink-0 rounded px-1.5 text-[0.72rem] leading-5', t.readOnly ? 'bg-sunken text-text-2' : 'bg-pollen-soft text-text')}>{t.readOnly ? 'reads' : 'asks first'}</span>
                  <span>
                    <b className="font-medium text-text">{t.name}</b> <span className="text-text-2">{t.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.84rem] text-text-2">No tools yet.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void api.connectors.reconnect(c.id).finally(() => setBusy(false))
              }}
            >
              {busy ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />} Reconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil size={14} /> Edit
            </Button>
            {confirm ? (
              <>
                <Button size="sm" variant="danger" onClick={() => void api.connectors.remove(c.id)}>
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
            )}
          </div>
        </div>
      )}
    </li>
  )
}

function ConnectorForm({ preset, edit, onClose }: { preset: ConnectorPreset; edit?: ConnectorInfo; onClose: () => void }) {
  const [name, setName] = useState(edit?.name ?? preset.name)
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(edit?.values ?? {}) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const list = edit ? await api.connectors.edit(edit.id, values, name) : await api.connectors.add(preset.id, values, name)
      const mine = edit ? list.find((c) => c.id === edit.id) : list[list.length - 1]
      if (mine?.status === 'error') setError(`Saved, but it could not connect: ${mine.error}`)
      else onClose()
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mb-6 rounded-2xl border border-petal/50 bg-raised p-4 shadow-float" aria-label={`Connect ${preset.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[1.1rem] font-semibold text-text">
            {edit ? 'Edit' : 'Connect'} {preset.name}
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
          <span className="mb-1 block text-[0.86rem] text-text-2">Name in Maris</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!edit} />
        </label>
        {preset.fields.map((f) => {
          const saved = Boolean(edit?.savedFields.includes(f.key))
          const common = {
            className: cn(inputCls, f.secret && 'font-mono'),
            placeholder: f.secret && saved ? 'Saved. Type to replace it.' : f.placeholder,
            value: values[f.key] ?? '',
            autoComplete: 'off',
            'aria-label': f.label
          }
          return (
            <label key={f.key} className="block">
              <span className="mb-1 block text-[0.86rem] text-text-2">
                {f.label}
                {f.optional && <span className="text-text-3"> (optional)</span>}
              </span>
              {f.multiline ? (
                <textarea {...common} rows={3} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              ) : (
                <input {...common} type={f.secret ? 'password' : 'text'} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              )}
              {f.help && <span className="mt-1 block text-[0.8rem] text-text-3">{f.help}</span>}
            </label>
          )
        })}
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[0.86rem] text-danger">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner className="size-3.5" /> : <Plug size={15} />} {edit ? 'Save and reconnect' : 'Connect'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {preset.docs && (
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-[0.84rem] text-petal underline" onClick={() => void api.shell.openExternal(preset.docs!)}>
              <ExternalLink size={13} /> Where do I get this?
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
