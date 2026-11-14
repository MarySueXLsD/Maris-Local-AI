// Watching a project folder for changes. Windows and macOS watch a whole tree with one system watcher;
// Linux has no such thing, and Node's recursive watch there adds a watch for every folder, node_modules
// and build output included, which can use up the system's watches on a big project. There Maris
// watches the folders it would show, one by one. Kept free of app imports so tests can load it.
import { readdirSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs'
import path from 'node:path'

/** Folders that are not looked into: big, generated, and never what the project panel is about. */
export const UNWATCHED_DIR = /^(\.git|node_modules|__pycache__|\.venv|venv|\.cache|\.next|\.nuxt|\.gradle|target|obj)$/i
/** A changed path inside a folder whose changes do not matter (for the one watcher of the whole tree). */
const IGNORED_PATH = /(^|[\\/])(\.git|node_modules|__pycache__|\.venv|\.cache)([\\/]|$)/i

/** The folders to watch one by one: the root and its subfolders, without the unwatched ones, at most `limit`. */
export function foldersToWatch(root: string, limit = 2000, maxDepth = 12): string[] {
  const out: string[] = []
  const queue: [string, number][] = [[root, 0]]
  while (queue.length && out.length < limit) {
    const [dir, depth] = queue.shift()!
    out.push(dir)
    if (depth >= maxDepth) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !UNWATCHED_DIR.test(e.name)) queue.push([path.join(dir, e.name), depth + 1])
  }
  return out
}

/**
 * Call `onChange` (debounced by the caller) when anything in the tree changes. Returns a function that stops
 * watching. `perFolder` defaults to on for Linux only.
 */
export function watchTree(root: string, onChange: () => void, perFolder = process.platform === 'linux'): () => void {
  if (!perFolder) {
    const w = watch(root, { recursive: true }, (_event, file) => {
      if (!IGNORED_PATH.test(String(file ?? ''))) onChange()
    })
    w.on('error', () => undefined)
    return () => w.close()
  }
  const all = new Map<string, FSWatcher>()
  const add = (dir: string): void => {
    if (all.has(dir) || all.size >= 2000) return
    try {
      const w = watch(dir, (_event, file) => {
        // Anything that changes in a watched folder counts, a new node_modules included; only what happens
        // inside the unwatched folders goes unseen.
        onChange()
        const name = String(file ?? '')
        if (!name || UNWATCHED_DIR.test(name)) return
        // A folder that appeared is watched from now on.
        const full = path.join(dir, name)
        try {
          if (statSync(full).isDirectory()) for (const d of foldersToWatch(full, 200)) add(d)
        } catch {
          /* gone again */
        }
      })
      w.on('error', () => {
        w.close()
        all.delete(dir)
      })
      all.set(dir, w)
    } catch {
      /* unreadable folder */
    }
  }
  for (const d of foldersToWatch(root)) add(d)
  return () => {
    for (const w of all.values()) w.close()
    all.clear()
  }
}
