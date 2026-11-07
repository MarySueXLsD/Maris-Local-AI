import { app } from 'electron'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalCommandStatus } from '@shared/types'
import { log } from '../util'

/**
 * The `maris` terminal command: on Windows a small launcher (bin\maris.exe, next to Maris.exe) that the
 * installer can put on PATH; on macOS and Linux a two-line script in /usr/local/bin or ~/.local/bin.
 * Both start Maris's own runtime in Node mode with resources/cli/maris.cjs, which talks to the app.
 */

const MARK = 'Maris terminal command'
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

function cliScript(): string {
  return path.join(process.resourcesPath, 'cli', 'maris.cjs')
}

function winBinDir(): string {
  return path.join(path.dirname(process.execPath), 'bin')
}

function posixTarget(): string {
  return IS_MAC ? '/usr/local/bin/maris' : path.join(os.homedir(), '.local', 'bin', 'maris')
}

function posixScript(): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh\n# ${MARK} (installed from Maris → Settings → Terminal command).\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(cliScript())} "$@"\n`
}

const norm = (p: string): string => p.replace(/%([^%]+)%/g, (_m, v: string) => process.env[v] ?? `%${v}%`).replace(/[\\/]+$/, '').toLowerCase()

function regPath(hive: 'HKCU\\Environment' | 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', hive, '/v', 'Path'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve('')
      const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout)
      resolve(m ? m[1].trim() : '')
    })
  })
}

export async function terminalStatus(): Promise<TerminalCommandStatus> {
  if (!app.isPackaged) return { supported: false, installed: false, note: 'The terminal command comes with the installed app.' }
  if (!existsSync(cliScript())) return { supported: false, installed: false, note: 'This copy of Maris was built without the terminal command.' }
  if (IS_WIN) {
    const dir = winBinDir()
    if (!existsSync(path.join(dir, 'maris.exe'))) return { supported: false, installed: false, note: 'The launcher (bin\\maris.exe) is missing from this copy of Maris.' }
    const [user, machine] = await Promise.all([regPath('HKCU\\Environment'), regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')])
    const has = (p: string): boolean => p.split(';').some((x) => x && norm(x) === norm(dir))
    const inUser = has(user)
    const inMachine = has(machine)
    return {
      supported: true,
      installed: inUser || inMachine,
      location: dir,
      scope: inMachine ? 'machine' : inUser ? 'user' : undefined,
      note: inMachine && !inUser ? 'Added for everyone on this PC by the installer.' : undefined
    }
  }
  if (process.env.APPIMAGE) return { supported: false, installed: false, note: 'The terminal command needs the installed version (deb, rpm or tar.gz), not the AppImage.' }
  const target = posixTarget()
  const installed = existsSync(target) && readFileSync(target, 'utf8').includes(MARK)
  const onPath = (process.env.PATH ?? '').split(':').some((d) => d === path.dirname(target))
  return {
    supported: true,
    installed,
    location: target,
    note: installed && !onPath ? `${path.dirname(target)} is not on your PATH yet; add it in your shell profile.` : undefined
  }
}

/** Add or remove the command. Windows: the user PATH (kept as REG_EXPAND_SZ so %VARIABLES% survive). */
export async function setTerminalCommand(on: boolean): Promise<TerminalCommandStatus> {
  const st = await terminalStatus()
  if (!st.supported) throw new Error(st.note ?? 'Not available on this computer.')
  if (IS_WIN) {
    // The launcher edits PATH itself (no PowerShell): bin\maris.exe --maris-path add|remove <folder>.
    const dir = winBinDir()
    const r = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile(path.join(dir, 'maris.exe'), ['--maris-path', on ? 'add' : 'remove', dir], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() })
      )
    )
    if (r.code !== 0 || !/done/.test(r.out)) throw new Error(`Could not change PATH: ${r.out.replace(/^maris: /, '').slice(0, 300) || `exit code ${r.code}`}`)
    log.info('cli', `terminal command ${on ? 'added to' : 'removed from'} the user PATH`)
    return terminalStatus()
  }
  const target = posixTarget()
  const dir = path.dirname(target)
  try {
    if (on) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, posixScript())
      chmodSync(target, 0o755)
    } else if (existsSync(target) && readFileSync(target, 'utf8').includes(MARK)) {
      rmSync(target, { force: true })
    }
  } catch (e) {
    if (!IS_MAC) throw e
    // /usr/local/bin belongs to the administrator: macOS asks for the password in its own dialog.
    const tmp = path.join(os.tmpdir(), `maris-cli-${process.pid}`)
    writeFileSync(tmp, posixScript())
    const sh = on ? `mkdir -p '${dir}' && cp '${tmp}' '${target}' && chmod 755 '${target}'` : `rm -f '${target}'`
    await new Promise<void>((resolve, reject) =>
      execFile('osascript', ['-e', `do shell script "${sh.replace(/"/g, '\\"')}" with administrator privileges`], (err) => (err ? reject(new Error('macOS did not allow the change.')) : resolve()))
    )
    rmSync(tmp, { force: true })
  }
  return terminalStatus()
}
