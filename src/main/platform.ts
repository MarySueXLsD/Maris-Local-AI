// Which operating system Maris runs on, and the few facts that differ between them.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = !IS_WIN && !IS_MAC

export const OS_LABEL = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
/** The shell commands run in, as the model should write them. */
export const SHELL_LABEL = IS_WIN ? 'PowerShell' : IS_MAC ? 'zsh' : 'bash'

/** The user's login shell on macOS/Linux (bash or zsh), used so commands see their normal PATH. */
export function posixShell(): string {
  const s = process.env.SHELL
  if (s && /\/(bash|zsh)$/.test(s)) return s
  return IS_MAC ? '/bin/zsh' : '/bin/bash'
}

/**
 * "Windows 11 Pro 24H2 (build 26200)" from os.release() ("10.0.26200") and the registry's EditionID and
 * DisplayVersion. Windows 11 still reports version 10.0, so small models read "Windows 10.0.26200" as
 * Windows 10; the build number (22000 and up) is what tells them apart.
 */
export function windowsName(release: string, edition?: string, displayVersion?: string): string {
  const build = Number(release.split('.')[2]) || 0
  const name = build >= 22000 ? 'Windows 11' : release.startsWith('6.') ? 'Windows' : 'Windows 10'
  const ed = edition ? ({ Core: 'Home', CoreSingleLanguage: 'Home', Professional: 'Pro', ProfessionalWorkstation: 'Pro for Workstations', Enterprise: 'Enterprise', Education: 'Education', ServerStandard: 'Server' } as Record<string, string>)[edition] ?? edition : ''
  return [name, ed, displayVersion].filter(Boolean).join(' ') + (build ? ` (build ${build})` : '')
}

function regValue(name: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', name], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(out)?.[1]?.trim()
  } catch {
    return undefined
  }
}

let osName: string | undefined
/** Human description, e.g. "Windows 11 Pro 24H2 (build 26200)", "macOS 15.1 (arm64)", "Ubuntu 24.04.1 LTS". */
export function osDescription(): string {
  if (osName) return osName
  if (IS_WIN) osName = windowsName(os.release(), regValue('EditionID'), regValue('DisplayVersion'))
  else if (IS_MAC) {
    let v = os.release()
    try {
      v = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 }).trim()
    } catch {
      /* keep the kernel version */
    }
    osName = `macOS ${v} (${os.arch()})`
  } else {
    try {
      const rel = readFileSync('/etc/os-release', 'utf8')
      osName = /PRETTY_NAME="?([^"\n]+)"?/.exec(rel)?.[1] ?? `Linux ${os.release()}`
    } catch {
      osName = `Linux ${os.release()}`
    }
  }
  return osName
}

/** How paths look on this system, for the model's instructions. */
export const PATH_STYLE = IS_WIN
  ? 'Paths on this PC use Windows format, e.g. C:\\Users\\name\\Documents.'
  : IS_MAC
    ? 'Paths on this Mac use POSIX format, e.g. /Users/name/Documents.'
    : 'Paths on this PC use POSIX format, e.g. /home/name/Documents.'

let elevated: boolean | undefined
/** True when Maris itself runs with administrator rights (then admin-only commands work directly). */
export function isElevated(): boolean {
  if (elevated === undefined) {
    if (IS_WIN) {
      try {
        execFileSync('net', ['session'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
        elevated = true
      } catch {
        elevated = false
      }
    } else elevated = process.getuid?.() === 0
  }
  return elevated
}

/** The word for this computer in the UI and prompts. */
export const DEVICE_WORD = IS_MAC ? 'Mac' : 'PC'
/** Where deleted files go. */
export const TRASH_LABEL = IS_WIN ? 'Recycle Bin' : 'Trash'

/** Linux package manager, for install hints. */
export function linuxPackageManager(): 'apt' | 'dnf' | 'pacman' | 'zypper' | undefined {
  if (!IS_LINUX) return undefined
  for (const pm of ['apt', 'dnf', 'pacman', 'zypper'] as const) {
    try {
      execFileSync('sh', ['-c', `command -v ${pm}`], { stdio: 'ignore', timeout: 2000 })
      return pm
    } catch {
      /* not this one */
    }
  }
  return undefined
}
