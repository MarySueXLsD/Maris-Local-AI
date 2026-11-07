import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ApprovalRule } from '@shared/approval'
import type { Attachment, ChatMode, DeepPartial, FileEntry, MediaParams, MemoryKind, ModelDetails, SendOptions, Settings, SetupPlan, ThinkMode } from '@shared/types'
import { setLaunchAtLogin } from './autostart'
import { handlers, outbound } from './bridge'
import { connectors } from './connectors/connectors'
import { admin } from './feed/admin'
import { feed } from './feed/feed'
import { skills } from './skills/skills'
import type { PostDraft } from '@shared/extensions'
import { link } from './link/server'
import { setTerminalCommand, terminalStatus } from './cli/terminal'
import { setup } from './setup'
import { lastScan, scanPc } from './system/scan'
import { agent, invalidateModels, listModels } from './agent/agent'
import { approvals } from './agent/approvals'
import { touchProject, updateProject } from './agent/project'
import { installToolchain, parseInstalled, TOOLCHAINS, toolchainEvents } from './toolchains'
import { devEnvReport } from './tools/code'
import { decode, isBinary } from './tools/fs'
import { processes } from './tools/processes'
import { CATALOG, cancelInstall, installModel, pulls } from './catalog'
import { repo } from './db'
import { ollama } from './engines/ollama'
import { comfy } from './media/comfy'
import { cancelDownload, downloads } from './media/downloader'
import { media } from './media/jobs'
import { learner } from './memory/learner'
import { memory } from './memory/store'
import { route } from './router'
import { settings } from './settings'
import { monitor } from './system/monitor'
import { gpuPrograms } from './system/gpuProcs'
import { log, uid } from './util'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

let watcher: FSWatcher | undefined
let watchedDir = ''

export function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
  }
  outbound.emit({ channel, payload })
}

export async function fileToAttachment(p: string): Promise<Attachment> {
  const st = statSync(p)
  const name = path.basename(p)
  if (IMAGE_EXT.test(p)) {
    let img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      const scale = Math.min(1, 1568 / Math.max(width, height))
      if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
      return {
        id: uid(),
        kind: 'image',
        name,
        mime: 'image/jpeg',
        size: st.size,
        path: p,
        dataUrl: `data:image/jpeg;base64,${img.toJPEG(88).toString('base64')}`
      }
    }
  }
  return { id: uid(), kind: 'file', name, mime: 'application/octet-stream', size: st.size, path: p }
}

const h = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)))
  handlers.set(channel, fn as (...args: unknown[]) => unknown)
}

export function registerIpc(): void {
  // ---------------------------------------------------------------- events → renderer
  agent.events.on((e) => broadcast('chat:event', e))
  approvals.requested.on((request) => broadcast('chat:event', { type: 'approval', request }))
  approvals.resolved.on(({ id, approved }) => broadcast('chat:event', { type: 'approval-resolved', id, approved }))
  approvals.sessionsChanged.on((ids) => broadcast('approvals:sessions', ids))
  monitor.changed.on((s) => broadcast('system:status', s))
  settings.changed.on((s) => broadcast('settings:changed', s))
  memory.changed.on(() => broadcast('memory:changed', null))
  memory.events.on((e) => broadcast('memory:event', e))
  pulls.on((p) => {
    if (p.done) invalidateModels()
    broadcast('models:pull', p)
  })
  downloads.on((d) => broadcast('media:download', d))
  comfy.changed.on((s) => broadcast('media:comfy', s))
  media.changed.on((j) => broadcast('media:job', j))
  toolchainEvents.on((e) => broadcast('project:toolchain', e))
  link.changed.on((s) => broadcast('link:status', s))
  feed.updateChanged.on((s) => broadcast('updates:changed', s))
  feed.newsChanged.on((s) => broadcast('news:changed', s))
  skills.changed.on((s) => broadcast('skills:changed', s))
  connectors.changed.on((s) => broadcast('connectors:changed', s))
  setup.changed.on((p) => broadcast('setup:progress', p))

  // ---------------------------------------------------------------- chat
  h('chat:send', (opts: SendOptions) => agent.send(opts))
  h('chat:stop', (conversationId: string) => agent.stop(conversationId))
  h('chat:regenerate', (messageId: string, model?: string, think?: ThinkMode) => agent.regenerate(messageId, model, think))
  h('chat:edit', (messageId: string, text: string) => agent.editAndResend(messageId, text))
  h('chat:feedback', (messageId: string, value: 1 | -1 | 0, note?: string) => agent.feedback(messageId, value, note))
  h('chat:approve', (id: string, approved: boolean, rule?: ApprovalRule | boolean) => approvals.respond(id, approved, rule))
  h('chat:autoEdits', (conversationId: string, on: boolean) => agent.setAutoEdits(conversationId, on))
  h('chat:compact', (conversationId: string) => agent.compact(conversationId))
  h('chat:context', (conversationId?: string, draft?: { mode?: ChatMode; projectDir?: string; model?: string }) => agent.contextUsage(conversationId, draft))
  h('chat:approvals', () => approvals.list())
  // "Approve everything in this session" (kept in memory only; ends when Maris closes).
  h('approvals:sessions', () => approvals.sessions())
  h('approvals:setSession', (conversationId: string, on: boolean) => approvals.setSession(conversationId, Boolean(on)))
  h('approvals:clearSessions', () => approvals.clearSessions())
  h('chat:previewRoute', async (text: string, attachments: Attachment[] = [], model?: string, think?: ThinkMode, mode?: 'chat' | 'code') => {
    const models = await listModels()
    const cfg = settings.get()
    return route(
      { text, attachments, historyTokens: 0, think: think ?? cfg.agent.defaultThink, explicitModel: model, mode },
      { ...cfg, routing: { ...cfg.routing, smartClassifier: false } },
      monitor.snapshot(),
      models
    ).catch(() => undefined)
  })

  // ---------------------------------------------------------------- conversations
  h('conv:list', () => repo.listConversations())
  h('conv:get', (id: string) => {
    const conversation = repo.getConversation(id)
    return conversation ? { conversation, messages: agent.liveMessages(id, repo.listMessages(id)), running: agent.isRunning(id) } : undefined
  })
  h('conv:rename', (id: string, title: string) => {
    const c = repo.getConversation(id)
    if (!c) return
    c.title = title.trim().slice(0, 80) || c.title
    repo.upsertConversation(c)
    broadcast('chat:event', { type: 'conversation', conversation: c })
  })
  h('conv:pin', (id: string, pinned: boolean) => {
    const c = repo.getConversation(id)
    if (!c) return
    c.pinned = pinned
    repo.upsertConversation(c)
    broadcast('chat:event', { type: 'conversation', conversation: c })
  })
  h('conv:setModel', (id: string, model: string) => {
    const c = repo.getConversation(id)
    if (!c) return
    c.model = model
    repo.upsertConversation(c)
    broadcast('chat:event', { type: 'conversation', conversation: c })
  })
  h('conv:delete', async (id: string) => {
    // Stop what the chat is doing first, so nothing is written into a chat that no longer exists.
    media.cancelFor(id)
    await agent.stopAndWait(id)
    repo.deleteConversation(id)
    broadcast('chat:event', { type: 'conversation-deleted', id })
  })
  h('conv:search', (q: string) => repo.searchMessages(q, 30))
  h('conv:running', () => agent.runningIds())

  // ---------------------------------------------------------------- models
  h('models:list', async (force?: boolean) => {
    try {
      return await listModels(Boolean(force))
    } catch {
      return []
    }
  })
  h('models:catalog', () => CATALOG.map(({ custom: _c, ...c }) => c))
  h('models:pull', (name: string) => installModel(name))
  h('models:cancelPull', (name: string) => cancelInstall(name))
  h('models:delete', async (name: string) => {
    await ollama.remove(name)
    invalidateModels()
  })
  h('models:unload', (name: string) => ollama.unload(name))
  h('models:details', async (name: string): Promise<ModelDetails> => {
    const s = await ollama.show(name)
    const info = s.model_info ?? {}
    const arch = typeof info['general.architecture'] === 'string' ? (info['general.architecture'] as string) : undefined
    const ctx = arch ? Number(info[`${arch}.context_length`]) : NaN
    const lic = s.license ?? ''
    const license = /apache license/i.test(lic)
      ? 'Apache 2.0'
      : /\bMIT License\b/i.test(lic)
        ? 'MIT'
        : /gemma/i.test(lic)
          ? 'Gemma Terms of Use'
          : /llama \d(\.\d)? community license/i.test(lic)
            ? (/llama \d(\.\d)? community license/i.exec(lic)?.[0] ?? 'Llama Community License')
            : lic.trim().split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 80)
    const defaults: Record<string, string> = {}
    for (const line of (s.parameters ?? '').split(/\r?\n/)) {
      const m = /^(\w+)\s+(.+)$/.exec(line.trim())
      if (m && m[1] !== 'stop') defaults[m[1]] = m[2].replace(/^"|"$/g, '')
    }
    return {
      architecture: arch,
      parameters: Number(info['general.parameter_count']) || undefined,
      contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : undefined,
      quantization: s.details?.quantization_level,
      license: license || undefined,
      defaults,
      modifiedAt: s.modified_at
    }
  })
  h('models:ensureOllama', () => ollama.ensureRunning())
  h('models:ollamaInstalled', () => ollama.isInstalled())

  // ---------------------------------------------------------------- system & settings
  h('system:status', () => monitor.snapshot())
  h('system:gpuPrograms', () => gpuPrograms.list())
  h('system:endProgram', (pid: number) => gpuPrograms.end(Number(pid)))
  h('settings:get', () => settings.get())
  h('settings:set', (patch: DeepPartial<Settings>) => {
    const s = settings.update(patch)
    if (patch.ui?.launchAtLogin !== undefined) setLaunchAtLogin(Boolean(patch.ui.launchAtLogin))
    if (patch.tiers?.embed) void memory.reembedAll()
    return s
  })
  h('settings:pickFolder', async (current?: string) => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: current })
    return r.canceled ? undefined : r.filePaths[0]
  })
  h('settings:reset', (section?: keyof Settings) => settings.reset(section))
  h('settings:export', async () => {
    const r = await dialog.showSaveDialog({
      title: 'Save Maris settings',
      defaultPath: path.join(app.getPath('documents'), 'maris-settings.json'),
      filters: [{ name: 'Maris settings', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return undefined
    await fs.writeFile(r.filePath, settings.exportJson(), 'utf8')
    return r.filePath
  })
  h('settings:import', async () => {
    const r = await dialog.showOpenDialog({ title: 'Load Maris settings', properties: ['openFile'], filters: [{ name: 'Maris settings', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return undefined
    return settings.importJson(await fs.readFile(r.filePaths[0], 'utf8'))
  })

  // ---------------------------------------------------------------- first-run setup
  h('setup:scan', () => scanPc())
  h('setup:lastScan', () => lastScan())
  h('setup:catalog', async () => {
    const models = await listModels(true).catch(() => [])
    return {
      llms: CATALOG.map(({ custom: _c, ...c }) => c),
      packs: media.packs(),
      installed: models.map((m) => m.name),
      dataDir: settings.get().dataDir
    }
  })
  h('setup:apply', (plan: SetupPlan) => setup.apply(plan))
  h('setup:progress', () => setup.progress())
  h('setup:cancel', () => setup.cancel())
  h('setup:skip', () => settings.update({ onboarded: true }))

  // ---------------------------------------------------------------- memory
  h('memory:list', () => memory.list())
  h('memory:add', (text: string, kind?: MemoryKind, pinned?: boolean) =>
    memory.add({ text, kind: kind ?? 'fact', source: 'user', importance: 0.8, pinned: Boolean(pinned) })
  )
  h('memory:update', (id: string, patch: { text?: string; kind?: MemoryKind; pinned?: boolean; importance?: number }) =>
    memory.update(id, patch)
  )
  h('memory:delete', (id: string) => memory.delete(id))
  h('memory:events', () => repo.listEvents(100))
  h('memory:learnNow', (conversationId: string) => learner.learnFrom(conversationId))
  h('memory:routeStats', () => repo.routeStats())
  h('memory:resetRouting', () => repo.resetRouteStats())

  // ---------------------------------------------------------------- media
  h('media:packs', () => media.packs())
  h('media:installPack', (id: string) => media.installPack(id))
  h('media:removePack', (id: string) => media.removePack(id))
  h('media:cancelDownload', (id: string) => cancelDownload(id))
  h('media:comfyState', () => comfy.state())
  h('media:installComfy', () => comfy.install())
  h('media:startComfy', () => comfy.start())
  h('media:stopComfy', () => comfy.stop())
  h('media:generate', (params: MediaParams) => media.generate(params))
  h('media:cancel', (id: string) => media.cancel(id))
  h('media:switch', (id: string, packId: string) => media.switchPack(id, packId))
  h('media:jobs', () => media.list())
  h('media:gallery', () => repo.listMedia(300))
  h('media:delete', async (id: string, alsoFile: boolean) => {
    const item = repo.listMedia(1000).find((m) => m.id === id)
    repo.deleteMedia(id)
    if (alsoFile && item) await shell.trashItem(item.path).catch(() => undefined)
  })
  h('media:outputsDir', () => media.outputsDir())

  // ---------------------------------------------------------------- projects (Code mode)
  h('project:list', () => repo.listProjects().filter((p) => existsSync(p.path)))
  h('project:open', async (dir?: string) => {
    let target = dir
    if (!target) {
      const r = await dialog.showOpenDialog({ title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return undefined
      target = r.filePaths[0]
    }
    return touchProject(target)
  })
  h('project:remove', (dir: string) => repo.removeProject(dir))
  h('project:update', (dir: string, patch: { name?: string; description?: string }) => updateProject(dir, patch))
  h('project:forgetCommand', (dir: string, prefix: string) => {
    const p = repo.getProject(dir)
    if (!p) return
    p.allowedCommands = p.allowedCommands.filter((c) => c !== prefix)
    repo.upsertProject(p)
    return p
  })
  h('project:files', async (dir: string): Promise<FileEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const out: FileEntry[] = []
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '$RECYCLE.BIN') continue
      const full = path.join(dir, e.name)
      const isDir = e.isDirectory()
      out.push({ name: e.name, path: full, dir: isDir, size: isDir ? undefined : (await fs.stat(full).catch(() => undefined))?.size })
    }
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 800)
  })
  h('project:readFile', async (p: string): Promise<{ text?: string; error?: string; size: number }> => {
    const st = await fs.stat(p).catch(() => undefined)
    if (!st || !st.isFile()) return { error: 'Not a file', size: 0 }
    if (st.size > 2 * 2 ** 20) return { error: 'File is larger than 2 MB', size: st.size }
    const buf = await fs.readFile(p)
    if (isBinary(buf)) return { error: 'Binary file', size: st.size }
    return { text: decode(buf), size: st.size }
  })
  h('project:revert', async (backupPath: string, target: string) => {
    // Restoring a backup is a change the user starts with a click.
    if (!existsSync(backupPath)) throw new Error('The backup is gone')
    await fs.copyFile(backupPath, target)
    return true
  })
  h('project:devEnv', async (force?: boolean) => {
    const report = await devEnvReport(Boolean(force))
    return { report, installed: parseInstalled(report), toolchains: TOOLCHAINS }
  })
  h('project:installToolchain', (id: string) => installToolchain(id))
  // A new, empty project folder (made because the person asked for it in the New project dialog).
  h('project:create', async (parent: string, name: string, description?: string) => {
    const clean = name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/[. ]+$/, '')
    if (!clean) throw new Error('Give the project a name.')
    if (!parent || !path.isAbsolute(parent)) throw new Error('Pick where the project goes.')
    const dir = path.join(parent, clean)
    await fs.mkdir(dir, { recursive: true })
    touchProject(dir)
    return updateProject(dir, { name: clean, ...(description?.trim() ? { description: description.trim() } : {}) })
  })
  // Where new projects go: next to the most recent one, else a Projects folder in Documents.
  h('project:suggestLocation', () => {
    const recent = repo.listProjects().filter((p) => existsSync(p.path)).sort((a, b) => b.lastOpened - a.lastOpened)[0]
    if (recent) return path.dirname(recent.path)
    return path.join(app.getPath('documents'), 'Maris Projects')
  })
  // The open project's files: tell the window when anything in the folder changes.
  h('project:watch', (dir?: string) => {
    if ((dir ?? '') === watchedDir) return
    watcher?.close()
    watcher = undefined
    watchedDir = dir ?? ''
    if (!dir || !existsSync(dir)) return
    let timer: NodeJS.Timeout | undefined
    try {
      watcher = watch(dir, { recursive: true }, (_event, file) => {
        if (/(^|[\\/])(\.git|node_modules|__pycache__|\.venv|\.cache)([\\/]|$)/i.test(String(file ?? ''))) return
        clearTimeout(timer)
        timer = setTimeout(() => broadcast('project:changed', { dir }), 350)
      })
      watcher.on('error', () => undefined)
    } catch (e) {
      log.warn('project', `cannot watch ${dir}`, e)
    }
  })
  h('processes:list', (conversationId?: string) => processes.list(conversationId))
  h('processes:output', (id: string, tail?: number) => processes.output(id, tail ?? 200))
  h('processes:stop', (id: string) => processes.stop(id))

  // ---------------------------------------------------------------- files & shell
  h('files:pick', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return []
    return Promise.all(r.filePaths.slice(0, 10).map(fileToAttachment))
  })
  h('files:pickImage', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
  h('files:attach', (paths: string[]) => Promise.all(paths.slice(0, 10).map(fileToAttachment)))
  h('files:saveImage', async (dataUrl: string) => {
    const dir = path.join(app.getPath('userData'), 'pasted')
    await fs.mkdir(dir, { recursive: true })
    const p = path.join(dir, `pasted-${Date.now()}.png`)
    await fs.writeFile(p, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    return p
  })
  h('shell:openPath', (p: string) => shell.openPath(p))
  h('shell:showInFolder', (p: string) => shell.showItemInFolder(p))
  // A path in an answer: open the folder in the file manager, or show the file there.
  h('shell:reveal', async (raw: string): Promise<'folder' | 'file' | 'missing'> => {
    let p = raw.trim().replace(/^["'`<(]+|["'`>),.;:]+$/g, '')
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
    p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, v: string) => process.env[v] ?? m)
    const st = await fs.stat(p).catch(() => undefined)
    if (!st) return 'missing'
    if (st.isDirectory()) {
      await shell.openPath(p)
      return 'folder'
    }
    shell.showItemInFolder(p)
    return 'file'
  })
  h('shell:openExternal', (url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
  })
  // ---------------------------------------------------------------- updates and news
  h('updates:state', () => feed.updateState())
  h('updates:check', () => feed.checkUpdate())
  h('updates:download', () => feed.downloadUpdate())
  h('updates:install', () => feed.installUpdate())
  h('updates:openRelease', () => feed.openRelease())
  h('news:state', () => feed.newsState())
  h('news:refresh', () => feed.fetchNews())
  h('news:post', (id: string) => feed.post(id))
  h('news:markRead', (ids: string[] | 'all') => feed.markRead(ids))

  // ---------------------------------------------------------------- admin: writing posts (needs a GitHub token)
  h('admin:status', (force?: boolean) => admin.status(Boolean(force)))
  h('admin:setToken', (token: string) => admin.setToken(token))
  h('admin:clearToken', () => admin.clearToken())
  h('admin:publish', (draft: PostDraft) => admin.publish(draft))
  h('admin:remove', (id: string) => admin.remove(id))
  h('admin:loadDraft', (id: string) => admin.loadDraft(id))
  h('admin:index', () => feed.currentIndex())

  // ---------------------------------------------------------------- skills
  h('skills:list', () => skills.list())
  h('skills:install', (source: string) => skills.install(source))
  h('skills:update', (id: string) => skills.update(id))
  h('skills:remove', (id: string) => skills.remove(id))
  h('skills:setEnabled', (id: string, on: boolean) => skills.setEnabled(id, Boolean(on)))
  h('skills:read', (id: string) => skills.read(id))
  h('skills:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Choose a skill folder (with SKILL.md)', properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })

  // ---------------------------------------------------------------- connectors
  h('connectors:list', () => connectors.list())
  h('connectors:presets', () => connectors.presets())
  h('connectors:add', (presetId: string, values: Record<string, string>, name?: string) => connectors.add(presetId, values, name))
  h('connectors:edit', (id: string, values: Record<string, string>, name?: string) => connectors.edit(id, values, name))
  h('connectors:remove', (id: string) => connectors.remove(id))
  h('connectors:setEnabled', (id: string, on: boolean) => connectors.setEnabled(id, Boolean(on)))
  h('connectors:reconnect', (id: string) => connectors.reconnect(id))

  // ---------------------------------------------------------------- Maris Link (desktop window only)
  h('link:status', () => link.status())
  h('link:startPairing', () => link.startPairing())
  h('link:cancelPairing', () => link.cancelPairing())
  h('link:removeDevice', (id: string) => link.removeDevice(id))

  h('cli:status', () => terminalStatus())
  h('cli:set', (on: boolean) => setTerminalCommand(Boolean(on)))
  h('app:info', () => ({
    version: app.getVersion(),
    userDir: app.getPath('userData'),
    dataDir: settings.get().dataDir,
    electron: process.versions.electron
  }))
}
