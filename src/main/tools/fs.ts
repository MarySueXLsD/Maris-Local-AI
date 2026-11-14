import { shell } from 'electron'
import { createTwoFilesPatch } from 'diff'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ApprovalPreview } from '@shared/types'
import { formatBytes, truncate } from '../util'
import { backupDir, isInside, isSystemPath, resolvePath } from './paths'
import { DEVICE_WORD, IS_WIN, OS_LABEL, TRASH_LABEL } from '../platform'
import { bool, num, schema, str, ToolError, type ToolDef } from './types'

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '$recycle.bin',
  'system volume information',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'winsxs'
])

export function isBinary(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}

/** Encode text the same way the original file was encoded (BOM / UTF-16 / line endings). */
export function encodeLike(original: Buffer | undefined, text: string): Buffer {
  let t = text
  if (original) {
    const orig = decode(original)
    if (orig.includes('\r\n') && !t.includes('\r\n')) t = t.replace(/\n/g, '\r\n')
    if (original[0] === 0xff && original[1] === 0xfe) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')])
    if (original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf)
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')])
  }
  return Buffer.from(t, 'utf8')
}

export async function readTextFile(p: string): Promise<{ text: string; raw: Buffer }> {
  const st = await fs.stat(p).catch(() => undefined)
  if (!st) throw new ToolError(`File not found: ${p}`)
  if (st.isDirectory()) throw new ToolError(`${p} is a folder, not a file. Use list_dir.`)
  if (st.size > 25 * 2 ** 20) throw new ToolError(`File is too large to read as text (${formatBytes(st.size)}).`)
  const raw = await fs.readFile(p)
  if (isBinary(raw)) throw new ToolError(`${p} is a binary file (${formatBytes(st.size)}); it can't be shown as text.`)
  return { text: decode(raw), raw }
}

export function makeDiff(p: string, before: string, after: string, isNew: boolean): ApprovalPreview {
  const a = before.replace(/\r\n/g, '\n')
  const b = after.replace(/\r\n/g, '\n')
  const patch = createTwoFilesPatch(isNew ? '/dev/null' : p, p, a, b, '', '', { context: 3 })
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { kind: 'diff', path: p, diff: truncate(patch, 40000), isNew, additions, deletions }
}

export async function backup(p: string): Promise<string | undefined> {
  if (!existsSync(p)) return undefined
  const dir = backupDir()
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  // Two files with the same name in the same second each keep their own backup.
  let dest = path.join(dir, `${stamp}-${path.basename(p)}`)
  for (let i = 2; existsSync(dest); i++) dest = path.join(dir, `${stamp}-${i}-${path.basename(p)}`)
  await fs.copyFile(p, dest)
  return dest
}

const hash = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^\\\\/]*'
    } else if (c === '?') re += '[^\\\\/]'
    else if (c === '/' || c === '\\') re += '[\\\\/]'
    else if ('.+^${}()|[]'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`^${re}$`, 'i')
}

/** write_files arguments, checked: models sometimes send the list as a JSON string. */
function batchArgs(args: Record<string, unknown>, cwd: string): { files: { path: string; content: string }[]; folders: string[] } {
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return undefined
    }
  }
  const rawFiles = parse(args.files)
  const rawFolders = parse(args.folders)
  if (!Array.isArray(rawFiles) || !rawFiles.length) throw new ToolError('files must be a list of { path, content } objects.')
  if (rawFiles.length > 500) throw new ToolError('At most 500 files at once; split the work into several calls.')
  const files = rawFiles.map((f, i) => {
    const o = (f ?? {}) as { path?: unknown; content?: unknown }
    if (typeof o.path !== 'string' || !o.path.trim()) throw new ToolError(`File ${i + 1} has no path.`)
    return { path: resolvePath(o.path, cwd), content: o.content === undefined || o.content === null ? '' : String(o.content) }
  })
  const seen = new Set<string>()
  for (const f of files) {
    const k = f.path.toLowerCase()
    if (seen.has(k)) throw new ToolError(`${f.path} is listed twice.`)
    seen.add(k)
  }
  const folders = Array.isArray(rawFolders) ? rawFolders.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => resolvePath(d, cwd)) : []
  return { files, folders }
}

export const riskFor = (p: string): 'change' | 'system' => (isSystemPath(p) ? 'system' : 'change')
export const systemNote = (p: string): string | undefined =>
  isSystemPath(p) ? `This is a ${OS_LABEL} system location. Changes here can affect how your ${DEVICE_WORD} works.` : undefined

/** The biggest files under a folder, biggest first (reads sizes only; stops after 45 s on huge drives). */
async function largestFiles(root: string, pattern: string, max: number, signal: AbortSignal): Promise<string> {
  const rx = pattern && /[*?]/.test(pattern) ? globToRegex(pattern) : undefined
  const started = Date.now()
  const top: { path: string; size: number; mtime: Date }[] = []
  let scanned = 0
  const queue: string[] = [root]
  while (queue.length && Date.now() - started < 45000 && !signal.aborted) {
    const dir = queue.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('$') && e.name !== 'System Volume Information') queue.push(full)
        continue
      }
      if (!e.isFile()) continue
      if (pattern && !(rx ? rx.test(e.name) : e.name.toLowerCase().includes(pattern.toLowerCase()))) continue
      scanned++
      const st = await fs.lstat(full).catch(() => undefined)
      if (!st || (top.length >= max && st.size <= top[top.length - 1]!.size)) continue
      top.push({ path: full, size: st.size, mtime: st.mtime })
      top.sort((a, b) => b.size - a.size)
      if (top.length > max) top.pop()
    }
  }
  const partial = queue.length > 0
  return [
    `The ${top.length} biggest file(s) in ${root}${partial ? ` among the first ${scanned} files (stopped after 45 s; search a smaller folder for a complete list)` : ` (all ${scanned} files checked)`}:`,
    ...top.map((f, i) => `${i + 1}. ${f.path}  (${formatBytes(f.size)}, ${f.mtime.toISOString().slice(0, 10)})`)
  ].join('\n')
}

export const fsTools: ToolDef[] = [
  {
    name: 'list_dir',
    risk: 'read',
    description:
      'List the contents of a folder on the user PC (names, sizes, dates). Accepts absolute paths, ~, %ENV% vars and known folders like "Desktop" or "Downloads".',
    parameters: schema(
      {
        path: { type: 'string', description: 'Folder path' },
        depth: { type: 'integer', description: 'How many levels deep to list (1-3, default 1)' },
        show_hidden: { type: 'boolean', description: 'Include hidden/dot files' }
      },
      ['path']
    ),
    async prepare(args, ctx) {
      return { risk: 'read', title: `List ${resolvePath(str(args.path, 'path'), ctx.cwd)}` }
    },
    async run(args, ctx) {
      const root = resolvePath(str(args.path, 'path'), ctx.cwd)
      const depth = Math.max(1, Math.min(3, num(args.depth, 1)))
      const hidden = bool(args.show_hidden)
      const lines: string[] = []
      let count = 0
      const walk = async (dir: string, level: number): Promise<void> => {
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch (e) {
          lines.push(`${'  '.repeat(level)}(cannot read: ${(e as Error).message})`)
          return
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        for (const e of entries) {
          if (count >= 400) return
          if (!hidden && (e.name.startsWith('.') || e.name.startsWith('$'))) continue
          const full = path.join(dir, e.name)
          count++
          if (e.isDirectory()) {
            lines.push(`${'  '.repeat(level)}[dir]  ${e.name}${path.sep}`)
            if (level + 1 < depth && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(full, level + 1)
          } else {
            const st = await fs.stat(full).catch(() => undefined)
            lines.push(
              `${'  '.repeat(level)}${e.name}  (${st ? formatBytes(st.size) : '?'}${st ? `, ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}` : ''})`
            )
          }
        }
      }
      const st = await fs.stat(root).catch(() => undefined)
      if (!st) throw new ToolError(`Folder not found: ${root}`)
      if (!st.isDirectory()) throw new ToolError(`${root} is a file. Use read_file.`)
      await walk(root, 0)
      if (count >= 400) lines.push('… (listing truncated at 400 entries)')
      return `${root}\n${lines.join('\n') || '(empty folder)'}`
    }
  },
  {
    name: 'read_file',
    risk: 'read',
    description: 'Read a text file from the user PC. For large files, read a range of lines with start_line/max_lines.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'integer', description: 'First line to return (1-based, default 1)' },
        max_lines: { type: 'integer', description: 'Maximum number of lines (default 400)' }
      },
      ['path']
    ),
    async prepare(args, ctx) {
      return { risk: 'read', title: `Read ${resolvePath(str(args.path, 'path'), ctx.cwd)}` }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const { text } = await readTextFile(p)
      const lines = text.split(/\r?\n/)
      const start = Math.max(1, num(args.start_line, 1))
      const max = Math.max(1, Math.min(2000, num(args.max_lines, ctx.mode === 'code' ? 600 : 400)))
      const chunk = lines.slice(start - 1, start - 1 + max)
      // In Code mode show line numbers (never part of the text when editing).
      const width = String(start + chunk.length).length
      const body =
        ctx.mode === 'code' ? chunk.map((l, i) => `${String(start + i).padStart(width)}│${l}`).join('\n') : chunk.join('\n')
      const end = Math.min(lines.length, start - 1 + max)
      const header = `${p}: lines ${start}-${end} of ${lines.length}${end < lines.length ? ` (use start_line=${end + 1} to read more)` : ''}`
      return `${header}\n\n${truncate(body, 48000)}`
    }
  },
  {
    name: 'search_files',
    risk: 'read',
    description:
      'Find files under a folder by name pattern (glob like *.pdf or **/report*.docx) and/or by text they contain, or list the biggest files (sort "largest"). Returns paths with size and date. Read-only, runs without asking.',
    parameters: schema(
      {
        root: { type: 'string', description: `Folder to search in (e.g. ${IS_WIN ? 'C:\\, ' : '/, '}~, Documents)` },
        pattern: { type: 'string', description: 'File name glob or plain substring, e.g. *.py or invoice' },
        contains: { type: 'string', description: 'Optional text the file must contain (case-insensitive)' },
        sort: { type: 'string', enum: ['found', 'largest'], description: '"largest" scans the whole folder and returns the biggest files first' },
        max_results: { type: 'integer', description: 'Default 50 (10 with sort "largest")' }
      },
      ['root']
    ),
    async prepare(args, ctx) {
      const root = resolvePath(str(args.root, 'root'), ctx.cwd)
      return {
        risk: 'read',
        title:
          args.sort === 'largest'
            ? `Find the biggest files in ${root}`
            : `Search ${root} for ${str(args.pattern, 'pattern', false) || '*'}${args.contains ? ` containing "${args.contains}"` : ''}`
      }
    },
    async run(args, ctx) {
      const root = resolvePath(str(args.root, 'root'), ctx.cwd)
      const pattern = str(args.pattern, 'pattern', false)
      const contains = str(args.contains, 'contains', false).toLowerCase()
      if (args.sort === 'largest' && !contains) return largestFiles(root, pattern, Math.max(1, Math.min(100, num(args.max_results, 10))), ctx.signal)
      const max = Math.max(1, Math.min(200, num(args.max_results, 50)))
      const hasWild = /[*?]/.test(pattern)
      const rx = pattern && hasWild ? globToRegex(pattern) : undefined
      const pathPattern = rx && /[\\/]/.test(pattern)
      const started = Date.now()
      const results: string[] = []
      let scanned = 0
      const queue: string[] = [root]
      while (queue.length && results.length < max && Date.now() - started < 15000) {
        if (ctx.signal.aborted) break
        const dir = queue.shift()!
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('$')) queue.push(full)
            continue
          }
          scanned++
          const rel = path.relative(root, full)
          const nameOk = !pattern
            ? true
            : rx
              ? rx.test(pathPattern ? rel : e.name)
              : e.name.toLowerCase().includes(pattern.toLowerCase())
          if (!nameOk) continue
          const st = await fs.stat(full).catch(() => undefined)
          if (!st) continue
          if (contains) {
            if (st.size > 2 * 2 ** 20) continue
            const buf = await fs.readFile(full).catch(() => undefined)
            if (!buf || isBinary(buf)) continue
            const lines = decode(buf).split(/\r?\n/)
            const hits: string[] = []
            for (let i = 0; i < lines.length && hits.length < 3; i++) {
              if (lines[i].toLowerCase().includes(contains)) hits.push(`    ${i + 1}: ${lines[i].trim().slice(0, 160)}`)
            }
            if (!hits.length) continue
            results.push(`${full}  (${formatBytes(st.size)})\n${hits.join('\n')}`)
          } else {
            results.push(`${full}  (${formatBytes(st.size)}, ${st.mtime.toISOString().slice(0, 10)})`)
          }
          if (results.length >= max) break
        }
      }
      const timedOut = Date.now() - started >= 15000
      return `${results.length} match(es) in ${root} (scanned ${scanned} files${timedOut ? ', stopped after 15s' : ''}):\n${results.join('\n') || '(none)'}`
    }
  },
  {
    name: 'file_info',
    risk: 'read',
    description: 'Get details about a file or folder: size, dates, type, and for folders the total size of direct children.',
    parameters: schema({ path: { type: 'string', description: 'File or folder path' } }, ['path']),
    async prepare(args, ctx) {
      return { risk: 'read', title: `Inspect ${resolvePath(str(args.path, 'path'), ctx.cwd)}` }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const st = await fs.stat(p).catch(() => undefined)
      if (!st) throw new ToolError(`Not found: ${p}`)
      const info: string[] = [
        `Path: ${p}`,
        `Type: ${st.isDirectory() ? 'folder' : 'file'}`,
        `Created: ${st.birthtime.toISOString()}`,
        `Modified: ${st.mtime.toISOString()}`
      ]
      if (st.isDirectory()) {
        const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => [])
        let total = 0
        for (const e of entries) {
          if (e.isFile()) total += (await fs.stat(path.join(p, e.name)).catch(() => undefined))?.size ?? 0
        }
        info.push(`Entries: ${entries.length}`, `Size of files directly inside: ${formatBytes(total)}`)
      } else info.push(`Size: ${formatBytes(st.size)} (${st.size} bytes)`)
      return info.join('\n')
    }
  },
  {
    name: 'write_file',
    risk: 'change',
    description:
      'Create a new text file or overwrite an existing one with the full content given. Missing folders are created automatically. The user must approve. Prefer edit_file or multi_edit for changes to existing files.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Complete file content' }
      },
      ['path', 'content']
    ),
    async prepare(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const content = str(args.content, 'content', false)
      const exists = existsSync(p)
      const before = exists ? (await readTextFile(p)).text : ''
      return {
        risk: riskFor(p),
        title: `${exists ? 'Overwrite' : 'Create'} ${p}`,
        detail: systemNote(p),
        preview: makeDiff(p, before, content, !exists),
        targets: [p]
      }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const content = str(args.content, 'content', false)
      const original = existsSync(p) ? await fs.readFile(p) : undefined
      const bak = await backup(p)
      if (bak) ctx.reportBackup(bak)
      await fs.mkdir(path.dirname(p), { recursive: true })
      const out = encodeLike(original, content)
      await fs.writeFile(p, out)
      return `Wrote ${formatBytes(out.length)} to ${p}${bak ? `. Previous version backed up to ${bak}` : ''}`
    }
  },
  {
    name: 'write_files',
    risk: 'change',
    description:
      'Create (or overwrite) several text files at once, plus any empty folders, in one step that the user approves once. Missing folders are created automatically. Use it for a set of new files or a folder tree instead of many write_file or make_dir calls.',
    parameters: schema(
      {
        files: {
          type: 'array',
          description: 'The files to write',
          items: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Complete file content' } },
            required: ['path', 'content']
          }
        },
        folders: { type: 'array', description: 'Extra empty folders to create (optional)', items: { type: 'string' } }
      },
      ['files']
    ),
    async prepare(args, ctx) {
      const { files, folders } = batchArgs(args, ctx.cwd)
      const targets = [...files.map((f) => f.path), ...folders]
      const overwrite = files.filter((f) => existsSync(f.path)).length
      const items = [
        ...folders.filter((d) => !existsSync(d)).map((d) => `Folder  ${d}`),
        ...files.map((f) => `${existsSync(f.path) ? 'Replace' : 'Create '} ${f.path}  (${formatBytes(Buffer.byteLength(f.content))})`)
      ]
      const system = targets.some((t) => isSystemPath(t))
      return {
        risk: system ? 'system' : 'change',
        title: `Write ${files.length} file${files.length === 1 ? '' : 's'}${folders.length ? ` and ${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''}${overwrite ? ` (${overwrite} replaced)` : ''}`,
        detail: system ? `Some of these are in a ${OS_LABEL} system location. Changes there can affect how your ${DEVICE_WORD} works.` : undefined,
        preview: { kind: 'list', items: items.slice(0, 200) },
        targets
      }
    },
    async run(args, ctx) {
      const { files, folders } = batchArgs(args, ctx.cwd)
      const lines: string[] = []
      for (const d of folders) {
        await fs.mkdir(d, { recursive: true })
      }
      for (const f of files) {
        const original = existsSync(f.path) ? await fs.readFile(f.path) : undefined
        const bak = await backup(f.path)
        if (bak) ctx.reportBackup(bak)
        await fs.mkdir(path.dirname(f.path), { recursive: true })
        const out = encodeLike(original, f.content)
        await fs.writeFile(f.path, out)
        lines.push(`${original ? 'Replaced' : 'Created'} ${f.path} (${formatBytes(out.length)})${bak ? `, backup ${bak}` : ''}`)
      }
      if (folders.length) lines.unshift(`Folders ready: ${folders.join(', ')}`)
      return `${files.length} file${files.length === 1 ? '' : 's'} written.\n${lines.join('\n')}`
    }
  },
  {
    name: 'edit_file',
    risk: 'change',
    description:
      'Replace an exact piece of text in an existing file. old_text must match the file exactly (including whitespace) and be unique unless replace_all is true. The user must approve.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        old_text: { type: 'string', description: 'Exact text to find' },
        new_text: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' }
      },
      ['path', 'old_text', 'new_text']
    ),
    async prepare(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const { text } = await readTextFile(p)
      const next = applyEdit(text, str(args.old_text, 'old_text'), str(args.new_text, 'new_text', false), bool(args.replace_all))
      return { risk: riskFor(p), title: `Edit ${p}`, detail: systemNote(p), preview: makeDiff(p, text, next, false), targets: [p] }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const { text, raw } = await readTextFile(p)
      const next = applyEdit(text, str(args.old_text, 'old_text'), str(args.new_text, 'new_text', false), bool(args.replace_all))
      const bak = await backup(p)
      if (bak) ctx.reportBackup(bak)
      await fs.writeFile(p, encodeLike(raw, next))
      return `Edited ${p} (backup: ${bak}). Hash ${hash(raw).slice(0, 8)} → ${hash(Buffer.from(next)).slice(0, 8)}`
    }
  },
  {
    name: 'make_dir',
    risk: 'change',
    description: 'Create a folder (and any missing parent folders). The user must approve.',
    parameters: schema({ path: { type: 'string', description: 'Folder path to create' } }, ['path']),
    async prepare(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      // Nothing to change when the folder is already there.
      if (existsSync(p)) return { risk: 'read', title: `Folder already exists: ${p}` }
      return { risk: riskFor(p), title: `Create folder ${p}`, detail: systemNote(p), preview: { kind: 'list', items: [p] }, targets: [p] }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      if (existsSync(p)) return `Folder already exists: ${p}`
      await fs.mkdir(p, { recursive: true })
      return `Created folder ${p}`
    }
  },
  {
    name: 'move_path',
    risk: 'change',
    description: 'Move or rename a file or folder. The user must approve.',
    parameters: schema(
      {
        from: { type: 'string', description: 'Existing path' },
        to: { type: 'string', description: 'New path (full destination path, not just a folder)' }
      },
      ['from', 'to']
    ),
    async prepare(args, ctx) {
      const from = resolvePath(str(args.from, 'from'), ctx.cwd)
      const to = resolvePath(str(args.to, 'to'), ctx.cwd)
      if (!existsSync(from)) throw new ToolError(`Not found: ${from}`)
      if (existsSync(to)) throw new ToolError(`Destination already exists: ${to}`)
      const sys = isSystemPath(from) || isSystemPath(to)
      return {
        risk: sys ? 'system' : 'change',
        title: `Move ${path.basename(from)} → ${to}`,
        detail: sys ? `Involves a ${OS_LABEL} system location.` : undefined,
        preview: { kind: 'list', items: [`From: ${from}`, `To:   ${to}`] },
        targets: [from, to]
      }
    },
    async run(args, ctx) {
      const from = resolvePath(str(args.from, 'from'), ctx.cwd)
      const to = resolvePath(str(args.to, 'to'), ctx.cwd)
      await fs.mkdir(path.dirname(to), { recursive: true })
      try {
        await fs.rename(from, to)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
        await fs.cp(from, to, { recursive: true, errorOnExist: true })
        await shell.trashItem(from)
        return `Copied ${from} to ${to} (different drive) and moved the original to the ${TRASH_LABEL}`
      }
      return `Moved ${from} → ${to}`
    }
  },
  {
    name: 'copy_path',
    risk: 'change',
    description: 'Copy a file or folder to a new location. The user must approve.',
    parameters: schema(
      {
        from: { type: 'string', description: 'Existing path' },
        to: { type: 'string', description: 'Destination path' }
      },
      ['from', 'to']
    ),
    async prepare(args, ctx) {
      const from = resolvePath(str(args.from, 'from'), ctx.cwd)
      const to = resolvePath(str(args.to, 'to'), ctx.cwd)
      if (!existsSync(from)) throw new ToolError(`Not found: ${from}`)
      if (existsSync(to)) throw new ToolError(`Destination already exists: ${to}`)
      return {
        risk: riskFor(to),
        title: `Copy ${path.basename(from)} → ${to}`,
        detail: systemNote(to),
        preview: { kind: 'list', items: [`From: ${from}`, `To:   ${to}`] },
        targets: [to]
      }
    },
    async run(args, ctx) {
      const from = resolvePath(str(args.from, 'from'), ctx.cwd)
      const to = resolvePath(str(args.to, 'to'), ctx.cwd)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.cp(from, to, { recursive: true, errorOnExist: true })
      return `Copied ${from} → ${to}`
    }
  },
  {
    name: 'delete_path',
    risk: 'change',
    description: `Move a file or folder to the ${IS_WIN ? 'Windows Recycle Bin' : 'Trash'} (recoverable). The user must approve.`,
    parameters: schema({ path: { type: 'string', description: 'File or folder to delete' } }, ['path']),
    async prepare(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      const st = await fs.stat(p).catch(() => undefined)
      if (!st) throw new ToolError(`Not found: ${p}`)
      if (/^[a-z]:\\?$/i.test(p) || p === path.parse(p).root) throw new ToolError('Refusing to delete a whole drive.')
      // The home folder, and the folders it is in, hold everything the person has.
      const home = os.homedir()
      if (isInside(home, p)) throw new ToolError(`Refusing to delete ${p}: it is your home folder or contains it. Name the files or folders inside it that should go.`)
      return {
        risk: riskFor(p),
        title: `Move to ${TRASH_LABEL}: ${p}`,
        detail: systemNote(p) ?? `You can restore it from the ${TRASH_LABEL}.`,
        targets: [p],
        preview: { kind: 'list', items: [`${st.isDirectory() ? 'Folder' : 'File'}: ${p}${st.isFile() ? ` (${formatBytes(st.size)})` : ''}`] }
      }
    },
    async run(args, ctx) {
      const p = resolvePath(str(args.path, 'path'), ctx.cwd)
      await shell.trashItem(p)
      return `Moved ${p} to the ${TRASH_LABEL}`
    }
  }
]

export function applyEdit(text: string, oldText: string, newText: string, all: boolean): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const norm = text.replace(/\r\n/g, '\n')
  const o = oldText.replace(/\r\n/g, '\n')
  const n = newText.replace(/\r\n/g, '\n')
  if (!o) throw new ToolError('old_text must not be empty')
  const count = norm.split(o).length - 1
  // Models sometimes copy read_file's "12│" line-number gutter; strip it and try again.
  const GUTTER = /^\s*\d+│/
  if (count === 0 && o.split('\n').some((l) => GUTTER.test(l)) && o.split('\n').every((l) => GUTTER.test(l) || l === '')) {
    const strip = (s: string): string =>
      s
        .split('\n')
        .map((l) => l.replace(GUTTER, ''))
        .join('\n')
    return applyEdit(text, strip(o), strip(n), all)
  }
  if (count === 0) throw new ToolError('old_text was not found in the file. Read the file again and copy the exact text.')
  if (count > 1 && !all)
    throw new ToolError(`old_text appears ${count} times. Include more surrounding text to make it unique, or set replace_all.`)
  const out = all ? norm.split(o).join(n) : norm.replace(o, () => n)
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out
}
