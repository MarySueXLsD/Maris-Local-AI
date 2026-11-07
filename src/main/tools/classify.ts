// Conservative classifier for PowerShell commands.
// Returns readOnly=true ONLY when every part of the command is known to just read state.
// Anything unknown is treated as a change and therefore needs the user's approval.

export interface Classification {
  readOnly: boolean
  reason: string
}

const ALLOWED_VERBS = new Set([
  'get',
  'select',
  'where',
  'sort',
  'measure',
  'format',
  'group',
  'test',
  'resolve',
  'join',
  'split',
  'compare',
  'convertto',
  'convertfrom',
  'foreach'
])
const ALLOWED_CMDLETS = new Set(['out-string', 'write-output', 'write-host', 'out-host', 'select-string', 'find-package'])
const DENIED_CMDLETS = new Set(['get-credential', 'convertto-securestring', 'convertfrom-securestring'])

// Bare commands (aliases and console programs) allowed at the start of a pipeline segment.
const ALLOWED_PROGRAMS = new Set([
  'dir',
  'ls',
  'gci',
  'gc',
  'cat',
  'type',
  'pwd',
  'gl',
  'gi',
  'gp',
  'gps',
  'ps',
  'gsv',
  'gcm',
  'gm',
  'echo',
  'select',
  'sort',
  'where',
  'where.exe',
  '?',
  '%',
  'foreach',
  'ft',
  'fl',
  'fw',
  'measure',
  'group',
  'sls',
  'whoami',
  'hostname',
  'ipconfig',
  'systeminfo',
  'tasklist',
  'ver',
  'findstr',
  'netstat',
  'nslookup',
  'ping',
  'tracert',
  'getmac',
  'driverquery',
  'nvidia-smi',
  'git',
  'node',
  'python',
  'py',
  'npm',
  'winget',
  'reg',
  'sc',
  'sc.exe',
  'schtasks',
  'wsl'
])

const SAFE_METHODS = new Set([
  'tostring',
  'toupper',
  'tolower',
  'trim',
  'trimend',
  'trimstart',
  'split',
  'substring',
  'contains',
  'startswith',
  'endswith',
  'replace',
  'indexof',
  'gettype',
  'equals',
  'padleft',
  'padright',
  'getfiles',
  'getdirectories'
])

const SAFE_STATICS =
  /^\[(math|system\.math)\]::\w+$|^\[(datetime|system\.datetime)\]::(now|utcnow|today)$|^\[(environment|system\.environment)\]::(getfoldertpath|getfolderpath|osversion|machinename|username|processorcount|is64bitoperatingsystem|getenvironmentvariable|tickcount64|version)$|^\[(system\.io\.path|io\.path)\]::(getfilename|getextension|getdirectoryname|combine|gettemppath|getfilenamewithoutextension)$|^\[(system\.io\.driveinfo|io\.driveinfo)\]::getdrives$/i

function stripStrings(cmd: string): string {
  // Remove single-quoted and double-quoted strings (PowerShell doubles quotes to escape them).
  return cmd.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.|"")*"/g, '""')
}

function splitSegments(cmd: string): string[] {
  return cmd
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
}

function checkProgramArgs(program: string, args: string[]): string | undefined {
  const a = args.map((x) => x.toLowerCase())
  const joined = a.join(' ')
  switch (program) {
    case 'ipconfig':
      if (/\/(release|renew|flushdns|registerdns|setclassid)/.test(joined)) return 'ipconfig would change network settings'
      return
    case 'nvidia-smi':
      for (const x of a) {
        if (!/^(-l|-q|-L|--list-gpus|--query[-\w]*(=.*)?|--format=.*|-i|\d+|-d|\w+|--id=.*|-lms|-l\d*)$/i.test(x) || /^-(pl|pm|ac|rac|r|c|e|am|lgc|rgc|lmc|rmc|mig)$/.test(x) || /--(power-limit|persistence-mode|applications-clocks|gpu-reset|compute-mode|ecc-config)/.test(x))
          return 'nvidia-smi option could change GPU settings'
      }
      return
    case 'git': {
      const sub = a[0]
      if (!sub) return
      const ok = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog', '--version']
      if (ok.includes(sub)) return
      if (sub === 'branch' && !a.some((x) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(x)) && a.length <= 3)
        return a.slice(1).every((x) => x.startsWith('-')) ? undefined : 'git branch with a name creates a branch'
      if (sub === 'remote' && (a.length === 1 || a[1] === '-v' || a[1] === 'show')) return
      if (sub === 'config' && a.some((x) => ['--get', '--list', '-l', '--get-all'].includes(x))) return
      if (sub === 'tag' && (a.length === 1 || a[1] === '-l' || a[1] === '--list')) return
      return `git ${sub} may change the repository`
    }
    case 'node':
    case 'python':
    case 'py':
      return a.length === 1 && ['--version', '-v', '-V'.toLowerCase()].includes(a[0]) ? undefined : `${program} would run code`
    case 'npm':
      return ['ls', 'list', 'view', 'outdated', '--version', '-v', 'root', 'prefix'].includes(a[0] ?? '') ||
        (a[0] === 'config' && a[1] === 'get')
        ? undefined
        : `npm ${a[0] ?? ''} may change packages`
    case 'winget':
      return ['list', 'search', 'show', '--version', '--info'].includes(a[0] ?? '') ? undefined : `winget ${a[0] ?? ''} may install or change software`
    case 'reg':
      return a[0] === 'query' ? undefined : 'reg would modify the registry'
    case 'sc':
    case 'sc.exe':
      return ['query', 'qc', 'queryex', 'qdescription'].includes(a[0] ?? '') ? undefined : 'sc would change a service'
    case 'schtasks':
      return a[0] === '/query' ? undefined : 'schtasks would change scheduled tasks'
    case 'wsl':
      return ['-l', '--list', '--status', '--version', '-v'].includes(a[0] ?? '') ? undefined : 'wsl would run commands'
    case 'ping':
    case 'tracert':
    case 'nslookup':
      return
    default:
      return
  }
}

function tokenizeArgs(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

const COMPOUND = /[\r\n;&|<>`]|\$\(|@\(/
/** Code that runs even inside double quotes: $(...) and @(...) in PowerShell, $(...) and `...` in bash. */
const INNER_CODE = /\$\(|@\(|`/

/**
 * The short prefix a user can choose to always allow, e.g. "cargo test", "dotnet build",
 * "python -m pytest" or "npm run dev". Compound commands get no prefix.
 */
export function commandPrefix(command: string): string | undefined {
  const cmd = command.trim()
  if (!cmd || COMPOUND.test(stripStrings(cmd)) || INNER_CODE.test(cmd)) return undefined
  const tokens = cmd.split(/\s+/)
  const first = tokens[0]
  if (!first || /^[.&$(\[]/.test(first) || /[\\/:]/.test(first)) return undefined
  const out = [first]
  const wordLike = (t: string): boolean => /^[A-Za-z][\w.:+-]*$/.test(t)
  const firstLower = first.toLowerCase().replace(/\.exe$/, '')
  for (let i = 1; i < tokens.length && out.length < 3; i++) {
    const t = tokens[i]
    if ((firstLower === 'python' || firstLower === 'py') && i === 1 && t === '-m') {
      out.push(t)
      continue
    }
    if (!wordLike(t)) break
    out.push(t)
    // Most tools need only "tool verb"; runners like "npm run x", "python -m x" and "haxelib run x" keep one more word.
    const runner = ['npm', 'pnpm', 'yarn', 'haxelib', 'lime', 'openfl'].includes(firstLower) && ['run', 'test', 'build'].includes(out[1]?.toLowerCase())
    if (!(out[1] === '-m' || runner) && out.length >= 2) break
  }
  return out.join(' ')
}

/** Returns the matching allowed prefix when `command` is a plain (non-compound) use of it. */
export function matchesAllowed(command: string, prefixes: string[]): string | undefined {
  const cmd = command.trim()
  if (!cmd || COMPOUND.test(stripStrings(cmd)) || INNER_CODE.test(cmd)) return undefined
  const lower = cmd.toLowerCase()
  return prefixes.find((p) => {
    const q = p.toLowerCase()
    return lower === q || lower.startsWith(q + ' ')
  })
}

export function classifyCommand(command: string): Classification {
  const cmd = command.trim()
  if (!cmd) return { readOnly: false, reason: 'empty command' }
  if (/[\r\n]/.test(cmd)) return { readOnly: false, reason: 'multi-line script' }
  if (cmd.includes('`')) return { readOnly: false, reason: 'escape characters' }
  if (/\$\(/.test(cmd) || /@\(/.test(cmd)) return { readOnly: false, reason: 'sub-expression' }
  const bare = stripStrings(cmd)
  if (/[<>]/.test(bare)) return { readOnly: false, reason: 'redirection writes to a file' }
  if (/;|&&|\|\||&/.test(bare)) return { readOnly: false, reason: 'chains several commands' }
  if (/(^|[\s|({])\.\s*[\\/{.]/.test(bare) || /(^|[\s|({])\.\\/.test(bare)) return { readOnly: false, reason: 'runs a script' }
  if (/-enc(odedcommand)?\b/i.test(bare)) return { readOnly: false, reason: 'encoded command' }

  // Static .NET calls
  for (const m of bare.matchAll(/\[[\w.]+\]::\w+/g)) {
    if (!SAFE_STATICS.test(m[0])) return { readOnly: false, reason: `.NET call ${m[0]}` }
  }
  // Method calls on objects, e.g. (Get-Item x).Delete()
  for (const m of bare.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) {
    if (!SAFE_METHODS.has(m[1].toLowerCase())) return { readOnly: false, reason: `method call .${m[1]}()` }
  }
  // Every cmdlet anywhere in the command (including inside script blocks) must be read-only.
  for (const m of bare.matchAll(/(?<![\w.\-\\/:])([A-Za-z]+)-([A-Za-z][\w]*)(?![\w-]*[:\\/])/g)) {
    const name = `${m[1]}-${m[2]}`.toLowerCase()
    const verb = m[1].toLowerCase()
    // Skip parameters like -Recurse (preceded by whitespace and a dash, handled by the lookbehind) and operators.
    if (DENIED_CMDLETS.has(name)) return { readOnly: false, reason: `${name} is not allowed` }
    if (ALLOWED_CMDLETS.has(name) || ALLOWED_VERBS.has(verb) || ALLOWED_PROGRAMS.has(name)) continue
    return { readOnly: false, reason: `${m[1]}-${m[2]} can change things` }
  }
  // The first word of each pipeline segment (and of each script block statement) must be known.
  const starts: string[] = []
  for (const seg of splitSegments(bare)) starts.push(seg)
  for (const m of bare.matchAll(/\{\s*([^{}|]+)/g)) starts.push(m[1])
  // Parenthesised sub-pipelines run commands too, e.g. Get-Item (ri x)
  for (const m of bare.matchAll(/\(\s*([^()|]+)/g)) starts.push(m[1])
  for (const seg of starts) {
    const tokens = tokenizeArgs(seg)
    const rawFirst = (tokens[0] ?? '').replace(/^\(+/, '')
    if (!rawFirst || /^[$['"\d\-)]/.test(rawFirst)) continue
    const word = (rawFirst.match(/^[A-Za-z0-9_.\-?%]+/)?.[0] ?? rawFirst).toLowerCase()
    const program = word.replace(/\.exe$/, '')
    if (ALLOWED_PROGRAMS.has(program) || ALLOWED_PROGRAMS.has(word)) {
      const why = checkProgramArgs(program, tokens.slice(1))
      if (why) return { readOnly: false, reason: why }
      continue
    }
    if (/^[a-z]+-[a-z]\w*$/i.test(word)) continue // cmdlets were checked above
    return { readOnly: false, reason: `"${tokens[0]}" is not a known read-only command` }
  }
  return { readOnly: true, reason: 'only reads information' }
}
