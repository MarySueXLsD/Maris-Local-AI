import { Rocket } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState } from 'react'
import { api } from '../lib/api'
import { IS_MAC, IS_WIN } from '../lib/platform'
import { useApp } from '../store'
import { Button, Tip } from './ui'

/** What "Restart and update" does on this system. */
export const UPDATE_HOW = IS_WIN
  ? 'Maris closes, updates itself in about a minute with no setup windows to click through, and opens again. Your chats, memories, models and settings stay. If Maris is installed for all users, Windows asks for permission once.'
  : IS_MAC
    ? 'The new version opens as a disk image: drag Maris into Applications to replace this one. Your chats, memories, models and settings stay.'
    : 'Maris restarts on the new version (a .deb or .rpm installation asks for your password first). Your chats, memories, models and settings stay.'

/** What Maris is in the middle of, in words; undefined while it is idle. */
function busyWords(): string | undefined {
  const s = useApp.getState()
  const answers = Object.values(s.running).filter(Boolean).length
  const media = s.status?.activeJobs.media ?? 0
  const parts: string[] = []
  if (answers) parts.push(answers === 1 ? 'writing an answer' : `writing ${answers} answers`)
  if (media) parts.push(media === 1 ? 'making a picture or video' : `making ${media} pictures or videos`)
  return parts.length ? parts.join(' and ') : undefined
}

/**
 * Installs the update Maris downloaded and checked in the background. Asks first while Maris is still
 * working, because restarting stops that work.
 */
export function RestartToUpdate({ pill, version }: { pill?: boolean; version?: string }) {
  const [ask, setAsk] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const go = async (): Promise<void> => {
    setAsk(undefined)
    setBusy(true)
    setError(undefined)
    try {
      await api.updates.install()
      // Windows and Linux close Maris now; macOS shows the disk image and Maris keeps running.
      if (IS_MAC) setBusy(false)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
      setBusy(false)
    }
  }
  const click = (): void => {
    const w = busyWords()
    if (w) setAsk(w)
    else void go()
  }
  const label = IS_MAC ? 'Install the update' : 'Restart and update'
  return (
    <>
      {pill ? (
        <Tip label={error ?? `Maris ${version ?? ''} is downloaded and checked. ${UPDATE_HOW}`} side="right">
          <button
            onClick={click}
            disabled={busy}
            className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-lg bg-petal-soft px-2.5 text-[0.86rem] font-medium text-text ring-1 ring-petal/50 transition-colors hover:bg-petal-strong hover:text-on-petal disabled:opacity-60"
          >
            <Rocket size={15} className="shrink-0 text-petal" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">{busy ? 'Updating…' : IS_MAC ? 'Install the update' : 'Restart to update'}</span>
            {version && <span className="tabular text-[0.72rem] text-text-2">{version}</span>}
          </button>
        </Tip>
      ) : (
        <Button variant="primary" size="sm" onClick={click} disabled={busy}>
          <Rocket size={14} /> {busy ? 'Updating…' : label}
        </Button>
      )}
      {error && !pill && <span className="self-center text-[0.84rem] text-danger">{error}</span>}
      {ask && (
        <Dialog.Root open onOpenChange={(o) => !o && setAsk(undefined)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
              <Dialog.Title className="text-[1.1rem] font-semibold text-text">Restart while Maris is working?</Dialog.Title>
              <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">
                Maris is still {ask}. Restarting to update stops that now. You can also wait and restart when it is done.
              </Dialog.Description>
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost">Wait</Button>
                </Dialog.Close>
                <Button variant="primary" onClick={() => void go()}>
                  <Rocket size={14} /> Restart anyway
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  )
}
