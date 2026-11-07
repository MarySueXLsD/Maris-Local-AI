// Entry point of the phone app (Android). It connects to Maris on a computer over Maris Link, then
// runs the same interface as the desktop app with a `maris` API that goes over the network.
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../src/styles.css'
import { createRemoteApi } from './api'
import { forgetPairing, LinkClient, LinkError, loadPairing, type Pairing } from './link'
import { onBack } from './native'
import { OfflineScreen, PairScreen } from './PairScreen'

document.documentElement.dataset.chrome = 'none'
document.documentElement.dataset.noMica = ''
let root: Root | undefined
const mount = (): Root => (root ??= createRoot(document.getElementById('root')!))

async function start(pairing: Pairing): Promise<void> {
  const client = new LinkClient(pairing)
  try {
    await client.connect()
  } catch (e) {
    if (e instanceof LinkError && e.kind === 'unpaired') {
      forgetPairing()
      showPair('This phone was removed on the computer. Pair it again.')
      return
    }
    mount().render(<OfflineScreen pairing={pairing} message={(e as Error).message} onRetry={() => void start(loadPairing() ?? pairing)} />)
    return
  }
  ;(window as unknown as { maris: unknown }).maris = createRemoteApi(client)
  // Events missed while the connection was down: start fresh once it is back.
  client.startEvents(() => location.reload())
  window.addEventListener('maris-link-unpaired', () => {
    forgetPairing()
    location.reload()
  })
  client.onState((s) => {
    document.documentElement.dataset.link = s
  })
  // A refused request because of the clock: say so instead of failing quietly.
  window.addEventListener('maris-link-clock', (e) => {
    const store = (window as unknown as { __marisStore?: { setState(s: { error: string }): void } }).__marisStore
    store?.setState({ error: (e as CustomEvent<string | undefined>).detail ?? "The phone's clock differs from the computer's. Check the time on both." })
  })
  root?.unmount()
  root = undefined
  // The desktop interface, unchanged: it reads window.maris when its modules load.
  const { bootApp } = await import('./boot')
  bootApp()
  onBack(() => {
    const store = (window as unknown as { __marisStore?: { getState(): { sidebarOpen: boolean; toggleSidebar(): void; view: string; setView(v: string): void } } }).__marisStore
    const s = store?.getState()
    if (!s) return false
    if (s.sidebarOpen && window.innerWidth < 768) {
      s.toggleSidebar()
      return true
    }
    if (s.view !== 'chat') {
      s.setView('chat')
      return true
    }
    return false
  })
}

function showPair(message?: string): void {
  mount().render(
    <StrictMode>
      <PairScreen
        onPaired={(p) => {
          void start(p)
        }}
      />
      {message && <p className="sr-only" role="status">{message}</p>}
    </StrictMode>
  )
}

const saved = loadPairing()
if (saved) void start(saved)
else showPair()
