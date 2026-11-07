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

let osName: string | undefined
/** Human description, e.g. "Windows 11 (10.0.26200)", "macOS 15.1 (arm64)", "Ubuntu 24.04.1 LTS". */
export function osDescription(): string {
  if (osName) return osName
  if (IS_WIN) osName = `Windows ${os.release()}`
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

/** The word for this computer in the UI and prompts. */
export const DEVICE_WORD = IS_MAC ? 'Mac' : 'PC'

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
