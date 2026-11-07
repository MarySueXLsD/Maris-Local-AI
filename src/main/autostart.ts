import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Whether Windows starts Maris at sign-in (the installer may have set it), to keep Settings in step. */
export async function launchAtLoginActive(): Promise<boolean | undefined> {
  if (process.platform !== 'win32' || !app.isPackaged) return undefined
  if (app.getLoginItemSettings({ args: ['--background'] }).openAtLogin) return true
  // The installer writes the same entry (under the app's id) itself; accept it with or without quotes.
  const out = await new Promise<string>((resolve) =>
    execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'app.maris.local'], { windowsHide: true, timeout: 8000 }, (_e, stdout) =>
      resolve(String(stdout ?? ''))
    )
  )
  const value = /REG_SZ\s+(.*)/i.exec(out)?.[1]?.trim() ?? ''
  return value.replace(/"/g, '').toLowerCase().startsWith(process.execPath.toLowerCase())
}

/**
 * Start Maris when the user logs in. Windows and macOS have a system setting for it; Linux desktops
 * read ~/.config/autostart/*.desktop (the XDG autostart standard used by GNOME, KDE, Xfce and others).
 */
export function setLaunchAtLogin(on: boolean): void {
  if (process.platform === 'win32') {
    // Starts quietly in the tray (the installer's "Start Maris in the background" writes the same entry).
    app.setLoginItemSettings({ openAtLogin: on, args: ['--background'] })
    return
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: on })
    return
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart')
  const file = path.join(dir, 'maris.desktop')
  if (!on) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(dir, { recursive: true })
  // An AppImage moves on every start; APPIMAGE holds the file the user actually has.
  const exe = process.env.APPIMAGE || process.execPath
  writeFileSync(
    file,
    ['[Desktop Entry]', 'Type=Application', 'Name=Maris', 'Comment=Local AI assistant', `Exec="${exe.replace(/"/g, '\\"')}"`, 'Icon=maris', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n')
  )
}
