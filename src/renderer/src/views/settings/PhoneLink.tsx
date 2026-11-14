import { Check, Globe, Smartphone, Trash2, Wifi, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { renderSVG } from 'uqr'
import type { LinkStatus } from '@shared/types'
import { api } from '../../lib/api'
import { timeAgo } from '../../lib/format'
import { DEVICE } from '../../lib/platform'
import { Button } from '../../components/ui'

/** Settings → Phone: pair the Android app and manage paired phones. */
export function PhoneLink() {
  const [status, setStatus] = useState<LinkStatus>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [confirm, setConfirm] = useState<string>()

  useEffect(() => {
    void api.link.status().then(setStatus)
    return api.link.onStatus(setStatus)
  }, [])

  const pairing = status?.pairing
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pairing])

  // The code as a QR code. Black on white whatever the theme, so phone cameras read it.
  const qr = useMemo(() => (pairing ? renderSVG(pairing.url, { ecc: 'M', border: 2, pixelSize: 5, whiteColor: '#ffffff', blackColor: '#000000' }) : ''), [pairing])

  if (!status) return null
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
  const relay = status.relay
  const anywhere = relay?.state === 'online'
  const act = (p: Promise<LinkStatus>): void => {
    setError('')
    void p.then(setStatus).catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')))
  }

  return (
    <div className="mt-5 space-y-5">
      <div>
        <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">Pair a phone</h3>
        <div className="rounded-xl border border-line bg-raised/60 p-4">
          {!status.enabled ? (
            <p className="text-[0.9rem] text-text-2">Turn on “Allow the phone app to connect” above, then pair your phone here.</p>
          ) : status.error ? (
            <p className="text-[0.9rem] text-danger" role="alert">
              {status.error}
            </p>
          ) : pairing && left > 0 ? (
            <div className="flex flex-wrap items-start gap-6">
              <div
                className="shrink-0 overflow-hidden rounded-lg bg-white p-1 [&>svg]:h-[184px] [&>svg]:w-[184px]"
                role="img"
                aria-label="QR code for pairing"
                dangerouslySetInnerHTML={{ __html: qr }}
              />
              <div className="min-w-[16rem] flex-1">
                <ol className="list-decimal space-y-1.5 pl-5 text-[0.9rem] text-text-2">
                  <li>
                    {anywhere
                      ? `Open Maris on your Android phone. It can be on the same Wi-Fi as this ${DEVICE}, or anywhere with internet.`
                      : `Open Maris on your Android phone. It must be on the same Wi-Fi as this ${DEVICE}.`}
                  </li>
                  <li>
                    Tap <b className="text-text">Scan code</b> and point the camera here, or type the address and code below.
                  </li>
                </ol>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.9rem]">
                  <dt className="text-text-2">Address</dt>
                  <dd className="selectable font-mono text-text">
                    {status.addresses.length ? `${status.addresses[0]}:${status.port}` : 'No network connection found'}
                    {status.addresses.length > 1 && (
                      <span className="block text-[0.8rem] text-text-3">Also: {status.addresses.slice(1, 3).map((a) => `${a}:${status.port}`).join(', ')}</span>
                    )}
                  </dd>
                  <dt className="text-text-2">Code</dt>
                  <dd className="selectable font-mono text-[1.35rem] font-semibold tracking-[0.12em] text-text">{pairing.code}</dd>
                </dl>
                <p className="mt-2 text-[0.82rem] text-text-3" aria-live="off">
                  The code works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
                </p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => act(api.link.cancelPairing())}>
                  <X size={14} /> Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-[56ch] text-[0.9rem] text-text-2">
                The phone app shows the same chats, approvals and creations as this {DEVICE}. Pairing uses a one-time code; after that, everything between
                the phone and this {DEVICE} is encrypted.
              </p>
              <Button variant="primary" size="sm" onClick={() => act(api.link.startPairing())}>
                <Smartphone size={14} /> Pair a phone
              </Button>
            </div>
          )}
          {error && (
            <p className="mt-2 text-[0.85rem] text-danger" role="alert">
              {error}
            </p>
          )}
          {status.enabled && status.running && (
            <p className="mt-3 flex items-center gap-1.5 text-[0.8rem] text-text-3">
              <Wifi size={13} aria-hidden /> If the phone cannot connect, allow Maris through this {DEVICE}’s firewall for private networks.
            </p>
          )}
          {relay && (
            <p className={`mt-1.5 flex items-center gap-1.5 text-[0.8rem] ${relay.state === 'unreachable' || !relay.url ? 'text-pollen' : 'text-text-3'}`} role="status">
              <Globe size={13} aria-hidden />
              {!relay.url
                ? 'Connect from anywhere needs a relay address: Maris does not have its own relay yet. Enter one under Relay address above, or turn Connect from anywhere off.'
                : relay.state === 'online'
                  ? 'Connected to the relay: paired phones reach Maris from anywhere. The relay passes encrypted messages on and cannot read them.'
                  : relay.state === 'unreachable'
                    ? `Cannot reach the relay right now${relay.error ? ` (${relay.error})` : ''}. Maris keeps trying; on this network phones still connect directly.`
                    : 'Connecting to the relay…'}
            </p>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-[0.8rem] font-semibold text-text-2">Paired phones</h3>
        <div className="divide-y divide-line rounded-xl border border-line bg-raised/60 px-4">
          {status.devices.length === 0 && <p className="py-3 text-[0.9rem] text-text-2">No phones yet.</p>}
          {status.devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[0.95rem] text-text">
                  <Smartphone size={15} aria-hidden /> {d.name}
                  {d.online && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-petal-soft px-2 py-0.5 text-[0.75rem] text-text">
                      <Check size={11} aria-hidden /> {d.via === 'relay' ? 'Connected through the relay' : 'Connected'}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[0.82rem] text-text-2">
                  Paired {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastSeen ? ` · last used ${timeAgo(d.lastSeen)}` : ''}
                </span>
              </span>
              {confirm === d.id ? (
                <span className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => act(api.link.removeDevice(d.id))}>
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(undefined)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" aria-label={`Remove ${d.name}`} onClick={() => setConfirm(d.id)}>
                  <Trash2 size={14} /> Remove
                </Button>
              )}
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[0.8rem] text-text-3">A removed phone can no longer connect, even if it still has the app.</p>
      </div>
    </div>
  )
}
