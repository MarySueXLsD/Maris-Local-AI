// Builds tests/installer/path-test.nsi with electron-builder's NSIS and checks how the installer edits
// PATH, on a scratch registry key (HKCU\Software\MarisInstallerTest) that is removed afterwards.
// Usage: node tests/installer/check-path.cjs   (Windows, after electron-builder has fetched NSIS once)
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache')
const nsisDir = readdirSync(cache)
  .filter((d) => /^nsis-\d/.test(d))
  .map((d) => path.join(cache, d))
  .flatMap((d) => readdirSync(d).map((x) => path.join(d, x)))
  .find((d) => existsSync(path.join(d, 'Bin', 'makensis.exe')))
if (!nsisDir) throw new Error('NSIS from electron-builder not found; run npm run dist once first.')

const tmp = mkdtempSync(path.join(os.tmpdir(), 'maris-nsis-'))
const exe = path.join(tmp, 'path-test.exe')
const result = path.join(tmp, 'result.txt')
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
try {
  execFileSync(
    path.join(nsisDir, 'Bin', 'makensis.exe'),
    ['-V2', `-DOUT=${exe}`, `-DRESULT=${result}`, `-DINC=${path.join(root, 'resources', 'installer.nsh')}`, path.join(__dirname, 'path-test.nsi')],
    { stdio: 'inherit' }
  )
  execFileSync(exe, ['/S'])
  const got = Object.fromEntries(
    // FileWrite in NSIS writes ANSI text.
    readFileSync(result, 'latin1')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
  const bin = 'C:\\Program Files\\Maris\\bin'
  check(got.add === `%USERPROFILE%\\bin;C:\\Tools;${bin}`, `appends and keeps %VARIABLES%: ${got.add}`)
  check(got.again === got.add, 'does not add it twice')
  check(got.present === 'C:\\A;C:\\PROGRAM FILES\\MARIS\\BIN\\;C:\\B', 'sees it already there in other letter case or with a trailing backslash')
  check(got.trailing === `C:\\A;${bin}`, `no double separator: ${got.trailing}`)
  check(got.empty === bin, `empty PATH: ${got.empty}`)
  check(got.long === 'unchanged', 'a PATH near the length limit is left alone')
} finally {
  try {
    execFileSync('reg', ['delete', 'HKCU\\Software\\MarisInstallerTest', '/f'], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
  rmSync(tmp, { recursive: true, force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all PATH checks passed')
process.exit(failures ? 1 : 0)
