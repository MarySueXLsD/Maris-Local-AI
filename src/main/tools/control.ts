// "Full control of this PC" (Settings → PC access, off until the person turns it on): run things as
// administrator and use the mouse and keyboard in other programs. Every action still waits for approval
// (only "approve everything" rules can cover it). While it is off, request_full_control lets the
// assistant ask for it with a button in the chat instead of telling the person to find the setting.
import { screen } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_MAC, IS_WIN, OS_LABEL } from '../platform'
import { truncate } from '../util'
import { escapeSendKeys, sendKeysFor } from './keys'
import { runPowerShell } from './shell'
import { bool, num, schema, str, ToolError, type ToolDef } from './types'

const on = (s: { agent: { fullControl?: boolean } }): boolean => Boolean(s.agent.fullControl)

/** PowerShell single-quoted string. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`
/** POSIX shell single-quoted string. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

function run(cmd: string, args: string[], timeoutMs = 120000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 2 ** 20, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0
      resolve({ code, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim() })
    })
  })
}

/** Run a script with administrator rights; the system asks the person first (UAC, pkexec, macOS prompt). */
async function runElevated(script: string, timeoutMs: number): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-admin-'))
  try {
    if (IS_WIN) {
      const task = path.join(dir, 'task.ps1')
      const runner = path.join(dir, 'runner.ps1')
      const out = path.join(dir, 'out.txt')
      const code = path.join(dir, 'code.txt')
      writeFileSync(task, `﻿${script}`, 'utf8')
      writeFileSync(
        runner,
        `﻿$ProgressPreference='SilentlyContinue'
$c = 0
try {
  & ${psq(task)} *>&1 | Out-File -FilePath ${psq(out)} -Encoding utf8 -Width 220
  if ($null -ne $LASTEXITCODE) { $c = $LASTEXITCODE } elseif (-not $?) { $c = 1 }
} catch { $_ | Out-File -FilePath ${psq(out)} -Append -Encoding utf8; $c = 1 }
Set-Content -Path ${psq(code)} -Value $c`,
        'utf8'
      )
      const launch = await runPowerShell(
        `try {
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',${psq(`"${runner}"`)}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  'STARTED'
} catch { 'DECLINED: ' + $_.Exception.Message }`,
        { timeoutMs }
      )
      if (/DECLINED/.test(launch.stdout)) throw new ToolError('The person did not give administrator permission in the Windows prompt, so nothing ran.')
      let text = ''
      let exit = '?'
      try {
        text = readFileSync(out, 'utf8').replace(/^﻿/, '')
        exit = readFileSync(code, 'utf8').trim()
      } catch {
        /* nothing written */
      }
      return `Ran as administrator (exit code ${exit}).\n${truncate(text.trim() || '(no output)', 24000)}`
    }
    const task = path.join(dir, 'task.sh')
    writeFileSync(task, script, { mode: 0o700 })
    if (IS_MAC) {
      const r = await run('osascript', ['-e', `do shell script "/bin/bash ${shq(task).replace(/"/g, '\\"')} 2>&1" with administrator privileges`], timeoutMs)
      if (r.code !== 0 && /User canceled|-128/.test(r.out)) throw new ToolError('The person cancelled the administrator prompt, so nothing ran.')
      return `Ran as administrator (exit code ${r.code}).\n${truncate(r.out || '(no output)', 24000)}`
    }
    const r = await new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn('pkexec', ['/bin/bash', task], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      const t = setTimeout(() => p.kill(), timeoutMs)
      p.on('close', (c) => {
        clearTimeout(t)
        resolve({ code: c ?? -1, out })
      })
      p.on('error', () => resolve({ code: -2, out: 'pkexec (the desktop password prompt) is not installed.' }))
    })
    if (r.code === 126 || r.code === 127) throw new ToolError('The person did not enter the administrator password, so nothing ran.')
    return `Ran as administrator (exit code ${r.code}).\n${truncate(r.out.trim() || '(no output)', 24000)}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Screenshot pixels (as take_screenshot shows them, at most 1600 wide) → physical screen pixels. */
function toScreen(x: number, y: number): { x: number; y: number } {
  const d = screen.getPrimaryDisplay()
  const scale = Math.min(1, 1600 / (d.size.width * d.scaleFactor))
  return { x: Math.round(x / scale), y: Math.round(y / scale) }
}

const WIN_INPUT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class MarisInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[MarisInput]::SetProcessDPIAware() | Out-Null
`

async function desktopWindows(action: string, a: Record<string, unknown>): Promise<string> {
  let body = ''
  switch (action) {
    case 'focus_window': {
      const t = str(a.window, 'window')
      body = `$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like ('*' + ${psq(t)} + '*') -or $_.ProcessName -like ${psq(t)}) } | Select-Object -First 1
if (-not $w) { 'NOT FOUND'; exit 2 }
[MarisInput]::ShowWindow($w.MainWindowHandle, 9) | Out-Null
[MarisInput]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
'Focused: ' + $w.MainWindowTitle`
      break
    }
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move_mouse': {
      const p = toScreen(num(a.x, NaN), num(a.y, NaN))
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new ToolError('x and y are needed (pixels in the latest screenshot)')
      const down = action === 'right_click' ? '0x0008' : '0x0002'
      const up = action === 'right_click' ? '0x0010' : '0x0004'
      const times = action === 'double_click' ? 2 : action === 'move_mouse' ? 0 : 1
      body = `[MarisInput]::SetCursorPos(${p.x}, ${p.y}) | Out-Null
Start-Sleep -Milliseconds 80
for ($i = 0; $i -lt ${times}; $i++) { [MarisInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero); [MarisInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 90 }
'Done at ${p.x},${p.y} (screen pixels)'`
      break
    }
    case 'scroll': {
      const amount = Math.round(num(a.amount, -3))
      body = `[MarisInput]::mouse_event(0x0800, 0, 0, ${amount * 120}, [UIntPtr]::Zero); 'Scrolled ${amount}'`
      break
    }
    case 'type_text':
      body = `[System.Windows.Forms.SendKeys]::SendWait(${psq(escapeSendKeys(str(a.text, 'text')))}); 'Typed ${String(a.text).length} characters'`
      break
    case 'press_keys':
      body = `[System.Windows.Forms.SendKeys]::SendWait(${psq(sendKeysFor(str(a.keys, 'keys')))}); 'Pressed ' + ${psq(String(a.keys))}`
      break
    default:
      throw new ToolError(`Unknown action "${action}"`)
  }
  const r = await runPowerShell(WIN_INPUT + body, { timeoutMs: 30000 })
  if (/NOT FOUND/.test(r.stdout)) throw new ToolError(`No open window matches "${String(a.window)}". List them with list_windows.`)
  if (r.code !== 0) throw new ToolError(r.stdout || r.stderr || `failed (exit ${r.code})`)
  return r.stdout.trim()
}

async function desktopPosix(action: string, a: Record<string, unknown>): Promise<string> {
  if (IS_MAC) {
    const as = (script: string): Promise<{ code: number; out: string }> => run('osascript', ['-e', script], 30000)
    const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    let r: { code: number; out: string }
    if (action === 'focus_window') r = await as(`tell application ${q(str(a.window, 'window'))} to activate`)
    else if (action === 'type_text') r = await as(`tell application "System Events" to keystroke ${q(str(a.text, 'text'))}`)
    else if (action === 'press_keys') {
      const keys = str(a.keys, 'keys').toLowerCase().split('+')
      const key = keys.pop() ?? ''
      const mods = keys.map((m) => ({ cmd: 'command down', command: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' })[m]).filter(Boolean)
      const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, esc: 53, escape: 53, delete: 51, backspace: 51, left: 123, right: 124, down: 125, up: 126, space: 49 }
      const press = codes[key] !== undefined ? `key code ${codes[key]}` : `keystroke ${q(key)}`
      r = await as(`tell application "System Events" to ${press}${mods.length ? ` using {${mods.join(', ')}}` : ''}`)
    } else if (action === 'click' || action === 'double_click' || action === 'right_click') {
      const p = toScreen(num(a.x, NaN), num(a.y, NaN))
      const d = screen.getPrimaryDisplay()
      r = await as(`tell application "System Events" to click at {${Math.round(p.x / d.scaleFactor)}, ${Math.round(p.y / d.scaleFactor)}}`)
    } else throw new ToolError(`"${action}" is not available on macOS yet`)
    if (r.code !== 0) throw new ToolError(`${r.out} (Maris needs Accessibility permission: System Settings → Privacy & Security → Accessibility)`)
    return `Done: ${action}`
  }
  // Linux (X11): xdotool.
  const has = await run('sh', ['-c', 'command -v xdotool'])
  if (has.code !== 0) throw new ToolError('Using the mouse and keyboard on Linux needs xdotool (for example: sudo apt install xdotool). It works on X11 desktops, not on Wayland.')
  let args: string[]
  if (action === 'focus_window') args = ['search', '--onlyvisible', '--name', str(a.window, 'window'), 'windowactivate']
  else if (action === 'type_text') args = ['type', '--delay', '15', '--', str(a.text, 'text')]
  else if (action === 'press_keys') args = ['key', ...str(a.keys, 'keys').split(/\s+/).map((k) => k.replace(/\benter\b/i, 'Return').replace(/\besc\b/i, 'Escape'))]
  else if (action === 'scroll') {
    const amount = Math.round(num(a.amount, -3))
    args = ['click', '--repeat', String(Math.abs(amount)), amount < 0 ? '5' : '4']
  } else {
    const p = toScreen(num(a.x, NaN), num(a.y, NaN))
    args = ['mousemove', String(p.x), String(p.y)]
    if (action !== 'move_mouse') args.push('click', ...(action === 'double_click' ? ['--repeat', '2'] : []), action === 'right_click' ? '3' : '1')
  }
  const r = await run('xdotool', args, 30000)
  if (r.code !== 0) throw new ToolError(r.out || `xdotool failed (exit ${r.code})`)
  return `Done: ${action}`
}

const ACTIONS = ['focus_window', 'click', 'double_click', 'right_click', 'move_mouse', 'scroll', 'type_text', 'press_keys']

export const controlTools: ToolDef[] = [
  {
    name: 'run_as_admin',
    risk: 'system',
    enabled: on,
    description: `Run a ${IS_WIN ? 'PowerShell' : 'bash'} script with administrator rights on this ${OS_LABEL} computer: system settings, services, drivers, installs for all users, protected folders and registry keys. ${IS_WIN ? 'Windows shows its own permission prompt (UAC)' : 'The system asks for the administrator password'} after the user approves. Use run_command for everything that does not need administrator rights.`,
    parameters: schema(
      {
        script: { type: 'string', description: `The ${IS_WIN ? 'PowerShell' : 'bash'} script` },
        reason: { type: 'string', description: 'Why it needs administrator rights, in one plain sentence for the user' },
        timeout_sec: { type: 'integer', description: 'Max runtime in seconds (default 300)' }
      },
      ['script', 'reason']
    ),
    async prepare(args) {
      const script = str(args.script, 'script')
      return {
        risk: 'system',
        title: `Run as administrator: ${str(args.reason, 'reason', false) || script.split('\n')[0]!.slice(0, 80)}`,
        detail: `This runs with administrator rights, which can change anything on this computer. ${IS_WIN ? 'Windows asks once more (UAC) after you approve.' : 'The system asks for your password after you approve.'}`,
        preview: { kind: 'command', command: script, cwd: os.homedir(), shell: IS_WIN ? 'PowerShell (administrator)' : 'bash (administrator)' }
      }
    },
    async run(args) {
      return runElevated(str(args.script, 'script'), Math.min(1800, Math.max(10, num(args.timeout_sec, 300))) * 1000)
    }
  },
  {
    name: 'list_windows',
    risk: 'read',
    enabled: on,
    description: 'List the open program windows (title, program, process id), to pick one for desktop_action.',
    parameters: schema({}),
    async prepare() {
      return { risk: 'read', title: 'List open windows' }
    },
    async run() {
      if (IS_WIN) {
        const r = await runPowerShell(
          "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object { '{0}  [{1}, pid {2}]' -f $_.MainWindowTitle, $_.ProcessName, $_.Id }",
          { timeoutMs: 20000 }
        )
        return r.stdout.trim() || '(no windows)'
      }
      if (IS_MAC) return (await run('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'])).out
      const r = await run('sh', ['-c', 'wmctrl -l 2>/dev/null || xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null'])
      return r.out || 'Listing windows needs wmctrl or xdotool.'
    }
  },
  {
    name: 'desktop_action',
    risk: 'system',
    enabled: on,
    description:
      'Use the mouse and keyboard in other programs: focus_window (window: part of its title or the program name), click / double_click / right_click / move_mouse (x, y: pixels in the latest take_screenshot image), scroll (amount: negative is down), type_text (text), press_keys (keys like "ctrl+s", "alt+tab", "enter"). Take a screenshot first to see where things are, and another one after to check the result. The user approves each action.',
    parameters: schema(
      {
        action: { type: 'string', enum: ACTIONS, description: 'What to do' },
        window: { type: 'string', description: 'focus_window: part of the window title, or the program name' },
        x: { type: 'integer', description: 'Pixels from the left of the latest screenshot' },
        y: { type: 'integer', description: 'Pixels from the top of the latest screenshot' },
        text: { type: 'string', description: 'type_text: the text to type' },
        keys: { type: 'string', description: 'press_keys: for example "ctrl+s", "alt+f4", "enter"' },
        amount: { type: 'integer', description: 'scroll: notches, negative is down' }
      },
      ['action']
    ),
    async prepare(args) {
      const action = str(args.action, 'action')
      if (!ACTIONS.includes(action)) throw new ToolError(`action is one of ${ACTIONS.join(', ')}`)
      const what =
        action === 'focus_window'
          ? `switch to the window "${str(args.window, 'window')}"`
          : action === 'type_text'
            ? `type "${truncate(str(args.text, 'text'), 80)}"`
            : action === 'press_keys'
              ? `press ${str(args.keys, 'keys')}`
              : action === 'scroll'
                ? `scroll ${num(args.amount, -3) < 0 ? 'down' : 'up'}`
                : `${action.replace('_', ' ')} at ${num(args.x, 0)}, ${num(args.y, 0)} in the screenshot`
      return { risk: 'system', title: `Use the ${action.includes('key') || action === 'type_text' ? 'keyboard' : 'mouse'}: ${what}`, detail: 'Maris acts in whatever program is in front, as if you did it.' }
    },
    async run(args) {
      const action = str(args.action, 'action')
      const out = IS_WIN ? await desktopWindows(action, args) : await desktopPosix(action, args)
      return `${out}${bool(args.no_check) ? '' : '\nTake a screenshot to check the result before the next action.'}`
    }
  },
  {
    name: 'request_full_control',
    risk: 'read',
    enabled: (s) => !on(s),
    description:
      'Full control is off: you cannot run things as administrator or use the mouse and keyboard in other programs. When a task needs that, call this with the reason: the user sees a button in the chat to turn it on. Then stop and wait for them.',
    parameters: schema({ reason: { type: 'string', description: 'What you need it for, in one plain sentence' } }, ['reason']),
    async prepare(args) {
      return { risk: 'read', title: `Ask for full control: ${str(args.reason, 'reason', false) || 'for this task'}` }
    },
    async run(_args, ctx) {
      ctx.endTurn?.()
      return 'The user now sees a button in the chat to turn on full control. Say in one sentence what you will do with it, then wait for them.'
    }
  }
]
