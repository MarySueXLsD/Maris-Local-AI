import { app, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NewsEntry, NewsIndex, NewsPostContent, NewsState, UpdateInfo, UpdateState } from '@shared/extensions'
import { settings } from '../settings'
import { Emitter, log } from '../util'
import { gh, GitHubError, isNewer, raw, rawBase } from './github'
import { imageRefs, pickAsset, postId } from './pure'

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

const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' }

/** Checks for new versions and fetches news posts from the publishing repository while online. */
class Feed {
  readonly updateChanged = new Emitter<UpdateState>()
  readonly newsChanged = new Emitter<NewsState>()
  private update: UpdateState = { current: app.getVersion(), checking: false }
  private news: NewsState = { posts: [], loading: false, unread: 0 }
  private index?: NewsIndex
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

  start(): void {
    try {
      this.index = JSON.parse(readFileSync(path.join(this.dir(), 'index.json'), 'utf8')) as NewsIndex
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
          ? { version, name: rel.name || `Maris ${version}`, notes: rel.body ?? '', url: rel.html_url, publishedAt: rel.published_at, asset: pickAsset(rel.assets, process.platform, process.arch) }
          : undefined
      this.setUpdate({ checking: false, checkedAt: Date.now(), available, offline: false })
      if (available && !this.notified.has(`v${version}`)) {
        this.notify(`v${version}`, `Maris ${version} is available`, 'Open Updates & news to see what is new and install it.')
      }
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

  /** Download the installer for this computer, with progress. */
  async downloadUpdate(): Promise<UpdateState> {
    const asset = this.update.available?.asset
    if (!asset) throw new Error('This update has no installer for this computer. Open the release page to download it.')
    const dir = path.join(app.getPath('userData'), 'updates')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, path.basename(asset.name))
    this.setUpdate({ downloading: 0, downloaded: undefined, error: undefined })
    try {
      const res = await fetch(asset.url, { headers: { 'User-Agent': 'Maris' }, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
      const total = Number(res.headers.get('content-length')) || asset.size || 0
      const chunks: Buffer[] = []
      let got = 0
      let last = 0
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
        got += value.byteLength
        if (total && Date.now() - last > 300) {
          last = Date.now()
          this.setUpdate({ downloading: Math.min(0.99, got / total) })
        }
      }
      await fs.writeFile(file, Buffer.concat(chunks))
      if (process.platform === 'linux') chmodSync(file, 0o755)
      this.setUpdate({ downloading: undefined, downloaded: file })
    } catch (e) {
      this.setUpdate({ downloading: undefined, error: (e as Error).message })
    }
    return this.update
  }

  /** Start the downloaded installer (only from the person's click). Windows quits Maris so it can be replaced. */
  async installUpdate(): Promise<void> {
    const file = this.update.downloaded
    if (!file || !existsSync(file)) throw new Error('Download the update first.')
    if (process.platform === 'win32') {
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => app.quit(), 800)
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
    try {
      const idx = JSON.parse((await raw(this.repo(), NEWS_BRANCH, `${NEWS_FOLDER}/index.json`, { fresh: true })).toString('utf8')) as NewsIndex
      if (!Array.isArray(idx.posts)) throw new Error('index.json has no posts list')
      this.setIndex(idx)
      this.news = { ...this.news, loading: false, offline: false, error: undefined, fetchedAt: Date.now() }
      const fresh = idx.posts.filter((p) => !this.read.has(p.id) && !this.notified.has(p.id))
      // First fetch on a new install: do not announce the whole history.
      if (this.notified.size === 0) for (const p of idx.posts) this.notified.add(p.id)
      else if (fresh[0]) this.notify(fresh[0].id, fresh[0].title, fresh[0].summary || 'A new post in Updates & news.')
      for (const p of fresh) this.notified.add(p.id)
      this.saveJson('notified.json', [...this.notified])
      await this.cacheCovers()
    } catch (e) {
      const err = e as GitHubError
      // A repository without a news folder simply has no posts yet.
      if (err.status === 404) this.setIndex({ version: 1, updated: new Date().toISOString(), posts: [] })
      this.news = { ...this.news, loading: false, offline: err.status === 0, error: err.status === 0 || err.status === 404 ? undefined : err.message, fetchedAt: Date.now() }
    }
    this.publishNews()
    return this.news
  }

  /** The admin just published: show the new list without waiting for GitHub's file cache. */
  setIndex(idx: NewsIndex): void {
    idx.posts.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.date.localeCompare(a.date))
    this.index = idx
    this.saveJson('index.json', idx)
    this.publishNews()
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
    return { entry, body: await this.localizeImages(body) }
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
