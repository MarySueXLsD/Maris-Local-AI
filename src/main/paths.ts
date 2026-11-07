import { app } from 'electron'
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

export const userDir = (): string => app.getPath('userData')
export const dbPath = (): string => join(userDir(), 'maris.db')

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

/**
 * Where large engine/model data goes. Windows: the fixed drive with the most free space.
 * macOS and Linux: a folder in the home directory (external disks can be chosen in setup).
 */
export function suggestDataDir(): string {
  if (process.platform !== 'win32') return join(os.homedir(), 'MarisData')
  let best = { root: 'C:\\', free: 0 }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      if (!existsSync(root)) continue
      const s = statfsSync(root)
      const free = Number(s.bavail) * Number(s.bsize)
      if (free > best.free) best = { root, free }
    } catch {
      /* drive not ready */
    }
  }
  return join(best.root, 'MarisData')
}

export function freeBytes(path: string): number {
  try {
    const s = statfsSync(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return 0
  }
}
