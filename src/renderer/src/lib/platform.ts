// The computer's operating system and the keyboard of the device in front of the user.
// No imports, so pure modules (settings schema, glossary) can use the same facts in unit tests.

export type OsPlatform = 'win32' | 'darwin' | 'linux'

const bridge = (globalThis as { maris?: { platform?: OsPlatform; remote?: boolean } }).maris

/** The operating system of the computer Maris runs on (in the phone app: the linked computer). */
export const PLATFORM: OsPlatform = bridge?.platform ?? 'win32'
export const IS_WIN = PLATFORM === 'win32'
export const IS_MAC = PLATFORM === 'darwin'
export const OS_NAME = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
export const SHELL_NAME = IS_WIN ? 'PowerShell' : IS_MAC ? 'zsh' : 'bash'
/** "PC" or "Mac", for sentences like "on your PC". */
export const DEVICE = IS_MAC ? 'Mac' : 'PC'
/** Where deleted files go. */
export const TRASH = IS_WIN ? 'Recycle Bin' : 'Trash'
/** True in the phone app. */
export const REMOTE = Boolean(bridge?.remote)

/** Keyboard shortcuts follow the device in front of the user (⌘ on a Mac). */
export const MAC_KEYS =
  typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad/.test(navigator.userAgent)

/** A touch screen without a mouse (the phone app): keyboard shortcut hints are left out. */
export const TOUCH = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: none) and (pointer: coarse)').matches)

/** The main shortcut modifier is held: ⌘ on a Mac, Ctrl elsewhere. */
export const modKey = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => (MAC_KEYS ? e.metaKey : e.ctrlKey)

/** Shortcut label, e.g. keys('N') → "Ctrl+N" or "⌘N"; keys('Space', true) → "Ctrl+Shift+Space" or "⌘⇧Space". */
export function keys(key: string, shift = false): string {
  return MAC_KEYS ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/** An Electron accelerator for display: "Control+Shift+Space" → "Ctrl+Shift+Space" or "⌃⇧Space". */
export function accelLabel(accel: string): string {
  if (!MAC_KEYS) return accel.replace(/\bControl\b|\bCommandOrControl\b|\bCmdOrCtrl\b/g, 'Ctrl')
  const sym: Record<string, string> = { control: '⌃', ctrl: '⌃', shift: '⇧', alt: '⌥', option: '⌥', command: '⌘', cmd: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘', super: '⌘', meta: '⌘' }
  const parts = accel.split('+')
  const key = parts.pop() ?? ''
  return parts.map((p) => sym[p.toLowerCase()] ?? p).join('') + key
}
