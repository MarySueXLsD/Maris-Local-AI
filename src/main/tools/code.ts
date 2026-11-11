import { nativeImage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { settings } from '../settings'
import { formatBytes, truncate, uid } from '../util'
import { commandPrefix } from './classify'
import { applyEdit, backup, decode, encodeLike, isBinary, makeDiff, readTextFile, riskFor, SKIP_DIRS, systemNote } from './fs'
import { resolvePath } from './paths'
import { processes } from './processes'
import { isElevated, IS_MAC, IS_WIN, SHELL_LABEL } from '../platform'
import { needsAdmin } from './keys'
import { runPosix, runPowerShell, runShell } from './shell'
import { bool, num, schema, str, ToolError, type ToolDef } from './types'

// Dependency and cache folders that are never worth searching, whatever the project.
const ALWAYS_SKIP = new Set([
  ...SKIP_DIRS,
  '.vs',
  '.idea',
  '.haxelib',
  '.godot',
  '.gradle',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'bower_components',
  'cmake-build-debug',
  'cmake-build-release'
])

/**
 * Build output of one kind of project, skipped only next to the files that mark that kind. The same
 * name means different things in different projects: "bin" beside a .csproj is build output, in a Node
 * project it holds the command-line scripts; "packages" beside a .sln is NuGet's cache, in a JavaScript
 * monorepo it is where all the code lives. (Skipping these by name alone hid whole projects from
 * project_tree and grep.) What a project's own .gitignore lists is skipped as well.
 */
const OUTPUT_DIRS: [name: string, beside: RegExp][] = [
  ['bin', /\.(csproj|fsproj|vbproj|sln|slnx)$/i],
  ['obj', /\.(csproj|fsproj|vbproj|vcxproj|sln|slnx)$/i],
  ['packages', /^(packages\.config|nuget\.config)$|\.sln$/i],
  ['target', /^(cargo\.toml|pom\.xml)$/i],
  ['export', /^project\.xml$|\.hxml$/i],
  ['library', /^projectsettings$/i],
  ['temp', /^projectsettings$/i],
  ['dist', /^(package\.json|pyproject\.toml|setup\.py)$/i],
  ['build', /^(package\.json|cmakelists\.txt|build\.gradle(\.kts)?|pyproject\.toml|setup\.py|meson\.build)$/i],
  ['out', /^(package\.json|tsconfig\.json|cmakelists\.txt)$/i],
  ['x64', /\.(vcxproj|sln)$/i],
  ['debug', /\.(vcxproj|sln)$|^cmakelists\.txt$/i],
  ['release', /\.(vcxproj|sln)$|^cmakelists\.txt$/i]
]

/** Whether a folder is left out of code searches. `siblings`: the names next to it. */
export function skipCodeDir(name: string, siblings: string[]): boolean {
  const lower = name.toLowerCase()
  if (ALWAYS_SKIP.has(lower) || (name.startsWith('.') && name !== '.github')) return true
  return OUTPUT_DIRS.some(([n, beside]) => n === lower && siblings.some((s) => beside.test(s)))
}

export function globToRegex(glob: string): RegExp {
  let re = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++
      } else re += '[^\\\\/]*'
    } else if (c === '?') re += '[^\\\\/]'
    else if (c === '{') {
      braces++
      re += '('
    } else if (c === '}' && braces > 0) {
      braces--
      re += ')'
    }
    // A comma separates alternatives only inside braces: "*.{ts,tsx}". Elsewhere it is a comma.
    else if (c === ',') re += braces > 0 ? '|' : ','
    else if (c === '/' || c === '\\') re += '[\\\\/]'
    else if ('.+^$()|[]{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`^${re}${')'.repeat(braces)}$`, 'i')
}

/** A list argument: models sometimes send it as a JSON string instead of a list. */
function asList(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as unknown
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Very small .gitignore support: name/glob patterns and folder patterns at the root. */
function gitignore(root: string): ((rel: string, isDir: boolean) => boolean) | undefined {
  const file = path.join(root, '.gitignore')
  if (!existsSync(file)) return undefined
  const rules = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const dirOnly = l.endsWith('/')
      const anchored = l.startsWith('/') || l.replace(/\/$/, '').includes('/')
      const pat = l.replace(/^\//, '').replace(/\/$/, '')
      return { rx: globToRegex(pat), dirOnly, anchored }
    })
  return (rel, isDir) => {
    const norm = rel.replace(/\\/g, '/')
    const base = norm.split('/').pop() ?? norm
    return rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.rx.test(norm) : r.rx.test(base)))
  }
}

async function* walkFiles(root: string, limit = 20000): AsyncGenerator<string> {
  const ignored = gitignore(root)
  const queue = [root]
  let n = 0
  while (queue.length) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const names = entries.map((e) => e.name)
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      if (e.isDirectory()) {
        if (skipCodeDir(e.name, names)) continue
        if (ignored?.(rel, true)) continue
        queue.push(full)
      } else if (e.isFile()) {
        if (ignored?.(rel, false)) continue
        yield full
        if (++n >= limit) return
      }
    }
  }
}

let devEnvCache: { at: number; text: string } | undefined

const DEV_ENV_SCRIPT = String.raw`
function V($name, [scriptblock]$probe) {
  $exe = $name.Split(' ')[0]
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { "$($name): not installed"; return }
  try { $o = (& $probe 2>&1 | Select-Object -First 3) -join ' ; '; if (-not $o) { $o = 'installed (nothing listed)' }; "$($name): $o" } catch { "$($name): installed" }
}
V 'dotnet' { dotnet --list-sdks }
V 'rustc' { rustc --version }
V 'cargo' { cargo --version }
V 'python' { python --version }
V 'py' { py -0p }
V 'node' { node --version }
V 'npm' { npm --version }
V 'haxe' { haxe --version }
V 'haxelib' { haxelib list | Select-String -Pattern '^(flixel|lime|openfl|hxcpp|flixel-tools|flixel-addons)\b' }
V 'git' { git --version }
V 'cmake' { cmake --version }
V 'ninja' { ninja --version }
V 'clang' { clang --version }
V 'gcc' { gcc --version }
V 'java' { java -version }
V 'go' { go version }
$vswhere = Join-Path ${'$'}{env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($vs) { "msvc: Visual Studio C++ tools at $vs (use a Developer PowerShell or vcvars64.bat for cl.exe)" } else { 'msvc: Visual Studio installed without C++ tools' }
} else { 'msvc: not installed' }
"windows: " + (Get-CimInstance Win32_OperatingSystem).Caption + " build " + [Environment]::OSVersion.Version.Build
`

// The same report for bash/zsh. Plain strings (no template literal) so the shell's ${...} stays intact.
const DEV_ENV_POSIX = [
  'v() { name="$1"; shift; exe="${1}"; if ! command -v "$exe" >/dev/null 2>&1; then echo "$name: not installed"; return; fi;',
  '  out=$("$@" 2>&1 | head -n 3 | tr "\\n" ";" ); echo "$name: ${out:-installed}"; }',
  'v dotnet dotnet --list-sdks',
  'v rustc rustc --version',
  'v cargo cargo --version',
  'v python python3 --version',
  'v node node --version',
  'v npm npm --version',
  'v haxe haxe --version',
  'if command -v haxelib >/dev/null 2>&1; then echo "haxelib: $(haxelib list 2>/dev/null | grep -E "^(flixel|lime|openfl|hxcpp|flixel-tools|flixel-addons)[: ]" | tr "\\n" ";")"; else echo "haxelib: not installed"; fi',
  'v git git --version',
  'v cmake cmake --version',
  'v ninja ninja --version',
  'v clang clang --version',
  'v gcc gcc --version',
  'v java java -version',
  'v go go version',
  'v brew brew --version',
  'if [ "$(uname)" = "Darwin" ]; then if xcode-select -p >/dev/null 2>&1; then echo "xcode: command line tools at $(xcode-select -p)"; else echo "xcode: not installed"; fi; fi',
  'echo "os: $(uname -srm)"'
].join('\n')

/** Installed toolchains (cached for 10 minutes; `force` re-checks, e.g. after an install). */
export async function devEnvReport(force = false): Promise<string> {
  if (!force && devEnvCache && Date.now() - devEnvCache.at < 10 * 60000) return devEnvCache.text
  const r = IS_WIN ? await runPowerShell(DEV_ENV_SCRIPT, { timeoutMs: 90000 }) : await runPosix(DEV_ENV_POSIX, { timeoutMs: 90000 })
  const text = r.stdout || r.stderr || 'Could not detect tools.'
  devEnvCache = { at: Date.now(), text }
  return text
}

export const codeTools: ToolDef[] = [
  {
    name: 'project_tree',
    risk: 'read',
    description:
      'Show the folder structure of the project (or any folder) as an indented tree, skipping build output, dependencies and .gitignored files. Start here to understand a codebase.',
    parameters: schema({
      path: { type: 'string', description: 'Folder (default: project root)' },
      depth: { type: 'integer', description: 'Levels to show (default 3, max 6)' }
    }),
    async prepare(args, ctx) {
      return { risk: 'read', title: `Map ${args.path ? resolvePath(String(args.path), ctx.cwd) : ctx.cwd}` }
    },
    async run(args, ctx) {
      const root = args.path ? resolvePath(String(args.path), ctx.cwd) : ctx.cwd
      const depth = Math.max(1, Math.min(6, num(args.depth, 3)))
      const ignored = gitignore(root)
      const lines: string[] = []
      let count = 0
      const walk = async (dir: string, level: number): Promise<void> => {
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        const names = entries.map((e) => e.name)
        entries = entries
          .filter((e) => !(e.isDirectory() && skipCodeDir(e.name, names)))
          .filter((e) => !ignored?.(path.relative(root, path.join(dir, e.name)), e.isDirectory()))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        const shown = entries.slice(0, 60)
        for (const e of shown) {
          if (count >= 700) return
          count++
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            lines.push(`${'  '.repeat(level)}${e.name}/`)
            if (level + 1 < depth) await walk(full, level + 1)
          } else {
            const st = await fs.stat(full).catch(() => undefined)
            lines.push(`${'  '.repeat(level)}${e.name}${st ? `  ${formatBytes(st.size)}` : ''}`)
          }
        }
        if (entries.length > shown.length) lines.push(`${'  '.repeat(level)}… ${entries.length - shown.length} more`)
      }
      await walk(root, 0)
      return `${root}\n${lines.join('\n') || '(empty)'}${count >= 700 ? '\n… (tree truncated; use a deeper path)' : ''}`
    }
  },
  {
    name: 'grep',
    risk: 'read',
    description:
      'Search file contents with a regular expression across the project (skips build output, dependencies and .gitignored files). Returns path:line: text. Use to find definitions, usages, TODOs or error messages.',
    parameters: schema(
      {
        pattern: { type: 'string', description: 'Regular expression (JavaScript syntax), e.g. class\\s+Player' },
        path: { type: 'string', description: 'Folder or file to search (default: project root)' },
        glob: { type: 'string', description: 'Only files matching this name glob, e.g. *.cs or *.{hx,xml}' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive (default true)' },
        context: { type: 'integer', description: 'Lines of context around each match (0-5, default 0)' },
        max_results: { type: 'integer', description: 'Max matches (default 80)' }
      },
      ['pattern']
    ),
    async prepare(args) {
      return { risk: 'read', title: `Search code for /${str(args.pattern, 'pattern')}/${args.glob ? ` in ${args.glob}` : ''}` }
    },
    async run(args, ctx) {
      let rx: RegExp
      try {
        rx = new RegExp(str(args.pattern, 'pattern'), bool(args.ignore_case, true) ? 'i' : '')
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${(e as Error).message}`)
      }
      const target = args.path ? resolvePath(String(args.path), ctx.cwd) : ctx.cwd
      const glob = args.glob ? globToRegex(String(args.glob)) : undefined
      const ctxLines = Math.max(0, Math.min(5, num(args.context, 0)))
      const max = Math.max(1, Math.min(400, num(args.max_results, 80)))
      const st = await fs.stat(target).catch(() => undefined)
      if (!st) throw new ToolError(`Not found: ${target}`)
      const files: AsyncIterable<string> = st.isFile() ? (async function* () { yield target })() : walkFiles(target)
      const out: string[] = []
      let matches = 0
      let scanned = 0
      const started = Date.now()
      for await (const f of files) {
        if (matches >= max || Date.now() - started > 20000 || ctx.signal.aborted) break
        if (glob && !glob.test(path.basename(f))) continue
        const size = (await fs.stat(f).catch(() => undefined))?.size ?? 0
        if (size > 1.5 * 2 ** 20) continue
        const buf = await fs.readFile(f).catch(() => undefined)
        if (!buf || isBinary(buf)) continue
        scanned++
        const lines = decode(buf).split(/\r?\n/)
        const rel = path.relative(ctx.cwd, f) || f
        for (let i = 0; i < lines.length && matches < max; i++) {
          if (!rx.test(lines[i])) continue
          matches++
          if (ctxLines) {
            const from = Math.max(0, i - ctxLines)
            const to = Math.min(lines.length - 1, i + ctxLines)
            out.push(`${rel}:${i + 1}:`)
            for (let j = from; j <= to; j++) out.push(`${j === i ? '>' : ' '} ${j + 1}│${lines[j].slice(0, 240)}`)
          } else out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
        }
      }
      return `${matches} match(es) in ${scanned} file(s)${matches >= max ? ' (limit reached)' : ''}\n${out.join('\n') || '(no matches)'}`
    }
  },
  {
    name: 'multi_edit',
    risk: 'change',
    description:
      'Apply several exact text replacements to ONE file in a single step (all or nothing). Each old_text must match the file exactly and be unique unless replace_all. Use for refactors touching several places in a file.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          description: 'Replacements, applied in order',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string', description: 'Exact text to find' },
              new_text: { type: 'string', description: 'Replacement' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence' }
            },
            required: ['old_text', 'new_text']
          }
        }
      },
      ['path', 'edits']
    ),
    async prepare(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const { text } = await readTextFile(p)
      const next = applyAll(text, args.edits)
      return { risk: riskFor(p), title: `Edit ${p} (${asList(args.edits)?.length ?? 0} changes)`, detail: systemNote(p), preview: makeDiff(p, text, next, false), targets: [p] }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const { text, raw } = await readTextFile(p)
      const next = applyAll(text, args.edits)
      const bak = await backup(p)
      if (bak) ctx.reportBackup(bak)
      await fs.writeFile(p, encodeLike(raw, next))
      return `Applied ${asList(args.edits)?.length ?? 0} edit(s) to ${p}${bak ? ` (backup: ${bak})` : ''}`
    }
  },
  {
    name: 'view_image',
    risk: 'read',
    description: 'Look at an image file (screenshot, sprite, UI mockup, diagram). Requires a vision-capable model.',
    parameters: schema({ path: { type: 'string', description: 'Image file path (png, jpg, webp, bmp, gif)' } }, ['path']),
    async prepare(args, ctx) {
      return { risk: 'read', title: `Look at ${resolvePath(str(args.path, 'path'), ctx.cwd)}` }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      if (!existsSync(p)) throw new ToolError(`Image not found: ${p}`)
      let img = nativeImage.createFromPath(p)
      if (img.isEmpty()) throw new ToolError('Not a picture this computer can read (PNG and JPEG always work).')
      const { width, height } = img.getSize()
      ctx.setPreview(`data:image/jpeg;base64,${img.resize({ width: Math.min(480, width) }).toJPEG(70).toString('base64')}`)
      if (!ctx.modelSupportsVision) return `Image ${width}x${height}. The current model cannot see pictures. Tell the user to pick a model that can (Models lists which ones "see images").`
      const scale = Math.min(1, 1280 / Math.max(width, height))
      if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
      ctx.attachImageForModel(img.toJPEG(85).toString('base64'), `Image ${path.basename(p)} (${width}x${height})`)
      return `Image ${path.basename(p)} is ${width}x${height}. It is attached for you to look at.`
    }
  },
  {
    name: 'start_process',
    risk: 'system',
    description:
      'Start a long-running command in the background (dev server, file watcher, game in test mode) and return its id. Read its output with process_output and end it with stop_process. Needs approval unless the user always-allowed the command.',
    parameters: schema(
      {
        command: { type: 'string', description: `${SHELL_LABEL} command, e.g. npm run dev` },
        cwd: { type: 'string', description: 'Working folder (default: project root)' },
        name: { type: 'string', description: 'Short label' }
      },
      ['command']
    ),
    async prepare(args, ctx) {
      const command = str(args.command, 'command')
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd
      return {
        risk: 'system',
        title: `Start in background: ${command.slice(0, 90)}`,
        preview: { kind: 'command', command, cwd, shell: `${SHELL_LABEL} (background)` },
        allowPrefix: commandPrefix(command)
      }
    },
    async run(args, ctx) {
      const command = str(args.command, 'command')
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd
      const p = processes.start(command, cwd, ctx.conversationId, args.name ? String(args.name) : undefined)
      await new Promise((r) => setTimeout(r, 4000))
      return `Started process ${p.id}.\n${processes.output(p.id, 40)}`
    }
  },
  {
    name: 'process_output',
    risk: 'read',
    description: 'Read the latest output of a background process started with start_process.',
    parameters: schema(
      {
        id: { type: 'string', description: 'Process id' },
        tail_lines: { type: 'integer', description: 'How many recent lines (default 80)' }
      },
      ['id']
    ),
    async prepare(args) {
      return { risk: 'read', title: `Read output of process ${str(args.id, 'id')}` }
    },
    async run(args) {
      return processes.output(str(args.id, 'id'), num(args.tail_lines, 80))
    }
  },
  {
    name: 'stop_process',
    risk: 'read',
    description: 'Stop a background process that Maris started (start_process). Cannot stop other programs.',
    parameters: schema({ id: { type: 'string', description: 'Process id' } }, ['id']),
    async prepare(args) {
      return { risk: 'read', title: `Stop process ${str(args.id, 'id')}` }
    },
    async run(args) {
      return processes.stop(str(args.id, 'id')) ? `Stopped ${args.id}` : `No process ${args.id}`
    }
  },
  {
    name: 'dev_environment',
    risk: 'read',
    description: `List the installed developer toolchains and versions: .NET SDKs, Rust, Python, Node, Haxe/HaxeFlixel libraries, Git, CMake, ${IS_WIN ? 'MSVC C++ tools, ' : IS_MAC ? 'Xcode command line tools, ' : ''}clang/gcc, Java, Go. Check this before building or suggesting installs.`,
    parameters: schema({}),
    async prepare() {
      return { risk: 'read', title: 'Check installed developer tools' }
    },
    async run() {
      return devEnvReport()
    }
  },
  {
    name: 'update_plan',
    risk: 'read',
    description:
      'Keep a short visible checklist for multi-step work. Call it at the start of a larger task and again whenever a step starts or finishes. Statuses: pending, in_progress, done.',
    parameters: schema(
      {
        steps: {
          type: 'array',
          description: 'All steps in order',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Step description' },
              status: { type: 'string', description: 'pending, in_progress or done', enum: ['pending', 'in_progress', 'done'] }
            },
            required: ['text', 'status']
          }
        }
      },
      ['steps']
    ),
    async prepare() {
      return { risk: 'read', title: 'Plan' }
    },
    async run(args) {
      const steps = (asList(args.steps) ?? []) as { text: string; status: string }[]
      const done = steps.filter((s) => s.status === 'done').length
      return `Plan updated: ${done}/${steps.length} done.`
    }
  },
  {
    name: 'run_script',
    risk: 'system',
    description: IS_WIN
      ? 'Run a multi-line script and return its output. language: powershell (full Windows access: .NET, WMI/CIM, COM, registry, and Win32 APIs through Add-Type with C# P/Invoke), python or node. The user must approve.'
      : `Run a multi-line script and return its output. language: ${IS_MAC ? 'zsh/bash (with macOS tools such as osascript, defaults, system_profiler)' : 'bash'}, python or node. The user must approve.`,
    parameters: schema(
      {
        language: { type: 'string', description: 'Script language', enum: IS_WIN ? ['powershell', 'python', 'node'] : ['bash', 'python', 'node'] },
        code: { type: 'string', description: 'The script' },
        cwd: { type: 'string', description: 'Working folder (default: project root or home)' },
        timeout_sec: { type: 'integer', description: 'Max runtime (default 120)' }
      },
      ['language', 'code']
    ),
    async prepare(args, ctx) {
      const lang = str(args.language, 'language')
      const code = str(args.code, 'code')
      if ((lang === 'powershell' || lang === 'bash') && needsAdmin(code, process.platform) && !isElevated()) {
        throw new ToolError(
          ctx.settings.agent.fullControl
            ? 'This script needs administrator rights, so it was not run. Run it with run_as_admin instead.'
            : 'This script needs administrator rights, so it was not run, and full control is off. Call request_full_control with the reason, then wait; do not claim it was done.'
        )
      }
      return {
        risk: 'system',
        title: `Run a ${lang} script (${code.split('\n').length} lines)`,
        preview: { kind: 'command', command: code, cwd: args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd, shell: lang }
      }
    },
    async run(args, ctx) {
      const lang = str(args.language, 'language')
      const code = str(args.code, 'code')
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd
      const timeoutMs = Math.min(1800, Math.max(5, num(args.timeout_sec, settings.get().agent.commandTimeoutSec))) * 1000
      if (lang === 'powershell' || lang === 'bash' || lang === 'sh' || lang === 'zsh') {
        const r = await runShell(code, { cwd, timeoutMs, signal: ctx.signal })
        return `(exit ${r.code ?? '?'}${r.timedOut ? ', timed out' : ''})\n${truncate([r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)', 24000)}`
      }
      const dir = path.join(os.tmpdir(), 'maris-scripts')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${uid()}.${lang === 'python' ? 'py' : 'mjs'}`)
      await fs.writeFile(file, code, 'utf8')
      try {
        const exe = lang === 'python' ? (IS_WIN ? 'python' : 'python3') : 'node'
        const r = IS_WIN
          ? await runPowerShell(`& ${exe} '${file.replace(/'/g, "''")}'`, { cwd, timeoutMs, signal: ctx.signal })
          : await runPosix(`${exe} '${file.replace(/'/g, `'\\''`)}'`, { cwd, timeoutMs, signal: ctx.signal })
        return `(exit ${r.code ?? '?'}${r.timedOut ? ', timed out' : ''})\n${truncate([r.stdout, r.stderr].filter(Boolean).join('\n') || '(no output)', 24000)}`
      } finally {
        await fs.rm(file, { force: true })
      }
    }
  }
]

function applyAll(text: string, given: unknown): string {
  const edits = asList(given)
  if (!edits?.length) throw new ToolError('edits must be a non-empty list of { old_text, new_text } objects')
  let out = text
  edits.forEach((e, i) => {
    const ed = e as { old_text?: string; new_text?: string; replace_all?: boolean }
    try {
      out = applyEdit(out, String(ed.old_text ?? ''), String(ed.new_text ?? ''), Boolean(ed.replace_all))
    } catch (err) {
      throw new ToolError(`Edit ${i + 1}: ${(err as Error).message}`)
    }
  })
  return out
}
