import { Cloud, Cpu, Feather, Gauge, MemoryStick, Power, ShieldCheck, Thermometer, Zap } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { gb, prettyModel } from '../lib/format'
import { useApp } from '../store'
import { cn, Tip } from './ui'
import { IS_MAC, IS_WIN } from '../lib/platform'
import { KIND_SHORT } from '@shared/approval'
import { autoApproveSummary, AutoApprovePopover, useAutoApprove } from './AutoApprove'
import { VramSeg } from './VramDetails'

const BUSY_WORD = { idle: 'Idle', light: 'Light load', busy: 'Busy', heavy: 'Heavy load' } as const
const STARTED = Date.now()

function Seg({ icon, children, tip, tone, onClick }: { icon: ReactNode; children: ReactNode; tip: ReactNode; tone?: 'warn' | 'live'; onClick?: () => void }) {
  const cls = cn(
    'tabular inline-flex h-full items-center gap-1.5 px-2.5 text-[0.76rem] whitespace-nowrap',
    tone === 'warn' ? 'text-danger' : tone === 'live' ? 'text-pollen' : 'text-text-2',
    onClick && 'hover:bg-sunken'
  )
  return (
    <Tip label={tip} side="top">
      {onClick ? (
        <button className={cls} onClick={onClick}>
          {icon}
          {children}
        </button>
      ) : (
        <span tabIndex={0} className={cls}>
          {icon}
          {children}
        </span>
      )}
    </Tip>
  )
}

function Bar({ value, ours }: { value: number; ours?: number }) {
  return (
    <span className="relative inline-block h-1.5 w-14 overflow-hidden rounded-full bg-sunken" aria-hidden>
      {ours !== undefined && <span className="absolute inset-y-0 left-0 bg-petal" style={{ width: `${Math.min(100, ours * 100)}%` }} />}
      <span
        className="absolute inset-y-0 bg-text-3/60"
        style={{ left: `${Math.min(100, (ours ?? 0) * 100)}%`, width: `${Math.max(0, Math.min(100, (value - (ours ?? 0)) * 100))}%` }}
      />
    </span>
  )
}

/** Always-visible system metrics: CPU, RAM, GPU, VRAM, temperature and what Maris has loaded. */
/** First in the bar while changes are approved without asking; opens the panel to change that. */
function AutoApproveSeg() {
  const currentId = useApp((st) => st.currentId)
  const view = useApp((st) => st.view)
  const conversationId = view === 'chat' ? currentId : undefined
  const a = useAutoApprove(conversationId)
  // Project rules only matter inside their Code-mode chat, which shows its own reminder.
  const global = a.everything || a.inSession || a.kinds.length > 0
  if (!global) return null
  const strong = a.everything || a.inSession
  return (
    <AutoApprovePopover conversationId={conversationId}>
      <button
        className={cn(
          'tabular inline-flex h-full shrink-0 items-center gap-1.5 px-2.5 text-[0.76rem] font-medium whitespace-nowrap hover:bg-sunken',
          strong ? 'text-danger' : 'text-petal'
        )}
        aria-label={`Approving without asking: ${autoApproveSummary(a)}. Change`}
      >
        <ShieldCheck size={12} aria-hidden />
        {a.everything ? 'Approving everything' : a.inSession ? 'Approving all in this chat' : `Auto-approve: ${a.kinds.map((k) => KIND_SHORT[k]).join(', ')}`}
      </button>
    </AutoApprovePopover>
  )
}

export function StatusBar() {
  const s = useApp((st) => st.status)
  const show = useApp((st) => st.settings?.ui.status)
  const apiModels = useApp((st) => st.models.filter((m) => m.provider && !m.capabilities.includes('embedding')).length)
  const setView = useApp((st) => st.setView)
  const openModels = useApp((st) => st.openModels)
  const [starting, setStarting] = useState(false)
  if (!s) return <footer className="h-7 shrink-0 border-t border-line bg-side" />
  const g = s.gpu
  const total = g?.memTotalMB || 1
  const used = g?.memUsedMB ?? 0
  // Maris's share: its language models and its picture engine (everything the monitor does not count as other programs).
  const ours = Math.max(0, used - Math.min(used, s.external.vramMB))
  const loaded = s.ollama.loaded
  const working = s.activeJobs.llm > 0 || s.activeJobs.media > 0
  return (
    <footer
      className="flex h-7 shrink-0 items-stretch divide-x divide-line overflow-x-auto overflow-y-hidden border-t border-line bg-side [scrollbar-width:none]"
      aria-label="System status"
    >
      <AutoApproveSeg />
      <Seg icon={<Cpu size={12} aria-hidden />} tip="Processor (CPU): how busy it is right now, across all cores. Maris uses it for small helper models and when the graphics card is busy.">
        CPU {Math.round(s.cpuLoad * 100)}%
        <Bar value={s.cpuLoad} />
      </Seg>
      {show?.ram !== false && (
        <Seg icon={<MemoryStick size={12} aria-hidden />} tip="System memory (RAM) used by all programs. Models that do not fit on the graphics card also run from here, more slowly.">
          RAM {gb(s.ramUsedMB)} / {gb(s.ramTotalMB)}
        </Seg>
      )}
      {g ? (
        <>
          <Seg icon={<Gauge size={12} aria-hidden />} tip={`${g.name}: how busy the graphics card is. When games or renders push this up, Maris switches to smaller models.`} tone={g.utilization > 85 ? 'live' : undefined}>
            GPU {g.utilization}%
            <Bar value={g.utilization / 100} />
          </Seg>
          {show?.vram !== false && <VramSeg s={s} g={g} bar={<Bar value={used / total} ours={ours / total} />} />}
          {show?.temp !== false && g.temperatureC !== undefined && (
            <Seg icon={<Thermometer size={12} aria-hidden />} tip="Graphics card temperature. Up to about 83°C is normal under load." tone={g.temperatureC >= 83 ? 'warn' : undefined}>
              {g.temperatureC}°C
            </Seg>
          )}
          {show?.power !== false && g.powerW !== undefined && (
            <Seg icon={<Zap size={12} aria-hidden />} tip="How much power the graphics card draws right now.">
              {Math.round(g.powerW)} W
            </Seg>
          )}
        </>
      ) : (
        <Seg icon={<Gauge size={12} aria-hidden />} tip={IS_WIN ? 'Live GPU readings need an NVIDIA driver (nvidia-smi) or Windows GPU counters' : IS_MAC ? 'Live GPU readings come from macOS for Apple chips' : 'Live GPU readings need the NVIDIA driver (nvidia-smi) or an AMD card'}>
          {Date.now() - STARTED < 15000 ? 'GPU …' : 'GPU not detected'}
        </Seg>
      )}
      <span className="min-w-0 flex-1" />
      {s.lite && (
        <Seg
          icon={<Feather size={12} aria-hidden />}
          tip="Low-power mode is on: short instructions, only the tools a request needs and a plain interface, so a small model answers as quickly as this computer allows. Click to change it in Settings → Engine."
          onClick={() => setView('settings')}
        >
          Low-power
        </Seg>
      )}
      {!s.ollama.up && s.ollama.installed === false ? (
        // No Ollama on this computer: fine when API models do the work, otherwise the place to start.
        <Seg
          icon={<Cloud size={12} aria-hidden />}
          tip={apiModels ? 'No models run on this computer: answers come from the API services you added in Models → API.' : 'No model is set up yet. Run the setup assistant, or add an API key in Models → API.'}
          onClick={() => openModels(apiModels ? 'api' : 'text')}
        >
          {apiModels ? `${apiModels} API model${apiModels === 1 ? '' : 's'}` : 'No models yet'}
        </Seg>
      ) : s.ollama.up ? (
        (show?.load !== false || show?.models !== false) && <Seg
          icon={<span className={cn('size-1.5 rounded-full', working ? 'animate-pulse bg-pollen' : loaded.length ? 'bg-petal' : 'bg-text-3')} aria-hidden />}
          tip={
            <span className="whitespace-pre-line">
              <span className="block font-medium">What Maris is doing, and the models in memory</span>
              {s.comfy.job?.conversationId ? <span className="block text-petal">Click to open the chat that is making it.</span> : null}
              {loaded.length
                ? loaded
                    .map((m) => `${prettyModel(m.name)}: ${gb(m.vramBytes / 2 ** 20)} on GPU${m.vramBytes < m.sizeBytes ? `, ${gb((m.sizeBytes - m.vramBytes) / 2 ** 20)} in RAM` : ''}`)
                    .join('\n')
                : 'No language model is loaded right now'}
            </span>
          }
          tone={working ? 'live' : undefined}
          onClick={s.comfy.job?.conversationId ? () => void useApp.getState().open(s.comfy.job!.conversationId!) : undefined}
        >
          <span className="max-w-72 truncate">
            {show?.load !== false ? (s.activeJobs.media ? 'Generating media' : working ? 'Working' : BUSY_WORD[s.busy]) : ''}
            {show?.models !== false && loaded.length ? `${show?.load !== false ? ', ' : ''}${loaded.map((m) => prettyModel(m.name)).join(', ')} loaded` : ''}
            {show?.load === false && (show?.models === false || !loaded.length) ? 'Ollama running' : ''}
          </span>
        </Seg>
      ) : (
        <button
          className="inline-flex items-center gap-1.5 px-3 text-[0.76rem] font-medium text-danger hover:bg-danger-soft"
          disabled={starting}
          onClick={async () => {
            setStarting(true)
            await api.models.ensureOllama()
            setStarting(false)
          }}
        >
          <Power size={12} /> {starting ? 'Starting Ollama…' : 'Ollama is stopped. Start it'}
        </button>
      )}
    </footer>
  )
}
