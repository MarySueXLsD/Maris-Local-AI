import { Laptop, Loader2, QrCode, RefreshCw, Unlink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MarisMark } from '../src/components/MarisMark'
import { forgetPairing, LinkError, pair, parseAddress, savePairing, type Pairing } from './link'
import { canScan, launchUrl, onOpenUrl, parsePairLink, phoneName, scanCode } from './native'

const field =
  'h-12 w-full rounded-xl border border-line-strong bg-raised px-3.5 text-[1rem] text-text outline-none placeholder:text-text-3 focus:border-petal focus:ring-2 focus:ring-petal-soft'

/** First start of the phone app: connect it to Maris on a computer. */
export function PairScreen({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState(phoneName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scanner, setScanner] = useState(false)

  const connect = async (hosts: string[], port: number, c: string, relay?: { url: string; room: string }): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const p = await pair({ hosts, port, code: c, name: name.trim() || 'Android phone', relay })
      savePairing(p)
      onPaired(p)
    } catch (e) {
      setError(e instanceof LinkError || e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const fromLink = (url: string | undefined): void => {
    const p = url ? parsePairLink(url) : undefined
    if (!p) return
    if (p.hosts[0]) setAddress(`${p.hosts[0]}:${p.port}`)
    setCode(p.code)
    // A code with the relay in it pairs from anywhere: through the relay when the computer is not on this network.
    void connect(p.hosts, p.port, p.code, p.relay)
  }

  useEffect(() => {
    void canScan().then(setScanner)
    void launchUrl().then(fromLink)
    onOpenUrl(fromLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (): void => {
    const a = parseAddress(address)
    if (!a) return setError('Type the address shown on the computer, for example 192.168.1.20:7341.')
    if (code.replace(/[^0-9a-z]/gi, '').length < 12) return setError('The code has 12 letters and numbers, for example K7QM-2XZ4-9PVR.')
    void connect([a.host], a.port, code)
  }

  return (
    <main className="flex min-h-full flex-col items-center overflow-y-auto bg-paper px-5 pt-10 pb-8">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3">
          <MarisMark size={44} bloom />
          <div>
            <h1 className="font-display text-[1.6rem] font-light leading-tight text-text">Connect to your computer</h1>
            <p className="text-[0.92rem] text-text-2">Maris runs on your computer. This app lets you use it from your phone.</p>
          </div>
        </div>

        <ol className="mt-6 list-decimal space-y-1.5 pl-5 text-[0.95rem] text-text-2">
          <li>On the computer, open Maris → Settings → Phone.</li>
          <li>Turn on “Allow the phone app to connect” and choose “Pair a phone”.</li>
          <li>{scanner ? 'Scan the code it shows, or type the address and code below.' : 'Type the address and code it shows.'}</li>
        </ol>

        {scanner && (
          <button
            disabled={busy}
            onClick={() => void scanCode().then(fromLink).catch((e: Error) => setError(e.message))}
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-petal-strong text-[1rem] font-medium text-on-petal disabled:opacity-60"
          >
            <QrCode size={18} /> Scan code
          </button>
        )}

        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[0.85rem] text-text-2">Address</span>
            <input className={field} inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="192.168.1.20:7341" value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[0.85rem] text-text-2">Code</span>
            <input
              className={`${field} font-mono tracking-[0.12em] uppercase`}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[0.85rem] text-text-2">Name of this phone</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[0.9rem] text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[1rem] font-medium disabled:opacity-60 ${scanner ? 'border border-line-strong text-text' : 'bg-petal-strong text-on-petal'}`}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Laptop size={18} />} {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
        <p className="mt-5 text-[0.82rem] leading-relaxed text-text-3">
          The phone and the computer must be on the same Wi-Fi. The code works once; after pairing, everything between them is encrypted.
        </p>
      </div>
    </main>
  )
}

/** The paired computer cannot be reached (it is off, asleep, or on another network). */
export function OfflineScreen({ pairing, message, onRetry }: { pairing: Pairing; message: string; onRetry: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-paper px-6 text-center">
      <MarisMark size={48} />
      <h1 className="mt-4 font-display text-[1.45rem] font-light text-text">Can’t reach {pairing.hostName}</h1>
      <p className="mt-2 max-w-sm text-[0.95rem] text-text-2">{message}</p>
      <p className="mt-2 max-w-sm text-[0.88rem] text-text-3">
        Make sure the computer is on and awake, Maris is open there, and this phone is on the same Wi-Fi.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true)
          onRetry()
        }}
        className="mt-6 flex h-12 w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-petal-strong font-medium text-on-petal disabled:opacity-60"
      >
        <RefreshCw size={18} className={busy ? 'animate-spin' : ''} /> Try again
      </button>
      <button
        onClick={() => {
          forgetPairing()
          location.reload()
        }}
        className="mt-3 flex h-11 items-center gap-2 rounded-xl px-4 text-[0.92rem] text-text-2"
      >
        <Unlink size={16} /> Pair with a computer again
      </button>
    </main>
  )
}
