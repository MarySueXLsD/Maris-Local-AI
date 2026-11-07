// Writes SHA256SUMS-<platform>.txt next to the installers in a release folder: the fingerprints people can
// check a download against, and that antivirus false-positive forms ask for.
// Usage: node scripts/checksums.cjs release/windows [name]
// The optional name keeps the files of two builds that share a folder name apart (linux-x64, linux-arm64).
const { createHash } = require('node:crypto')
const { createReadStream, readdirSync, statSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const dir = path.resolve(process.argv[2] ?? 'release')
const KINDS = /\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz|apk)$/i

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
  const files = readdirSync(dir).filter((f) => KINDS.test(f) && statSync(path.join(dir, f)).isFile())
  // The uninstaller Windows users see lives inside the unpacked app folder.
  const unpacked = path.join(dir, 'win-unpacked')
  const extra = []
  for (const f of ['Maris.exe', path.join('bin', 'maris.exe')]) {
    try {
      if (statSync(path.join(unpacked, f)).isFile()) extra.push(path.join('win-unpacked', f))
    } catch {
      /* not a Windows build */
    }
  }
  const lines = []
  for (const f of [...files, ...extra]) lines.push(`${await sha256(path.join(dir, f))}  ${f.replace(/\\/g, '/')}`)
  const name = `SHA256SUMS-${process.argv[3] ?? path.basename(dir)}.txt`
  writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`)
  console.log(`${name}:\n${lines.join('\n')}`)
})()
