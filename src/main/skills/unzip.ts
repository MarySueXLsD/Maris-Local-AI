import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * Unpack a zip archive (stored or deflated entries) into `dest`. Used when git is not installed:
 * GitHub serves every repository as a zip. Entries that would land outside `dest` are skipped.
 * `stripFirst` drops the top folder GitHub puts around everything ("repo-main/").
 */
export function unzip(buf: Buffer, dest: string, opts: { stripFirst?: boolean } = {}): number {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const root = path.resolve(dest)
  let written = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('The zip archive is damaged')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/')
    off += 46 + nameLen + extraLen + commentLen
    let rel = name
    if (opts.stripFirst) rel = rel.split('/').slice(1).join('/')
    if (!rel) continue
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) continue
    if (rel.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : undefined
    if (!data) continue
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
    written++
  }
  return written
}
