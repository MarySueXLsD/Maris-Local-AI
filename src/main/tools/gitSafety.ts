// A repository's own settings (.git/config) can name programs that git starts by itself, even for
// commands that only read: a file monitor (status), diff and textconv drivers (diff, log -p, show), clean
// filters (status), credential helpers and ssh commands (remote show). A folder unpacked from an archive,
// copied from a USB stick or opened on a network share brings its own .git folder with such settings, so
// "git status" there is not harmless by itself. Kept free of app imports so tests can load it directly.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Settings, in any section, whose value is a program for git to run (or, for path, a program or another settings file). */
const PROGRAM_KEYS = new Set([
  'textconv',
  'external',
  'pager',
  'command',
  'cmd',
  'program',
  'clean',
  'smudge',
  'process',
  'editor',
  'askpass',
  'sshcommand',
  'gitproxy',
  'helper',
  'uploadpack',
  'receivepack',
  'path'
])

/** Whether settings text names a program, or reads more settings from another file ([include], [includeIf]). */
export function settingsNameProgram(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*\[\s*include(if)?\b/i.test(raw)) return true
    // A setting may follow its section header on the same line.
    const m = /^\s*([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(raw.replace(/^\s*\[[^\]]*\]/, ''))
    if (!m) continue
    const key = m[1].toLowerCase()
    // core.fsmonitor = true is git's own monitor; any other value is a program.
    if (key === 'fsmonitor') {
      const value = m[2].replace(/\s*[#;].*$/, '').replace(/^"|"$/g, '').trim().toLowerCase()
      if (!/^(true|false|yes|no|on|off|1|0)?$/.test(value)) return true
    } else if (PROGRAM_KEYS.has(key)) return true
  }
  return false
}

/** The .git folder git uses in `start` (looking upwards like git does), or the folder itself when it is a bare repository. */
export function findGitDir(start: string): string | undefined {
  let dir = path.resolve(start)
  for (let depth = 0; depth < 100; depth++) {
    const dotGit = path.join(dir, '.git')
    try {
      const st = statSync(dotGit)
      if (st.isDirectory()) return dotGit
      // A worktree or a submodule: ".git" is a file that says where the repository is.
      if (st.isFile()) {
        const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, 'utf8'))
        if (m) return path.resolve(dir, m[1])
      }
    } catch {
      /* no .git here */
    }
    // A bare repository, or a folder inside .git: git uses it as it is.
    if (existsSync(path.join(dir, 'HEAD')) && existsSync(path.join(dir, 'objects')) && existsSync(path.join(dir, 'config'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
  return undefined
}

/** A repository's settings files: its own, and for a worktree those of the repository it belongs to. */
function settingsFiles(gitDir: string): string[] {
  const files = [path.join(gitDir, 'config'), path.join(gitDir, 'config.worktree')]
  try {
    const common = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    if (common) files.push(path.join(path.resolve(gitDir, common), 'config'))
  } catch {
    /* not a worktree */
  }
  return files
}

/** Why git, run in `cwd`, could start a program the repository itself names; undefined when its settings name none. */
export function repoProgramRisk(cwd: string): string | undefined {
  const gitDir = findGitDir(cwd)
  if (!gitDir) return undefined
  for (const file of settingsFiles(gitDir)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (settingsNameProgram(text)) return `the repository's own settings (${file}) can make git start a program`
  }
  return undefined
}

/** The command line runs git. */
export const usesGit = (command: string): boolean => /(^|[\s|({])git(\.exe)?(\s|$)/i.test(command)

/**
 * Environment for commands that run without approval. Git takes no optional lock, so "git status" does not
 * write the index (which would start the repository's post-index-change hook), and starts no file monitor.
 */
export function readOnlyGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = Number(base.GIT_CONFIG_COUNT) || 0
  return { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${n}`]: 'false' }
}
