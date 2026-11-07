// Conservative read-only check for bash/zsh command lines on macOS and Linux.
// Kept free of runtime imports so tests can load it directly.
import type { Classification } from './classify'

type Check = ((args: string[]) => string | undefined) | null

/** Programs that only read, each with an optional check of its arguments (returns a reason when it would change things). */
const POSIX_READ: Record<string, Check> = {
  ls: null,
  ll: null,
  cat: null,
  head: null,
  tail: null,
  wc: null,
  grep: null,
  egrep: null,
  fgrep: null,
  rg: null,
  stat: null,
  file: null,
  du: null,
  df: null,
  pwd: null,
  whoami: null,
  id: null,
  groups: null,
  uname: null,
  hostname: (a) => (a.some((x) => !x.startsWith('-')) ? 'hostname with a name renames the computer' : undefined),
  date: (a) => (a.some((x) => x === '-s' || x === '--set') ? 'sets the clock' : undefined),
  uptime: null,
  ps: null,
  pgrep: null,
  free: null,
  lscpu: null,
  lspci: null,
  lsusb: null,
  lsblk: null,
  lsmod: null,
  which: null,
  whereis: null,
  type: null,
  echo: null,
  printf: null,
  tree: null,
  sort: (a) => (a.some((x) => x === '-o' || x.startsWith('--output')) ? 'writes a file' : undefined),
  uniq: (a) => (a.filter((x) => !x.startsWith('-')).length > 1 ? 'writes a file' : undefined),
  cut: null,
  tr: null,
  column: null,
  jq: null,
  diff: null,
  cmp: null,
  md5sum: null,
  sha1sum: null,
  sha256sum: null,
  shasum: null,
  nproc: null,
  basename: null,
  dirname: null,
  realpath: null,
  readlink: null,
  test: null,
  '[': null,
  true: null,
  locale: null,
  getconf: null,
  arch: null,
  sw_vers: null,
  vm_stat: null,
  ioreg: null,
  system_profiler: null,
  mdfind: null,
  mdls: null,
  lsof: null,
  ss: null,
  netstat: null,
  dig: null,
  nslookup: null,
  host: null,
  ping: null,
  printenv: null,
  find: (a) => (a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(x)) ? 'find can delete files or run commands' : undefined),
  sysctl: (a) => (a.some((x) => x === '-w' || x.includes('=')) ? 'changes kernel settings' : undefined),
  pmset: (a) => (a[0] === '-g' ? undefined : 'changes power settings'),
  defaults: (a) => (['read', 'domains', 'read-type'].includes(a[0] ?? '') ? undefined : 'changes app preferences'),
  launchctl: (a) => (['list', 'print', 'print-disabled'].includes(a[0] ?? '') ? undefined : 'changes background services'),
  systemctl: (a) => {
    const verb = a.find((x) => !x.startsWith('-'))
    return !verb || ['status', 'show', 'list-units', 'list-unit-files', 'list-timers', 'is-active', 'is-enabled', 'is-failed', 'cat'].includes(verb) ? undefined : 'changes system services'
  },
  journalctl: (a) => (a.some((x) => /^--(vacuum|rotate|flush|sync|relinquish-var|setup-keys)/.test(x)) ? 'changes the system log' : undefined),
  ip: (a) => (a.some((x) => ['add', 'del', 'delete', 'set', 'flush', 'change', 'replace'].includes(x)) ? 'changes network settings' : undefined),
  ifconfig: (a) => (a.length > 1 ? 'changes network settings' : undefined),
  'nvidia-smi': (a) => (a.every((x) => !x.startsWith('-') || /^(--query|--format|-q|-L|--list-gpus|-i|--id|-d|--display|-l|--loop|-lms)/.test(x)) ? undefined : 'changes GPU settings'),
  'rocm-smi': (a) => (a.every((x) => !x.startsWith('-') || /^(--show|-a|--alldevices|--json|-d|--device)/.test(x)) ? undefined : 'changes GPU settings'),
  command: (a) => (a[0] === '-v' || a[0] === '-V' ? undefined : 'runs another command'),
  env: (a) => (a.length ? 'runs another command' : undefined),
  git: (a) => {
    const sub = a.find((x) => !x.startsWith('-'))
    if (!sub || a[0] === '--version') return undefined
    if (['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'reflog', 'cat-file', 'grep', 'help', 'version'].includes(sub)) return undefined
    if (sub === 'branch' && !a.some((x) => /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream-to|-u)$/.test(x))) return undefined
    if (sub === 'remote' && (a.length === 1 || a.includes('-v') || a.includes('show') || a.includes('get-url'))) return undefined
    if (sub === 'tag' && (a.length === 1 || a.includes('-l') || a.includes('--list'))) return undefined
    if (sub === 'stash' && a.includes('list')) return undefined
    if (sub === 'config' && a.some((x) => /^(--get|--list|-l)/.test(x))) return undefined
    return `git ${sub} can change the repository`
  }
}

/** Tools that may only print their version. */
const VERSION_ONLY = new Set(['node', 'python', 'python3', 'rustc', 'go', 'java', 'javac', 'haxe', 'cmake', 'make', 'gcc', 'g++', 'clang', 'clang++', 'swift', 'ruby', 'perl', 'php', 'deno', 'bun'])

/** Tools whose first argument must be one of these listing/reading verbs. */
const LISTING: Record<string, string[]> = {
  npm: ['ls', 'list', 'view', 'info', 'outdated', 'root', 'prefix', 'help', 'explain', 'why'],
  pnpm: ['ls', 'list', 'view', 'info', 'outdated', 'root', 'why'],
  yarn: ['list', 'info', 'why', 'outdated'],
  cargo: ['tree', 'metadata', 'search', 'version', 'help', 'verify-project', 'locate-project'],
  dotnet: ['--info', '--list-sdks', '--list-runtimes'],
  haxelib: ['list', 'info', 'path', 'version', 'config', 'search'],
  brew: ['list', 'info', 'outdated', 'search', 'config', 'deps', 'leaves', 'doctor', 'desc', 'home', 'uses'],
  apt: ['list', 'show', 'policy', 'search'],
  'apt-cache': ['show', 'policy', 'search', 'depends', 'rdepends', 'showpkg'],
  dpkg: ['-l', '-L', '-s', '-S', '--list', '--status', '--listfiles', '--search', '--get-selections'],
  rpm: ['-q', '-qa', '-qi', '-ql', '-qf'],
  flatpak: ['list', 'info', 'remotes', 'search'],
  snap: ['list', 'info', 'find', 'version'],
  xcrun: ['--show-sdk-path', '--show-sdk-version', '-f', '--find'],
  'xcode-select': ['-p', '--print-path', '-v', '--version']
}

/**
 * Pipelines are allowed when every step only reads. Chaining (; && ||), background jobs, redirection,
 * command substitution, environment prefixes, sudo and unknown programs all need the user's approval.
 */
export function classifyPosixCommand(command: string): Classification {
  const cmd = command.trim()
  if (!cmd) return { readOnly: false, reason: 'empty command' }
  if (/[\r\n]/.test(cmd)) return { readOnly: false, reason: 'multi-line script' }
  const bare = cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  if (bare.includes('`') || /\$\(|<\(|>\(/.test(bare)) return { readOnly: false, reason: 'runs a sub-command' }
  if (/[<>]/.test(bare)) return { readOnly: false, reason: 'redirection reads or writes files' }
  if (/;|&&|\|\||&/.test(bare)) return { readOnly: false, reason: 'chains several commands' }
  for (const seg of bare.split('|')) {
    const tokens: string[] = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const [first, ...rest] = tokens
    if (first === undefined) return { readOnly: false, reason: 'empty pipeline step' }
    if (/^\w+=/.test(first)) return { readOnly: false, reason: 'sets environment variables' }
    const program = first.replace(/^.*\//, '')
    const args = rest.map((t) => t.replace(/^['"]|['"]$/g, ''))
    if (['sudo', 'doas', 'su', 'pkexec'].includes(program)) return { readOnly: false, reason: 'runs as administrator' }
    if (program in POSIX_READ) {
      const why = POSIX_READ[program]?.(args)
      if (why) return { readOnly: false, reason: why }
      continue
    }
    if (VERSION_ONLY.has(program)) {
      if (args.length === 1 && /^(--version|-v|-V|version|-version)$/.test(args[0])) continue
      return { readOnly: false, reason: `${program} can run code` }
    }
    if (program in LISTING) {
      if (!args.length || ['--version', '-v', '-V'].includes(args[0]) || LISTING[program].includes(args[0])) continue
      return { readOnly: false, reason: `${program} ${args[0]} can change things` }
    }
    return { readOnly: false, reason: `"${program}" is not a known read-only command` }
  }
  return { readOnly: true, reason: 'only reads information' }
}
