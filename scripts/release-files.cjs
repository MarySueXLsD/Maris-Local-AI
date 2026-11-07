// Turns the build outputs of every platform into the files of a GitHub release, with names that say who
// each one is for, one checksum list and a Linux installer that picks the right package:
//
//   Maris-<v>-Windows-Setup.exe                 Maris-<v>-Linux-x64.AppImage
//   Maris-<v>-macOS-Apple-silicon-arm64.dmg     Maris-<v>-Linux-ARM64.AppImage
//   Maris-<v>-macOS-Intel-x64.dmg               Maris-<v>-Linux-x64-Debian-Ubuntu.deb
//   Maris-Link-<v>-Android.apk                  Maris-<v>-Linux-x64-Fedora-openSUSE.rpm
//   install-maris-linux.sh                      SHA256SUMS.txt
//
// The names keep "setup…exe", "arm64", "x64" and the file types that installed copies (including 0.2.0)
// look for when they pick their update. The per-platform SHA256SUMS-*.txt from the build jobs are folded
// into SHA256SUMS.txt, keeping their lines for the unpacked Windows programs (for antivirus reports).
//
// Usage: node scripts/release-files.cjs <folder> <tag, e.g. v0.3.0> <owner/repo>
const { createHash } = require('node:crypto')
const { createReadStream, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const [dir, tag, repo] = process.argv.slice(2)
if (!dir || !/^v\d+\.\d+\.\d+/.test(tag ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
  console.error('Usage: node scripts/release-files.cjs <folder> <tag like v0.3.0> <owner/repo>')
  process.exit(2)
}
const v = tag.slice(1)

/** Build output → release name. Each must be present exactly once. */
const RULES = [
  [/^Maris-Setup-.+\.exe$/i, `Maris-${v}-Windows-Setup.exe`],
  [/^Maris-.+-arm64\.dmg$/i, `Maris-${v}-macOS-Apple-silicon-arm64.dmg`],
  [/^Maris-.+-x64\.dmg$/i, `Maris-${v}-macOS-Intel-x64.dmg`],
  [/^Maris-.+-x86_64\.AppImage$/i, `Maris-${v}-Linux-x64.AppImage`],
  [/^Maris-.+-arm64\.AppImage$/i, `Maris-${v}-Linux-ARM64.AppImage`],
  [/_amd64\.deb$/i, `Maris-${v}-Linux-x64-Debian-Ubuntu.deb`],
  [/\.x86_64\.rpm$/i, `Maris-${v}-Linux-x64-Fedora-openSUSE.rpm`],
  [/\.apk$/i, `Maris-Link-${v}-Android.apk`]
]

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

;(async () => {
  const files = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile())
  const problems = []

  // Lines for files that are not release assets (the unpacked Windows programs), from the build jobs' lists.
  const extraSums = []
  for (const f of files.filter((x) => /^SHA256SUMS-.+\.txt$/i.test(x))) {
    for (const line of readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (/^[a-f0-9]{64}\s+\S*\//i.test(line)) extraSums.push(line.trim())
    }
    rmSync(path.join(dir, f))
  }

  const kept = []
  for (const [rx, name] of RULES) {
    const hits = files.filter((f) => rx.test(f))
    if (hits.length !== 1) {
      problems.push(`${name}: expected one build file matching ${rx}, found ${hits.length ? hits.join(', ') : 'none'}`)
      continue
    }
    if (hits[0] !== name) renameSync(path.join(dir, hits[0]), path.join(dir, name))
    kept.push(name)
  }
  const unknown = files.filter((f) => !/^SHA256SUMS/i.test(f) && !RULES.some(([rx]) => rx.test(f)))
  for (const f of unknown) {
    console.log(`Not a release file, removed: ${f}`)
    rmSync(path.join(dir, f))
  }

  const script = readFileSync(path.join(__dirname, 'install-linux.sh'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll('__VERSION__', v)
    .replaceAll('__REPO__', repo)
  writeFileSync(path.join(dir, 'install-maris-linux.sh'), script, { mode: 0o755 })
  kept.push('install-maris-linux.sh')

  const lines = []
  for (const f of kept) lines.push(`${await sha256(path.join(dir, f))}  ${f}`)
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${[...lines, ...extraSums].join('\n')}\n`)

  console.log(`Release files in ${dir}:`)
  for (const f of [...kept, 'SHA256SUMS.txt']) console.log(`  ${f}`)
  if (problems.length) {
    console.error(`\n${problems.join('\n')}`)
    process.exit(1)
  }
})()
