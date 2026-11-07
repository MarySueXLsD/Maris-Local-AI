import { app, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NewsEntry, NewsIndex, NewsPostContent, NewsState, UpdateInfo, UpdateState } from '@shared/extensions'
import { settings } from '../settings'
import { Emitter, log } from '../util'
import { gh, GitHubError, isNewer, raw, rawBase } from './github'
import { bodyForDisplay, entryFromMarkdown, imageRefs, mergeNews, parseChecksums, pickAsset, postId } from './pure'

export { postId }

/** The folder in the repository that holds news posts, and its branch. */
export const NEWS_FOLDER = 'news'
export const NEWS_BRANCH = process.env.MARIS_NEWS_BRANCH ?? 'main'

interface Release {
  tag_name: string
  name?: string
  body?: string
  html_url: string
  published_at: string
  draft?: boolean
  prerelease?: boolean
  assets: { name: string; browser_download_url: string; size: number }[]
}

/** The SHA-256 of a file on disk. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' }

/** Checks for new versions and fetches news posts from the publishing repository while online. */
class Feed {
  readonly updateChanged = new Emitter<UpdateState>()
  readonly newsChanged = new Emitter<NewsState>()
  private update: UpdateState = { current: app.getVersion(), checking: false }
  private news: NewsState = { posts: [], loading: false, unread: 0 }
  private index?: NewsIndex
  /** Posts written as Markdown files in the news folder, from the last look at git. */
  private mdPosts: NewsEntry[] = []
  private read = new Set<string>()
  private timer?: NodeJS.Timeout
  private notified = new Set<string>()

  dir(): string {
    const d = path.join(app.getPath('userData'), 'news-cache')
    mkdirSync(path.join(d, 'img'), { recursive: true })
    return d
  }

  private repo(): string {
    return settings.get().updates.repo.trim()
  }

  /** justUpdated: Maris was started by its own update (the installer passes --updated). */
  start(opts: { justUpdated?: boolean } = {}): void {
    if (opts.justUpdated) {
      this.update = { ...this.update, justUpdated: app.getVersion() }
      // The installer that was just used is no longer needed.
      void this.cleanDownloads()
    }
    try {
      this.index = JSON.parse(readFileSync(path.join(this.dir(), 'index.json'), 'utf8')) as NewsIndex
      this.mdPosts = this.index.posts.filter((p) => p.source === 'file')
      this.read = new Set(JSON.parse(readFileSync(path.join(this.dir(), 'read.json'), 'utf8')) as string[])
      this.notified = new Set(JSON.parse(readFileSync(path.join(this.dir(), 'notified.json'), 'utf8')) as string[])
    } catch {
      /* first start */
    }
    this.publishNews()
    setTimeout(() => void this.refresh(), 15000).unref()
    this.reschedule()
  }

  reschedule(): void {
    if (this.timer) clearInterval(this.timer)
    const hours = Math.max(1, settings.get().updates.intervalHours || 6)
    this.timer = setInterval(() => void this.refresh(), hours * 3600_000)
    this.timer.unref()
  }

  updateState(): UpdateState {
    return this.update
  }

  newsState(): NewsState {
    return this.news
  }

  /** Check for a new version and new posts (each only when turned on). */
  async refresh(): Promise<void> {
    const cfg = settings.get().updates
    await Promise.all([cfg.check ? this.checkUpdate() : Promise.resolve(), cfg.news ? this.fetchNews() : Promise.resolve()])
  }

  // ---------------------------------------------------------------- updates

  async checkUpdate(): Promise<UpdateState> {
    if (this.update.checking) return this.update
    this.setUpdate({ checking: true, error: undefined })
    try {
      const rel = await gh<Release>(`/repos/${this.repo()}/releases/latest`)
      const version = rel.tag_name.replace(/^v/i, '')
      const available: UpdateInfo | undefined =
        !rel.draft && isNewer(version, this.update.current)
          ? {
              version,
              name: rel.name || `Maris ${version}`,
              notes: rel.body ?? '',
              url: rel.html_url,
              publishedAt: rel.published_at,
              asset: pickAsset(rel.assets, process.platform, process.arch),
              checksums: rel.assets.filter((a) => /^SHA256SUMS.*\.txt$/i.test(a.name)).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
            }
          : undefined
      // A download of an older update than this one is of no use any more.
      const same = available && this.update.available?.version === available.version
      this.setUpdate({ checking: false, checkedAt: Date.now(), available, offline: false, ...(same ? {} : { downloaded: undefined, ready: undefined }) })
      if (available && !this.notified.has(`v${version}`)) {
        this.notify(`v${version}`, `Maris ${version} is available`, settings.get().updates.autoDownload ? 'It is getting ready in the background; Updates & news says when you can restart to update.' : 'Open Updates & news to see what is new and install it.')
      }
      // Get it ready in the background, so updating is one click and about a minute.
      if (available?.asset && settings.get().updates.autoDownload && this.update.downloading === undefined && !this.update.ready) void this.downloadUpdate()
    } catch (e) {
      const err = e as GitHubError
      // No releases yet is not an error worth showing.
      if (err.status === 404) this.setUpdate({ checking: false, checkedAt: Date.now(), available: undefined, offline: false })
      else this.setUpdate({ checking: false, checkedAt: Date.now(), offline: err.status === 0, error: err.status === 0 ? undefined : err.message })
    }
    return this.update
  }

  private setUpdate(patch: Partial<UpdateState>): void {
    this.update = { ...this.update, ...patch }
    this.updateChanged.emit(this.update)
  }

  /** The fingerprint the release publishes for one of its files, if it publishes any. */
  private async expectedHash(name: string): Promise<string | undefined> {
    for (const c of this.update.available?.checksums ?? []) {
      try {
        const res = await fetch(c.url, { headers: { 'User-Agent': 'Maris' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
        if (!res.ok) continue
        const hash = parseChecksums(await res.text()).get(name)
        if (hash) return hash
      } catch {
        /* try the next list */
      }
    }
    return undefined
  }

  /**
   * Download this computer's installer in the background and check it (size, and the SHA-256 the release
   * publishes) before it may be used.
   */
  async downloadUpdate(): Promise<UpdateState> {
    const asset = this.update.available?.asset
    if (!asset) throw new Error('This update has no installer for this computer. Open the release page to download it.')
    if (this.update.downloading !== undefined) return this.update
    const dir = path.join(app.getPath('userData'), 'updates')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, path.basename(asset.name))
    const part = `${file}.part`
    this.setUpdate({ downloading: 0, downloaded: undefined, ready: undefined, error: undefined })
    try {
      const expected = await this.expectedHash(asset.name)
      // Already downloaded earlier (Maris was restarted in between): check it and use it.
      if (existsSync(file) && (!asset.size || statSync(file).size === asset.size) && (!expected || (await sha256File(file)) === expected)) {
        this.setUpdate({ downloading: undefined, downloaded: file, ready: true })
        this.notifyReady()
        return this.update
      }
      const res = await fetch(asset.url, { headers: { 'User-Agent': 'Maris' }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
      const total = Number(res.headers.get('content-length')) || asset.size || 0
      const hash = createHash('sha256')
      const out = createWriteStream(part)
      let got = 0
      let last = 0
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          hash.update(chunk)
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
          got += chunk.byteLength
          if (total && Date.now() - last > 300) {
            last = Date.now()
            this.setUpdate({ downloading: Math.min(0.99, got / total) })
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()))
      }
      if (asset.size && got !== asset.size) throw new Error('The download stopped part-way. It is tried again at the next check.')
      if (expected && hash.digest('hex') !== expected) throw new Error('The download does not match the fingerprint the release publishes, so it was not used.')
      await fs.rm(file, { force: true })
      await fs.rename(part, file)
      if (process.platform === 'linux') chmodSync(file, 0o755)
      this.setUpdate({ downloading: undefined, downloaded: file, ready: true })
      this.notifyReady()
    } catch (e) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      this.setUpdate({ downloading: undefined, error: (e as Error).message })
    }
    return this.update
  }

  private notifyReady(): void {
    const v = this.update.available?.version
    if (v && !this.notified.has(`ready-v${v}`)) this.notify(`ready-v${v}`, `Maris ${v} is ready`, 'Restart and update from Updates & news; it takes about a minute.')
  }

  /** Installers left from earlier updates. */
  private async cleanDownloads(): Promise<void> {
    const dir = path.join(app.getPath('userData'), 'updates')
    try {
      for (const f of readdirSync(dir)) await fs.rm(path.join(dir, f), { force: true }).catch(() => undefined)
    } catch {
      /* nothing downloaded */
    }
  }

  /**
   * Install the downloaded update (only from the person's click). Windows: the installer runs silently
   * (no windows to click through), keeps the choices made at the first install, and starts Maris again.
   * An installation for all users makes Windows ask for permission once. Linux AppImage: the file is
   * replaced and Maris restarts.
   */
  async installUpdate(): Promise<void> {
    const file = this.update.downloaded
    if (!file || !existsSync(file) || !this.update.ready) throw new Error('The update is not ready yet.')
    if (process.platform === 'win32') {
      spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => app.quit(), 600)
      return
    }
    if (process.platform === 'linux' && process.env.APPIMAGE && existsSync(process.env.APPIMAGE)) {
      const target = process.env.APPIMAGE
      const next = `${target}.new`
      await fs.copyFile(file, next)
      chmodSync(next, 0o755)
      await fs.rename(next, target)
      app.relaunch({ execPath: target, args: ['--updated'] })
      app.exit(0)
      return
    }
    if (process.platform === 'darwin') {
      // The disk image opens in Finder: drag Maris into Applications to replace this version.
      await shell.openPath(file)
      return
    }
    shell.showItemInFolder(file)
  }

  openRelease(): void {
    const url = this.update.available?.url ?? `https://github.com/${this.repo()}/releases`
    void shell.openExternal(url)
  }

  // ---------------------------------------------------------------- news

  async fetchNews(): Promise<NewsState> {
    this.news = { ...this.news, loading: true }
    this.newsChanged.emit(this.news)
    // Posts come from news/index.json (written by the Admin page) and from any Markdown file put straight
    // into the news folder in git. Either may be missing.
    const repo = this.repo()
    const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: GitHubError }> =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (e: unknown) => ({ ok: false as const, error: e as GitHubError })
      )
    const idx = await settle(
      raw(repo, NEWS_BRANCH, `${NEWS_FOLDER}/index.json`, { fresh: true }).then((b) => {
        const parsed = JSON.parse(b.toString('utf8')) as NewsIndex
        if (!Array.isArray(parsed.posts)) throw new Error('index.json has no posts list')
        return parsed.posts
      })
    )
    // Files index.json lists are its posts already; they are not read twice.
    const listed = new Set((idx.ok ? idx.value : []).map((p) => p.file.toLowerCase()))
    const files = await settle(this.markdownPosts(repo, listed))
    const failed = [idx, files].flatMap((r) => (r.ok ? [] : [r.error]))
    if (failed.length === 2 && !failed.every((e) => e.status === 404)) {
      const err = failed.find((e) => e.status !== 404) ?? failed[0]!
      this.news = { ...this.news, loading: false, offline: err.status === 0, error: err.status === 0 ? undefined : err.message, fetchedAt: Date.now() }
      this.publishNews()
      return this.news
    }
    // One source failing for a moment (a server error, a half-written index.json) keeps its last good
    // copy; only "not found" means its posts are gone.
    this.mdPosts = files.ok ? files.value : files.error.status === 404 ? [] : this.mdPosts
    const indexed = idx.ok ? idx.value : idx.error.status === 404 ? [] : (this.index?.posts ?? []).filter((p) => p.source !== 'file')
    this.setIndex({ version: 1, updated: new Date().toISOString(), posts: indexed })
    const posts = this.index?.posts ?? []
    this.news = { ...this.news, loading: false, offline: false, error: undefined, fetchedAt: Date.now() }
    const fresh = posts.filter((p) => !this.read.has(p.id) && !this.notified.has(p.id))
    // First fetch on a new install: do not announce the whole history.
    if (this.notified.size === 0) for (const p of posts) this.notified.add(p.id)
    else if (fresh[0]) this.notify(fresh[0].id, fresh[0].title, fresh[0].summary || 'A new post in Updates & news.')
    for (const p of fresh) this.notified.add(p.id)
    this.saveJson('notified.json', [...this.notified])
    await this.cacheCovers()
    this.publishNews()
    return this.news
  }

  /**
   * Markdown files in the repository's news folder, each one a post (see entryFromMarkdown for how its
   * title, date and summary are found). Files are read again only when git has a new version of them.
   */
  private async markdownPosts(repo: string, listed: Set<string>): Promise<NewsEntry[]> {
    type Item = { name?: string; path: string; type: string; sha?: string }
    const ls = (dir: string): Promise<Item[]> => gh<Item[]>(`/repos/${repo}/contents/${dir}?ref=${encodeURIComponent(NEWS_BRANCH)}`)
    const top = await ls(NEWS_FOLDER)
    if (!Array.isArray(top)) return []
    const list = [...top]
    // The Admin page keeps its posts in news/posts; a file added there by hand (not in index.json) counts too.
    if (top.some((f) => f.type === 'dir' && (f.name ?? f.path.split('/').pop()) === 'posts')) {
      const more = await ls(`${NEWS_FOLDER}/posts`).catch(() => [] as Item[])
      if (Array.isArray(more)) list.push(...more)
    }
    let cache: Record<string, NewsEntry> = {}
    try {
      cache = JSON.parse(readFileSync(path.join(this.dir(), 'md-posts.json'), 'utf8')) as Record<string, NewsEntry>
    } catch {
      /* first time */
    }
    const next: Record<string, NewsEntry> = {}
    const out: NewsEntry[] = []
    for (const f of list) {
      // The file's path inside the news folder: hello.md, or posts/hello.md.
      const rel = f.path.startsWith(`${NEWS_FOLDER}/`) ? f.path.slice(NEWS_FOLDER.length + 1) : (f.name ?? f.path)
      const name = rel.split('/').pop() ?? ''
      if (f.type !== 'file' || !/\.md$/i.test(name) || /^readme\.md$/i.test(name) || listed.has(rel.toLowerCase())) continue
      const key = `${rel}@${f.sha ?? ''}`
      let entry = f.sha ? cache[key] : undefined
      if (!entry) {
        const md = (await raw(repo, NEWS_BRANCH, `${NEWS_FOLDER}/${rel}`, { fresh: true })).toString('utf8')
        entry = entryFromMarkdown(rel, md) as NewsEntry
      }
      if (f.sha) next[key] = entry
      out.push(entry)
    }
    this.saveJson('md-posts.json', next)
    return out
  }

  /**
   * The list from index.json (also right after the admin published, without waiting for GitHub's file
   * cache), together with the posts written as Markdown files.
   */
  setIndex(idx: NewsIndex): void {
    idx = { ...idx, posts: mergeNews(idx.posts.filter((p) => p.source !== 'file'), this.mdPosts) }
    idx.posts.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.date.localeCompare(a.date))
    this.index = idx
    this.saveJson('index.json', idx)
    this.publishNews()
  }

  /** A Markdown post was just deleted in git: it leaves the list now rather than at the next look. */
  forgetFilePost(id: string): void {
    this.mdPosts = this.mdPosts.filter((p) => p.id !== id)
    this.setIndex(this.currentIndex())
  }

  currentIndex(): NewsIndex {
    return this.index ?? { version: 1, updated: new Date().toISOString(), posts: [] }
  }

  private publishNews(): void {
    const posts = (this.index?.posts ?? []).map((p) => ({ ...p, unread: !this.read.has(p.id), coverPath: p.cover ? this.cachedPath(this.urlFor(p.cover)) : undefined }))
    this.news = { ...this.news, posts, unread: posts.filter((p) => p.unread).length }
    this.newsChanged.emit(this.news)
  }

  private async cacheCovers(): Promise<void> {
    for (const p of (this.index?.posts ?? []).slice(0, 30)) {
      if (p.cover) await this.cacheImage(this.urlFor(p.cover)).catch(() => undefined)
    }
  }

  markRead(ids: string[] | 'all'): NewsState {
    const list = ids === 'all' ? (this.index?.posts ?? []).map((p) => p.id) : ids
    for (const id of list) this.read.add(id)
    this.saveJson('read.json', [...this.read])
    this.publishNews()
    return this.news
  }

  /** A post's Markdown, with its pictures downloaded and pointing at the local copies. */
  async post(id: string): Promise<NewsPostContent> {
    const entry = this.index?.posts.find((p) => p.id === id)
    if (!entry) throw new Error('This post is no longer published.')
    const cacheFile = path.join(this.dir(), `post-${createHash('sha1').update(`${entry.id}|${entry.date}`).digest('hex').slice(0, 16)}.md`)
    let body: string
    try {
      body = (await raw(this.repo(), NEWS_BRANCH, `${NEWS_FOLDER}/${entry.file}`)).toString('utf8')
      await fs.writeFile(cacheFile, body)
    } catch (e) {
      if (!existsSync(cacheFile)) throw new Error(`Could not load the post (${(e as Error).message}).`)
      body = await fs.readFile(cacheFile, 'utf8')
    }
    this.markRead([id])
    return { entry, body: await this.localizeImages(bodyForDisplay(body, entry.title)) }
  }

  /** Relative picture paths are relative to the news folder; every picture is cached on this computer. */
  urlFor(ref: string): string {
    return /^https?:\/\//i.test(ref) ? ref : new URL(ref.replace(/^\.?\//, ''), `${rawBase(this.repo(), NEWS_BRANCH)}${NEWS_FOLDER}/`).toString()
  }

  private cachedPath(url: string): string | undefined {
    const base = path.join(this.dir(), 'img', createHash('sha1').update(url).digest('hex').slice(0, 20))
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']) if (existsSync(base + ext)) return base + ext
    return undefined
  }

  async cacheImage(url: string): Promise<string> {
    const hit = this.cachedPath(url)
    if (hit) return hit
    const res = await fetch(url, { headers: { 'User-Agent': 'Maris' }, signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`picture ${res.status}`)
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    const ext = MIME_EXT[type] ?? (path.extname(new URL(url).pathname).toLowerCase() || '.png')
    const file = path.join(this.dir(), 'img', createHash('sha1').update(url).digest('hex').slice(0, 20) + ext)
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
    return file
  }

  private async localizeImages(md: string): Promise<string> {
    let out = md
    for (const ref of imageRefs(md)) {
      if (/^(data:|maris-media:)/i.test(ref)) continue
      try {
        const file = await this.cacheImage(this.urlFor(ref))
        const local = `maris-media://file/${encodeURIComponent(file)}`
        // (path) and (path "title"), <path with spaces>, and src="path" in HTML.
        out = out.split(`(${ref}`).join(`(${local}`).split(`<${ref}>`).join(`<${local}>`).split(`"${ref}"`).join(`"${local}"`)
      } catch (e) {
        log.warn('news', `picture ${ref}`, e)
      }
    }
    return out
  }

  private notify(key: string, title: string, body: string): void {
    this.notified.add(key)
    this.saveJson('notified.json', [...this.notified])
    try {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
    } catch {
      /* notifications unavailable */
    }
  }

  private saveJson(name: string, value: unknown): void {
    try {
      writeFileSync(path.join(this.dir(), name), JSON.stringify(value, null, 1))
    } catch (e) {
      log.warn('news', e)
    }
  }
}

export const feed = new Feed()

export type { NewsEntry }
