import { Clapperboard, Image as ImageIcon, Square, Zap, Gem } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MediaProgress } from '@shared/types'
import { api } from '../../lib/api'
import { cn, Tip } from '../ui'

function secs(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m} min ${r} s` : `${m} min`
}

/**
 * A picture or video being made for the chat: which model, how far along, about how long is left, a way
 * to stop it, and other installed models to switch to (it then starts again with that one).
 */
export function MediaProgressCard({ m }: { m: MediaProgress }) {
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState('')
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.round((now - m.startedAt) / 1000))
  const sampling = m.status === 'running' && m.progress > 0.01
  const Icon = m.kind === 'image' ? ImageIcon : Clapperboard
  const verb = m.kind === 'image' ? 'Drawing' : 'Rendering'
  const stage = m.switchedTo
    ? 'Switching to the other model…'
    : m.status === 'queued'
      ? 'Waiting for the picture engine to finish another job'
      : m.status === 'preparing'
        ? (m.step ?? 'Getting ready')
        : sampling
          ? (m.step ?? `${verb}`)
          : (m.step ?? `Loading ${m.model}`)
  const left = m.etaSec !== undefined && m.etaSec > 0 ? `about ${secs(m.etaSec)} left` : ''
  return (
    <div className="mt-1.5 rounded-xl border border-line bg-raised/70 px-3.5 py-3" role="group" aria-label={`${verb} with ${m.model}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Icon size={15} className="shrink-0 text-petal" aria-hidden />
        <span className="text-[0.9rem] text-text">
          {verb} with <span className="font-medium">{m.model}</span>
        </span>
        <span className="tabular ml-auto text-[0.8rem] text-text-2" aria-live="polite">
          {sampling ? `${Math.round(m.progress * 100)}%` : ''}
          {sampling && left ? ' · ' : ''}
          {left}
        </span>
        <Tip label={`Stop making this ${m.kind === 'image' ? 'picture' : 'video'}`}>
          <button
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-[0.8rem] text-text-2 hover:border-line-strong hover:text-text disabled:opacity-50"
            disabled={busy !== ''}
            onClick={() => {
              setBusy('stop')
              void api.media.cancel(m.jobId)
            }}
          >
            <Square size={11} className="fill-current" aria-hidden /> Stop
          </button>
        </Tip>
      </div>
      <div className={cn('mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-sunken', !sampling && 'animate-pulse')} role="progressbar" aria-label="Progress" aria-valuenow={Math.round(m.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-petal transition-[width] duration-700" style={{ width: `${sampling ? Math.max(3, Math.round(m.progress * 100)) : 4}%` }} />
      </div>
      <p className="tabular mt-1.5 text-[0.78rem] text-text-3">
        {stage} · {secs(elapsed)} so far
        {m.expectedSec && !sampling ? ` · usually about ${secs(m.expectedSec)} in all` : ''}
      </p>
      {m.alternatives && m.alternatives.length > 0 && !m.switchedTo && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 text-[0.8rem]">
          <span className="text-text-3">Use another model instead:</span>
          {m.alternatives.map((a) => (
            <Tip key={a.packId} label={a.faster ? `Start again with ${a.name}: faster, a little less detail` : `Start again with ${a.name}: slower, more detail`}>
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-text-2 hover:border-petal hover:text-text disabled:opacity-50"
                disabled={busy !== ''}
                onClick={() => {
                  setBusy(a.packId)
                  void api.media.switch(m.jobId, a.packId)
                }}
              >
                {a.faster ? <Zap size={12} aria-hidden /> : <Gem size={12} aria-hidden />}
                {a.name}
                <span className="text-text-3">{a.faster ? 'faster' : 'more detail'}</span>
              </button>
            </Tip>
          ))}
        </div>
      )}
    </div>
  )
}
