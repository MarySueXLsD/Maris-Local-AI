// Plain-language descriptions of what Maris did with its tools, for the "Simple" activity view.
// Kept free of React so tests/activity.test.ts can check it directly.
import type { ToolCallRecord } from '@shared/types'

// The computer's OS, from the preload bridge (absent in unit tests, which describe Windows).
const HOST = (globalThis as { maris?: { platform?: string } }).maris?.platform ?? 'win32'
const TRASH = HOST === 'win32' ? 'Recycle Bin' : 'Trash'
const DEVICE = HOST === 'darwin' ? 'Mac' : 'PC'
const OS_WORD = HOST === 'darwin' ? 'macOS' : HOST === 'linux' ? 'Linux' : 'Windows'

export type ActKind =
  | 'explore'
  | 'edit'
  | 'create'
  | 'delete'
  | 'test'
  | 'build'
  | 'run'
  | 'install'
  | 'git'
  | 'web'
  | 'process'
  | 'look'
  | 'system'
  | 'memory'
  | 'media'
  | 'plan'
  | 'other'

export interface Described {
  kind: ActKind
  /** While it runs, e.g. "Running the Python tests". */
  running: string
  /** When finished, e.g. "Ran the Python tests". */
  done: string
  /** File, search text or page the step is about. */
  subject?: string
  /** Shown in full even in Simple view: installs, deletions, git history changes, unknown changing commands. */
  important: boolean
  /** Why it is important, in a few words. */
  why?: string
  /** Short result, e.g. "all 3 passed" or "failed". */
  outcome?: string
  /** true = worked, false = failed, undefined = nothing to judge. */
  ok?: boolean
  /** The command line, for commands. */
  command?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
export const baseName = (p: unknown): string => {
  const s = str(p).replace(/[\\/]+$/, '')
  return s.split(/[\\/]/).filter(Boolean).pop() ?? s
}
const quote = (s: string, max = 40): string => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`
const host = (u: unknown): string => {
  try {
    return new URL(/^https?:/i.test(str(u)) ? str(u) : `https://${str(u)}`).hostname.replace(/^www\./, '')
  } catch {
    return str(u)
  }
}

type Rule = [RegExp, ActKind, string, string, string?]
/** Known commands → plain words. A fourth entry marks the command as important and says why. */
const RULES: Rule[] = [
  [/^(python3?|py)(\s+-\d(\.\d+)?)?\s+-m\s+(pytest|unittest)\b|^pytest\b/i, 'test', 'Running the Python tests', 'Ran the Python tests'],
  [/^cargo\s+test\b/i, 'test', 'Running the Rust tests', 'Ran the Rust tests'],
  [/^dotnet\s+test\b/i, 'test', 'Running the .NET tests', 'Ran the .NET tests'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?test\b|^npx\s+(jest|vitest|mocha)\b|^(jest|vitest)\b/i, 'test', 'Running the JavaScript tests', 'Ran the JavaScript tests'],
  [/^go\s+test\b/i, 'test', 'Running the Go tests', 'Ran the Go tests'],
  [/^ctest\b/i, 'test', 'Running the C++ tests', 'Ran the C++ tests'],
  [/^(haxelib\s+run\s+)?lime\s+test\b/i, 'run', 'Building and starting the game', 'Built and started the game'],
  [/^(haxelib\s+run\s+)?lime\s+build\b|^haxe\s/i, 'build', 'Building the game', 'Built the game'],
  [/^cargo\s+(build|check)\b/i, 'build', 'Building the Rust project', 'Built the Rust project'],
  [/^cargo\s+run\b/i, 'run', 'Running the program', 'Ran the program'],
  [/^cargo\s+(clippy|fmt)\b|^(rustfmt|ruff|black|flake8|mypy|eslint|prettier|dotnet\s+format)\b|^npx\s+(eslint|prettier|tsc\s+--noEmit)\b/i, 'build', 'Checking the code for problems', 'Checked the code for problems'],
  [/^dotnet\s+build\b|^msbuild\b/i, 'build', 'Building the .NET project', 'Built the .NET project'],
  [/^dotnet\s+run\b/i, 'run', 'Running the app', 'Ran the app'],
  [/^dotnet\s+new\b/i, 'create', 'Creating a new .NET project', 'Created a new .NET project'],
  [/^cargo\s+(new|init)\b/i, 'create', 'Creating a new Rust project', 'Created a new Rust project'],
  [/^(npm|pnpm|yarn)\s+(create|init)\b|^npx\s+create-/i, 'create', 'Creating a new project', 'Created a new project'],
  [/^(haxelib\s+run\s+)?flixel-tools\s+tpl\b|^haxelib\s+run\s+flixel-tools\s+(tpl|template)\b/i, 'create', 'Creating a new HaxeFlixel project', 'Created a new HaxeFlixel project'],
  [/^(npm|pnpm|yarn)\s+run\s+build\b|^npx\s+tsc\b|^tsc\b|^npx\s+vite\s+build\b/i, 'build', 'Building the project', 'Built the project'],
  [/^(npm|pnpm|yarn)\s+(run\s+)?(dev|start|serve)\b/i, 'run', 'Starting the app', 'Started the app'],
  [/^cmake\b|^ninja\b|^make\b|^cl(\.exe)?\s/i, 'build', 'Building the C++ project', 'Built the C++ project'],
  [
    /^(npm|pnpm|yarn)\s+(install|i|add|ci)\b|^(pip3?|(python3?|py)\s+-m\s+pip)\s+install\b|^cargo\s+(add|install)\b|^dotnet\s+(add\s+.*package|tool\s+install)\b|^haxelib\s+(install|git|update|upgrade)\b|^(winget|choco|scoop)\s+(install|upgrade)\b|^(sudo\s+|pkexec\s+)?(apt(-get)?|dnf|yum|pacman|zypper|snap|flatpak)\s+(install|-S\b|upgrade|update|in\b)|^brew\s+(install|upgrade|reinstall)\b|^(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
    'install',
    'Installing software',
    'Installed software',
    'installs software from the internet'
  ],
  [/^(python3?|py)\s+-m\s+venv\b/i, 'create', 'Setting up a Python environment', 'Set up a Python environment'],
  [/^git\s+(status|diff|log|show|branch|remote|rev-parse)\b/i, 'git', 'Checking the version history', 'Checked the version history'],
  [/^git\s+init\b/i, 'git', 'Setting up version history', 'Set up version history'],
  [/^git\s+(add|commit|stash|tag)\b/i, 'git', 'Saving a version in git', 'Saved a version in git', 'records a version in git'],
  [
    /^git\s+(push|pull|fetch|reset|rebase|checkout|switch|merge|clean|restore|revert|cherry-pick)\b/i,
    'git',
    'Changing the version history',
    'Changed the version history',
    'changes the git history or talks to a server'
  ],
  [/^(remove-item|rm|del|erase|rmdir|rd|trash|gio\s+trash)\b/i, 'delete', 'Deleting files', 'Deleted files', 'deletes files'],
  [/^(set-itemproperty|new-itemproperty|reg\s+(add|delete)|set-service|stop-service|start-service|sc(\.exe)?\s|shutdown|restart-computer|stop-computer|reboot|systemctl\s+(start|stop|restart|enable|disable|mask)|launchctl\s+(load|unload|bootstrap|bootout|enable|disable|kickstart)|defaults\s+(write|delete)|gsettings\s+set|sudo\s|pkexec\s|chmod\s|chown\s)/i, 'system', `Changing ${OS_WORD} settings`, `Changed ${OS_WORD} settings`, `changes ${OS_WORD} itself`],
  [/^(python3?|py|node|deno|bun)\s+(?!-)[^\s]+\.(py|js|mjs|cjs|ts)\b/i, 'run', 'Running the script', 'Ran the script'],
  [/^(\.[\\/])?[\w.-]+\.exe\b|^start-process\b|^start\s|^open\s+-a\s|^xdg-open\s|^\.\/[\w.-]+$/i, 'run', 'Starting the program', 'Started the program'],
  [
    /^(get-childitem|gci|ls|dir|get-content|gc|cat|type|select-string|sls|findstr|get-item|test-path|resolve-path|tree|where(\.exe)?|get-command|measure-object|head|tail|less|grep|rg|find|stat|file|du|wc|which|pwd)\b|^(python3?|py|node|dotnet|cargo|rustc|haxe|haxelib|cmake|git|npm|java|go)\s+(--version|-v|version)\b/i,
    'explore',
    'Looking at files',
    'Looked at files'
  ]
]

const FORMATTERS = /^(select-object|select|where-object|where|\?|sort-object|sort|measure-object|measure|format-table|ft|format-list|fl|out-string|group-object|group)\b/i

/**
 * Commands chained together (a; b, a && b), piped into anything but formatting, or writing to a file
 * can hide anything, so they are always shown in full.
 */
export function isCompound(cmd: string): boolean {
  if (/;|&&|\|\|/.test(cmd)) return true
  const pipes = cmd.split('|').slice(1)
  if (pipes.some((s) => !FORMATTERS.test(s.trim()))) return true
  return /(?:^|\s)\d?>{1,2}\s*(?!&)\S/.test(cmd)
}

export function describeCommand(command: string): Pick<Described, 'kind' | 'running' | 'done' | 'important' | 'why'> {
  const cmd = command.trim().replace(/^&\s+/, '')
  const compound = isCompound(cmd)
  for (const [rx, kind, running, done, why] of RULES) {
    if (rx.test(cmd)) {
      if (compound) return { kind, running, done, important: true, why: 'runs several commands at once' }
      return { kind, running, done, important: Boolean(why), why }
    }
  }
  return { kind: 'other', running: 'Running a command', done: 'Ran a command', important: compound, why: compound ? 'runs several commands at once' : undefined }
}

/** Pass/fail counts from common test runners (pytest, unittest, cargo, dotnet, jest/vitest, go). */
export function testCounts(out: string): { passed?: number; failed?: number } {
  const num = (rx: RegExp): number | undefined => {
    const m = rx.exec(out)
    return m ? Number(m[1]) : undefined
  }
  const dotnet = /Failed:\s+(\d+),\s+Passed:\s+(\d+)/.exec(out)
  if (dotnet) return { failed: Number(dotnet[1]), passed: Number(dotnet[2]) }
  const unittest = /Ran (\d+) tests?/.exec(out)
  if (unittest) {
    const total = Number(unittest[1])
    const f = /FAILED \((?:failures=(\d+))?(?:,?\s*errors=(\d+))?/.exec(out)
    const failed = f ? Number(f[1] ?? 0) + Number(f[2] ?? 0) : 0
    return { passed: total - failed, failed }
  }
  const passed = num(/(\d+)\s+passed/)
  const failed = num(/(\d+)\s+failed/) ?? (passed !== undefined ? 0 : undefined)
  return { passed, failed }
}

/** Exit code from a run_command/run_script result header. */
export function exitCode(result?: string): number | undefined {
  const m = /\((?:exit code|exit) (-?\d+)/.exec(result ?? '')
  return m ? Number(m[1]) : undefined
}

function commandOutcome(d: Pick<Described, 'kind'>, call: ToolCallRecord): Pick<Described, 'outcome' | 'ok'> {
  if (call.status !== 'done') return {}
  const code = exitCode(call.result)
  if (/timed out/.test(call.result ?? '')) return { outcome: 'took too long and was stopped', ok: false }
  if (d.kind === 'test') {
    const { passed, failed } = testCounts(call.result ?? '')
    if (failed) return { outcome: passed !== undefined ? `${failed} of ${failed + passed} failed` : `${failed} failed`, ok: false }
    if (passed !== undefined && code !== undefined && code !== 0) return { outcome: 'failed', ok: false }
    if (passed !== undefined) return { outcome: passed === 1 ? 'the test passed' : passed === 2 ? 'both passed' : `all ${passed} passed`, ok: true }
  }
  if (code === undefined) return {}
  if (code === 0) return { outcome: d.kind === 'build' ? 'no errors' : undefined, ok: true }
  return { outcome: d.kind === 'build' ? 'it reported errors' : `it failed (code ${code})`, ok: false }
}

const diffCounts = (diff?: string): { add: number; del: number } | undefined => {
  if (!diff) return undefined
  let add = 0
  let del = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}

export function describeCall(call: ToolCallRecord): Described {
  const a = call.args ?? {}
  const p = baseName(a.path ?? call.targets?.[0])
  const d = (kind: ActKind, running: string, done: string, extra: Partial<Described> = {}): Described => ({ kind, running, done, important: false, ...extra })
  switch (call.name) {
    case 'project_tree':
      return d('explore', 'Looking at how the project is organised', 'Looked at how the project is organised')
    case 'list_dir':
      return d('explore', `Looking inside ${p || 'a folder'}`, `Looked inside ${p || 'a folder'}`, { subject: p })
    case 'read_file':
      return d('explore', `Reading ${p}`, `Read ${p}`, { subject: p })
    case 'file_info':
      return d('explore', `Checking ${p}`, `Checked ${p}`, { subject: p })
    case 'grep':
      return d('explore', `Searching the code for ${quote(str(a.pattern))}`, `Searched the code for ${quote(str(a.pattern))}`, { subject: quote(str(a.pattern), 24) })
    case 'search_files':
      return d('explore', 'Looking for files', `Looked for ${str(a.pattern) || 'files'}${a.contains ? ` containing ${quote(str(a.contains), 24)}` : ''}`)
    case 'edit_file':
    case 'multi_edit': {
      const c = diffCounts(call.diff)
      return d('edit', `Changing ${p}`, `Changed ${p}`, { subject: p, outcome: c ? `+${c.add} −${c.del}` : undefined })
    }
    case 'write_file': {
      const created = /^Create/.test(call.title ?? '')
      const c = diffCounts(call.diff)
      return d(created ? 'create' : 'edit', created ? `Creating ${p}` : `Rewriting ${p}`, created ? `Created ${p}` : `Rewrote ${p}`, {
        subject: p,
        outcome: c ? (created ? `${c.add} line${c.add === 1 ? '' : 's'}` : `+${c.add} −${c.del}`) : undefined
      })
    }
    case 'write_files': {
      const list = Array.isArray(a.files) ? (a.files as { path?: string }[]) : []
      const n = list.length || Number(/Write (\d+)/.exec(call.title ?? '')?.[1] ?? 0)
      const what = n === 1 ? baseName(list[0]?.path) || 'a file' : `${n || 'several'} files`
      return d('create', `Creating ${what}`, `Created ${what}`, { subject: n === 1 ? baseName(list[0]?.path) : undefined, outcome: /replaced/.test(call.title ?? '') ? 'some replaced' : undefined })
    }
    case 'make_dir':
      return d('create', `Creating the folder ${p}`, `Created the folder ${p}`, { subject: p })
    case 'move_path':
      return d('edit', `Moving ${baseName(a.from)} to ${str(a.to)}`, `Moved ${baseName(a.from)} to ${str(a.to)}`, { important: true, why: 'moves files' })
    case 'copy_path':
      return d('create', `Copying ${baseName(a.from)}`, `Copied ${baseName(a.from)} to ${str(a.to)}`)
    case 'delete_path':
      return d('delete', `Moving ${p} to the ${TRASH}`, `Moved ${p} to the ${TRASH}`, { subject: p, important: true, why: `removes files (you can restore them from the ${TRASH})` })
    case 'run_command': {
      const command = str(a.command)
      const c = describeCommand(command)
      // A command that needed approval and that Maris cannot describe is shown in full.
      const unknownChange = c.kind === 'other' && call.risk !== 'read'
      const desc: Described = {
        ...c,
        important: c.important || unknownChange,
        why: c.why ?? (unknownChange ? 'changes something Maris cannot describe simply' : undefined),
        command
      }
      return { ...desc, ...commandOutcome(desc, call) }
    }
    case 'run_script': {
      const lang = str(a.language) === 'powershell' ? 'PowerShell' : str(a.language) === 'bash' ? 'Bash' : str(a.language) || 'a'
      const change = call.risk !== 'read'
      const desc: Described = d('run', `Running a small ${lang} script`, `Ran a small ${lang} script`, {
        important: change,
        why: change ? `runs code that can change things on your ${DEVICE}` : undefined
      })
      return { ...desc, ...commandOutcome(desc, call) }
    }
    case 'start_process': {
      const c = describeCommand(str(a.command))
      const name = str(a.name) || (c.kind === 'run' ? '' : 'a program')
      return d('process', `Starting ${name || 'the app'} in the background`, `Started ${name || 'the app'} in the background`, { command: str(a.command), important: c.important, why: c.why })
    }
    case 'process_output':
      return d('process', 'Checking on the running app', 'Checked on the running app')
    case 'stop_process':
      return d('process', 'Stopping the running app', 'Stopped the running app')
    case 'view_image':
      return d('look', `Looking at ${p}`, `Looked at ${p}`, { subject: p })
    case 'take_screenshot':
      return d('look', 'Taking a screenshot', 'Took a screenshot')
    case 'dev_environment':
      return d('system', 'Checking which developer tools are installed', 'Checked which developer tools are installed')
    case 'update_plan':
      return d('plan', 'Planning the work', 'Updated the plan')
    case 'web_search':
      return d('web', `Searching the web for ${quote(str(a.query))}`, `Searched the web for ${quote(str(a.query))}`)
    case 'read_webpage':
      return d('web', `Reading a page on ${host(a.url)}`, `Read a page on ${host(a.url)}`, { subject: host(a.url) })
    case 'system_info':
      return d('system', `Checking your ${DEVICE}`, `Checked your ${DEVICE}`)
    case 'list_processes':
      return d('system', 'Looking at running programs', 'Looked at running programs')
    case 'kill_process':
      return d('system', `Closing ${str(a.name ?? a.pid)}`, `Closed ${str(a.name ?? a.pid)}`, { important: true, why: 'closes a program; unsaved work there may be lost' })
    case 'open_target':
      return d('system', `Opening ${baseName(a.target) || str(a.target)}`, `Opened ${baseName(a.target) || str(a.target)}`, { important: true, why: 'opens a program or file' })
    case 'get_clipboard':
      return d('system', 'Reading the clipboard', 'Read the clipboard')
    case 'set_clipboard':
      return d('system', 'Copying text to the clipboard', 'Copied text to the clipboard')
    case 'remember':
      return d('memory', 'Remembering this', 'Saved to memory', { subject: str(a.text).slice(0, 60) })
    case 'recall':
      return d('memory', 'Checking memories', 'Checked memories')
    case 'forget':
      return d('memory', 'Forgetting a memory', 'Forgot a memory', { important: true, why: 'removes something Maris remembered' })
    case 'search_chats':
      return d('memory', 'Looking through past chats', 'Looked through past chats')
    case 'generate_image':
      return d('media', 'Drawing a picture', 'Drew a picture')
    case 'generate_video':
      return d('media', 'Making a video', 'Made a video')
    default:
      return d('other', call.title ?? call.name, call.title ?? call.name)
  }
}

export interface TurnSummary {
  changed: string[]
  created: string[]
  tests?: boolean
  builds?: boolean
  failedSteps: number
  approvals: number
}

/** What a whole answer did, for the line under it. */
export function summarize(calls: ToolCallRecord[]): TurnSummary {
  const s: TurnSummary = { changed: [], created: [], failedSteps: 0, approvals: 0 }
  for (const call of calls) {
    const d = describeCall(call)
    if (call.status === 'error') s.failedSteps++
    if (call.status === 'done' && !call.autoApproved && call.risk !== 'read' && call.name !== 'update_plan') s.approvals++
    if (call.status !== 'done') continue
    if (d.kind === 'edit' && d.subject && !s.changed.includes(d.subject)) s.changed.push(d.subject)
    if (d.kind === 'create' && d.subject && !s.created.includes(d.subject)) s.created.push(d.subject)
    // The latest run counts: tests that failed and were then fixed end as passing.
    if (d.kind === 'test' && d.ok !== undefined) s.tests = d.ok
    if (d.kind === 'build' && d.ok !== undefined) s.builds = d.ok
  }
  return s
}

/** "Running the tests" → "run the tests", for approval questions. */
export function imperative(running: string): string {
  const [first, ...rest] = running.split(' ')
  const map: Record<string, string> = {
    Running: 'run',
    Building: 'build',
    Installing: 'install',
    Checking: 'check',
    Creating: 'create',
    Changing: 'change',
    Deleting: 'delete',
    Moving: 'move',
    Copying: 'copy',
    Starting: 'start',
    Stopping: 'stop',
    Saving: 'save',
    Setting: 'set',
    Looking: 'look',
    Reading: 'read',
    Searching: 'search',
    Rewriting: 'rewrite',
    Opening: 'open',
    Closing: 'close',
    Drawing: 'draw',
    Making: 'make',
    Forgetting: 'forget',
    Remembering: 'remember',
    Taking: 'take',
    Planning: 'plan'
  }
  return [map[first] ?? first.toLowerCase(), ...rest].join(' ')
}
