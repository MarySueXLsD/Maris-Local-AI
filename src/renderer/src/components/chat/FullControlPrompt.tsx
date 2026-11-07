import { Check, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { DEVICE, IS_WIN, REMOTE } from '../../lib/platform'
import { useApp } from '../../store'
import { Button } from '../ui'

/**
 * Maris asked for full control of this PC (request_full_control): a button to turn it on right here,
 * then one to let Maris carry on. Only the person can turn it on; the assistant cannot change it itself.
 */
export function FullControlPrompt({ reason, latest }: { reason: string; latest: boolean }) {
  const on = useApp((s) => Boolean(s.settings?.agent.fullControl))
  const running = useApp((s) => Object.values(s.running).some(Boolean))
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (dismissed) return null
  return (
    <div role="group" aria-label="Maris asks for full control" className="mt-2 space-y-2.5 rounded-xl border border-petal/50 bg-petal-soft p-3.5">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-petal" aria-hidden />
        <div className="min-w-0">
          <p className="text-[0.95rem] font-medium text-text">{on ? `Full control of this ${DEVICE} is on` : `Maris asks for full control of this ${DEVICE}`}</p>
          <p className="mt-0.5 text-[0.86rem] text-text">{reason}</p>
          <p className="mt-1 text-[0.8rem] text-text-2">
            Full control lets Maris run things as administrator ({IS_WIN ? 'Windows asks with its permission prompt' : 'the system asks for your password'}) and use the mouse and keyboard in other programs. Every action still waits for your approval. You can turn it off in Settings → {DEVICE} access.
          </p>
        </div>
      </div>
      {latest && !REMOTE && (
        <div className="flex flex-wrap items-center gap-2">
          {on ? (
            <Button
              variant="primary"
              size="sm"
              disabled={running || busy}
              onClick={async () => {
                setBusy(true)
                const s = useApp.getState()
                await s.send('Full control is on now. Please continue.', [], s.settings?.agent.defaultThink ?? 'auto', s.settings?.web.enabled ?? true).catch(() => undefined)
                setBusy(false)
              }}
            >
              <Check size={15} /> Continue the task
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await api.settings.set({ agent: { fullControl: true } }).catch(() => undefined)
                  setBusy(false)
                }}
              >
                <ShieldCheck size={15} /> Turn on full control
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
                Not now
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
