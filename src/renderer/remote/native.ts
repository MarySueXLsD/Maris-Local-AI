// Android-side helpers, used only in the phone app. All of them do nothing in a plain browser.
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'

/** Google's code scanner (Play services), wrapped by MarisScanner in the Android project. */
const Scanner = registerPlugin<{ scan(): Promise<{ text?: string; cancelled?: boolean }>; available(): Promise<{ available: boolean }> }>('MarisScanner')

export const isNative = (): boolean => Capacitor.isNativePlatform()

export async function canScan(): Promise<boolean> {
  if (!isNative()) return false
  try {
    return (await Scanner.available()).available
  } catch {
    return false
  }
}

/** Scan a QR code; undefined when the person cancels. */
export async function scanCode(): Promise<string | undefined> {
  const r = await Scanner.scan()
  return r.cancelled ? undefined : r.text
}

/** The maris://pair link the app was opened with (from a QR code scanned with the camera app). */
export async function launchUrl(): Promise<string | undefined> {
  if (!isNative()) return new URLSearchParams(location.search).get('pair') ?? undefined
  try {
    return (await App.getLaunchUrl())?.url
  } catch {
    return undefined
  }
}

export function onOpenUrl(cb: (url: string) => void): void {
  if (isNative()) void App.addListener('appUrlOpen', (e) => cb(e.url))
}

/** Android's back gesture: close what is open, otherwise send the app to the background. */
export function onBack(handler: () => boolean): void {
  if (!isNative()) return
  void App.addListener('backButton', () => {
    if (!handler()) void App.minimizeApp()
  })
}

/** The phone's model name from the user agent ("Pixel 8"), as a default name for pairing. */
export function phoneName(): string {
  const m = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(navigator.userAgent)
  const model = m?.[1]?.trim()
  return model && !/^K$/.test(model) ? model : 'Android phone'
}

/** Parse maris://pair?h=192.168.1.20,10.0.0.5&p=7341&c=ABCD-EFGH-JKMN&n=DESKTOP */
export function parsePairLink(url: string): { hosts: string[]; port: number; code: string; name?: string } | undefined {
  try {
    const u = new URL(url.replace(/^maris:\/\//i, 'http://maris/'))
    const hosts = (u.searchParams.get('h') ?? '').split(',').map((h) => h.trim()).filter(Boolean)
    const code = u.searchParams.get('c') ?? ''
    if (!hosts.length || !code) return undefined
    return { hosts, port: Number(u.searchParams.get('p')) || 7341, code, name: u.searchParams.get('n') ?? undefined }
  } catch {
    return undefined
  }
}
