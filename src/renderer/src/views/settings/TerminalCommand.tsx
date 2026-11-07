import { SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TerminalCommandStatus } from '@shared/types'
import { Spinner, Switch } from '../../components/ui'
import { api } from '../../lib/api'
import { IS_MAC, IS_WIN } from '../../lib/platform'

const EXAMPLES: [string, string][] = [
  ['maris', 'chat in the terminal'],
  ['maris "how much space is left on C:?"', 'ask once'],
  ['maris code .', 'work on the current folder'],
  ['git diff | maris "write a commit message"', 'use the output of another command'],
  ['maris image "a red fox in fresh snow"', 'make a picture']
]

/** Settings → Window and startup: the maris command for Terminal, PowerShell and Command Prompt. */
export function TerminalCommand() {
  const [st, setSt] = useState<TerminalCommandStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    void api.cli.status().then(setSt).catch(() => setSt({ supported: false, installed: false }))
  }, [])

  const shells = IS_WIN ? 'Terminal, PowerShell or Command Prompt' : IS_MAC ? 'Terminal' : 'your terminal'
  return (
    <section className="mt-6 rounded-xl border border-line bg-raised/60 px-4 py-3" aria-labelledby="terminal-command-title">
      <h3 id="terminal-command-title" className="flex items-center gap-2 text-[0.98rem] font-medium text-text">
        <SquareTerminal size={16} className="text-petal" aria-hidden /> Terminal command
      </h3>
      <p className="mt-0.5 text-[0.86rem] text-text-2">
        Type <code className="rounded bg-code px-1 font-mono text-[0.82rem]">maris</code> in {shells} to chat with Maris there. It uses the same models, memory and approvals as this
        window, and its chats show up here too.
      </p>
      {!st ? (
        <Spinner className="mt-3 size-4" />
      ) : !st.supported ? (
        <p className="mt-3 text-[0.86rem] text-text-3">{st.note}</p>
      ) : (
        <>
          <div className="mt-1">
            <Switch
              checked={st.installed}
              disabled={busy || st.scope === 'machine'}
              label={IS_WIN ? 'Add maris to PATH' : `Install maris in ${st.location?.replace(/\/maris$/, '')}`}
              description={
                busy ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="size-3" /> Changing…
                  </span>
                ) : st.scope === 'machine' ? (
                  'Added for everyone on this PC by the installer. Run the installer again to change it.'
                ) : st.installed ? (
                  `On. ${IS_WIN ? `${st.location} is on your PATH.` : `The command is ${st.location}.`}`
                ) : (
                  'Off.'
                )
              }
              onChange={(on) => {
                setBusy(true)
                setError('')
                void api.cli
                  .set(on)
                  .then((next) => {
                    setSt(next)
                    setChanged(true)
                  })
                  .catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')))
                  .finally(() => setBusy(false))
              }}
            />
          </div>
          {st.note && <p className="text-[0.82rem] text-text-3">{st.note}</p>}
          {changed && st.installed && <p className="text-[0.82rem] text-ok">Open a new terminal window to use it; windows that are already open keep the old PATH.</p>}
          {error && <p className="text-[0.84rem] text-danger">{error}</p>}
          <ul className="mt-2 space-y-1 border-t border-line pt-2.5" aria-label="Examples">
            {EXAMPLES.map(([cmd, what]) => (
              <li key={cmd} className="flex flex-wrap items-baseline gap-x-3 text-[0.84rem]">
                <code className="selectable rounded bg-code px-1.5 py-0.5 font-mono text-[0.8rem] text-text">{cmd}</code>
                <span className="text-text-3">{what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.8rem] text-text-3">
            Inside a chat, <code className="font-mono">/help</code> lists the commands. Maris asks before changing anything: press y to allow, n to deny.
          </p>
        </>
      )}
    </section>
  )
}
