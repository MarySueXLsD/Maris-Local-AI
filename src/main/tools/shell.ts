import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { settings } from '../settings'
import { truncate } from '../util'
import { isElevated, IS_WIN, OS_LABEL, posixShell, SHELL_LABEL } from '../platform'
import { needsAdmin } from './keys'
import { classifyCommand, commandPrefix } from './classify'
import { installInfo } from './installInfo'
import { classifyPosixCommand } from './classifyPosix'
import { resolvePath } from './paths'
import { num, schema, str, ToolError, type ToolDef } from './types'

export interface PsResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  ms: number
}

/**
 * Write a script to a temporary .ps1 file and return the PowerShell arguments to run it.
 * (Encoded command lines look like malware to antivirus behaviour shields such as Norton's,
 * which then suspend the whole app; running a script file is what IDEs and build tools do.)
 */
export function psScriptFile(script: string): { args: string[]; file: string } {
  const dir = path.join(os.tmpdir(), 'maris-ps')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.ps1`)
  // BOM so Windows PowerShell 5.1 reads the file as UTF-8.
  writeFileSync(file, `﻿${script}`, 'utf8')
  return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] }
}

/** Run a PowerShell script safely (script file, no profile, hidden window, UTF-8 output). */
export function runPowerShell(
  script: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<PsResult> {
  const wrapped = `$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$OutputEncoding=[System.Text.Encoding]::UTF8
& {
${script}
} 2>&1 | Out-String -Width 220
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
  const { args, file } = psScriptFile(wrapped)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { cwd: opts.cwd ?? os.homedir(), windowsHide: true })
    child.on('close', () => rmSync(file, { force: true }))
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const kill = (): void => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs ?? 120000)
    const onAbort = (): void => kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 200_000) stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: stdout.replace(/\r\n/g, '\n').trimEnd(), stderr: stderr.trim(), code, timedOut, ms: Date.now() - started })
    })
  })
}

/** Stop a process and everything it started. */
export function killTree(pid: number): void {
  if (IS_WIN) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  // POSIX children run in their own process group (detached), so the negative pid reaches them all.
  const kill = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        /* already gone */
      }
    }
  }
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), 3000).unref()
}

/**
 * Put per-user toolchains on PATH for every command (after the login profile ran, which may reset PATH).
 * Apps started from the Dock or an app menu do not get the terminal's PATH, and Maris installs
 * .NET into ~/.dotnet and Rust into ~/.cargo without editing the user's shell profile.
 */
export const POSIX_PRELUDE = [
  'export PATH="$PATH:$HOME/.dotnet:$HOME/.dotnet/tools:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.volta/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin"',
  'if [ -d "$HOME/.dotnet" ] && [ -z "$DOTNET_ROOT" ]; then export DOTNET_ROOT="$HOME/.dotnet"; fi',
  'if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then PATH="$PATH:$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V 2>/dev/null | tail -n 1)"; fi'
].join('\n')

/** Run a script with the user's login shell (bash or zsh) on macOS and Linux. */
export function runPosix(script: string, opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PsResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(posixShell(), ['-lc', `${POSIX_PRELUDE}\n${script}`], {
      cwd: opts.cwd ?? os.homedir(),
      detached: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, opts.timeoutMs ?? 120000)
    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 200_000) stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trim(), code, timedOut, ms: Date.now() - started })
    })
  })
}

/** Run a command line in this system's shell: PowerShell on Windows, bash/zsh elsewhere. */
export function runShell(script: string, opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PsResult> {
  return IS_WIN ? runPowerShell(script, opts) : runPosix(script, opts)
}

/**
 * A note for the model when a command failed for lack of administrator rights: ask for full control
 * (or use run_as_admin when it is on) instead of telling the person to run it themselves.
 */
export function adminHint(output: string, fullControl: boolean): string {
  const denied =
    /access is denied|access denied|requires elevation|run as administrator|administrator privileges|administrative privileges|cannot open \S+ service|PermissionDenied|UnauthorizedAccess|not have permission|Operation not permitted|Permission denied|must be run as root|are you root|requires root/i
  if (!denied.test(output)) return ''
  return fullControl
    ? '\n\nNote from Maris: this needs administrator rights. Run it again with run_as_admin (the user approves it, then the system asks too).'
    : '\n\nNote from Maris: this needs administrator rights, and full control is off. Call request_full_control with the reason so the user can turn it on with one click, then wait. Do not ask them to run it by hand.'
}

const READ_EXAMPLES =IS_WIN ? 'Get-*, dir, ipconfig, git status…' : 'ls, cat, grep, df, git status…'

export const shellTools: ToolDef[] = [
  {
    name: 'run_command',
    risk: 'system',
    description: `Run a ${SHELL_LABEL} command on the user's ${OS_LABEL} computer and return its output (builds, tests, git, package managers, system queries). Read-only commands (${READ_EXAMPLES}) may run immediately; anything that changes the system needs the user to approve it first. In Code mode it runs in the project folder by default. Prefer the dedicated file tools for reading and editing files.`,
    parameters: schema(
      {
        command: { type: 'string', description: `${SHELL_LABEL} command line` },
        cwd: { type: 'string', description: 'Working folder (default: the project folder in Code mode, otherwise home)' },
        timeout_sec: { type: 'integer', description: 'Max runtime in seconds (default 120, max 1800)' }
      },
      ['command']
    ),
    async prepare(args, ctx) {
      const command = str(args.command, 'command')
      // Admin-only commands fail (or silently do nothing) without administrator rights: say so before
      // they run, so the model asks for full control (or uses run_as_admin) instead of claiming success.
      if (needsAdmin(command, process.platform) && !isElevated()) {
        throw new ToolError(
          ctx.settings.agent.fullControl
            ? 'This command needs administrator rights, so it was not run. Run the same script with run_as_admin (the user approves it, then the system asks too).'
            : 'This command needs administrator rights, so it was not run, and full control is off. Call request_full_control with the reason: the user gets a button in the chat to turn it on. Then wait; do not ask them to run it by hand and do not claim it was done.'
        )
      }
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd
      if (!existsSync(cwd)) throw new ToolError(`Working folder not found: ${cwd}`)
      const c = IS_WIN ? classifyCommand(command) : classifyPosixCommand(command)
      const auto = c.readOnly && ctx.settings.agent.autoRunReadOnlyCommands
      // Installs say how big they are (download, disk space, what is free) before the person decides.
      const install = c.readOnly ? undefined : await installInfo(command)
      return {
        risk: auto ? 'read' : 'system',
        title: `Run: ${command.length > 90 ? command.slice(0, 90) + '…' : command}`,
        detail: c.readOnly ? 'This command only reads information.' : `Needs approval: ${c.reason}.`,
        preview: { kind: 'command', command, cwd, shell: SHELL_LABEL },
        allowPrefix: c.readOnly ? undefined : commandPrefix(command),
        install
      }
    },
    async run(args, ctx) {
      const command = str(args.command, 'command')
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx.cwd) : ctx.cwd
      const timeoutMs = Math.min(1800, Math.max(5, num(args.timeout_sec, settings.get().agent.commandTimeoutSec))) * 1000
      ctx.progress('Running…')
      const r = await runShell(command, { cwd, timeoutMs, signal: ctx.signal })
      const out = [r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join('\n')
      const status = r.timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${r.code ?? '?'}`
      return `$ ${command}\n(${status}, ${(r.ms / 1000).toFixed(1)}s)\n${truncate(out || '(no output)', 24000)}${adminHint(out, ctx.settings.agent.fullControl)}`
    }
  }
]
