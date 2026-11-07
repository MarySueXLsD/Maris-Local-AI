import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AdminStatus, NewsEntry, NewsIndex, PostDraft } from '@shared/extensions'
import { settings } from '../settings'
import { log } from '../util'
import { feed, NEWS_BRANCH, NEWS_FOLDER, postId } from './feed'
import { commitFiles, gh, GitHubError, raw } from './github'

const MAX_IMAGE = 8 * 2 ** 20
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * Publishing posts. Who may publish is decided by GitHub: only a token with write access to the
 * repository can change it. The token stays on this computer, encrypted with the system keychain.
 */
class Admin {
  private token?: string
  private last?: AdminStatus

  private file(): string {
    return path.join(app.getPath('userData'), 'admin-token.bin')
  }

  private repo(): string {
    return settings.get().updates.repo.trim()
  }

  private loadToken(): string | undefined {
    if (this.token) return this.token
    try {
      if (existsSync(this.file()) && safeStorage.isEncryptionAvailable()) this.token = safeStorage.decryptString(readFileSync(this.file()))
    } catch (e) {
      log.warn('admin', 'could not read the saved token', e)
    }
    return this.token
  }

  async status(force = false): Promise<AdminStatus> {
    if (this.last && !force && this.last.repo === this.repo()) return this.last
    const token = this.loadToken()
    const base: AdminStatus = { hasToken: Boolean(token), canPublish: false, repo: this.repo() }
    if (!token) return (this.last = base)
    try {
      const user = await gh<{ login: string }>('/user', { token })
      const repo = await gh<{ permissions?: { push?: boolean } }>(`/repos/${this.repo()}`, { token })
      this.last = { ...base, login: user.login, canPublish: Boolean(repo.permissions?.push) }
      if (!this.last.canPublish) this.last.error = `${user.login} cannot write to ${this.repo()}. Use a token with "Contents: Read and write" for that repository.`
    } catch (e) {
      this.last = { ...base, error: (e as Error).message }
    }
    return this.last
  }

  async setToken(token: string): Promise<AdminStatus> {
    const t = token.trim()
    if (!t) throw new Error('Paste a GitHub token first.')
    const user = await gh<{ login: string }>('/user', { token: t })
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system has no keychain to keep the token safe, so it cannot be saved.')
    writeFileSync(this.file(), safeStorage.encryptString(t), { mode: 0o600 })
    this.token = t
    log.info('admin', `token saved for ${user.login}`)
    const s = await this.status(true)
    if (s.canPublish && !settings.get().updates.admin) settings.update({ updates: { admin: true } })
    return s
  }

  clearToken(): AdminStatus {
    this.token = undefined
    rmSync(this.file(), { force: true })
    this.last = { hasToken: false, canPublish: false, repo: this.repo() }
    return this.last
  }

  private async requireToken(): Promise<string> {
    const s = await this.status()
    const token = this.loadToken()
    if (!token || !s.canPublish) throw new Error(s.error ?? 'Add a GitHub token with write access first.')
    return token
  }

  /** The current list, straight from GitHub (not the cached copy), so two publishes never overwrite each other. */
  private async freshIndex(token: string): Promise<NewsIndex> {
    try {
      const f = await gh<{ content: string }>(`/repos/${this.repo()}/contents/${NEWS_FOLDER}/index.json?ref=${encodeURIComponent(NEWS_BRANCH)}`, { token })
      return JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')) as NewsIndex
    } catch (e) {
      if ((e as GitHubError).status === 404) return { version: 1, updated: new Date().toISOString(), posts: [] }
      throw e
    }
  }

  /** Publish a new post or a new version of one: Markdown, pictures and the list, in one commit. */
  async publish(draft: PostDraft): Promise<NewsIndex> {
    const token = await this.requireToken()
    const title = draft.title.trim()
    if (!title) throw new Error('Give the post a title.')
    if (!draft.body.trim()) throw new Error('The post is empty.')
    const index = await this.freshIndex(token)
    const existing = draft.id ? index.posts.find((p) => p.id === draft.id) : undefined
    const id = existing?.id ?? draft.id ?? postId(title)
    const files: { path: string; content?: Buffer; delete?: boolean }[] = []
    // Pictures: images/<name> in the editor become images/<post id>/<name> in the repository.
    let body = draft.body
    const names = new Map<string, string>()
    for (const img of draft.images) {
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(img.dataUrl)
      if (!m) continue
      const data = Buffer.from(m[2]!, 'base64')
      if (data.length > MAX_IMAGE) throw new Error(`${img.name} is larger than 8 MB.`)
      const safe = img.name.replace(/[^\w.-]+/g, '-').replace(/^-+/, '') || `picture.${EXT[m[1]!] ?? 'png'}`
      names.set(img.name, safe)
      files.push({ path: `${NEWS_FOLDER}/images/${id}/${safe}`, content: data })
    }
    for (const [name, safe] of names) body = body.split(`(images/${name})`).join(`(images/${id}/${safe})`)
    files.push({ path: `${NEWS_FOLDER}/posts/${id}.md`, content: Buffer.from(body.endsWith('\n') ? body : `${body}\n`, 'utf8') })
    const now = new Date().toISOString()
    const entry: NewsEntry = {
      id,
      title,
      kind: draft.kind,
      date: existing?.date ?? now,
      summary: draft.summary.trim() || body.replace(/[#*_>`!\[\]()]/g, '').trim().split('\n')[0]!.slice(0, 160),
      file: `posts/${id}.md`,
      cover: draft.cover && names.has(draft.cover) ? `images/${id}/${names.get(draft.cover)}` : existing?.cover,
      version: draft.version?.trim() || undefined,
      pinned: Boolean(draft.pinned),
      author: (await this.status()).login
    }
    const next: NewsIndex = { version: 1, updated: now, posts: [entry, ...index.posts.filter((p) => p.id !== id)] }
    files.push({ path: `${NEWS_FOLDER}/index.json`, content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8') })
    await commitFiles(this.repo(), NEWS_BRANCH, token, files, `${existing ? 'Update' : 'Publish'} post: ${title}`)
    log.info('admin', `published ${id} (${files.length} files)`)
    feed.setIndex(next)
    return next
  }

  /** Take a post down: its Markdown and pictures are deleted and it leaves the list. */
  async remove(id: string): Promise<NewsIndex> {
    const token = await this.requireToken()
    const index = await this.freshIndex(token)
    const entry = index.posts.find((p) => p.id === id)
    if (!entry) {
      // A post written as a Markdown file in the news folder: removing it deletes that file.
      const file = feed.currentIndex().posts.find((p) => p.id === id && p.source === 'file')
      if (!file) throw new Error('That post is not published.')
      await commitFiles(this.repo(), NEWS_BRANCH, token, [{ path: `${NEWS_FOLDER}/${file.file}`, delete: true }], `Remove post: ${file.title}`)
      log.info('admin', `removed the Markdown post ${file.file}`)
      feed.forgetFilePost(id)
      return feed.currentIndex()
    }
    const files: { path: string; delete?: boolean; content?: Buffer }[] = [{ path: `${NEWS_FOLDER}/${entry.file}`, delete: true }]
    try {
      const imgs = await gh<{ path: string }[]>(`/repos/${this.repo()}/contents/${NEWS_FOLDER}/images/${encodeURIComponent(id)}?ref=${encodeURIComponent(NEWS_BRANCH)}`, { token })
      for (const f of imgs) files.push({ path: f.path, delete: true })
    } catch {
      /* no pictures */
    }
    const next: NewsIndex = { version: 1, updated: new Date().toISOString(), posts: index.posts.filter((p) => p.id !== id) }
    files.push({ path: `${NEWS_FOLDER}/index.json`, content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8') })
    await commitFiles(this.repo(), NEWS_BRANCH, token, files, `Remove post: ${entry.title}`)
    feed.setIndex(next)
    return next
  }

  /** A published post as an editable draft (pictures as data, paths back to images/<name>). */
  async loadDraft(id: string): Promise<PostDraft> {
    const token = await this.requireToken()
    const index = await this.freshIndex(token)
    const entry = index.posts.find((p) => p.id === id)
    if (!entry) throw new Error('That post is not published.')
    let body = (await raw(this.repo(), NEWS_BRANCH, `${NEWS_FOLDER}/${entry.file}`, { fresh: true })).toString('utf8')
    const images: PostDraft['images'] = []
    const prefix = `images/${id}/`
    for (const m of body.matchAll(/\]\((images\/[^)\s]+)\)/g)) {
      const ref = m[1]!
      if (!ref.startsWith(prefix) || images.some((i) => `${prefix}${i.name}` === ref)) continue
      const name = ref.slice(prefix.length)
      const data = await raw(this.repo(), NEWS_BRANCH, `${NEWS_FOLDER}/${ref}`).catch(() => undefined)
      if (!data) continue
      const ext = path.extname(name).slice(1).toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      images.push({ name, dataUrl: `data:${mime};base64,${data.toString('base64')}` })
    }
    body = body.split(`(${prefix}`).join('(images/')
    return {
      id,
      title: entry.title,
      kind: entry.kind,
      summary: entry.summary,
      body: body.replace(/\n$/, ''),
      version: entry.version,
      pinned: entry.pinned,
      images,
      cover: entry.cover?.startsWith(prefix) ? entry.cover.slice(prefix.length) : undefined
    }
  }
}

export const admin = new Admin()
