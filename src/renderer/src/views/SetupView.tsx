import {
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  Layers,
  MemoryStick,
  Minus,
  MonitorCog,
  Package,
  RefreshCw,
  Sparkles,
  X,
  Zap
} from 'lucide-react'
import { Switch as RSwitch } from 'radix-ui'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { budgetOf, defaultPrefs, diskFor, diskName, makePlan, ROLE_TEXT } from '@shared/recommend'
import type { CatalogModel, PcScan, Placement, PlanItem, Processing, SetupPrefs, SetupProgress, SetupRole, SetupTask } from '@shared/types'
import { api, type PackInfo } from '../lib/api'
import { MarisMark } from '../components/MarisMark'
import { PreviewSlider } from '../components/ModelPreviews'
import { Term, withTerms } from '../components/Term'
import { Button, cn, Spinner } from '../components/ui'
import { useApp } from '../store'
import { DEVICE } from '../lib/platform'

type Step = 'scan' | 'pc' | 'models' | 'install'
const STEPS: { id: Step; title: string; hint: string }[] = [
  { id: 'scan', title: 'Scan', hint: `What this ${DEVICE} has` },
  { id: 'pc', title: `This ${DEVICE}`, hint: 'Where models run' },
  { id: 'models', title: 'Models', hint: 'Text, images, video' },
  { id: 'install', title: 'Install', hint: 'Download and finish' }
]

const gb = (mb: number): string => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`
const gbDec = (v: number): string => `${v >= 10 ? Math.round(v) : v.toFixed(1)} GB`

interface Catalog {
  llms: CatalogModel[]
  packs: PackInfo[]
  installed: string[]
  dataDir: string
}

// ------------------------------------------------------------------ pieces

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-[22px] w-[40px] shrink-0 rounded-full border border-line-strong bg-sunken transition-colors data-[state=checked]:border-petal-strong data-[state=checked]:bg-petal-strong"
    >
      <RSwitch.Thumb className="block size-[14px] translate-x-[3px] rounded-full bg-text-2 transition-transform data-[state=checked]:translate-x-[21px] data-[state=checked]:bg-on-petal" />
    </RSwitch.Root>
  )
}

/** How a model sits in memory: the violet part is on the GPU, the golden part in system RAM. */
function FitBar({ p, vramMB, ramMB }: { p: Placement; vramMB: number; ramMB: number }) {
  const onGpu = p.where === 'gpu' ? p.needMB : p.where === 'hybrid' ? p.needMB * p.gpuShare : 0
  const inRam = p.where === 'cpu' ? p.needMB : p.where === 'hybrid' ? p.needMB - onGpu : 0
  const cpu = p.where === 'cpu'
  const scale = Math.max(1, cpu ? Math.max(ramMB, p.needMB) : Math.max(vramMB, p.needMB))
  const text =
    p.where === 'gpu'
      ? `On the GPU · ${gb(p.needMB)} of ${gb(vramMB)}`
      : p.where === 'hybrid'
        ? `${Math.round(p.gpuShare * 100)}% GPU · ${gb(inRam)} from RAM`
        : p.where === 'cpu'
          ? `CPU · ${gb(p.needMB)} of RAM`
          : (p.note ?? 'Does not fit')
  return (
    <div className="min-w-0">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
        {onGpu > 0 && <span className="absolute inset-y-0 left-0 bg-petal" style={{ width: `${(onGpu / scale) * 100}%` }} />}
        {inRam > 0 && (
          <span
            className={cn('absolute inset-y-0', cpu ? 'bg-text-3/70' : 'bg-pollen')}
            style={{
              left: `${(onGpu / scale) * 100}%`,
              width: `${(inRam / scale) * 100}%`,
              backgroundImage: cpu ? undefined : 'repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.35) 3px 5px)'
            }}
          />
        )}
        {p.where === 'none' && <span className="absolute inset-0 bg-danger/40" />}
      </div>
      <p className={cn('mt-1 text-[0.76rem]', p.where === 'none' ? 'text-danger' : 'text-text-3')}>{withTerms(text, 1)}</p>
    </div>
  )
}

function Stat({ icon, title, value, detail, delay, shown }: { icon: ReactNode; title: string; value?: ReactNode; detail?: ReactNode; delay: number; shown: boolean }) {
  return (
    <li
      className={cn('flex items-start gap-3 rounded-xl border border-line bg-raised/70 px-4 py-3 transition-all duration-500', shown ? 'opacity-100' : 'opacity-60')}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', shown ? 'bg-petal-soft text-petal' : 'bg-sunken text-text-3')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.8rem] text-text-3">{title}</span>
        {shown ? (
          <>
            <span className="block truncate text-[0.98rem] font-medium text-text">{value}</span>
            {detail && <span className="block text-[0.82rem] text-text-2">{detail}</span>}
          </>
        ) : (
          <span className="live block text-[0.95rem]">Checking…</span>
        )}
      </span>
      {shown && <Check size={16} className="mt-1 shrink-0 text-ok" aria-label="done" />}
    </li>
  )
}

function TaskIcon({ t }: { t: SetupTask }) {
  if (t.status === 'running') return <Spinner className="size-4" />
  if (t.status === 'done') return <Check size={16} className="text-ok" aria-label="done" />
  if (t.status === 'error') return <AlertTriangle size={16} className="text-danger" aria-label="failed" />
  if (t.status === 'skipped') return <Minus size={16} className="text-text-3" aria-label="skipped" />
  return <span className="block size-3 rounded-full border-2 border-line-strong" aria-label="waiting" />
}

// ------------------------------------------------------------------ the assistant

export function SetupView() {
  const settings = useApp((s) => s.settings)
  const close = useApp((s) => s.closeSetup)
  const refreshModels = useApp((s) => s.refreshModels)
  const reduceMotion = useApp((s) => s.settings?.ui.reduceMotion ?? false)
  const [step, setStep] = useState<Step>('scan')
  const [scan, setScan] = useState<PcScan>()
  const [catalog, setCatalog] = useState<Catalog>()
  const [revealed, setRevealed] = useState(0)
  const [scanError, setScanError] = useState<string>()
  const [prefs, setPrefs] = useState<SetupPrefs>()
  const [overrides, setOverrides] = useState<Partial<Record<SetupRole, string | null>>>({})
  const [progress, setProgress] = useState<SetupProgress>()
  const heading = useRef<HTMLHeadingElement>(null)
  const firstRun = !settings?.onboarded

  const runScan = async (): Promise<void> => {
    setScan(undefined)
    setRevealed(0)
    setScanError(undefined)
    try {
      const [s, c] = await Promise.all([api.setup.scan(), api.setup.catalog()])
      setCatalog(c)
      setScan(s)
      setPrefs((p) => p ?? defaultPrefs(s, c.dataDir))
    } catch (e) {
      setScanError((e as Error).message)
    }
  }

  useEffect(() => {
    const off = api.setup.onProgress(setProgress)
    void api.setup.progress().then((p) => {
      if (p.running) {
        setProgress(p)
        setStep('install')
      }
    })
    void runScan()
    return off
  }, [])

  // Reveal scan results one at a time: the single orchestrated moment of the assistant.
  useEffect(() => {
    if (!scan) return
    if (reduceMotion) return setRevealed(6)
    let i = 0
    const t = setInterval(() => {
      i++
      setRevealed(i)
      if (i >= 6) clearInterval(t)
    }, 170)
    return () => clearInterval(t)
  }, [scan, reduceMotion])

  useEffect(() => {
    heading.current?.focus()
  }, [step])

  const plan = useMemo(() => {
    if (!scan || !catalog || !prefs) return undefined
    return makePlan({ scan, llms: catalog.llms, packs: catalog.packs, installed: catalog.installed, prefs, overrides })
  }, [scan, catalog, prefs, overrides])

  const previews = useMemo(() => {
    if (!scan || !catalog || !prefs) return undefined
    const out = {} as Record<Processing, PlanItem | undefined>
    for (const proc of ['gpu', 'hybrid', 'cpu'] as Processing[]) {
      const p = makePlan({ scan, llms: catalog.llms, packs: catalog.packs, installed: catalog.installed, prefs: { ...prefs, processing: proc } })
      out[proc] = p.items.find((i) => i.role === 'max')
    }
    return out
  }, [scan, catalog, prefs])

  const finish = async (): Promise<void> => {
    if (!settings?.onboarded) await api.setup.skip()
    void refreshModels(true)
    close()
  }

  const install = (): void => {
    if (!plan) return
    setStep('install')
    setProgress({ running: true, done: false, tasks: [] })
    void api.setup.apply(plan).catch((e: Error) => setProgress((p) => ({ running: false, done: true, tasks: p?.tasks ?? [], error: e.message })))
  }

  const b = scan ? budgetOf(scan) : undefined
  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const disk = (dir?: string) => (scan && dir ? diskFor(scan.disks, dir) : undefined)

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-paper"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Maris"
      onKeyDown={(e) => {
        // Escape closes a re-run (the first run is skipped explicitly instead).
        if (e.key === 'Escape' && !firstRun && !progress?.running && !(e.target instanceof HTMLSelectElement)) close()
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: 'radial-gradient(900px 520px at 12% -10%, var(--petal-soft), transparent 70%), radial-gradient(700px 420px at 100% 110%, var(--pollen-soft), transparent 70%)' }}
        aria-hidden
      />
      <div className="drag relative h-11 shrink-0" />
      <div className="relative flex min-h-0 flex-1">
        {/* steps */}
        <aside className="hidden w-64 shrink-0 flex-col px-7 pb-8 md:flex">
          <MarisMark size={40} bloom={step === 'scan'} />
          <p className="mt-4 font-display text-[1.45rem] leading-tight font-light text-text">Set up Maris</p>
          <p className="mt-1 text-[0.86rem] leading-relaxed text-text-2">Models chosen for this {DEVICE}. You can change everything later in Settings.</p>
          <ol className="mt-8 space-y-1" aria-label="Setup steps">
            {STEPS.map((s, i) => {
              const done = i < stepIndex
              const active = i === stepIndex
              return (
                <li key={s.id} className={cn('flex items-center gap-3 rounded-lg px-2 py-2', active && 'bg-petal-soft')} aria-current={active ? 'step' : undefined}>
                  <span
                    className={cn(
                      'tabular flex size-7 shrink-0 items-center justify-center rounded-full border text-[0.8rem] font-semibold',
                      done ? 'border-ok/50 bg-ok-soft text-ok' : active ? 'border-petal bg-petal text-on-petal' : 'border-line-strong text-text-3'
                    )}
                  >
                    {done ? <Check size={14} /> : i + 1}
                  </span>
                  <span>
                    <span className={cn('block text-[0.92rem]', active ? 'font-medium text-text' : 'text-text-2')}>{s.title}</span>
                    <span className="block text-[0.76rem] text-text-3">{s.hint}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          <div className="mt-auto">
            {step !== 'install' &&
              (firstRun ? (
                <button onClick={() => void finish()} className="text-[0.84rem] text-text-3 underline-offset-4 hover:text-text hover:underline">
                  Skip setup for now
                </button>
              ) : null)}
          </div>
        </aside>

        {/* content */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          {!firstRun && (step !== 'install' || !progress?.running) && (
            <button
              onClick={close}
              aria-label="Close setup"
              className="absolute top-1 right-6 z-10 inline-flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-sunken hover:text-text"
            >
              <X size={18} />
            </button>
          )}
          <div className="mx-auto max-w-[880px] px-8 pb-28">
            {/* ------------------------------------------------ scan */}
            {step === 'scan' && (
              <section>
                <h1 ref={heading} tabIndex={-1} className="font-display text-[2.1rem] leading-tight font-light text-text outline-none">
                  {scan ? `Here is what this ${DEVICE} has` : `Looking at this ${DEVICE}…`}
                </h1>
                <p className="mt-2 max-w-[60ch] text-[0.98rem] leading-relaxed text-text-2">
                  Maris reads your graphics card, memory and disks to pick models that run well here. Nothing is installed or changed until you approve the plan.
                </p>
                <ul className="mt-7 grid gap-3 sm:grid-cols-2" aria-live="polite">
                  <Stat
                    icon={<MonitorCog size={16} />}
                    title="Graphics"
                    delay={0}
                    shown={revealed >= 1}
                    value={scan?.gpu ? scan.gpu.name : 'No dedicated GPU'}
                    detail={
                      scan?.gpu
                        ? `${gb(scan.gpu.vramMB)} ${scan.gpu.unified ? 'of shared memory' : 'VRAM'} · ${scan.gpu.integrated ? 'integrated' : scan.gpu.llm === 'cuda' ? 'CUDA' : scan.gpu.llm === 'rocm' ? 'ROCm' : scan.gpu.llm === 'vulkan' ? 'Vulkan' : scan.gpu.llm === 'metal' ? `Metal${scan.gpu.cores ? `, ${scan.gpu.cores} cores` : ''}` : 'not supported'}${scan.gpus.length > 1 ? ` · ${scan.gpus.length} adapters` : ''}`
                        : 'Models will run on the CPU'
                    }
                  />
                  <Stat icon={<Cpu size={16} />} title="Processor" delay={0} shown={revealed >= 2} value={scan?.cpu.name} detail={scan && `${scan.cpu.cores} cores · ${scan.cpu.threads} threads${scan.laptop ? ' · laptop' : ''}`} />
                  <Stat
                    icon={<MemoryStick size={16} />}
                    title="Memory"
                    delay={0}
                    shown={revealed >= 3}
                    value={scan && `${Math.round(scan.ram.totalMB / 1024)} GB${scan.ram.type ? ` ${scan.ram.type}` : ''}`}
                    detail={scan && `${scan.ram.speedMTs ? `${scan.ram.speedMTs} MT/s · ` : ''}≈${scan.ram.bandwidthGBs} GB/s · ${gb(scan.ram.freeMB)} free now`}
                  />
                  <Stat
                    icon={<HardDrive size={16} />}
                    title="Storage"
                    delay={0}
                    shown={revealed >= 4}
                    value={scan && (scan.disks.length ? scan.disks.map((d) => `${diskName(d)} ${gbDec(d.freeGB)}`).join(' · ') : 'No fixed drives found')}
                    detail="Free space per drive"
                  />
                  <Stat
                    icon={<Sparkles size={16} />}
                    title="Language engine"
                    delay={0}
                    shown={revealed >= 5}
                    value={scan && (scan.ollama.running ? `Ollama ${scan.ollama.version ?? ''}` : scan.ollama.installed ? 'Ollama (not running)' : 'Ollama is not installed')}
                    detail={scan && (scan.ollama.installed ? `${scan.ollama.models.length} model${scan.ollama.models.length === 1 ? '' : 's'} installed` : 'Setup installs it for you')}
                  />
                  <Stat
                    icon={<Package size={16} />}
                    title="Image and video engine"
                    delay={0}
                    shown={revealed >= 6}
                    value={scan && (scan.comfy.installed ? 'ComfyUI installed' : 'ComfyUI is not installed')}
                    detail={scan && (scan.comfy.installed ? scan.comfy.dir : `Setup can install the ${scan.gpu?.comfy && scan.gpu.comfy !== 'none' ? scan.gpu.comfy.replace('_', ' ').toUpperCase() : 'CPU-capable'} build`)}
                  />
                </ul>
                {scanError && (
                  <p role="alert" className="mt-5 flex items-center gap-2 text-[0.9rem] text-danger">
                    <AlertTriangle size={16} /> The scan failed: {scanError}
                  </p>
                )}
                {scan?.notes.map((n) => (
                  <p key={n} className="mt-3 text-[0.86rem] text-text-2">
                    {n}
                  </p>
                ))}
                <Footer>
                  <Button variant="ghost" onClick={() => void runScan()} disabled={!scan && !scanError}>
                    <RefreshCw size={14} /> Scan again
                  </Button>
                  <Button variant="primary" disabled={!scan || revealed < 6} onClick={() => setStep('pc')}>
                    Continue <ArrowRight size={15} />
                  </Button>
                </Footer>
              </section>
            )}

            {/* ------------------------------------------------ this PC */}
            {step === 'pc' && scan && prefs && b && (
              <section>
                <h1 ref={heading} tabIndex={-1} className="font-display text-[2.1rem] leading-tight font-light text-text outline-none">
                  Where should models run?
                </h1>
                <p className="mt-2 max-w-[62ch] text-[0.98rem] leading-relaxed text-text-2">
                  Your {scan.gpu && !scan.gpu.integrated ? `${scan.gpu.name} has ${gb(scan.gpu.vramMB)} of video memory` : `${DEVICE} has no supported graphics card`} and the system has {Math.round(scan.ram.totalMB / 1024)} GB of RAM. Pick how Maris uses them.
                </p>
                <div className="mt-6 grid gap-3 lg:grid-cols-3" role="radiogroup" aria-label="Where models run">
                  {(
                    [
                      { id: 'gpu', title: 'GPU only', icon: Zap, line: 'Fastest. Every model fits fully in video memory.', needsGpu: true },
                      { id: 'hybrid', title: 'GPU + CPU', icon: Layers, line: 'Bigger, smarter models. What does not fit in VRAM runs from RAM, so they answer slower.', needsGpu: true },
                      { id: 'cpu', title: 'CPU only', icon: Cpu, line: b.llmGpu ? 'No graphics card needed and the GPU stays free for games. The slowest option.' : 'Every model runs on the processor. Answers take longer than on a GPU.', needsGpu: false }
                    ] as const
                  ).map((o) => {
                    const disabled = o.needsGpu && !b.llmGpu
                    const active = prefs.processing === o.id && !disabled
                    const preview = previews?.[o.id]
                    const opt = preview?.options.find((x) => x.id === preview.pick)
                    return (
                      <button
                        key={o.id}
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        onClick={() => {
                          setPrefs({ ...prefs, processing: o.id })
                          setOverrides({})
                        }}
                        className={cn(
                          'flex flex-col items-start rounded-2xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                          active ? 'border-petal bg-petal-soft' : 'border-line bg-raised/70 hover:border-line-strong'
                        )}
                      >
                        <span className="flex w-full items-center gap-2">
                          <o.icon size={17} className={active ? 'text-petal' : 'text-text-2'} aria-hidden />
                          <span className="text-[1.02rem] font-medium text-text">{o.title}</span>
                          {active && <Check size={16} className="ml-auto text-petal" aria-hidden />}
                        </span>
                        <span className="mt-1.5 text-[0.86rem] leading-snug text-text-2">{disabled ? 'Needs a supported graphics card.' : o.line}</span>
                        {!disabled && opt && (
                          <span className="mt-3 w-full border-t border-line pt-2.5 text-[0.8rem] text-text-2">
                            <span className="block text-text-3">Strongest model</span>
                            <span className="block truncate font-medium text-text">{opt.label}</span>
                            <span className="tabular block">{opt.placement.speed}</span>
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                <div className="mt-6 divide-y divide-line rounded-2xl border border-line bg-raised/70 px-5">
                  <div className="flex items-center justify-between gap-6 py-3.5">
                    <span>
                      <span className="block text-[0.95rem] text-text">Image generation</span>
                      <span className="block text-[0.84rem] text-text-2">
                        {!b.mediaGpu || prefs.processing === 'cpu' ? 'Small pictures with a model that runs on the processor, about a minute each.' : 'Pictures from a description, in seconds on the GPU.'}
                      </span>
                    </span>
                    <Toggle label="Image generation" checked={prefs.images} onChange={(v) => setPrefs({ ...prefs, images: v })} />
                  </div>
                  <div className="flex items-center justify-between gap-6 py-3.5">
                    <span>
                      <span className="block text-[0.95rem] text-text">Video generation</span>
                      <span className="block text-[0.84rem] text-text-2">{b.mediaGpu ? 'Short clips from text or a picture. Takes minutes per clip.' : 'Needs a supported graphics card.'}</span>
                    </span>
                    <Toggle label="Video generation" checked={prefs.video && b.mediaGpu} onChange={(v) => setPrefs({ ...prefs, video: v && b.mediaGpu })} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5">
                    <span className="min-w-0">
                      <span className="block text-[0.95rem] text-text">Data folder</span>
                      <span className="block text-[0.84rem] text-text-2">
                        Image and video models and your creations.{' '}
                        {disk(prefs.dataDir) ? `${diskName(disk(prefs.dataDir)!)} has ${gbDec(disk(prefs.dataDir)!.freeGB)} free.` : ''}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="max-w-72 truncate rounded-md bg-sunken px-2 py-1 text-[0.82rem] text-text-2">{prefs.dataDir}</code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const p = await api.settings.pickFolder(prefs.dataDir)
                          if (p) setPrefs({ ...prefs, dataDir: p })
                        }}
                      >
                        <FolderOpen size={14} /> Change
                      </Button>
                    </span>
                  </div>
                </div>
                <Footer>
                  <Button variant="ghost" onClick={() => setStep('scan')}>
                    <ArrowLeft size={15} /> Back
                  </Button>
                  <Button variant="primary" onClick={() => setStep('models')}>
                    See recommended models <ArrowRight size={15} />
                  </Button>
                </Footer>
              </section>
            )}

            {/* ------------------------------------------------ models */}
            {step === 'models' && plan && b && scan && (
              <section>
                <h1 ref={heading} tabIndex={-1} className="font-display text-[2.1rem] leading-tight font-light text-text outline-none">
                  Recommended for this {DEVICE}
                </h1>
                <p className="mt-2 max-w-[64ch] text-[0.98rem] leading-relaxed text-text-2">
                  <Term id="tier">Auto</Term> sends each message to Fast, Balanced or Max depending on how hard it is and how busy your {DEVICE} is. Swap any model; the bars show how it fits in{' '}
                  <Term id="vram">video memory</Term>
                  <span className="mx-1 inline-block size-2 rounded-full bg-petal align-middle" aria-hidden />
                  and <Term id="ram">system RAM</Term>
                  <span className="mx-1 inline-block size-2 rounded-full bg-pollen align-middle" aria-hidden />.
                </p>
                {(
                  [
                    ['Language models', plan.items.filter((i) => i.kind === 'llm')],
                    ['Images', plan.items.filter((i) => i.role === 'imageFast' || i.role === 'imageQuality')],
                    ['Video', plan.items.filter((i) => i.role === 'videoFast' || i.role === 'videoQuality')]
                  ] as const
                ).map(([title, items]) => {
                  const off = (title === 'Images' && !plan.prefs.images) || (title === 'Video' && !plan.prefs.video)
                  return (
                    <div key={title} className="mt-6">
                      <h2 className="mb-2 flex items-center gap-2 text-[0.86rem] font-semibold text-text-2">
                        {title}
                        {off && <span className="font-normal text-text-3">· switched off on the previous step</span>}
                      </h2>
                      {!off && (
                        <div className="divide-y divide-line rounded-2xl border border-line bg-raised/70">
                          {items.map((item) => (
                            <PlanRow
                              key={item.role}
                              item={item}
                              vramMB={item.kind === 'media' ? b.vramGB * 1024 : b.vramMB}
                              ramMB={b.ramMB}
                              onPick={(id) => setOverrides((o) => ({ ...o, [item.role]: id }))}
                              overridden={overrides[item.role] !== undefined}
                              onReset={() =>
                                setOverrides((o) => {
                                  const { [item.role]: _gone, ...rest } = o
                                  return rest
                                })
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {plan.warnings.length > 0 && (
                  <ul className="mt-5 space-y-1.5">
                    {plan.warnings.map((w) => (
                      <li key={w} className="flex items-start gap-2 text-[0.86rem] text-text-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pollen" aria-hidden /> {w}
                      </li>
                    ))}
                  </ul>
                )}
                <Footer>
                  <span className="mr-auto text-[0.86rem] text-text-2">
                    {plan.downloadGB > 0 ? (
                      <>
                        <span className="tabular font-medium text-text">{plan.downloadGB} GB</span> to download
                      </>
                    ) : (
                      'Everything is already installed'
                    )}
                  </span>
                  <Button variant="ghost" onClick={() => setStep('pc')}>
                    <ArrowLeft size={15} /> Back
                  </Button>
                  <Button variant="primary" onClick={install}>
                    {plan.downloadGB > 0 ? (
                      <>
                        <Download size={15} /> Install and finish
                      </>
                    ) : (
                      <>
                        Finish <Check size={15} />
                      </>
                    )}
                  </Button>
                </Footer>
              </section>
            )}

            {/* ------------------------------------------------ install */}
            {step === 'install' && (
              <section>
                <h1 ref={heading} tabIndex={-1} className="font-display text-[2.1rem] leading-tight font-light text-text outline-none">
                  {progress?.done ? (progress.error ? 'Almost there' : 'Maris is ready') : 'Setting things up…'}
                </h1>
                <p className="mt-2 max-w-[62ch] text-[0.98rem] leading-relaxed text-text-2">
                  {progress?.done
                    ? (progress.error ?? 'Everything is installed. Auto now picks between your models for every message.')
                    : 'Downloads run one at a time. You can start using Maris now; anything still downloading keeps going in the background.'}
                </p>
                <ul className="mt-6 divide-y divide-line rounded-2xl border border-line bg-raised/70" aria-live="polite">
                  {(progress?.tasks ?? []).map((t) => (
                    <li key={t.id} className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <span className="flex size-5 items-center justify-center">
                          <TaskIcon t={t} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-[0.95rem]', t.status === 'queued' ? 'text-text-2' : 'text-text')}>{t.label}</span>
                          {(t.error || t.detail) && <span className={cn('block truncate text-[0.8rem]', t.error ? 'text-danger' : 'text-text-3')}>{t.error ?? t.detail}</span>}
                        </span>
                        {t.total ? (
                          <span className="tabular shrink-0 text-[0.8rem] text-text-3">
                            {t.status === 'done' ? gbDec(t.total / 1e9) : `${gbDec((t.received ?? 0) / 1e9)} of ${gbDec(t.total / 1e9)}`}
                          </span>
                        ) : null}
                      </div>
                      {t.status === 'running' && t.total ? (
                        <div className="mt-2 ml-8 h-1.5 overflow-hidden rounded-full bg-sunken">
                          <div className="h-full rounded-full bg-petal transition-[width] duration-500" style={{ width: `${Math.min(100, ((t.received ?? 0) / t.total) * 100)}%` }} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                  {!progress?.tasks.length && (
                    <li className="flex items-center gap-3 px-5 py-4 text-[0.92rem] text-text-2">
                      <Spinner /> Preparing…
                    </li>
                  )}
                </ul>
                <Footer>
                  {progress?.running && (
                    <Button variant="ghost" onClick={() => void api.setup.cancel()}>
                      Stop downloads
                    </Button>
                  )}
                  {progress?.done && progress.error && (
                    <Button variant="ghost" onClick={() => setStep('models')}>
                      <ArrowLeft size={15} /> Review the plan
                    </Button>
                  )}
                  <Button variant="primary" onClick={() => void finish()}>
                    {progress?.done ? 'Start using Maris' : 'Use Maris while this finishes'} <ArrowRight size={15} />
                  </Button>
                </Footer>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="fixed right-0 bottom-0 left-0 z-10 border-t border-line bg-paper/90 backdrop-blur md:left-64">
      <div className="mx-auto flex max-w-[880px] items-center justify-end gap-2 px-8 py-3.5">{children}</div>
    </div>
  )
}

const NONE = '__none__'

function PlanRow({
  item,
  vramMB,
  ramMB,
  onPick,
  overridden,
  onReset
}: {
  item: PlanItem
  vramMB: number
  ramMB: number
  onPick: (id: string | null) => void
  overridden: boolean
  onReset: () => void
}) {
  const t = ROLE_TEXT[item.role]
  const chosen = item.options.find((o) => o.id === item.pick)
  const [examples, setExamples] = useState(false)
  const optional = item.role === 'code' || item.role === 'imageQuality' || item.role === 'videoQuality' || item.kind === 'media'
  const leaveOutLabel = item.role === 'code' ? 'Use the Max model' : item.role === 'imageQuality' || item.role === 'videoQuality' ? 'Use the fast model' : 'Leave out'
  const where = (o: (typeof item.options)[number]): string =>
    o.placement.where === 'gpu' ? 'GPU' : o.placement.where === 'hybrid' ? `${Math.round(o.placement.gpuShare * 100)}% GPU` : o.placement.where === 'cpu' ? 'CPU' : 'too big'
  return (
    <div className="grid gap-x-6 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="text-[0.98rem] font-medium text-text">{t.title}</p>
        <p className="text-[0.82rem] text-text-2">{t.hint}</p>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <select
            aria-label={`${t.title} model`}
            value={item.pick ?? NONE}
            onChange={(e) => onPick(e.target.value === NONE ? null : e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-raised px-3 py-2 text-[0.92rem] text-text focus:border-petal focus:outline-none"
          >
            {(optional || !item.pick) && <option value={NONE}>{item.pick ? leaveOutLabel : optional ? leaveOutLabel : 'Nothing fits'}</option>}
            {item.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} — {o.sizeGB} GB · {where(o)} · {o.placement.speed}
                {o.installed ? ' · installed' : ''}
              </option>
            ))}
          </select>
          {overridden && (
            <Button variant="ghost" size="sm" onClick={onReset} aria-label={`Use the recommended ${t.title} model`}>
              <RefreshCw size={13} /> Recommended
            </Button>
          )}
        </div>
        {chosen ? (
          <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
            <FitBar p={chosen.placement} vramMB={vramMB} ramMB={ramMB} />
            <span className="tabular text-right text-[0.8rem]">
              <span className="block font-medium text-text">{chosen.placement.speed}</span>
              <span className={cn('block', chosen.installed ? 'text-ok' : 'text-text-3')}>{chosen.installed ? 'Installed' : `${chosen.sizeGB} GB download`}</span>
            </span>
          </div>
        ) : null}
        <p className="mt-1.5 text-[0.8rem] leading-snug text-text-2">{withTerms(item.reason, 1)}</p>
        {item.kind === 'media' && chosen && (
          <>
            <button
              className="mt-2 inline-flex items-center gap-1 text-[0.82rem] text-petal hover:underline"
              aria-expanded={examples}
              onClick={() => setExamples(!examples)}
            >
              <ChevronRight size={13} className={cn('transition-transform', examples && 'rotate-90')} aria-hidden />
              {examples ? 'Hide examples' : `See what ${chosen.label} makes`}
            </button>
            {examples && (
              <PreviewSlider
                packId={chosen.id}
                kind={item.role === 'videoFast' || item.role === 'videoQuality' ? 'video' : 'image'}
                modelName={chosen.label}
                className="mt-2 max-w-[22rem]"
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
