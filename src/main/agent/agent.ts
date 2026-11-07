import { existsSync, statSync, readFileSync } from 'node:fs'
import os from 'node:os'
import type {
  Attachment,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ContextUsage,
  Conversation,
  MediaRequest,
  ModelInfo,
  Part,
  RouteDecision,
  SendOptions,
  ThinkMode,
  ToolCallRecord,
  ToolRisk
} from '@shared/types'
import { messageText, repo } from '../db'
import { isRunnerCrash, ollama, type OllamaMessage, type OllamaToolCall } from '../engines/ollama'
import { learner } from '../memory/learner'
import { memory } from '../memory/store'
import { quickJson } from '../memory/utility'
import { media } from '../media/jobs'
import { assignTiers, route, routerLearning } from '../router'
import { settings } from '../settings'
import { skills } from '../skills/skills'
import { monitor } from '../system/monitor'
import { activeTools, EDIT_TOOLS, findTool, needsApproval, toOllamaTools } from '../tools'
import { matchesAllowed } from '../tools/classify'
import { approvalKind, autoApproveReason, kindLabel, type ApprovalRule } from '@shared/approval'
import { isInside } from '../tools/paths'
import type { ToolContext } from '../tools/types'
import { Emitter, errMsg, estimateTokens, log, truncate, uid, sleep } from '../util'
import { DEVICE_WORD, IS_WIN } from '../platform'
import { conversationLanguage, drifted, isContinuation, scriptCounts, type Language } from '@shared/language'
import { approvals } from './approvals'

/** Where deleted files go on this system, for messages about "Always approve" rules. */
const TRASH_WORD = IS_WIN ? 'Recycle Bin' : 'Trash'
/** A picture or video that finishes within this many seconds is waited for instead of answering on the processor. */
const MEDIA_WAIT_SEC = 60
import { allowCommand, projectContext, touchProject } from './project'
import { codeSystemPrompt, COMPACT_SYSTEM, systemPrompt, TITLE_SYSTEM } from './prompts'

// ------------------------------------------------------------------ model list cache

let modelCache: { at: number; models: ModelInfo[] } | undefined
export async function listModels(force = false): Promise<ModelInfo[]> {
  if (!force && modelCache && Date.now() - modelCache.at < 20000) return modelCache.models
  const models = await ollama.list()
  modelCache = { at: Date.now(), models }
  const cfg = settings.get()
  const tiers = assignTiers(models, cfg.tiers, monitor.snapshot().gpu?.memTotalMB ?? 0)
  if (JSON.stringify(tiers) !== JSON.stringify(cfg.tiers)) settings.update({ tiers })
  return models
}
export const invalidateModels = (): void => {
  modelCache = undefined
}

// ------------------------------------------------------------------ history → Ollama messages

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|hx|hxml|ps1|psm1|bat|cmd|sh|ini|cfg|conf|toml|ya?ml|log|sql|env|gitignore|lua|php|swift|r|tex|csproj|sln|vcxproj|cmake|glsl|hlsl|shader)$/i

function fileNote(a: Attachment): string {
  if (a.kind === 'snippet') {
    const where = a.lines ? ` lines="${a.lines[0]}-${a.lines[1]}"` : ''
    return `<selection file="${a.path ?? a.name}"${where}>\n${a.text ?? ''}\n</selection>`
  }
  if (!a.path) return `[Attached file: ${a.name}]`
  try {
    if (TEXT_EXT.test(a.path) && existsSync(a.path) && statSync(a.path).size <= 96 * 1024) {
      return `<file name="${a.name}" path="${a.path}">\n${readFileSync(a.path, 'utf8')}\n</file>`
    }
  } catch {
    /* fall through */
  }
  return `[Attached file: ${a.path} — use read_file or other tools to inspect it]`
}

function toolResultFor(call: ToolCallRecord, limit: number): string {
  if (call.status === 'denied') return 'The user denied this action, so it was not performed.'
  if (call.status === 'error') return `Error: ${call.error ?? 'failed'}`
  return truncate(call.result ?? '(no output)', limit)
}

export function buildHistory(history: ChatMessage[]): OllamaMessage[] {
  // Keep recent tool output in full; older tool output shrinks to save context.
  let toolSeen = 0
  const totalTools = history.reduce((n, m) => n + m.parts.filter((p) => p.type === 'tool').length, 0)
  const out: OllamaMessage[] = []
  for (const m of history) {
    if (m.role === 'user') {
      const text = messageText(m)
      const files = (m.attachments ?? []).filter((a) => a.kind === 'file' || a.kind === 'snippet').map(fileNote)
      const images = (m.attachments ?? [])
        .filter((a) => a.kind === 'image' && a.dataUrl)
        .map((a) => a.dataUrl!.slice(a.dataUrl!.indexOf(',') + 1))
      out.push({ role: 'user', content: [text, ...files].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}) })
      continue
    }
    let content = ''
    for (const p of m.parts) {
      if (p.type === 'text') content += p.text
      else if (p.type === 'tool') {
        toolSeen++
        const recent = totalTools - toolSeen < 8
        out.push({ role: 'assistant', content, tool_calls: [{ function: { name: p.call.name, arguments: p.call.args } }] })
        out.push({ role: 'tool', tool_name: p.call.name, content: toolResultFor(p.call, recent ? 6000 : 700) })
        content = ''
      } else if (p.type === 'media') content += `\n[Generated ${p.media.kind}: ${p.media.path}]`
    }
    if (content.trim()) out.push({ role: 'assistant', content })
  }
  return out
}

const msgTokens = (m: OllamaMessage): number =>
  estimateTokens(m.content) + (m.images?.length ?? 0) * 900 + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0)

/** Keep the newest messages that fit in the context window; drop images from older turns. */
export function fitToContext(msgs: OllamaMessage[], numCtx: number, reserved: number): OllamaMessage[] {
  const budget = Math.max(1024, numCtx - reserved - 2048)
  const kept: OllamaMessage[] = []
  let used = 0
  let userSeen = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    let m = msgs[i]
    if (m.role === 'user') {
      userSeen++
      if (userSeen > 2 && m.images) m = { ...m, images: undefined, content: `${m.content}\n[image omitted]` }
    }
    const t = msgTokens(m)
    if (used + t > budget && kept.length) break
    if (used + t > budget) m = { ...m, content: truncate(m.content, Math.max(500, (budget - used) * 3)) }
    kept.unshift(m)
    used += Math.min(t, budget)
  }
  while (kept.length && kept[0].role === 'tool') kept.shift()
  return kept
}

function parseArgs(a: OllamaToolCall['function']['arguments']): Record<string, unknown> {
  if (typeof a === 'string') {
    try {
      return JSON.parse(a) as Record<string, unknown>
    } catch {
      return { input: a }
    }
  }
  return a ?? {}
}

const humanTool = (name: string, args: Record<string, unknown>): string => {
  const arg = args.path ?? args.command ?? args.query ?? args.url ?? args.pattern ?? args.root ?? args.prompt
  const label = name.replace(/_/g, ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${arg ? `: ${String(arg).slice(0, 100)}` : ''}`
}

/** A chat title from a picture or video prompt: its first words. */
function titleFromPrompt(prompt: string, what: string): string {
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').replace(/[,.;:]+$/, '')
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 60) : `New ${what}`
}

const prettyName = (name: string): string => name.replace(/^hf\.co\/[^/]+\//, '').replace(/-GGUF/i, '')

/** Letters in a tool result that are in another writing system than the person's. */
function foreignLetters(lang: Language, text: string): number {
  const c = scriptCounts(text.slice(0, 20000))
  const total = Object.values(c).reduce((a, b) => a + b, 0)
  const own = lang.script === 'kana' ? c.kana + c.cjk : c[lang.script]
  return total - own - (lang.script === 'latin' ? 0 : c.latin)
}

// ------------------------------------------------------------------ agent

interface RunOptions {
  model?: string
  think?: ThinkMode
  webAccess?: boolean
}

class Agent {
  readonly events = new Emitter<ChatEvent>()
  private runs = new Map<string, AbortController>()
  /** The answer being written now, per chat: the saved copy only has its parts once it is finished. */
  private live = new Map<string, ChatMessage>()

  /** A chat's messages with the answer in progress as it is right now (for opening a busy chat again). */
  liveMessages(conversationId: string, saved: ChatMessage[]): ChatMessage[] {
    const now = this.live.get(conversationId)
    return now ? saved.map((m) => (m.id === now.id ? { ...now, parts: now.parts.slice() } : m)) : saved
  }

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId)
  }

  runningIds(): string[] {
    return [...this.runs.keys()]
  }

  private emitMessage(m: ChatMessage): void {
    this.events.emit({ type: 'message', message: structuredClone(m) })
  }
  private emitPart(m: ChatMessage, i: number): void {
    this.events.emit({ type: 'part', conversationId: m.conversationId, messageId: m.id, partIndex: i, part: structuredClone(m.parts[i]) })
  }
  private emitStatus(m: ChatMessage): void {
    this.events.emit({
      type: 'status',
      conversationId: m.conversationId,
      messageId: m.id,
      status: m.status,
      stats: m.stats,
      error: m.error,
      model: m.model
    })
  }
  private emitConversation(c: Conversation): void {
    this.events.emit({ type: 'conversation', conversation: { ...c } })
  }

  async send(opts: SendOptions): Promise<{ conversationId: string; messageId: string }> {
    const now = Date.now()
    let conv = opts.conversationId ? repo.getConversation(opts.conversationId) : undefined
    if (!conv) {
      const mode = opts.mode ?? 'chat'
      if (mode === 'code' && !opts.projectDir) throw new Error('Pick a project folder first.')
      if (opts.projectDir && !existsSync(opts.projectDir)) throw new Error(`Project folder not found: ${opts.projectDir}`)
      conv = {
        id: opts.conversationId ?? uid(),
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        model: opts.model ?? 'auto',
        mode,
        projectDir: mode === 'code' ? opts.projectDir : undefined,
        origin: opts.origin
      }
      repo.upsertConversation(conv)
      this.emitConversation(conv)
    }
    if (conv.projectDir) touchProject(conv.projectDir)
    if (this.runs.has(conv.id)) throw new Error('Maris is still answering in this chat. Stop it first or wait.')
    if (opts.model && opts.model !== conv.model) {
      conv.model = opts.model
      repo.upsertConversation(conv)
    }
    const user: ChatMessage = {
      id: uid(),
      conversationId: conv.id,
      role: 'user',
      parts: [{ type: 'text', text: opts.text }],
      attachments: opts.attachments?.length ? opts.attachments : undefined,
      status: 'done',
      createdAt: now,
      media: opts.media
    }
    repo.saveMessage(user)
    this.emitMessage(user)
    if (opts.media) void this.runMedia(conv, opts.media)
    else void this.run(conv, { model: opts.model, think: opts.think, webAccess: opts.webAccess })
    return { conversationId: conv.id, messageId: user.id }
  }

  stop(conversationId: string): void {
    this.runs.get(conversationId)?.abort()
    approvals.denyAll(conversationId)
  }

  /** Stop an answer and wait (up to a few seconds) until it has finished winding down. */
  async stopAndWait(conversationId: string, ms = 8000): Promise<void> {
    this.stop(conversationId)
    const until = Date.now() + ms
    while (this.runs.has(conversationId) && Date.now() < until) await sleep(100)
  }

  /** Remember an "Always approve …" choice made together with an approval; returns what it now covers. */
  private applyRule(
    rule: ApprovalRule,
    r: { conversationId: string; tool: string; risk: ToolRisk; projectDir?: string; allowPrefix?: string }
  ): string | undefined {
    if (rule === 'prefix' && r.allowPrefix && r.projectDir) {
      allowCommand(r.projectDir, r.allowPrefix)
      return `Approved. "${r.allowPrefix}" is now always allowed in this project.`
    }
    const kind = approvalKind(r.tool, r.risk)
    if (rule === 'kind' && kind) {
      settings.update({ agent: { autoApprove: { [kind]: true } } })
      return `Approved. From now on you always approve ${kindLabel(kind, TRASH_WORD)}.`
    }
    if (rule === 'session') {
      approvals.setSession(r.conversationId, true)
      return 'Approved. Everything else in this session is approved automatically.'
    }
    if (rule === 'everything') {
      settings.update({ agent: { autoApprove: { everything: true } } })
      return 'Approved. From now on everything is approved automatically, in every chat.'
    }
    return undefined
  }

  setAutoEdits(conversationId: string, on: boolean): void {
    const c = repo.getConversation(conversationId)
    if (!c || c.mode !== 'code') return
    c.autoEdits = on
    repo.upsertConversation(c)
    this.emitConversation(c)
  }

  private deleteFrom(conversationId: string, messageId: string): ChatMessage[] {
    const all = repo.listMessages(conversationId)
    const idx = all.findIndex((m) => m.id === messageId)
    if (idx < 0) return []
    const removed = all.slice(idx)
    for (const m of removed) {
      repo.deleteMessage(m.id)
      this.events.emit({ type: 'message-deleted', conversationId, messageId: m.id })
    }
    // A summary that covered deleted messages is no longer accurate.
    const c = repo.getConversation(conversationId)
    if (c?.summaryUntil && removed.some((m) => m.createdAt <= c.summaryUntil!)) repo.setSummary(conversationId, null, null)
    return removed
  }

  async regenerate(messageId: string, model?: string, think?: ThinkMode): Promise<void> {
    const m = repo.getMessage(messageId)
    if (!m || m.role !== 'assistant') throw new Error('Only answers can be regenerated')
    const conv = repo.getConversation(m.conversationId)
    if (!conv) throw new Error('Conversation not found')
    if (this.runs.has(conv.id)) throw new Error('Still answering')
    if (model && model !== 'auto' && m.route?.auto) {
      const cfg = settings.get()
      const toTier = (Object.entries(cfg.tiers).find(([k, v]) => v === model && k !== 'embed')?.[0] as string) ?? 'custom'
      routerLearning.regenerated(m.route.category, m.route.tier, toTier)
      memory.logEvent('route-adjusted', `You re-ran a ${m.route.category} answer with ${model}; routing will lean that way.`)
    }
    // An answer to the Image or Video mode is made again the same way.
    const all = repo.listMessages(conv.id)
    const asked = [...all.slice(0, all.findIndex((x) => x.id === messageId))].reverse().find((x) => x.role === 'user')
    this.deleteFrom(conv.id, messageId)
    if (asked?.media) void this.runMedia(conv, asked.media)
    else void this.run(conv, { model: model ?? (conv.model !== 'auto' ? conv.model : undefined), think })
  }

  async editAndResend(messageId: string, text: string): Promise<void> {
    const m = repo.getMessage(messageId)
    if (!m || m.role !== 'user') throw new Error('Only your messages can be edited')
    if (this.runs.has(m.conversationId)) throw new Error('Still answering')
    this.deleteFrom(m.conversationId, messageId)
    await this.send({ conversationId: m.conversationId, text, attachments: m.attachments })
  }

  feedback(messageId: string, value: 1 | -1 | 0, note?: string): void {
    const m = repo.getMessage(messageId)
    if (!m) return
    m.feedback = value === 0 ? undefined : value
    repo.saveMessage(m)
    this.emitMessage(m)
    if (value !== 0) {
      if (m.route?.auto && m.route.tier !== 'custom') routerLearning.rated(m.route.category, m.route.tier, value)
      void learner.fromFeedback(m, value, note)
    }
  }

  // ---------------------------------------------------------------- compaction

  /** Summarise older messages into the conversation summary. Returns how many were folded in. */
  private async compactMessages(
    conv: Conversation,
    older: ChatMessage[],
    model: string,
    options: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<number> {
    if (!older.length) return 0
    const transcript = older
      .map((m) => {
        const tools = m.parts
          .filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
          .map((p) => `  [${p.call.name} ${p.call.title ?? ''} → ${p.call.status}${p.call.status === 'error' ? `: ${p.call.error}` : ''}]`)
          .join('\n')
        return `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${messageText(m).slice(0, 3000)}${tools ? `\n${tools}` : ''}`
      })
      .join('\n\n')
    const budgetChars = Math.max(6000, (Number(options.num_ctx ?? 16384) - 3000) * 3)
    const input = `${conv.summary ? `Previous summary:\n${conv.summary}\n\n` : ''}Conversation to fold in:\n${transcript.slice(-budgetChars)}`
    const r = await ollama.chatOnce(
      {
        model,
        think: false,
        options: { ...options, temperature: 0.2, num_predict: 900 },
        messages: [
          { role: 'system', content: COMPACT_SYSTEM },
          { role: 'user', content: input }
        ]
      },
      signal
    )
    const summary = r.content.trim()
    if (!summary) return 0
    const until = older[older.length - 1].createdAt
    repo.setSummary(conv.id, summary, until)
    conv.summary = summary
    conv.summaryUntil = until
    return older.length
  }

  /** Manual "Compact now": fold everything except the latest exchange into the summary. */
  async compact(conversationId: string): Promise<number> {
    const conv = repo.getConversation(conversationId)
    if (!conv) return 0
    if (this.runs.has(conversationId)) throw new Error('Wait until the current answer finishes')
    const history = repo.listMessages(conversationId).filter((m) => !conv.summaryUntil || m.createdAt > conv.summaryUntil)
    const older = history.slice(0, Math.max(0, history.length - 2))
    const cfg = settings.get()
    const model = cfg.tiers.max ?? cfg.tiers.balanced ?? cfg.tiers.fast
    if (!model || !older.length) return 0
    const w = ollama.loadedWith.get(model)
    return this.compactMessages(conv, older, model, { num_ctx: w?.num_ctx ?? cfg.routing.codeContext })
  }

  // ---------------------------------------------------------------- one assistant turn

  private async run(conv: Conversation, opts: RunOptions): Promise<void> {
    const ctrl = new AbortController()
    this.runs.set(conv.id, ctrl)
    const msg: ChatMessage = {
      id: uid(),
      conversationId: conv.id,
      role: 'assistant',
      parts: [],
      status: 'streaming',
      createdAt: Date.now()
    }
    repo.saveMessage(msg)
    this.live.set(conv.id, msg)
    this.emitMessage(msg)
    let userText = ''
    const started = Date.now()
    const stats = { prompt: 0, out: 0, evalNs: 0, loadNs: 0 }
    try {
      const cfg = settings.get()
      const fresh = repo.getConversation(conv.id) ?? conv
      Object.assign(conv, fresh)
      const code = conv.mode === 'code' && Boolean(conv.projectDir)
      let history = repo
        .listMessages(conv.id)
        .filter((m) => m.id !== msg.id && m.status !== 'streaming' && (!conv.summaryUntil || m.createdAt > conv.summaryUntil))
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      userText = lastUser ? messageText(lastUser) : ''
      // The person's language, so the answer stays in it whatever the files or web pages are written in.
      const lang = conversationLanguage(repo.listMessages(conv.id).filter((m) => m.role === 'user').map(messageText))
      // "continue", "go on": the same kind of task as the answer before, not small talk.
      const prevRoute = [...history].reverse().find((m) => m.role === 'assistant' && m.route)?.route
      const previous = prevRoute && isContinuation(userText) ? { category: prevRoute.category, complexity: prevRoute.complexity } : undefined
      const models = await listModels()
      let hist = buildHistory(history)
      const historyTokens = hist.reduce((s, m) => s + msgTokens(m), 0)
      const explicit = opts.model && opts.model !== 'auto' ? opts.model : conv.model !== 'auto' ? conv.model : undefined
      // A picture or video is being made (maybe in another chat). If it is nearly done, wait for the
      // graphics card; otherwise the router moves this answer to the processor and the chat says why.
      let mediaNote: string | undefined
      const busyMedia = cfg.engine.processing !== 'cpu' ? media.busyInfo() : undefined
      if (busyMedia) {
        const what = busyMedia.kind === 'video' ? 'a video' : 'a picture'
        const eta = busyMedia.etaSec
        if (eta !== undefined && eta <= MEDIA_WAIT_SEC) {
          const waitText = (s: number): string => `Waiting for the graphics card: it is finishing ${what}${busyMedia.model ? ` with ${busyMedia.model}` : ''} (about ${Math.max(1, s)} s).`
          const ni = msg.parts.push({ type: 'notice', text: waitText(eta), tone: 'info' }) - 1
          this.emitPart(msg, ni)
          const t0 = Date.now()
          const until = t0 + (eta + 45) * 1000
          while (media.activeCount > 0 && Date.now() < until && !ctrl.signal.aborted) {
            await sleep(1000)
            const left = media.busyInfo()?.etaSec
            if (left !== undefined) {
              msg.parts[ni] = { type: 'notice', text: waitText(left), tone: 'info' }
              this.emitPart(msg, ni)
            }
          }
          // Give the engine a moment to hand the graphics card's memory back.
          if (media.activeCount === 0) await sleep(1500)
          msg.parts[ni] = { type: 'notice', text: `Waited ${Math.round((Date.now() - t0) / 1000)} s for ${what} to finish, so this answer could use the graphics card.`, tone: 'info' }
          this.emitPart(msg, ni)
        } else {
          mediaNote = `${what[0].toUpperCase()}${what.slice(1)} is being made${eta ? ` (about ${eta < 90 ? `${eta} s` : `${Math.round(eta / 60)} min`} left)` : ''}, so this answer runs on the processor and is slower. Answers are fast again when it is done.`
        }
      }
      const sysNow = monitor.snapshot()
      const decision: RouteDecision = await route(
        {
          text: userText,
          attachments: lastUser?.attachments ?? [],
          historyTokens,
          think: opts.think ?? cfg.agent.defaultThink,
          explicitModel: explicit,
          mode: code ? 'code' : 'chat',
          previous
        },
        cfg,
        // The monitor samples every few seconds: what the media queue knows now is more current.
        media.activeCount > 0 ? sysNow : { ...sysNow, comfy: { ...sysNow.comfy, busy: false }, activeJobs: { ...sysNow.activeJobs, media: 0 } },
        models
      )
      msg.route = decision
      msg.model = decision.model
      this.events.emit({ type: 'route', conversationId: conv.id, messageId: msg.id, route: decision })
      if (mediaNote && decision.cpuOnly) {
        msg.parts.push({ type: 'notice', text: mediaNote, tone: 'info', conversationId: busyMedia?.conversationId !== conv.id ? busyMedia?.conversationId : undefined })
        this.emitPart(msg, msg.parts.length - 1)
      }
      const info = models.find((m) => m.name === decision.model)
      const canTools = info?.capabilities.includes('tools') ?? false
      const canSee = info?.capabilities.includes('vision') ?? false
      const tools = canTools ? activeTools(cfg, { webAccess: opts.webAccess ?? cfg.web.enabled, mode: code ? 'code' : 'chat' }) : []
      const ollamaTools = toOllamaTools(tools)
      const options: Record<string, unknown> = { num_ctx: decision.numCtx }
      // Per-role sampling and placement from Settings → Models (unset values keep the model's defaults).
      const roleKey = code ? 'code' : decision.tier === 'fast' || decision.tier === 'balanced' || decision.tier === 'max' ? decision.tier : undefined
      const gen = roleKey ? cfg.generation[roleKey] : undefined
      if (gen) {
        if (gen.temperature !== undefined) options.temperature = gen.temperature
        if (gen.topP !== undefined) options.top_p = gen.topP
        if (gen.topK !== undefined) options.top_k = gen.topK
        if (gen.repeatPenalty !== undefined) options.repeat_penalty = gen.repeatPenalty
        if (gen.maxTokens) options.num_predict = gen.maxTokens
        if (gen.placement === 'cpu') options.num_gpu = 0
        else if (gen.placement === 'gpu' && !decision.cpuOnly) options.num_gpu = 999
      }
      if (cfg.engine.cpuThreads > 0) options.num_thread = cfg.engine.cpuThreads
      if (decision.cpuOnly) options.num_gpu = 0

      const skillFit = tools.some((t) => t.name === 'use_skill') ? await skills.match(userText) : undefined
      const buildSystem = async (): Promise<string> => {
        const mem = cfg.memory.enabled ? await memory.promptBlock(userText) : { block: '', ids: [] }
        const base = code
          ? codeSystemPrompt(cfg, decision, mem.block, tools.map((t) => t.name), await projectContext(conv.projectDir!), Boolean(conv.autoEdits), skillFit, lang)
          : systemPrompt(cfg, decision, mem.block, tools.map((t) => t.name), skillFit, lang)
        return conv.summary ? `${base}\n\n## Earlier in this conversation (summary)\n${conv.summary}` : base
      }
      let sys = await buildSystem()
      const reserved = (): number => estimateTokens(sys) + estimateTokens(JSON.stringify(ollamaTools))

      // ---- context compaction: fold older turns into a summary instead of silently dropping them
      const budget = decision.numCtx - reserved() - 2500
      if (cfg.agent.autoCompact && hist.reduce((s, m) => s + msgTokens(m), 0) > budget * cfg.agent.compactAt && history.length > 4) {
        let keepTokens = 0
        let cut = history.length
        while (cut > 1) {
          const t = buildHistory([history[cut - 1]]).reduce((s, m) => s + msgTokens(m), 0)
          if (keepTokens + t > budget * 0.45) break
          keepTokens += t
          cut--
        }
        cut = Math.min(cut, history.length - 1)
        const older = history.slice(0, cut)
        const notice: Part = { type: 'notice', text: 'Summarising earlier messages to make room…', tone: 'info' }
        msg.parts.push(notice)
        const ni = msg.parts.length - 1
        this.emitPart(msg, ni)
        try {
          const n = await this.compactMessages(conv, older, decision.model, options, ctrl.signal)
          msg.parts[ni] = { type: 'notice', text: `Compacted ${n} earlier messages into a summary to keep the context window free.`, tone: 'info' }
          history = history.slice(cut)
          hist = buildHistory(history)
          sys = await buildSystem()
        } catch (e) {
          if (ctrl.signal.aborted) throw e
          msg.parts[ni] = { type: 'notice', text: 'Could not summarise older messages; the oldest ones are left out instead.', tone: 'warn' }
        }
        this.emitPart(msg, ni)
      }

      const messages: OllamaMessage[] = [{ role: 'system', content: sys }, ...fitToContext(hist, decision.numCtx, reserved())]

      // No step limit unless the person set one: the work goes on until it is done. A model that
      // repeats a failing step is told so (and handed to a stronger model when one can run).
      const maxSteps = cfg.agent.maxSteps > 0 ? cfg.agent.maxSteps : Infinity
      const failures = new Map<string, number>()
      let failedSteps = 0
      let same = { sig: '', n: 0 }
      let model = decision.model
      let modelInfo = info
      let escalated = false
      let langRetried = false
      for (let step = 0; step < maxSteps; step++) {
        let textIdx = -1
        let thinkIdx = -1
        let thinkStart = 0
        let stepText = ''
        const calls: OllamaToolCall[] = []
        const closeThinking = (): void => {
          if (thinkIdx >= 0) {
            const p = msg.parts[thinkIdx] as Extract<Part, { type: 'thinking' }>
            if (p.durationMs === undefined) {
              p.durationMs = Date.now() - thinkStart
              this.emitPart(msg, thinkIdx)
            }
          }
        }
        const tag = `[${conv.id.slice(0, 8)}] step ${step + 1}`
        log.info('agent', `${tag}: ${model}, ${messages.length} messages, ctx ${decision.numCtx}`)
        // If the model's process stops part-way (it happens), drop this step's partial output and run it again once.
        // If the answer comes out in another writing system than the person's, start it again in theirs.
        let crashRetried = false
        const resetStep = (): void => {
          closeThinking()
          if (textIdx >= 0) {
            ;(msg.parts[textIdx] as { text: string }).text = ''
            this.emitPart(msg, textIdx)
          }
          stepText = ''
          calls.length = 0
          textIdx = -1
          thinkIdx = -1
        }
        for (;;) {
          let drift = false
          try {
            for await (const chunk of ollama.chat(
              {
                model,
                messages,
                tools: ollamaTools.length ? ollamaTools : undefined,
                think: modelInfo?.capabilities.includes('thinking') ? decision.think : undefined,
                options
              },
              ctrl.signal
            )) {
              const m = chunk.message
              if (m?.thinking) {
                if (thinkIdx < 0) {
                  msg.parts.push({ type: 'thinking', text: '' })
                  thinkIdx = msg.parts.length - 1
                  thinkStart = Date.now()
                  this.emitPart(msg, thinkIdx)
                }
                ;(msg.parts[thinkIdx] as { text: string }).text += m.thinking
                this.events.emit({ type: 'delta', conversationId: conv.id, messageId: msg.id, partIndex: thinkIdx, kind: 'thinking', text: m.thinking })
              }
              if (m?.content) {
                closeThinking()
                if (textIdx < 0) {
                  msg.parts.push({ type: 'text', text: '' })
                  textIdx = msg.parts.length - 1
                  this.emitPart(msg, textIdx)
                }
                ;(msg.parts[textIdx] as { text: string }).text += m.content
                stepText += m.content
                this.events.emit({ type: 'delta', conversationId: conv.id, messageId: msg.id, partIndex: textIdx, kind: 'text', text: m.content })
                if (lang && !langRetried && stepText.length >= 30 && stepText.length <= 600 && drifted(lang, stepText)) {
                  drift = true
                  break
                }
              }
              if (m?.tool_calls?.length) calls.push(...m.tool_calls)
              if (chunk.done) {
                stats.prompt += chunk.prompt_eval_count ?? 0
                stats.out += chunk.eval_count ?? 0
                stats.evalNs += chunk.eval_duration ?? 0
                stats.loadNs += chunk.load_duration ?? 0
              }
            }
            if (drift && lang) {
              log.info('agent', `${tag}: the answer drifted out of ${lang.name}, starting it again`)
              langRetried = true
              resetStep()
              messages.push({ role: 'user', content: `Write your answer in ${lang.name}, the language I use, even though some files or results are in another language.` })
              continue
            }
            break
          } catch (e) {
            if (ctrl.signal.aborted || crashRetried || !isRunnerCrash(errMsg(e))) throw e
            crashRetried = true
            log.warn('agent', `${tag}: the model process stopped part-way, running the step again`)
            resetStep()
            msg.parts.push({ type: 'notice', text: 'The model stopped unexpectedly, so Maris started this step again.', tone: 'info' })
            this.emitPart(msg, msg.parts.length - 1)
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
        closeThinking()
        log.info('agent', `${tag}: done, ${stepText.length} chars, tools: ${calls.map((c) => c.function.name).join(', ') || 'none'}`)
        messages.push({
          role: 'assistant',
          content: stepText,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } })) } : {})
        })
        if (!calls.length) break
        let endTurn = false
        let stepFailed = calls.length > 0
        let stuck = false
        for (const call of calls) {
          if (ctrl.signal.aborted) break
          const r = await this.execTool(msg, conv, call, ctrl, canSee)
          const sig = `${call.function.name} ${JSON.stringify(parseArgs(call.function.arguments))}`
          same = sig === same.sig ? { sig, n: same.n + 1 } : { sig, n: 1 }
          let content = r.content
          if (r.failed) {
            const n = (failures.get(sig) ?? 0) + 1
            failures.set(sig, n)
            if (n >= 2) content += `\n\nNote from Maris: this exact step has now failed ${n} times. Do not repeat it unchanged. Read the error, fix its cause (syntax, path, a missing program) or take a different approach.`
          } else {
            failures.delete(sig)
            stepFailed = false
          }
          if (same.n >= 4) content += `\n\nNote from Maris: you have made this same call ${same.n} times in a row. Use its result and move on to the next part of the task.`
          if (same.n >= 10) stuck = true
          // Results in another writing system (file names, web pages) can pull a small model into that language.
          if (lang && foreignLetters(lang, content) >= 5) content += `\n\n(Answer the user in ${lang.name}.)`
          messages.push({ role: 'tool', tool_name: call.function.name, content })
          for (const img of r.images) messages.push({ role: 'user', content: img.caption, images: [img.b64] })
          if (r.endTurn) endTurn = true
        }
        repo.saveMessage(msg)
        if (endTurn || ctrl.signal.aborted) break
        if (stuck) {
          msg.parts.push({ type: 'notice', text: 'Maris stopped this answer because the model kept repeating the same step without getting anywhere. Say what to try differently, or pick a stronger model.', tone: 'warn' })
          this.emitPart(msg, msg.parts.length - 1)
          break
        }
        failedSteps = stepFailed ? failedSteps + 1 : 0
        // A small model that keeps failing hands the rest of the task to a stronger one, when one can run now.
        if (failedSteps >= 3 && !escalated && decision.auto) {
          const stronger = this.strongerModel(model, decision, cfg, models)
          if (stronger) {
            escalated = true
            failedSteps = 0
            msg.parts.push({ type: 'notice', text: `${prettyName(model)} kept running into errors, so ${prettyName(stronger.name)} takes over this task.`, tone: 'info' })
            this.emitPart(msg, msg.parts.length - 1)
            model = stronger.name
            modelInfo = stronger
            msg.model = model
            this.emitStatus(msg)
          }
        }
        if (step === maxSteps - 1) {
          msg.parts.push({ type: 'notice', text: `Stopped after ${maxSteps} steps (Settings → ${DEVICE_WORD} access → Most steps per answer). Say "continue" to keep going.`, tone: 'warn' })
          this.emitPart(msg, msg.parts.length - 1)
        }
      }
      if (ctrl.signal.aborted) throw new Error('aborted')
      msg.status = 'done'
    } catch (e) {
      if (ctrl.signal.aborted) msg.status = 'stopped'
      else {
        msg.status = 'error'
        msg.error = errMsg(e)
        log.warn('agent', e)
      }
    } finally {
      this.runs.delete(conv.id)
      this.live.delete(conv.id)
      // The chat was deleted while answering: nothing left to save it in.
      if (!repo.getConversation(conv.id)) return
      msg.stats = {
        promptTokens: stats.prompt || undefined,
        outputTokens: stats.out || undefined,
        tokensPerSec: stats.evalNs ? Math.round((stats.out / (stats.evalNs / 1e9)) * 10) / 10 : undefined,
        durationMs: Date.now() - started,
        loadMs: stats.loadNs ? Math.round(stats.loadNs / 1e6) : undefined
      }
      repo.saveMessage(msg)
      this.emitStatus(msg)
      const fresh = repo.getConversation(conv.id)
      if (fresh) {
        fresh.updatedAt = Date.now()
        repo.upsertConversation(fresh)
        this.emitConversation(fresh)
        if (msg.status === 'done') {
          if (fresh.title === 'New chat') void this.makeTitle(fresh, userText, messageText(msg))
          learner.schedule(conv.id)
        }
      }
    }
  }

  /** A picture or video from the composer's Image or Video mode: made straight away, with its progress card. */
  private async runMedia(conv: Conversation, req: MediaRequest): Promise<void> {
    const ctrl = new AbortController()
    this.runs.set(conv.id, ctrl)
    const msg: ChatMessage = { id: uid(), conversationId: conv.id, role: 'assistant', parts: [], status: 'streaming', createdAt: Date.now() }
    repo.saveMessage(msg)
    this.live.set(conv.id, msg)
    this.emitMessage(msg)
    const started = Date.now()
    const what = req.kind === 'video' ? 'video' : 'picture'
    try {
      const pack = req.packId ? media.packs().find((p) => p.id === req.packId) : undefined
      const decision: RouteDecision = {
        model: pack?.name ?? (req.kind === 'video' ? 'Video model' : 'Picture model'),
        tier: 'custom',
        think: false,
        numCtx: 0,
        cpuOnly: false,
        reason: pack
          ? `You picked ${pack.name} for this ${what}.`
          : `Maris picks the ${req.quality === 'quality' ? 'best' : req.quality === 'fast' ? 'quickest' : 'most suitable'} installed ${what} model for this.`,
        auto: !pack,
        category: 'media',
        complexity: 0
      }
      msg.route = decision
      msg.model = decision.model
      this.events.emit({ type: 'route', conversationId: conv.id, messageId: msg.id, route: decision })
      const args: Record<string, unknown> =
        req.kind === 'image'
          ? { prompt: req.prompt, quality: req.quality ?? 'auto', aspect: req.aspect ?? 'square', count: req.count ?? 1, negative: req.negative, pack: req.packId }
          : { prompt: req.prompt, quality: req.quality ?? 'auto', aspect: req.aspect ?? 'wide', seconds: req.seconds, image_path: req.startImage, pack: req.packId }
      await this.execTool(msg, conv, { function: { name: req.kind === 'video' ? 'generate_video' : 'generate_image', arguments: args } }, ctrl, false)
      // The model that made it (the card knows it once the job started).
      const card = msg.parts.find((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
      if (card?.call.media?.model && card.call.media.model !== msg.model) {
        msg.model = card.call.media.model
        msg.route = { ...decision, model: card.call.media.model }
        this.events.emit({ type: 'route', conversationId: conv.id, messageId: msg.id, route: msg.route })
      }
      if (ctrl.signal.aborted) throw new Error('aborted')
      msg.status = 'done'
    } catch (e) {
      if (ctrl.signal.aborted) msg.status = 'stopped'
      else {
        msg.status = 'error'
        msg.error = errMsg(e)
      }
    } finally {
      this.runs.delete(conv.id)
      this.live.delete(conv.id)
      if (repo.getConversation(conv.id)) {
        msg.stats = { durationMs: Date.now() - started }
        repo.saveMessage(msg)
        this.emitStatus(msg)
        const fresh = repo.getConversation(conv.id)
        if (fresh) {
          fresh.updatedAt = Date.now()
          if (fresh.title === 'New chat') fresh.title = titleFromPrompt(req.prompt, what)
          repo.upsertConversation(fresh)
          this.emitConversation(fresh)
        }
      }
    }
  }

  /** What fills a chat's context window, part by part (estimates, as the agent counts them). */
  async contextUsage(conversationId?: string, draft?: { mode?: ChatMode; projectDir?: string; model?: string }): Promise<ContextUsage> {
    const cfg = settings.get()
    const conv = conversationId ? repo.getConversation(conversationId) : undefined
    const projectDir = conv?.projectDir ?? draft?.projectDir
    const code = (conv?.mode ?? draft?.mode) === 'code' && Boolean(projectDir)
    const history = conv
      ? repo.listMessages(conv.id).filter((m) => m.status !== 'streaming' && (!conv.summaryUntil || m.createdAt > conv.summaryUntil))
      : []
    const lastRoute = [...history].reverse().find((m) => m.role === 'assistant' && m.route && m.route.numCtx > 0)?.route
    const models = await listModels().catch(() => [] as ModelInfo[])
    const chosen = conv?.model && conv.model !== 'auto' ? conv.model : draft?.model && draft.model !== 'auto' ? draft.model : undefined
    const model = chosen ?? lastRoute?.model ?? (code ? (cfg.tiers.code ?? cfg.tiers.max) : cfg.tiers.balanced) ?? cfg.tiers.fast ?? models[0]?.name ?? ''
    const window = lastRoute?.numCtx || (code ? cfg.routing.codeContext : cfg.routing.contextByTier.balanced)
    const decision: RouteDecision = lastRoute ?? { model, tier: 'custom', think: false, numCtx: window, cpuOnly: false, reason: '', auto: true, category: code ? 'code' : 'chat', complexity: 0.5 }
    const info = models.find((m) => m.name === model)
    const tools = info && !info.capabilities.includes('tools') ? [] : activeTools(cfg, { webAccess: cfg.web.enabled, mode: code ? 'code' : 'chat' })
    const own = tools.filter((t) => !t.name.startsWith('mcp_'))
    const services = tools.filter((t) => t.name.startsWith('mcp_'))
    const toolTokens = (list: typeof tools): number => (list.length ? estimateTokens(JSON.stringify(toOllamaTools(list))) : 0)
    const userTexts = history.filter((m) => m.role === 'user').map(messageText)
    const lastText = userTexts[userTexts.length - 1] ?? ''
    const lang = conversationLanguage(userTexts)
    const mem = cfg.memory.enabled ? await memory.promptBlock(lastText).catch(() => ({ block: '', ids: [] as string[] })) : { block: '', ids: [] as string[] }
    const skillBlock = tools.some((t) => t.name === 'use_skill') ? skills.promptBlock() : ''
    const project = code ? await projectContext(projectDir!) : undefined
    const sys = code
      ? codeSystemPrompt(cfg, decision, mem.block, tools.map((t) => t.name), project!, Boolean(conv?.autoEdits), undefined, lang)
      : systemPrompt(cfg, decision, mem.block, tools.map((t) => t.name), undefined, lang)
    const memoryT = estimateTokens(mem.block)
    const skillsT = estimateTokens(skillBlock)
    const projectT = project ? estimateTokens([project.about ?? '', project.topLevel, project.git ?? '', project.instructions ?? '', project.stack.join(', ')].join('\n')) : 0
    const customT = estimateTokens(cfg.persona.customInstructions?.trim() ?? '')
    const summaryT = conv?.summary ? estimateTokens(conv.summary) + 12 : 0
    const instructionsT = Math.max(0, estimateTokens(sys) - memoryT - skillsT - projectT - customT)
    let messagesT = 0
    let resultsT = 0
    let picturesT = 0
    for (const m of buildHistory(history)) {
      picturesT += (m.images?.length ?? 0) * 900
      if (m.role === 'tool') resultsT += estimateTokens(m.content)
      else messagesT += estimateTokens(m.content) + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0)
    }
    const parts = [
      { key: 'instructions', label: 'Maris\'s instructions', hint: 'How Maris works: your name, folders, the date, its style and safety rules.', tokens: instructionsT },
      { key: 'tools', label: 'Tools', hint: `Descriptions of the ${own.length} things Maris can do (read files, run commands, search the web…).`, tokens: toolTokens(own) },
      { key: 'services', label: 'Connected services', hint: `Tools of the services you connected (${services.length}).`, tokens: toolTokens(services) },
      { key: 'skills', label: 'Skills', hint: 'The list of your skills, so Maris knows when to use one.', tokens: skillsT },
      { key: 'memory', label: 'Memory', hint: 'What Maris remembers about you that fits this chat.', tokens: memoryT },
      { key: 'project', label: 'Project', hint: 'The project folder, its files, git status and what it is about.', tokens: projectT },
      { key: 'custom', label: 'Your instructions', hint: 'Your own instructions from Settings.', tokens: customT },
      { key: 'summary', label: 'Summary of earlier messages', hint: 'Older messages folded into a short summary.', tokens: summaryT },
      { key: 'messages', label: 'Messages', hint: 'Your messages and the answers, including attached files.', tokens: messagesT },
      { key: 'results', label: 'Tool results', hint: 'What tools returned: file contents, command output, web pages.', tokens: resultsT },
      { key: 'pictures', label: 'Pictures', hint: 'Pictures in the chat that the model looks at.', tokens: picturesT }
    ].filter((p) => p.tokens > 0)
    const used = parts.reduce((s, p) => s + p.tokens, 0)
    const reserved = 2048
    const fixed = used - messagesT - resultsT - picturesT
    const budget = window - fixed - 2500
    const untilCompact = cfg.agent.autoCompact ? Math.max(0, Math.round(budget * cfg.agent.compactAt - (messagesT + resultsT + picturesT))) : undefined
    return { model, window, parts, used, reserved, untilCompact, summarised: Boolean(conv?.summary), messages: history.length }
  }

  private async execTool(
    msg: ChatMessage,
    conv: Conversation,
    call: OllamaToolCall,
    ctrl: AbortController,
    canSee: boolean
  ): Promise<{ content: string; images: { b64: string; caption: string }[]; endTurn: boolean; failed?: boolean }> {
    const name = call.function.name
    const def = findTool(name)
    const args = parseArgs(call.function.arguments)
    const rec: ToolCallRecord = { id: uid(), name, args, risk: def?.risk ?? 'read', status: 'pending', startedAt: Date.now() }
    msg.parts.push({ type: 'tool', call: rec })
    const idx = msg.parts.length - 1
    const update = (): void => this.emitPart(msg, idx)
    update()
    const images: { b64: string; caption: string }[] = []
    let endTurn = false
    if (!def) {
      rec.status = 'error'
      rec.title = humanTool(name, args)
      rec.error = `Unknown tool "${name}"`
      update()
      return { content: `Error: there is no tool named "${name}". Use one of the listed tools.`, images, endTurn, failed: true }
    }
    const cfg = settings.get()
    const code = conv.mode === 'code' && Boolean(conv.projectDir)
    const ctx: ToolContext = {
      conversationId: msg.conversationId,
      messageId: msg.id,
      signal: ctrl.signal,
      settings: cfg,
      mode: code ? 'code' : 'chat',
      cwd: code ? conv.projectDir! : os.homedir(),
      projectDir: code ? conv.projectDir : undefined,
      modelSupportsVision: canSee,
      progress: (t) => {
        rec.progress = t
        update()
      },
      setPreview: (u) => {
        rec.preview = u
        update()
      },
      setMedia: (m) => {
        rec.media = m
        update()
      },
      addMedia: (m) => {
        msg.parts.push({ type: 'media', media: m })
        this.emitPart(msg, msg.parts.length - 1)
        endTurn = true
      },
      attachImageForModel: (b64, caption) => images.push({ b64, caption }),
      reportBackup: (p) => {
        rec.backup = p
      }
    }
    try {
      const prep = def.prepare ? await def.prepare(args, ctx) : { risk: def.risk, title: name }
      rec.risk = prep.risk
      rec.title = prep.title
      rec.detail = prep.detail
      rec.targets = prep.targets
      if (prep.preview?.kind === 'diff') rec.diff = prep.preview.diff
      if (needsApproval(prep.risk)) {
        // Rules the user explicitly enabled for this project can skip the prompt.
        const live = repo.getConversation(conv.id) ?? conv
        let auto: string | undefined
        if (code && live.projectDir) {
          if (live.autoEdits && EDIT_TOOLS.has(name) && prep.targets?.length && prep.targets.every((t) => isInside(t, live.projectDir!))) {
            auto = 'File edits inside this project are allowed for this chat.'
          }
          if (!auto && (name === 'run_command' || name === 'start_process')) {
            const project = repo.getProject(live.projectDir)
            const hit = project ? matchesAllowed(String(args.command ?? ''), project.allowedCommands) : undefined
            if (hit) auto = `You always allow "${hit}" in this project.`
          }
        }
        // "Always approve" rules the person chose: a kind of change, this session, or everything.
        if (!auto) auto = autoApproveReason(cfg.agent.autoApprove, { tool: name, risk: prep.risk, inSession: approvals.inSession(conv.id) }, TRASH_WORD)
        if (auto) {
          rec.autoApproved = auto
        } else {
          rec.status = 'awaiting-approval'
          msg.status = 'waiting'
          update()
          this.emitStatus(msg)
          const answer = await approvals.request(
            {
              conversationId: msg.conversationId,
              messageId: msg.id,
              toolCallId: rec.id,
              tool: name,
              title: prep.title,
              detail: prep.detail ?? '',
              risk: prep.risk,
              preview: prep.preview,
              allowPrefix: code ? prep.allowPrefix : undefined,
              kind: approvalKind(name, prep.risk),
              install: prep.install
            },
            ctrl.signal
          )
          msg.status = 'streaming'
          this.emitStatus(msg)
          if (!answer.approved) {
            rec.status = 'denied'
            rec.endedAt = Date.now()
            update()
            if (ctrl.signal.aborted) throw new Error('aborted')
            return {
              content:
                'The user DENIED this action, so it was NOT performed. Do not retry it or work around it. Briefly acknowledge and ask how they would like to proceed.',
              images,
              endTurn
            }
          }
          if (answer.rule) rec.autoApproved = this.applyRule(answer.rule, { conversationId: conv.id, tool: name, risk: prep.risk, projectDir: live.projectDir, allowPrefix: prep.allowPrefix })
        }
      }
      rec.status = 'running'
      update()
      log.info('agent', `tool ${name} running${rec.autoApproved ? ' (auto-approved)' : ''}`)
      const out = await def.run(args, ctx)
      log.info('agent', `tool ${name} done (${out.length} chars)`)
      rec.status = 'done'
      rec.result = truncate(out, 6000)
      rec.progress = undefined
      rec.endedAt = Date.now()
      update()
      // Commands report failure through their exit code rather than by throwing.
      const exit = /^\((?:exit code|exit) (-?\d+|\?)/m.exec(out)
      const failed = Boolean(exit && exit[1] !== '0') || /^\((?:timed out after|exit [^)\n]*timed out)/m.test(out)
      return { content: truncate(out, 16000), images, endTurn, failed }
    } catch (e) {
      if (ctrl.signal.aborted) throw e
      rec.status = 'error'
      rec.title = rec.title ?? humanTool(name, args)
      rec.error = errMsg(e)
      rec.progress = undefined
      rec.endedAt = Date.now()
      update()
      return { content: `Error: ${errMsg(e)}`, images, endTurn, failed: true }
    }
  }

  /** The next bigger model that can run right now (not while the graphics card is making media). */
  private strongerModel(current: string, decision: RouteDecision, cfg: ReturnType<typeof settings.get>, models: ModelInfo[]): ModelInfo | undefined {
    if (decision.cpuOnly || media.activeCount > 0) return undefined
    const order = ['tiny', 'fast', 'balanced', 'max'] as const
    const tierOf = order.findIndex((t) => cfg.tiers[t] === current)
    const sizeNow = models.find((m) => m.name === current)?.sizeBytes ?? 0
    for (const t of order.slice(Math.max(0, tierOf) + 1)) {
      const name = t === 'max' && decision.category === 'code' && cfg.tiers.code ? cfg.tiers.code : cfg.tiers[t]
      const m = models.find((x) => x.name === name)
      if (m && m.sizeBytes > sizeNow && m.capabilities.includes('tools') && m.capabilities.includes('completion')) return m
    }
    return undefined
  }

  private async makeTitle(conv: Conversation, userText: string, answer: string): Promise<void> {
    const fallback = userText.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ').slice(0, 60) || 'New chat'
    let title = fallback
    try {
      const r = await quickJson<{ title: string }>(
        TITLE_SYSTEM,
        `User: ${userText.slice(0, 800)}\nAssistant: ${answer.slice(0, 600)}`,
        { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        { timeoutMs: 45000, maxTokens: 40 }
      )
      const t = r?.title?.replace(/^["'«“]+|["'»”.]+$/g, '').trim()
      if (t && t.length >= 2) title = t.slice(0, 60)
    } catch {
      /* keep fallback */
    }
    const fresh = repo.getConversation(conv.id)
    if (!fresh || fresh.title !== 'New chat') return
    fresh.title = title
    repo.upsertConversation(fresh)
    this.emitConversation(fresh)
  }
}

export const agent = new Agent()
