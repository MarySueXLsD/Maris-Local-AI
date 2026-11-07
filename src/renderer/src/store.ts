import { create } from 'zustand'
import type {
  ApprovalRequest,
  Attachment,
  ChatEvent,
  ChatMode,
  Project,
  ChatMessage,
  Conversation,
  MediaRequest,
  ModelInfo,
  Settings,
  SystemStatus,
  ThinkMode
} from '@shared/types'
import { api } from './lib/api'
import type { NewsState, UpdateState } from '@shared/extensions'

/** Phone-sized screens: the sidebar and the project panel slide over the page instead of sitting beside it. */
const narrow = (): boolean => typeof window !== 'undefined' && window.innerWidth < 768

export type View = 'chat' | 'memory' | 'models' | 'settings' | 'help' | 'news' | 'admin' | 'skills' | 'connectors'

/** What the composer makes: an answer (text), or a picture or video directly. */
export type ComposerKind = 'text' | 'image' | 'video'

const UNREAD_KEY = 'maris.unread'
function loadUnread(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '{}') as Record<string, true>
  } catch {
    return {}
  }
}
function saveUnread(u: Record<string, true>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(u))
  } catch {
    /* a convenience only */
  }
}

interface State {
  ready: boolean
  settings?: Settings
  status?: SystemStatus
  view: View
  conversations: Conversation[]
  currentId?: string
  messages: Record<string, ChatMessage[]>
  running: Record<string, boolean>
  approvals: Record<string, ApprovalRequest>
  /** Chats where "Approve everything in this session" is on (until Maris closes). */
  approvalSessions: string[]
  /** New versions and news posts (for the sidebar badge and the Updates & news page). */
  updateState?: UpdateState
  newsState?: NewsState
  models: ModelInfo[]
  draftModel: string
  focusTick: number
  announcement: string
  sidebarOpen: boolean
  error?: string
  mode: ChatMode
  project?: Project
  projects: Project[]
  panelOpen: boolean
  draftAutoEdits: boolean
  composerInsert?: { text: string; tick: number; replace?: boolean }
  /** Attachments to add to the message box (a file or a selection from the project panel). */
  composerAttach?: { list: Attachment[]; tick: number }
  /** Switch the message box to Image or Video mode, optionally with a model picked. */
  composerMedia?: { kind: ComposerKind; packId?: string; tick: number }
  /** Chats with a finished answer the person has not looked at yet. */
  unread: Record<string, true>
  /** Which tab the Models page opens on. */
  modelsTab: 'text' | 'image' | 'video'
  /** The setup assistant, opened from Settings (it also shows on first launch). */
  setupOpen: boolean
  /** Article shown on the Help page. */
  helpArticle?: string

  openHelp(article?: string): void
  openSetup(): void
  closeSetup(): void
  setMode(m: ChatMode): void
  /** Put text into the message box (added to what is there, or replacing it). */
  insertIntoComposer(text: string, replace?: boolean): void
  attachToComposer(list: Attachment[]): void
  setComposerMedia(kind: ComposerKind, packId?: string): void
  openModels(tab?: 'text' | 'image' | 'video'): void
  /** Make a picture or video in the open chat (or a new one). */
  sendMedia(req: MediaRequest, attachments: Attachment[]): Promise<void>
  setAutoEdits(on: boolean): void
  openProject(dir?: string): Promise<void>
  loadProjects(): Promise<void>
  togglePanel(): void

  init(): Promise<void>
  setView(v: View): void
  newChat(): void
  open(id: string): Promise<void>
  send(text: string, attachments: Attachment[], think: ThinkMode, web: boolean): Promise<void>
  stop(): void
  setChatModel(model: string): void
  refreshModels(force?: boolean): Promise<void>
  updateSettings(patch: Parameters<typeof api.settings.set>[0]): Promise<void>
  announce(text: string): void
  focusComposer(): void
  toggleSidebar(): void
  dismissError(): void
}

const sortConvs = (list: Conversation[]): Conversation[] =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

function upsertMessage(list: ChatMessage[] = [], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) {
    const next = list.slice()
    next[i] = m
    return next
  }
  return [...list, m].sort((a, b) => a.createdAt - b.createdAt)
}

function patchMessage(
  state: State,
  conversationId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage
): Partial<State> | State {
  const list = state.messages[conversationId]
  if (!list) return state
  const i = list.findIndex((m) => m.id === messageId)
  if (i < 0) return state
  const next = list.slice()
  next[i] = fn(list[i])
  return { messages: { ...state.messages, [conversationId]: next } }
}

export const useApp = create<State>((set, get) => {
  const onChat = (e: ChatEvent): void => {
    switch (e.type) {
      case 'message':
        set((s) => ({
          messages: { ...s.messages, [e.message.conversationId]: upsertMessage(s.messages[e.message.conversationId], e.message) },
          running:
            e.message.role === 'assistant' && (e.message.status === 'streaming' || e.message.status === 'waiting')
              ? { ...s.running, [e.message.conversationId]: true }
              : s.running
        }))
        break
      case 'delta':
        set((s) =>
          patchMessage(s, e.conversationId, e.messageId, (m) => {
            const parts = m.parts.slice()
            const p = parts[e.partIndex]
            if (p && (p.type === 'text' || p.type === 'thinking')) parts[e.partIndex] = { ...p, text: p.text + e.text }
            return { ...m, parts }
          })
        )
        break
      case 'part':
        set((s) =>
          patchMessage(s, e.conversationId, e.messageId, (m) => {
            const parts = m.parts.slice()
            parts[e.partIndex] = e.part
            return { ...m, parts }
          })
        )
        break
      case 'status': {
        const active = e.status === 'streaming' || e.status === 'waiting'
        // A finished answer in a chat the person is not looking at gets a dot in the sidebar.
        if (e.status === 'done' && !(get().currentId === e.conversationId && get().view === 'chat')) {
          const unread = { ...get().unread, [e.conversationId]: true as const }
          saveUnread(unread)
          set({ unread })
        }
        set((s) => ({
          ...patchMessage(s, e.conversationId, e.messageId, (m) => ({
            ...m,
            status: e.status,
            stats: e.stats ?? m.stats,
            error: e.error,
            model: e.model ?? m.model
          })),
          running: { ...s.running, [e.conversationId]: active }
        }))
        if (e.status === 'done') get().announce('Answer complete')
        if (e.status === 'error') get().announce(`Error: ${e.error ?? 'something went wrong'}`)
        break
      }
      case 'route':
        set((s) => patchMessage(s, e.conversationId, e.messageId, (m) => ({ ...m, route: e.route, model: e.route.model })))
        break
      case 'activity':
        set((s) => patchMessage(s, e.conversationId, e.messageId, (m) => ({ ...m, activity: e.activity })))
        break
      case 'conversation':
        set((s) => {
          const list = s.conversations.filter((c) => c.id !== e.conversation.id)
          return { conversations: sortConvs([e.conversation, ...list]) }
        })
        break
      case 'conversation-deleted':
        set((s) => {
          const { [e.id]: _gone, ...rest } = s.messages
          const { [e.id]: _read, ...unread } = s.unread
          saveUnread(unread)
          return {
            conversations: s.conversations.filter((c) => c.id !== e.id),
            messages: rest,
            unread,
            currentId: s.currentId === e.id ? undefined : s.currentId
          }
        })
        break
      case 'message-deleted':
        set((s) => ({
          messages: { ...s.messages, [e.conversationId]: (s.messages[e.conversationId] ?? []).filter((m) => m.id !== e.messageId) }
        }))
        break
      case 'approval':
        set((s) => ({ approvals: { ...s.approvals, [e.request.id]: e.request } }))
        get().announce(`Approval needed: ${e.request.title}`)
        break
      case 'approval-resolved':
        set((s) => {
          const { [e.id]: _done, ...rest } = s.approvals
          return { approvals: rest }
        })
        break
    }
  }

  return {
    ready: false,
    view: 'chat',
    conversations: [],
    messages: {},
    running: {},
    approvals: {},
    approvalSessions: [],
    models: [],
    draftModel: 'auto',
    focusTick: 0,
    announcement: '',
    sidebarOpen: !narrow(),
    mode: 'chat',
    projects: [],
    panelOpen: typeof window === 'undefined' || window.innerWidth >= 1100,
    draftAutoEdits: false,
    setupOpen: false,
    unread: loadUnread(),
    modelsTab: 'text',

    openHelp(article) {
      set((s) => ({ view: 'help', helpArticle: article ?? s.helpArticle ?? 'welcome' }))
    },

    openSetup() {
      set({ setupOpen: true })
    },

    closeSetup() {
      set({ setupOpen: false })
    },

    async init() {
      api.chat.onEvent(onChat)
      api.system.onStatus((status) => set({ status }))
      api.settings.onChange((settings) => set({ settings }))
      api.approvals.onSessions((approvalSessions) => set({ approvalSessions }))
      api.updates.onChange((updateState) => set({ updateState }))
      api.news.onChange((newsState) => set({ newsState }))
      void api.updates.state().then((updateState) => set({ updateState })).catch(() => undefined)
      void api.news.state().then((newsState) => set({ newsState })).catch(() => undefined)
      api.models.onPull((p) => {
        if (p.done && !p.error) void get().refreshModels(true)
      })
      api.app.onCommand((cmd) => {
        if (cmd === 'new-chat') get().newChat()
        if (cmd === 'open-settings') get().setView('settings')
        if (cmd === 'open-help') get().openHelp()
        // From the maris terminal command (maris open) and Explorer's "Open in Maris".
        if (cmd.startsWith('open:')) void get().open(cmd.slice(5))
        if (cmd.startsWith('open-project:')) void get().openProject(cmd.slice(13))
        if (cmd === 'focus-composer') {
          set({ view: 'chat' })
          get().focusComposer()
        }
      })
      const [settings, status, conversations, approvals, running, approvalSessions] = await Promise.all([
        api.settings.get(),
        api.system.status(),
        api.conv.list(),
        api.chat.approvals(),
        api.conv.running(),
        api.approvals.sessions().catch(() => [] as string[])
      ])
      set({
        settings,
        status,
        conversations: sortConvs(conversations),
        approvals: Object.fromEntries(approvals.map((a) => [a.id, a])),
        running: Object.fromEntries(running.map((id) => [id, true])),
        approvalSessions,
        ready: true
      })
      void get().refreshModels()
      void get().loadProjects()
    },

    setMode(mode) {
      set({ mode, currentId: undefined, view: 'chat' })
      if (mode === 'code' && !get().project) {
        const p = get().projects[0]
        if (p) set({ project: p })
      }
      get().focusComposer()
    },

    async loadProjects() {
      const projects = await api.project.list()
      set((s) => ({ projects, project: s.project ? (projects.find((p) => p.path === s.project!.path) ?? s.project) : s.project }))
    },

    async openProject(dir) {
      const p = await api.project.open(dir)
      if (!p) return
      set({ project: p, mode: 'code', currentId: undefined, view: 'chat' })
      void get().loadProjects()
      get().focusComposer()
    },

    insertIntoComposer(text, replace) {
      set((s) => ({ composerInsert: { text, replace, tick: (s.composerInsert?.tick ?? 0) + 1 } }))
    },

    attachToComposer(list) {
      set((s) => ({ composerAttach: { list, tick: (s.composerAttach?.tick ?? 0) + 1 }, view: 'chat' }))
      get().focusComposer()
    },

    setComposerMedia(kind, packId) {
      set((s) => ({ composerMedia: { kind, packId, tick: (s.composerMedia?.tick ?? 0) + 1 } }))
    },

    openModels(tab) {
      set({ view: 'models', ...(tab ? { modelsTab: tab } : {}), ...(narrow() ? { sidebarOpen: false } : {}) })
    },

    async sendMedia(req, attachments) {
      const s = get()
      try {
        const r = await api.chat.send({
          conversationId: s.currentId,
          text: req.prompt,
          attachments,
          media: req,
          mode: s.currentId ? undefined : s.mode,
          projectDir: s.currentId ? undefined : s.mode === 'code' ? s.project?.path : undefined
        })
        if (!s.currentId) set({ currentId: r.conversationId })
      } catch (e) {
        set({ error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') })
      }
    },

    setAutoEdits(on) {
      const id = get().currentId
      if (id) void api.chat.autoEdits(id, on)
      else set({ draftAutoEdits: on })
    },

    togglePanel() {
      set((s) => ({ panelOpen: !s.panelOpen }))
    },

    setView(view) {
      set({ view, ...(narrow() ? { sidebarOpen: false } : {}) })
    },

    newChat() {
      set({ currentId: undefined, view: 'chat', draftModel: 'auto', ...(narrow() ? { sidebarOpen: false } : {}) })
      get().focusComposer()
    },

    async open(id) {
      if (get().unread[id]) {
        const { [id]: _seen, ...unread } = get().unread
        saveUnread(unread)
        set({ unread })
      }
      const conv = get().conversations.find((c) => c.id === id)
      if (conv) {
        const project = conv.projectDir ? (get().projects.find((p) => p.path === conv.projectDir) ?? { path: conv.projectDir, name: conv.projectDir.split(/[\\/]/).pop() ?? conv.projectDir, lastOpened: 0, allowedCommands: [] }) : get().project
        set({ mode: conv.mode, project })
      }
      set({ currentId: id, view: 'chat', ...(narrow() ? { sidebarOpen: false } : {}) })
      const r = await api.conv.get(id)
      if (!r) return
      set((s) => ({
        messages: { ...s.messages, [id]: r.messages },
        running: { ...s.running, [id]: r.running }
      }))
    },

    async send(text, attachments, think, web) {
      const s = get()
      try {
        const r = await api.chat.send({
          conversationId: s.currentId,
          text,
          attachments,
          think,
          webAccess: web,
          model: s.currentId ? undefined : s.draftModel,
          mode: s.currentId ? undefined : s.mode,
          projectDir: s.currentId ? undefined : s.mode === 'code' ? s.project?.path : undefined
        })
        if (!s.currentId) {
          set({ currentId: r.conversationId })
          if (s.mode === 'code' && s.draftAutoEdits) void api.chat.autoEdits(r.conversationId, true)
        }
      } catch (e) {
        set({ error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') })
      }
    },

    stop() {
      const id = get().currentId
      if (id) void api.chat.stop(id)
    },

    setChatModel(model) {
      const id = get().currentId
      if (id) {
        void api.conv.setModel(id, model)
      } else set({ draftModel: model })
    },

    async refreshModels(force) {
      try {
        const models = await api.models.list(force)
        set({ models })
      } catch {
        /* engine down */
      }
    },

    async updateSettings(patch) {
      const settings = await api.settings.set(patch)
      set({ settings })
    },

    announce(text) {
      set({ announcement: '' })
      setTimeout(() => set({ announcement: text }), 50)
    },

    focusComposer() {
      set((s) => ({ focusTick: s.focusTick + 1 }))
    },

    toggleSidebar() {
      set((s) => ({ sidebarOpen: !s.sidebarOpen }))
    },

    dismissError() {
      set({ error: undefined })
    }
  }
})
