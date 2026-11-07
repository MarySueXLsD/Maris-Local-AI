import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstallInfo } from '@shared/types'

/**
 * How big an install command is, for its approval: what it downloads, about how much disk it needs and
 * how much is free. Knows winget (installer size from the package's own download), npm and pip
 * (their registries), and the toolchains Maris itself offers. Gives up quietly after a few seconds.
 */

const cache = new Map<string, InstallInfo | undefined>()
/** Size hints of the toolchains Maris offers, by package id (lower case). */
const known = new Map<string, string>()

export function registerInstallSizes(entries: [id: string, sizeHint: string][]): void {
  for (const [id, hint] of entries) known.set(id.toLowerCase(), hint)
}

/** Disk space after unpacking, as a multiple of the download, by installer type. */
const UNPACK: Record<string, number> = { zip: 3, portable: 3, msi: 2.2, exe: 2.2, inno: 2.2, nullsoft: 2.2, burn: 2, msix: 1.3, appx: 1.3 }

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

/** "≈1–2 GB" / "≈300 MB" → bytes (the upper end). */
function parseHint(hint?: string): number | undefined {
  const m = /([\d.]+)\s*(?:[–-]\s*([\d.]+)\s*)?(KB|MB|GB)/i.exec(hint ?? '')
  if (!m) return undefined
  const n = Number(m[2] ?? m[1])
  return n * (m[3].toUpperCase() === 'GB' ? 1e9 : m[3].toUpperCase() === 'MB' ? 1e6 : 1e3)
}

function run(cmd: string, args: string[], ms: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 4 * 2 ** 20 }, (_e, stdout) => resolve(String(stdout ?? '')))
  })
}

async function headSize(url: string, ms: number): Promise<number | undefined> {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'Maris' } })
    const n = Number(r.headers.get('content-length'))
    return r.ok && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

async function getJson<T>(url: string, ms: number): Promise<T | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'Maris', Accept: 'application/json' } })
    return r.ok ? ((await r.json()) as T) : undefined
  } catch {
    return undefined
  }
}

function freeOn(dir: string): { drive: string; free?: number } {
  const root = path.parse(path.resolve(dir)).root || dir
  const drive = process.platform === 'win32' ? root.replace(/\\$/, '') : root
  try {
    const st = statfsSync(root)
    return { drive, free: Number(st.bavail) * Number(st.bsize) }
  } catch {
    return { drive }
  }
}

function summary(name: string | undefined, download?: number, disk?: number, where?: { drive: string; free?: number }): InstallInfo | undefined {
  if (!download && !disk) return undefined
  const parts: string[] = []
  if (download) parts.push(`downloads about ${fmtBytes(download)}`)
  if (disk) parts.push(`needs about ${fmtBytes(disk)}${where ? ` on ${where.drive}` : ''}`)
  const what = parts.join(' and ')
  let text = name ? `${name}: ${what}` : `${what.charAt(0).toUpperCase()}${what.slice(1)}`
  if (where?.free !== undefined) {
    text += ` (${fmtBytes(where.free)} free)`
    if (disk && where.free < disk * 1.1) text += '. There may not be enough space'
  }
  return { summary: `${text}.`, name, downloadBytes: download, diskBytes: disk, drive: where?.drive, freeBytes: where?.free }
}

/** Arguments after the install verb, without options. */
function packagesAfter(tokens: string[], verbAt: number, valueFlags: string[]): string[] {
  const out: string[] = []
  for (let i = verbAt + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^[;&|]/.test(t)) break
    if (t.startsWith('-')) {
      if (valueFlags.includes(t.toLowerCase())) i++
      continue
    }
    out.push(t.replace(/^["']|["']$/g, ''))
  }
  return out
}

async function winget(tokens: string[]): Promise<InstallInfo | undefined> {
  const at = tokens.findIndex((t) => /^(install|add)$/i.test(t))
  const idFlag = tokens.findIndex((t) => /^(--id|-q|--query)$/i.test(t))
  const id = (idFlag >= 0 ? tokens[idFlag + 1] : packagesAfter(tokens, at, ['--source', '-s', '--version', '-v', '--scope', '--override', '--location', '-l', '--architecture', '-a', '--log', '-o'])[0])?.replace(/^["']|["']$/g, '')
  if (!id) return undefined
  const hint = known.get(id.toLowerCase())
  const where = freeOn(process.env.LOCALAPPDATA ?? os.homedir())
  const out = await run('winget', ['show', '--id', id, '-e', '--accept-source-agreements', '--disable-interactivity'], 6000)
  const name = /^Found (.+?) \[/m.exec(out)?.[1]?.trim()
  const url = /Installer Url:\s*(\S+)/i.exec(out)?.[1]
  const type = (/Installer Type:\s*(\w+)/i.exec(out)?.[1] ?? '').toLowerCase()
  const download = url ? await headSize(url, 4000) : undefined
  const disk = parseHint(hint) ?? (download ? Math.round(download * (UNPACK[type] ?? 2)) : undefined)
  return summary(name ?? id, download, disk, where)
}

async function npm(tokens: string[]): Promise<InstallInfo | undefined> {
  const at = tokens.findIndex((t) => /^(install|i|add)$/i.test(t))
  const pkgs = packagesAfter(tokens, at, ['--prefix', '--registry', '--tag'])
  if (!pkgs.length || pkgs.some((p) => p.startsWith('.') || p.includes('/') && !p.startsWith('@'))) return undefined
  let total = 0
  for (const spec of pkgs.slice(0, 5)) {
    const name = spec.replace(/(?!^)@[^/]*$/, '')
    const meta = await getJson<{ dist?: { unpackedSize?: number } }>(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`, 3000)
    total += meta?.dist?.unpackedSize ?? 0
  }
  if (!total) return undefined
  // The packages themselves; their dependencies usually add several times as much.
  // Global packages go to npm's folder in the profile.
  return summary(pkgs.length === 1 ? pkgs[0] : `${pkgs.length} packages`, undefined, total * 4, freeOn(process.env.APPDATA ?? os.homedir()))
}

async function pip(tokens: string[]): Promise<InstallInfo | undefined> {
  const at = tokens.findIndex((t) => t.toLowerCase() === 'install')
  const pkgs = packagesAfter(tokens, at, ['-r', '--requirement', '-i', '--index-url', '--target', '-t', '--extra-index-url'])
  if (!pkgs.length || tokens.some((t) => t === '-r' || t === '--requirement')) return undefined
  let download = 0
  for (const spec of pkgs.slice(0, 5)) {
    const name = spec.split(/[<>=!~[\s]/)[0]
    const meta = await getJson<{ urls?: { size: number; packagetype: string; filename: string }[] }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, 3000)
    const files = meta?.urls ?? []
    const plat = process.platform === 'win32' ? /win_amd64|none-any/ : process.platform === 'darwin' ? /macosx|none-any/ : /manylinux.*x86_64|none-any/
    const best = files.filter((f) => f.packagetype === 'bdist_wheel' && plat.test(f.filename)).sort((a, b) => b.size - a.size)[0] ?? files[0]
    download += best?.size ?? 0
  }
  if (!download) return undefined
  return summary(pkgs.length === 1 ? pkgs[0] : `${pkgs.length} packages`, download, download * 3, freeOn(os.homedir()))
}

/** Install size for a command line, if it is an install Maris recognises. */
export async function installInfo(command: string): Promise<InstallInfo | undefined> {
  const key = command.trim().replace(/\s+/g, ' ')
  if (cache.has(key)) return cache.get(key)
  const tokens: string[] = key.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const first = (tokens[0] ?? '').replace(/^["'&\s]+|["']$/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
  let info: InstallInfo | undefined
  try {
    if (first === 'winget' && tokens.some((t) => /^(install|add)$/i.test(t))) info = await winget(tokens)
    else if ((first === 'npm' || first === 'pnpm' || first === 'yarn') && tokens.some((t) => /^(install|i|add)$/i.test(t)) && tokens.some((t) => t === '-g' || t === '--global' || t === 'global'))
      info = await npm(tokens)
    else if ((first === 'pip' || first === 'pip3' || ((first === 'python' || first === 'python3' || first === 'py') && tokens.includes('pip'))) && tokens.some((t) => t.toLowerCase() === 'install'))
      info = await pip(tokens)
  } catch {
    // Best effort: the approval simply shows no size.
  }
  cache.set(key, info)
  return info
}
