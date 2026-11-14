import type { ApprovalRule } from '@shared/approval'
import type { UndoResult } from '@shared/chatExport'
import type {
  AdminStatus,
  ConnectorInfo,
  ConnectorPreset,
  NewsIndex,
  NewsPostContent,
  NewsState,
  PostDraft,
  SkillInfo,
  UpdateState
} from '@shared/extensions'
import type { UsageSummary } from '@shared/pricing'
import type { ProviderInfo, ProviderPreset } from '@shared/providers'
import type {
  ApprovalRequest,
  Attachment,
  CatalogModel,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ComfyState,
  ContextUsage,
  Conversation,
  DeepPartial,
  DownloadProgress,
  FileEntry,
  LearningEvent,
  LinkStatus,
  Project,
  MediaJob,
  MediaPack,
  MediaParams,
  MediaResult,
  Memory,
  MemoryKind,
  ModelDetails,
  ModelInfo,
  PcScan,
  PullProgress,
  RouteDecision,
  SendOptions,
  Settings,
  SetupPlan,
  SetupProgress,
  SystemStatus,
  GpuProgramList,
  TerminalCommandStatus,
  ThinkMode
} from '@shared/types'

type Off = () => void

export type PackInfo = Omit<MediaPack, 'files'> & {
  installing: boolean
  missingGB: number
  files: (MediaPack['files'][number] & { present?: boolean })[]
  /** Seconds for one result on this computer, and whether that was measured here (or estimated from the PC scan). */
  estimateSec?: number
  estimateMeasured?: boolean
}

export interface Toolchain {
  id: string
  label: string
  probe: string
  languages: string
  command: string
  sizeHint: string
}

export interface ManagedProcess {
  id: string
  name: string
  command: string
  cwd: string
  conversationId: string
  pid?: number
  startedAt: number
  exitCode?: number | null
  running: boolean
  lines: string[]
}

export interface MarisApi {
  platform: 'win32' | 'darwin' | 'linux'
  remote: boolean
  chat: {
    send(o: SendOptions): Promise<{ conversationId: string; messageId: string }>
    stop(conversationId: string): Promise<void>
    regenerate(messageId: string, model?: string, think?: ThinkMode): Promise<void>
    edit(messageId: string, text: string): Promise<void>
    feedback(messageId: string, value: 1 | -1 | 0, note?: string): Promise<void>
    /** `rule`: also "Always approve …" with this scope. `note`: with a denial, what Maris should do instead. */
    approve(id: string, approved: boolean, rule?: ApprovalRule, note?: string): Promise<boolean>
    approvals(): Promise<ApprovalRequest[]>
    autoEdits(conversationId: string, on: boolean): Promise<void>
    compact(conversationId: string): Promise<number>
    previewRoute(text: string, attachments?: Attachment[], model?: string, think?: ThinkMode, mode?: 'chat' | 'code'): Promise<RouteDecision | undefined>
    /** What fills the chat's context window (a new chat: what it would start with). */
    context(conversationId?: string, draft?: { mode?: ChatMode; projectDir?: string; model?: string }): Promise<ContextUsage>
    /** Undo what this answer changed in files. Each step says whether it worked. */
    undoAnswer(messageId: string): Promise<UndoResult[]>
    onEvent(cb: (e: ChatEvent) => void): Off
  }
  approvals: {
    /** Chats where "Approve everything in this session" is on. */
    sessions(): Promise<string[]>
    setSession(conversationId: string, on: boolean): Promise<string[]>
    clearSessions(): Promise<string[]>
    onSessions(cb: (ids: string[]) => void): Off
  }
  conv: {
    list(): Promise<Conversation[]>
    get(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[]; running: boolean } | undefined>
    rename(id: string, title: string): Promise<void>
    pin(id: string, pinned: boolean): Promise<void>
    setModel(id: string, model: string): Promise<void>
    remove(id: string): Promise<void>
    search(q: string): Promise<{ conversationId: string; messageId: string; snippet: string; title: string }[]>
    running(): Promise<string[]>
    /** The chat as a file: Markdown, or JSON with everything. */
    exportChat(id: string, format: 'md' | 'json'): Promise<{ name: string; content: string }>
    /** A new chat with the messages up to and including this one. */
    branch(messageId: string): Promise<Conversation>
  }
  models: {
    list(force?: boolean): Promise<ModelInfo[]>
    catalog(): Promise<CatalogModel[]>
    pull(name: string): Promise<void>
    cancelPull(name: string): Promise<void>
    remove(name: string): Promise<void>
    unload(name: string): Promise<void>
    /** What an installed model says about itself: architecture, size, context, licence. */
    details(name: string): Promise<ModelDetails>
    ensureOllama(): Promise<boolean>
    ollamaInstalled(): Promise<boolean>
    onPull(cb: (p: PullProgress) => void): Off
  }
  system: {
    status(): Promise<SystemStatus>
    /** Programs using video memory, biggest first (Maris's own and the system's left out of the list). */
    gpuPrograms(): Promise<GpuProgramList>
    /** End a program from that list, with its helper processes. Only after the person confirmed it. */
    endProgram(pid: number): Promise<void>
    onStatus(cb: (s: SystemStatus) => void): Off
  }
  settings: {
    get(): Promise<Settings>
    set(patch: DeepPartial<Settings>): Promise<Settings>
    pickFolder(current?: string): Promise<string | undefined>
    reset(section?: keyof Settings): Promise<Settings>
    exportFile(): Promise<string | undefined>
    importFile(): Promise<Settings | undefined>
    onChange(cb: (s: Settings) => void): Off
  }
  setup: {
    scan(): Promise<PcScan>
    lastScan(): Promise<PcScan | undefined>
    catalog(): Promise<{ llms: CatalogModel[]; packs: PackInfo[]; installed: string[]; dataDir: string }>
    apply(plan: SetupPlan): Promise<void>
    progress(): Promise<SetupProgress>
    cancel(): Promise<void>
    skip(): Promise<Settings>
    onProgress(cb: (p: SetupProgress) => void): Off
  }
  memory: {
    list(): Promise<Memory[]>
    add(text: string, kind?: MemoryKind, pinned?: boolean): Promise<{ memory: Memory; merged: boolean }>
    update(id: string, patch: Partial<Pick<Memory, 'text' | 'kind' | 'pinned' | 'importance'>>): Promise<Memory>
    remove(id: string): Promise<boolean>
    events(): Promise<LearningEvent[]>
    learnNow(conversationId: string): Promise<number>
    routeStats(): Promise<{ category: string; tier: string; score: number; n: number }[]>
    resetRouting(): Promise<void>
    onChange(cb: () => void): Off
    onEvent(cb: (e: LearningEvent) => void): Off
  }
  cli: {
    status(): Promise<TerminalCommandStatus>
    set(on: boolean): Promise<TerminalCommandStatus>
  }
  media: {
    packs(): Promise<PackInfo[]>
    installPack(id: string): Promise<void>
    removePack(id: string): Promise<void>
    cancelDownload(id: string): Promise<boolean>
    comfyState(): Promise<ComfyState>
    installComfy(): Promise<void>
    startComfy(): Promise<void>
    stopComfy(): Promise<void>
    generate(params: MediaParams): Promise<MediaJob>
    cancel(id: string): Promise<void>
    /** Stop a job and start it again with another installed model. */
    switch(id: string, packId: string): Promise<void>
    jobs(): Promise<MediaJob[]>
    gallery(): Promise<MediaResult[]>
    remove(id: string, alsoFile: boolean): Promise<void>
    outputsDir(): Promise<string>
    onDownload(cb: (d: DownloadProgress) => void): Off
    onComfy(cb: (s: ComfyState) => void): Off
    onJob(cb: (j: MediaJob) => void): Off
  }
  project: {
    list(): Promise<Project[]>
    open(dir?: string): Promise<Project | undefined>
    remove(dir: string): Promise<void>
    /** Rename a project or change what it is about. */
    update(dir: string, patch: { name?: string; description?: string }): Promise<Project>
    forgetCommand(dir: string, prefix: string): Promise<Project | undefined>
    files(dir: string): Promise<FileEntry[]>
    readFile(path: string): Promise<{ text?: string; error?: string; size: number }>
    revert(backup: string, target: string): Promise<boolean>
    devEnv(force?: boolean): Promise<{ report: string; installed: Record<string, boolean>; toolchains: Toolchain[] }>
    installToolchain(id: string): Promise<string>
    /** Make a new, empty project folder and open it as a project. */
    create(parent: string, name: string, description?: string): Promise<Project>
    suggestLocation(): Promise<string>
    /** Watch this project folder (one at a time); onChanged fires when anything in it changes. */
    watch(dir?: string): Promise<void>
    onToolchain(cb: (e: { id: string; status: 'running' | 'done' | 'error'; output?: string }) => void): Off
    onChanged(cb: (e: { dir: string }) => void): Off
  }
  processes: {
    list(conversationId?: string): Promise<ManagedProcess[]>
    output(id: string, tail?: number): Promise<string>
    stop(id: string): Promise<boolean>
  }
  files: {
    pick(): Promise<Attachment[]>
    pickImage(): Promise<string | undefined>
    attach(paths: string[]): Promise<Attachment[]>
    saveImage(dataUrl: string): Promise<string>
    /** Save text (an exported chat) where the person picks; undefined when they cancel. Desktop only. */
    saveText(name: string, content: string): Promise<string | undefined>
    pathFor(file: File): string
  }
  shell: {
    openPath(p: string): Promise<string>
    showInFolder(p: string): Promise<void>
    openExternal(url: string): Promise<void>
    /** A path from an answer: opens the folder, or shows the file in its folder. */
    reveal(p: string): Promise<'folder' | 'file' | 'missing'>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    openRelease(): Promise<void>
    onChange(cb: (s: UpdateState) => void): Off
  }
  news: {
    state(): Promise<NewsState>
    refresh(): Promise<NewsState>
    post(id: string): Promise<NewsPostContent>
    markRead(ids: string[] | 'all'): Promise<NewsState>
    onChange(cb: (s: NewsState) => void): Off
  }
  admin: {
    status(force?: boolean): Promise<AdminStatus>
    setToken(token: string): Promise<AdminStatus>
    clearToken(): Promise<AdminStatus>
    publish(draft: PostDraft): Promise<NewsIndex>
    remove(id: string): Promise<NewsIndex>
    loadDraft(id: string): Promise<PostDraft>
    index(): Promise<NewsIndex>
  }
  skills: {
    list(): Promise<SkillInfo[]>
    install(source: string): Promise<SkillInfo[]>
    update(id: string): Promise<SkillInfo[]>
    remove(id: string): Promise<SkillInfo[]>
    setEnabled(id: string, on: boolean): Promise<SkillInfo[]>
    read(id: string): Promise<string>
    pickFolder(): Promise<string | undefined>
    onChange(cb: (s: SkillInfo[]) => void): Off
  }
  connectors: {
    list(): Promise<ConnectorInfo[]>
    presets(): Promise<ConnectorPreset[]>
    add(presetId: string, values: Record<string, string>, name?: string): Promise<ConnectorInfo[]>
    edit(id: string, values: Record<string, string>, name?: string): Promise<ConnectorInfo[]>
    remove(id: string): Promise<ConnectorInfo[]>
    setEnabled(id: string, on: boolean): Promise<ConnectorInfo[]>
    reconnect(id: string): Promise<ConnectorInfo[]>
    onChange(cb: (s: ConnectorInfo[]) => void): Off
  }
  /** Model services besides Ollama: Claude, and anything with an OpenAI-compatible address. */
  providers: {
    list(): Promise<ProviderInfo[]>
    presets(): Promise<ProviderPreset[]>
    /** Add a service; its models are read to check the address and key. The key is stored in the system keychain. */
    add(presetId: string, values: { key?: string; baseUrl?: string; name?: string }): Promise<ProviderInfo[]>
    edit(id: string, values: { key?: string; baseUrl?: string; name?: string }): Promise<ProviderInfo[]>
    remove(id: string): Promise<ProviderInfo[]>
    setEnabled(id: string, on: boolean): Promise<ProviderInfo[]>
    /** Which of the service's models show up in Maris. */
    setPicked(id: string, picked: string[]): Promise<ProviderInfo[]>
    /** Read the service's models again. */
    refresh(id: string): Promise<ProviderInfo[]>
    /** What the models at API services used and cost: today, this month, in all, and per model. */
    usage(): Promise<UsageSummary>
    clearUsage(): Promise<UsageSummary>
    /** Your own price for a model, in dollars per million tokens. Without one: back to the lists. */
    setPrice(id: string, model: string, price?: { in: number; out: number } | null): Promise<ProviderInfo[]>
    /** Look the public price list up now. */
    refreshPrices(): Promise<UsageSummary>
    onChange(cb: (s: ProviderInfo[]) => void): Off
  }
  link: {
    status(): Promise<LinkStatus>
    startPairing(): Promise<LinkStatus>
    cancelPairing(): Promise<LinkStatus>
    removeDevice(id: string): Promise<LinkStatus>
    onStatus(cb: (s: LinkStatus) => void): Off
  }
  app: {
    info(): Promise<{ version: string; userDir: string; dataDir: string; electron: string; /** The system can show the desktop through the window (Windows 11, macOS). */ material?: boolean }>
    onCommand(cb: (cmd: string) => void): Off
  }
}

// Looked up on use, not at load: the phone app installs its network version of `maris` after start-up.
export const api = new Proxy({} as MarisApi, {
  get: (_t, key) => (window as unknown as { maris?: Record<PropertyKey, unknown> }).maris?.[key]
})

/** URL for showing a generated file from Maris's media folders. */
export const mediaUrl = (p: string): string => `maris-media://file/${encodeURIComponent(p)}`
