// Key names the assistant writes ("ctrl+s", "enter") in Windows SendKeys syntax. No imports, so
// tests/assistant.test.ts can check it.

/** "ctrl+s", "alt+f4", "enter" → Windows SendKeys syntax. */
export function sendKeysFor(combo: string): string {
  const names: Record<string, string> = {
    enter: '{ENTER}',
    return: '{ENTER}',
    tab: '{TAB}',
    esc: '{ESC}',
    escape: '{ESC}',
    backspace: '{BACKSPACE}',
    delete: '{DEL}',
    del: '{DEL}',
    up: '{UP}',
    down: '{DOWN}',
    left: '{LEFT}',
    right: '{RIGHT}',
    home: '{HOME}',
    end: '{END}',
    pageup: '{PGUP}',
    pagedown: '{PGDN}',
    space: ' ',
    insert: '{INS}'
  }
  return combo
    .split(/\s+/)
    .filter(Boolean)
    .map((one) => {
      const keys = one.toLowerCase().split('+')
      const key = keys.pop() ?? ''
      const mods = keys.map((m) => (m === 'ctrl' || m === 'control' ? '^' : m === 'shift' ? '+' : m === 'alt' ? '%' : '')).join('')
      const k = names[key] ?? (/^f([1-9]|1[0-6])$/.test(key) ? `{${key.toUpperCase()}}` : key.length === 1 ? escapeSendKeys(key) : `{${key.toUpperCase()}}`)
      return `${mods}${k}`
    })
    .join('')
}

export const escapeSendKeys = (text: string): string => text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}')


/**
 * Commands that only work with administrator rights (services, drivers, boot settings, machine-wide
 * registry and features, sudo). A model without them ran a command that did nothing and then said it
 * had restarted the service, so these are caught before they run.
 */
export function needsAdmin(command: string, platform: string): boolean {
  const c = command.replace(/\s+/g, ' ')
  if (platform === 'win32') {
    return (
      /\b(Restart|Stop|Start|Set|New|Remove|Suspend|Resume)-Service\b/i.test(c) ||
      /\bsc(\.exe)? +(\\\S+ +)?(start|stop|config|delete|create|pause|continue|failure)\b/i.test(c) ||
      /\bnet(\.exe)? +(start|stop|pause|continue) +\S/i.test(c) ||
      /\bservices\.exe\b/i.test(c) ||
      /\b(bcdedit|dism|sfc|pnputil|bootrec|diskpart|fsutil +(behavior|dirty|quota))\b/i.test(c) ||
      /\b(Set|New|Remove)-ItemProperty\b[^;|]*(HKLM:|HKEY_LOCAL_MACHINE)/i.test(c) ||
      /\breg(\.exe)? +(add|delete|import|load|unload) +(HKLM|HKEY_LOCAL_MACHINE)\b/i.test(c) ||
      /\b(Enable|Disable)-WindowsOptionalFeature\b|\b(Add|Remove)-WindowsCapability\b/i.test(c) ||
      /\bSet-MpPreference\b|\bAdd-MpPreference\b/i.test(c) ||
      /\bnetsh +(advfirewall|interface|int|winsock|wlan +set +hostednetwork)\b[^;|]*\b(set|add|delete|reset)\b/i.test(c) ||
      /-Verb +RunAs\b/i.test(c)
    )
  }
  return /(^|[;&|] *)(sudo|doas|pkexec) /.test(c) || /\bsystemctl +(start|stop|restart|enable|disable|mask|unmask|reload|daemon-reload)\b/.test(c) && !/--user\b/.test(c)
}
