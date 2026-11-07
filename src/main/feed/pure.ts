// Pure helpers for updates and news, without imports, so tests/feed.test.ts can check them.

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

/** "v1.2.3" → [1, 2, 3, 1]; a pre-release suffix ("-beta.1") counts as older than the plain version. */
export function parseVersion(v: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)(-.+)?/.exec(v)
  if (!m) return [0, 0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1]
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < 4; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/**
 * The installer in a release that fits this computer. On Linux, `linuxPackage` says how this copy was
 * installed: a .deb or .rpm installation updates with the same kind of package, otherwise the AppImage.
 */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: string,
  arch: string,
  linuxPackage?: 'deb' | 'rpm'
): { name: string; url: string; size: number } | undefined {
  const a = assets.map((x) => ({ name: x.name, url: x.browser_download_url, size: x.size }))
  const archWord = arch === 'arm64' ? /arm64|aarch64/i : /x64|x86_64|amd64/i
  if (platform === 'win32') return a.find((x) => /setup.*\.exe$/i.test(x.name)) ?? a.find((x) => /\.exe$/i.test(x.name))
  if (platform === 'darwin') return a.find((x) => /\.dmg$/i.test(x.name) && archWord.test(x.name)) ?? a.find((x) => /\.dmg$/i.test(x.name))
  if (linuxPackage) {
    const ext = linuxPackage === 'deb' ? /\.deb$/i : /\.rpm$/i
    const pkg = a.find((x) => ext.test(x.name) && archWord.test(x.name))
    if (pkg) return pkg
  }
  return a.find((x) => /\.AppImage$/i.test(x.name) && archWord.test(x.name)) ?? a.find((x) => /\.AppImage$/i.test(x.name))
}

/** Short id for a new post from its date and title: 2026-11-06-new-skills-tab. */
export function postId(title: string, date = new Date()): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `${date.toISOString().slice(0, 10)}-${slug || 'post'}`
}

/** Picture references in a post's Markdown (Markdown images and HTML img tags). */
export function imageRefs(md: string): string[] {
  const refs = new Set<string>()
  // ![alt](path "title") and ![alt](<path with spaces>)
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)) refs.add((m[1] ?? m[2])!)
  for (const m of md.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) refs.add(m[1]!)
  return [...refs]
}

// ------------------------------------------------------------------ news posts as plain Markdown files

/** The fields of a news post (the same shape as NewsEntry in src/shared/extensions.ts). */
export interface PostFields {
  id: string
  title: string
  kind: 'news' | 'update' | 'tip'
  date: string
  summary: string
  file: string
  cover?: string
  version?: string
  pinned?: boolean
  author?: string
  source?: 'file'
}

/** "---\nkey: value\n---" at the top of a post: its fields, and the text after them. */
export function splitFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)
  if (!m) return { meta: {}, body: md.replace(/^\uFEFF/, '') }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return { meta, body: md.slice(m[0].length) }
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/

/** Plain words from a Markdown paragraph (no links, emphasis or code marks). */
function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A post written as a Markdown file straight in the repository's news folder (no index entry needed).
 * Fields come from front matter when it is there; otherwise the title is the first "# heading", the date
 * comes from a YYYY-MM-DD at the start of the file name, the summary is the first paragraph and the cover
 * is the first picture.
 */
export function entryFromMarkdown(fileName: string, md: string): PostFields {
  const { meta, body } = splitFrontMatter(md)
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.md$/i, '')
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]
  const fromName = stem.replace(DATE_PREFIX, '').replace(/^[-_\s]+/, '').replace(/[-_]+/g, ' ').trim()
  const title = meta.title || heading || (fromName ? fromName.charAt(0).toUpperCase() + fromName.slice(1) : stem)
  const rawDate = meta.date || DATE_PREFIX.exec(stem)?.[1] || ''
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T12:00:00.000Z` : rawDate
  let summary = meta.summary ?? ''
  if (!summary) {
    // The first paragraph that is text (not a heading, picture, list marker only or code).
    const blocks = body.replace(/```[\s\S]*?```/g, '').split(/\r?\n\s*\r?\n/)
    for (const b of blocks) {
      if (/^\s*#/.test(b)) continue
      const t = plainText(b)
      if (t) {
        summary = t.length > 220 ? `${t.slice(0, 217).replace(/\s+\S*$/, '')}…` : t
        break
      }
    }
  }
  const kind = meta.kind === 'update' || meta.kind === 'tip' || meta.kind === 'news' ? meta.kind : meta.version ? 'update' : 'news'
  return {
    id: stem.toLowerCase().replace(/[^\w.-]+/g, '-'),
    title,
    kind,
    date,
    summary,
    file: fileName,
    cover: meta.cover || imageRefs(body)[0],
    ...(meta.version ? { version: meta.version.replace(/^v/i, '') } : {}),
    ...(/^(true|yes|1)$/i.test(meta.pinned ?? '') ? { pinned: true } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    source: 'file'
  }
}

/** The posts listed in index.json, plus Markdown files in the folder that the index does not list. */
export function mergeNews<T extends PostFields>(indexed: T[], files: T[]): T[] {
  const files0 = new Set(indexed.map((p) => p.file.toLowerCase()))
  const ids = new Set(indexed.map((p) => p.id))
  const out = [...indexed]
  for (const f of files) {
    if (files0.has(f.file.toLowerCase()) || ids.has(f.id)) continue
    ids.add(f.id)
    out.push(f)
  }
  return out
}

/** A post's text as shown under its title: without front matter or a first heading that repeats the title. */
export function bodyForDisplay(md: string, title: string): string {
  const { body } = splitFrontMatter(md)
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body)
  return m && m[1]!.trim().toLowerCase() === title.trim().toLowerCase() ? body.slice(m[0].length).replace(/^\s+/, '') : body
}

/** "sha256  file name" lines (sha256sum's format) → file name → lowercase hash. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (m) out.set(m[2]!.replace(/^.*\//, ''), m[1]!.toLowerCase())
  }
  return out
}
