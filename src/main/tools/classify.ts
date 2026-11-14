// Conservative classifier for PowerShell commands.
// Returns readOnly=true ONLY when every part of the command is known to just read state.
// Anything unknown is treated as a change and therefore needs the user's approval.

export interface Classification {
  readOnly: boolean
  reason: string
}

/** Verbs whose cmdlets only read, whichever cmdlet it is. */
const ALLOWED_VERBS = new Set(['get', 'select', 'where', 'sort', 'measure', 'group', 'foreach'])
/**
 * Cmdlets that only read, of verbs that also have cmdlets which change things, so they are named one by
 * one: Format-Volume formats a drive, Test-ComputerSecureChannel -Repair resets a trust, Split-WindowsImage
 * writes files.
 */
const ALLOWED_CMDLETS = new Set([
  'out-string',
  'write-output',
  'write-host',
  'out-host',
  'select-string',
  'find-package',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'format-hex',
  'test-path',
  'test-connection',
  'test-netconnection',
  'test-json',
  'resolve-path',
  'resolve-dnsname',
  'join-path',
  'join-string',
  'split-path',
  'compare-object',
  'convertto-json',
  'convertto-csv',
  'convertto-html',
  'convertto-xml',
  'convertfrom-json',
  'convertfrom-csv',
  'convertfrom-stringdata',
  'convertfrom-markdown'
])
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
  // Only as sc.exe: in Windows PowerShell a plain "sc" is Set-Content, which writes a file.
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

/** ForEach-Object, also as % and foreach. */
const FOREACH = new Set(['%', 'foreach', 'foreach-object'])

/**
 * Members that ForEach-Object may use by name. "% Name" reads a property, but "% Delete" or "% Kill"
 * calls a method on every object, so only properties known to be harmless pass (and SAFE_METHODS).
 */
const SAFE_MEMBERS = new Set(
  (
    'name fullname basename extension length directory directoryname parent root exists mode attributes lastwritetime ' +
    'creationtime lastaccesstime linktype target pspath pschildname psparentpath psiscontainer id processname path ' +
    'mainwindowtitle starttime cpu ws workingset64 pm vm handles company description productversion fileversion versioninfo ' +
    'status displayname servicename starttype count value key keys values line linenumber filename matches source version ' +
    'definition commandtype modulename hash algorithm size freespace used free caption manufacturer model driveletter ' +
    'filesystemlabel filesystem sizeremaining message timecreated providername levelname ipaddress interfacealias ' +
    'localaddress localport remoteaddress remoteport state owningprocess commandline executablepath processid ' +
    'parentprocessid title text username'
  ).split(' ')
)

/**
 * The member a ForEach-Object step uses by name when it is not known to be harmless ("% Delete").
 * Script blocks are left out: the commands in them are checked like every other command.
 */
function foreachMember(rest: string): string | undefined {
  let text = rest
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(/\{[^{}]*\}/g, ' ')
  }
  // A script block that a pipe cut in two.
  text = text.replace(/\{[^}]*$/, ' ')
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[)}\]]+$/, '')
    // Parameters (-MemberName, -Begin…) and values that are variables, strings, numbers or groups.
    if (!word || /^[-$'"(@\d[]/.test(word)) continue
    if (!SAFE_MEMBERS.has(word.toLowerCase()) && !SAFE_METHODS.has(word.toLowerCase())) return word
  }
  return undefined
}

/** Options of `git branch` that only list branches. */
const BRANCH_LIST_FLAG =
  /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|-i|--ignore-case|--omit-empty|--no-abbrev|--abbrev=\d+|--no-color|--color(=\w+)?|--no-column|--column(=[\w,]+)?|--(sort|format|contains|no-contains|merged|no-merged|points-at)=.*)$/
/** Options of `git branch` whose value is the next word (a commit, a sort key, a format). */
const BRANCH_VALUE = /^--(sort|format|contains|no-contains|merged|no-merged|points-at)$/

/** `git branch` that only lists: listing options, and name patterns after --list. (Arguments are in lower case.) */
function branchListsOnly(args: string[]): boolean {
  const list = args.includes('-l') || args.includes('--list')
  for (let i = 0; i < args.length; i++) {
    const x = args[i]
    if (BRANCH_VALUE.test(x)) i++
    else if (!BRANCH_LIST_FLAG.test(x) && !(list && !x.startsWith('-'))) return false
  }
  return true
}

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
      // Options that write a file (git diff --output=x) or start another program, whatever the command.
      if (a.some((x) => /^--(output|ext-diff|open-files-in-pager)(=|$)/.test(x))) return 'git can write a file or start a program with that option'
      const ok = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', '--version']
      if (ok.includes(sub)) return
      if (sub === 'reflog') return ['expire', 'delete', 'drop'].includes(a[1] ?? '') ? `git reflog ${a[1]} deletes history` : undefined
      if (sub === 'branch') return branchListsOnly(a.slice(1)) ? undefined : 'git branch with these options creates, moves or changes a branch'
      if (sub === 'remote') {
        const rest = a.slice(1).filter((x) => x !== '-v' && x !== '--verbose')
        return !rest.length || rest[0] === 'show' || rest[0] === 'get-url' ? undefined : `git remote ${rest[0]} changes the repository's remotes`
      }
      if (sub === 'config' && (a[1] === 'get' || a[1] === 'list' || a.some((x) => ['--get', '--list', '-l', '--get-all'].includes(x)))) return
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
  // PowerShell reads en and em dashes as "-" (Remove–Item, –Force), so the checks below do too.
  const bare = stripStrings(cmd).replace(/[\u2013\u2014\u2015]/g, '-')
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
  // Setting a property or a variable: (Get-Item x).IsReadOnly = $true changes the file. (Program options
  // such as --format=csv have a plain word before the "=", so they do not count.)
  if (/(?:\$[\w:]+|[)\]}]|\.\w+)\s*(?:\?\?|[-+*/%])?=(?!=)/.test(bare)) return { readOnly: false, reason: 'sets a property or variable' }
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
  // Parenthesised sub-pipelines run commands too, e.g. Get-Item (ri x), and so does the pipeline of a
  // foreach statement: foreach ($x in rd C:\x) { … } runs rd.
  for (const m of bare.matchAll(/\(\s*([^()|]+)/g)) starts.push(m[1].replace(/^\$[\w:{}]+\s+in\s+/i, ''))
  for (const seg of starts) {
    const tokens = tokenizeArgs(seg)
    const rawFirst = (tokens[0] ?? '').replace(/^\(+/, '')
    if (!rawFirst || /^[$['"\d\-)]/.test(rawFirst)) continue
    const word = (rawFirst.match(/^[A-Za-z0-9_.\-?%]+/)?.[0] ?? rawFirst).toLowerCase()
    const program = word.replace(/\.exe$/, '')
    if (FOREACH.has(word)) {
      const rest = seg.trim().replace(/^\(+/, '').slice(word.length)
      // The foreach statement, foreach ($x in …) { … }: its pipeline and block are checked as starts of their own.
      if (/^\s*\(/.test(rest)) continue
      const member = foreachMember(rest)
      if (member) return { readOnly: false, reason: `ForEach-Object ${member} may call a method that changes every object` }
      continue
    }
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
