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

/** The installer in a release that fits this computer. */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: string,
  arch: string
): { name: string; url: string; size: number } | undefined {
  const a = assets.map((x) => ({ name: x.name, url: x.browser_download_url, size: x.size }))
  const archWord = arch === 'arm64' ? /arm64|aarch64/i : /x64|x86_64|amd64/i
  if (platform === 'win32') return a.find((x) => /setup.*\.exe$/i.test(x.name)) ?? a.find((x) => /\.exe$/i.test(x.name))
  if (platform === 'darwin') return a.find((x) => /\.dmg$/i.test(x.name) && archWord.test(x.name)) ?? a.find((x) => /\.dmg$/i.test(x.name))
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
