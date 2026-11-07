import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'

const KNOWN: Record<string, Parameters<typeof app.getPath>[0]> = {
  desktop: 'desktop',
  downloads: 'downloads',
  documents: 'documents',
  pictures: 'pictures',
  music: 'music',
  videos: 'videos',
  home: 'home'
}

// Windows and (by default) macOS file systems ignore case; Linux does not.
const FOLD_CASE = process.platform !== 'linux'
const norm = (p: string): string => (FOLD_CASE ? path.resolve(p).toLowerCase() : path.resolve(p))

/** True when `p` is `root` itself or lies inside it. */
export function isInside(p: string, root: string): boolean {
  const a = norm(p)
  const b = norm(root)
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/** Expand ~, %VAR%, $env:VAR, $VAR and known folder names, then make the path absolute (relative to `base`). */
export function resolvePath(input: string, base: string = os.homedir()): string {
  let p = input.trim().replace(/^["']|["']$/g, '')
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`)
    p = p.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, v: string) => process.env[v] ?? '')
  } else {
    p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a?: string, b?: string) => process.env[a ?? b ?? ''] ?? m)
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1))
  const first = p.split(/[\\/]/)[0].toLowerCase()
  if (KNOWN[first] && !path.isAbsolute(p)) {
    try {
      p = path.join(app.getPath(KNOWN[first]), p.slice(first.length))
    } catch {
      /* ignore */
    }
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(p)) p += '\\'
  return path.resolve(path.isAbsolute(p) ? p : path.join(base, p))
}

const SYSTEM_PREFIXES =
  process.platform === 'win32'
    ? [
        process.env.SystemRoot ?? 'C:\\Windows',
        process.env.ProgramFiles ?? 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        process.env.ProgramData ?? 'C:\\ProgramData'
      ]
    : process.platform === 'darwin'
      ? ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/private', '/etc', '/var', '/opt', '/Volumes']
      : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '/snap']

/** True for OS folders and drive roots, where a change deserves an extra warning. */
export function isSystemPath(p: string): boolean {
  const n = norm(p)
  if (process.platform === 'win32') {
    if (/^[a-z]:\\?$/.test(n)) return true
  } else if (n === '/') return true
  // ~/Library on macOS holds app data; leave the user's own folders alone.
  return SYSTEM_PREFIXES.map((s) => (FOLD_CASE ? s.toLowerCase() : s)).some((s) => n === s || n.startsWith(s + path.sep))
}

export const backupDir = (): string => path.join(app.getPath('userData'), 'backups')
