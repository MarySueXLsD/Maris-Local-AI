// Builds tests/installer/ui-test.nsi with electron-builder's NSIS, runs it (it installs nothing), and checks
// that Back, Next and Cancel are evenly spaced and that the copying page explains what happens. Saves a
// screenshot of the page.
// Usage: node tests/installer/check-ui.cjs [shotsDir]   (Windows, after electron-builder has fetched NSIS once)
const { execFileSync, spawn } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')
const nsisDir = readdirSync(cache)
  .filter((d) => /^nsis-\d/.test(d))
  .map((d) => path.join(cache, d))
  .flatMap((d) => readdirSync(d).map((x) => path.join(d, x)))
  .find((d) => existsSync(path.join(d, 'Bin', 'makensis.exe')))
if (!nsisDir) throw new Error('NSIS from electron-builder not found; run npm run dist once first.')

const tmp = mkdtempSync(path.join(os.tmpdir(), 'maris-nsis-ui-'))
const exe = path.join(tmp, 'ui-test.exe')
const result = path.join(tmp, 'result.txt')
const png = path.join(shots, 'installer-copying-page.png')
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

// A screenshot of the test installer's window, by its title.
const grab = path.join(tmp, 'grab.ps1')
writeFileSync(
  grab,
  `﻿param([int]$ProcId, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
$h = (Get-Process -Id $ProcId).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { 'no window'; exit 1 }
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
$r = New-Object W+R
[void][W]::GetWindowRect($h, [ref]$r)
$bmp = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
'saved'
`,
  'utf8'
)

try {
  execFileSync(
    path.join(nsisDir, 'Bin', 'makensis.exe'),
    ['-V2', `-DOUT=${exe}`, `-DRESULT=${result}`, `-DINC=${path.join(root, 'resources', 'installer.nsh')}`, path.join(__dirname, 'ui-test.nsi')],
    { stdio: 'inherit' }
  )
  const child = spawn(exe, [], { stdio: 'ignore' })
  const t0 = Date.now()
  while (!existsSync(result) && Date.now() - t0 < 20000) execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'])
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)'])
  // The window title, as Windows reports it for the test installer's process.
  const title = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).MainWindowTitle`], { encoding: 'utf8' }).trim()
  const got = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', grab, '-ProcId', String(child.pid), '-Out', png], { encoding: 'utf8' }).trim()
  check(got === 'saved', `screenshot of the copying page (${title}): ${png}`)
  child.on('exit', () => undefined)
  const raw = Object.fromEntries(
    readFileSync(result, 'latin1')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
  const [back, next, cancel] = ['back', 'next', 'cancel'].map((k) => raw[k].split(',').map(Number))
  const gap1 = next[0] - back[2]
  const gap2 = cancel[0] - next[2]
  check(gap1 > 0 && Math.abs(gap1 - gap2) <= 1, `Back, Next and Cancel are evenly spaced (gaps ${gap1} and ${gap2} px)`)
  check(back[1] === next[1] && next[1] === cancel[1], 'the buttons stay on one line')
  check(raw.plan === 'yes', 'the copying page explains what happens')
} finally {
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'])
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all installer UI checks passed')
process.exit(failures ? 1 : 0)
