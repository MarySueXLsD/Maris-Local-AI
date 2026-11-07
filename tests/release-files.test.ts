import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseChecksums, pickAsset } from '../src/main/feed/pure.ts'

const root = path.resolve(import.meta.dirname, '..')
// What the build jobs of v0.2.0 produced, plus a stray file.
const BUILT = [
  'Maris-Setup-0.3.0.exe',
  'Maris-0.3.0-arm64.dmg',
  'Maris-0.3.0-x64.dmg',
  'Maris-0.3.0-x86_64.AppImage',
  'Maris-0.3.0-arm64.AppImage',
  'maris_0.3.0_amd64.deb',
  'maris-0.3.0.x86_64.rpm',
  'app-debug.apk',
  'Maris-0.3.0-mac.zip'
]

test('release files get names that say who they are for, one checksum list and the Linux installer', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-release-'))
  try {
    for (const f of BUILT) writeFileSync(path.join(dir, f), `contents of ${f}`)
    writeFileSync(path.join(dir, 'SHA256SUMS-windows.txt'), `${'a'.repeat(64)}  Maris-Setup-0.3.0.exe\n${'b'.repeat(64)}  win-unpacked/Maris.exe\n`)
    writeFileSync(path.join(dir, 'SHA256SUMS-linux-x64.txt'), `${'c'.repeat(64)}  maris_0.3.0_amd64.deb\n`)
    execFileSync(process.execPath, [path.join(root, 'scripts', 'release-files.cjs'), dir, 'v0.3.0', 'Owner/Repo'], { stdio: 'pipe' })

    const files = readdirSync(dir).sort()
    assert.deepEqual(files, [
      'Maris-0.3.0-Linux-ARM64.AppImage',
      'Maris-0.3.0-Linux-x64-Debian-Ubuntu.deb',
      'Maris-0.3.0-Linux-x64-Fedora-openSUSE.rpm',
      'Maris-0.3.0-Linux-x64.AppImage',
      'Maris-0.3.0-Windows-Setup.exe',
      'Maris-0.3.0-macOS-Apple-silicon-arm64.dmg',
      'Maris-0.3.0-macOS-Intel-x64.dmg',
      'Maris-Link-0.3.0-Android.apk',
      'SHA256SUMS.txt',
      'install-maris-linux.sh'
    ])

    const sums = parseChecksums(readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'))
    for (const f of files.filter((x) => x !== 'SHA256SUMS.txt')) {
      assert.equal(sums.get(f), createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex'), `checksum of ${f}`)
    }
    assert.equal(sums.get('Maris.exe'), 'b'.repeat(64), 'the unpacked Windows program stays listed')

    // Installed copies pick their update from these names, 0.2.0 included.
    const assets = files.map((name) => ({ name, browser_download_url: name, size: 1 }))
    assert.equal(pickAsset(assets, 'win32', 'x64')?.name, 'Maris-0.3.0-Windows-Setup.exe')
    assert.equal(pickAsset(assets, 'darwin', 'arm64')?.name, 'Maris-0.3.0-macOS-Apple-silicon-arm64.dmg')
    assert.equal(pickAsset(assets, 'darwin', 'x64')?.name, 'Maris-0.3.0-macOS-Intel-x64.dmg')
    assert.equal(pickAsset(assets, 'linux', 'x64')?.name, 'Maris-0.3.0-Linux-x64.AppImage')
    assert.equal(pickAsset(assets, 'linux', 'arm64')?.name, 'Maris-0.3.0-Linux-ARM64.AppImage')
    assert.equal(pickAsset(assets, 'linux', 'x64', 'deb')?.name, 'Maris-0.3.0-Linux-x64-Debian-Ubuntu.deb')
    assert.equal(pickAsset(assets, 'linux', 'x64', 'rpm')?.name, 'Maris-0.3.0-Linux-x64-Fedora-openSUSE.rpm')
    assert.equal(pickAsset(assets, 'linux', 'arm64', 'deb')?.name, 'Maris-0.3.0-Linux-ARM64.AppImage', 'no ARM deb: the AppImage')

    // The installer names this version, this repository, and the same files.
    const sh = readFileSync(path.join(dir, 'install-maris-linux.sh'), 'utf8')
    assert.ok(!sh.includes('__VERSION__') && !sh.includes('__REPO__') && !sh.includes('\r'))
    assert.match(sh, /VERSION="0\.3\.0"/)
    assert.match(sh, /github\.com\/Owner\/Repo\/releases\/latest\/download\/install-maris-linux\.sh/)
    for (const f of ['Linux-x64-Debian-Ubuntu.deb', 'Linux-x64-Fedora-openSUSE.rpm', 'Linux-$arch.AppImage']) assert.ok(sh.includes(f), f)

    // Where bash is available, the script parses and its dry run names a package.
    const bash = spawnSync('bash', ['-n', path.join(dir, 'install-maris-linux.sh')])
    if (!bash.error) {
      assert.equal(bash.status, 0, String(bash.stderr))
      if (process.platform === 'linux') {
        const dry = spawnSync('bash', [path.join(dir, 'install-maris-linux.sh')], { env: { ...process.env, MARIS_INSTALL_DRY_RUN: '1' }, encoding: 'utf8' })
        assert.equal(dry.status, 0, dry.stderr)
        assert.match(dry.stdout, /Maris 0\.3\.0 for this computer: Maris-0\.3\.0-Linux-/)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a release step that misses a platform fails loudly', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-release-'))
  try {
    for (const f of BUILT.filter((x) => !x.endsWith('.rpm'))) writeFileSync(path.join(dir, f), 'x')
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-files.cjs'), dir, 'v0.3.0', 'Owner/Repo'], { encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /Fedora-openSUSE\.rpm: expected one build file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
