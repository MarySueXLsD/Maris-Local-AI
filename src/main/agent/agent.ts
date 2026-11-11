import { existsSync, statSync, readFileSync } from 'node:fs'
import os from 'node:os'
import type {
  Attachment,
  ChatEvent,
  ChatMessage,
  ChatMode,
  ContextSizeOption,
  ContextSizes,
  ContextUsage,
  Conversation,
  MediaRequest,
  ModelInfo,
  Part,
  RouteDecision,
  SendOptions,
  Settings,
  ThinkMode,
  ToolCallRecord,
  ToolRisk
} from '@shared/types'
import { messageText, repo } from '../db'
import { llm } from '../engines/llm'
import { API_CONTEXT_SIZES, RING_CONTEXT_SIZES, sizesFor, usableWindow } from '@shared/context'
import { contextOverflow } from '../engines/errors'
import { usage } from '../engines/usage'
import { isRunnerCrash, ollama } from '../engines/ollama'
import { providers } from '../engines/providers'
import type { LlmMessage, LlmTool, LlmToolCall } from '../engines/types'
import { learner } from '../memory/learner'
import { memory } from '../memory/store'
import { cancelBackground, quickJson } from '../memory/utility'
import { media } from '../media/jobs'
import { isLite } from '../perf'
import { analyze, apiContext, assignTiers, localContext, noteApiWindow, route, routerLearning, vramNeedMB } from '../router'
import { prettyModel } from '../../renderer/src/lib/format'
import { settings } from '../settings'
import { skills } from '../skills/skills'
import { monitor } from '../system/monitor'
import { activeTools, allToolNames, EDIT_TOOLS, findTool, needsApproval, selectTools, toLlmTools, type ChatToolContext } from '../tools'
import { matchesAllowed } from '../tools/classify'
import { ALWAYS_ASK, approvalKind, autoApproveReason, kindLabel, type ApprovalRule } from '@shared/approval'
import { isInside } from '../tools/paths'
import type { ToolContext, ToolDef } from '../tools/types'
import { clamp, Emitter, errMsg, estimateTokens, log, truncate, uid, sleep } from '../util'
import { DEVICE_WORD, IS_WIN, SHELL_LABEL } from '../platform'
import { resolveToolName, shellAlias } from './toolAlias'
import { conversationLanguage, drifted, isContinuation, scriptCounts, type Language } from '@shared/language'
import { approvals } from './approvals'

/** Where deleted files go on this system, for messages about "Always approve" rules. */
const TRASH_WORD = IS_WIN ? 'Recycle Bin' : 'Trash'
/** A picture or video that finishes within this many seconds is waited for instead of answering on the processor. */
const MEDIA_WAIT_SEC = 60
import { allowCommand, isProjectFolder, projectContext, projectKey, touchProject } from './project'
import { codeSystemPrompt, COMPACT_SYSTEM, COMPACT_SYSTEM_BRIEF, contextNote, PROJECT_STATE_MARK, projectState, systemPrompt, TITLE_SYSTEM } from './prompts'

// ------------------------------------------------------------------ model list cache

let modelCache: { at: number; models: ModelInfo[] } | undefined
/**
 * Every model Maris can use: the ones in Ollama on this computer, then the chosen models of the API
 * services the person added. Ollama not running is not an error here: API models still work without it.
 */
export async function listModels(force = false): Promise<ModelInfo[]> {
  if (!force && modelCache && Date.now() - modelCache.at < 20000) return modelCache.models
  let local: ModelInfo[] = []
  let localKnown = true
  try {
    local = await ollama.list()
  } catch (e) {
    localKnown = false
    // Keep what was known a moment ago rather than making every local model look uninstalled.
    local = modelCache?.models.filter((m) => !m.provider) ?? []
    log.debug('agent', 'Ollama did not list its models', errMsg(e))
  }
  const models = [...local, ...providers.modelInfos()]
  // A failed listing is remembered for a few seconds only, so Ollama is asked again soon.
  modelCache = { at: localKnown ? Date.now() : Date.now() - 15000, models }
  if (localKnown) {
    const cfg = settings.get()
    const tiers = assignTiers(models, cfg.tiers, monitor.snapshot().gpu?.memTotalMB ?? 0)
    if (JSON.stringify(tiers) !== JSON.stringify(cfg.tiers)) settings.update({ tiers })
  }
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

/** What the model is told when the person says no to an action. */
const DENIED = 'The user DENIED this action, so it was NOT performed. Do not retry it or work around it. Briefly acknowledge and ask how they would like to proceed.'
/** How much of a tool's output is kept with the chat, and how much of that a small window is shown. */
const RESULT_KEPT = 6000
const RESULT_SMALL = 1800

function toolResultFor(call: ToolCallRecord, limit: number): string {
  if (call.status === 'denied') return DENIED
  if (call.status === 'error') return `Error: ${call.error ?? 'failed'}`
  return truncate(call.result ?? '(no output)', limit)
}

/**
 * A chat as the model reads it. `small` (a slow computer with a small window) keeps less of each tool
 * result: what an old step returned matters less than having room for the next one.
 */
export function buildHistory(history: ChatMessage[], small = false): LlmMessage[] {
  // Keep recent tool output in full; older tool output shrinks to save context.
  let toolSeen = 0
  const totalTools = history.reduce((n, m) => n + m.parts.filter((p) => p.type === 'tool').length, 0)
  // In a small window every result is cut to the same short length, in the chat as it was during the
  // task: results that keep their wording are not read again by a slow processor.
  const [recentChars, oldChars, keepRecent] = small ? [RESULT_SMALL, RESULT_SMALL, 0] : [RESULT_KEPT, 700, 8]
  const out: LlmMessage[] = []
  for (const m of history) {
    if (m.role === 'user') {
      const text = messageText(m)
      const files = (m.attachments ?? []).filter((a) => a.kind === 'file' || a.kind === 'snippet').map(fileNote)
      const images = (m.attachments ?? [])
        .filter((a) => a.kind === 'image' && a.dataUrl)
        .map((a) => a.dataUrl!.slice(a.dataUrl!.indexOf(',') + 1))
      // The note Maris wrote with this message (time, memories, project state) goes first, unchanged
      // from when the message was sent: an unchanged beginning is what a model does not read twice.
      out.push({ role: 'user', content: [m.context, text, ...files].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}) })
      continue
    }
    let content = ''
    for (const p of m.parts) {
      if (p.type === 'text') content += p.text
      else if (p.type === 'tool') {
        toolSeen++
        const recent = totalTools - toolSeen < keepRecent
        const id = `call_${p.call.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`
        out.push({ role: 'assistant', content, tool_calls: [{ id, function: { name: p.call.name, arguments: p.call.args } }] })
        out.push({ role: 'tool', tool_name: p.call.name, tool_call_id: id, is_error: p.call.status === 'error' || undefined, content: toolResultFor(p.call, recent ? recentChars : oldChars) })
        content = ''
      } else if (p.type === 'media') content += `\n[Generated ${p.media.kind}: ${p.media.path}]`
    }
    if (content.trim()) out.push({ role: 'assistant', content })
  }
  return out
}

/** What a chat is about, for picking which connected services bring their tools. */
function chatToolContext(messages: ChatMessage[]): ChatToolContext {
  const users = messages.filter((m) => m.role === 'user').slice(-3).map(messageText)
  const used: string[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool') continue
      if (p.call.name === 'use_connector' && typeof p.call.args?.service === 'string') used.push(p.call.args.service)
      else if (p.call.name.startsWith('mcp_')) used.push(p.call.name)
    }
  }
  return { text: users.join('\n'), used }
}

/** 20400 → "20K", 850 → "850". */
const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

const msgTokens = (m: LlmMessage): number =>
  estimateTokens(m.content) + (m.images?.length ?? 0) * 900 + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0)

/** Room kept free for the answer: a quarter of the window, between 512 and 2,500 tokens. */
export const answerRoom = (numCtx: number): number => Math.round(clamp(numCtx * 0.25, 512, 2500))

/** Keep the newest messages that fit in the context window; drop images from older turns. */
export function fitToContext(msgs: LlmMessage[], numCtx: number, reserved: number): LlmMessage[] {
  const budget = Math.max(numCtx <= 8192 ? 600 : 1024, numCtx - reserved - Math.min(2048, answerRoom(numCtx)))
  const kept: LlmMessage[] = []
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

function parseArgs(a: LlmToolCall['function']['arguments']): Record<string, unknown> {
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

  /** Chats whose run is a picture or video from the message box (no language model involved). */
  private mediaRuns = new Set<string>()

  /** What is being worked on right now, for the question Maris asks before it closes. */
  runningWork(): { answers: number; media: number } {
    const making = [...this.runs.keys()].filter((id) => this.mediaRuns.has(id)).length
    return { answers: this.runs.size - making, media: making }
  }

  runningIds(): string[] {
    return [...this.runs.keys()]
  }

  /**
   * Streamed words waiting to be shown. A fast model writes a few hundred small pieces a second, and
   * each one sent on its own makes the window lay the answer out again; gathered into a few updates a
   * second they read the same and cost a fraction (which a slow computer feels, with the model
   * already using every core).
   */
  private pending = new Map<string, { conversationId: string; messageId: string; partIndex: number; kind: 'text' | 'thinking'; text: string }>()
  private pendingTimer?: NodeJS.Timeout

  private queueDelta(m: ChatMessage, partIndex: number, kind: 'text' | 'thinking', text: string): void {
    const key = `${m.id}:${partIndex}:${kind}`
    const cur = this.pending.get(key)
    if (cur) cur.text += text
    else this.pending.set(key, { conversationId: m.conversationId, messageId: m.id, partIndex, kind, text })
    this.pendingTimer ??= setTimeout(() => this.flushDeltas(), isLite() ? 220 : 45)
  }

  private flushDeltas(): void {
    clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
    if (!this.pending.size) return
    const list = [...this.pending.values()]
    this.pending.clear()
    for (const d of list) this.events.emit({ type: 'delta', ...d })
  }

  private emitMessage(m: ChatMessage): void {
    this.flushDeltas()
    this.events.emit({ type: 'message', message: structuredClone(m) })
  }
  private emitPart(m: ChatMessage, i: number): void {
    // Words still waiting belong to the part as it was before this update: drop the ones for this part
    // (the update carries its whole text) and send the rest first.
    for (const [k, d] of this.pending) if (d.messageId === m.id && d.partIndex === i) this.pending.delete(k)
    this.flushDeltas()
    this.events.emit({ type: 'part', conversationId: m.conversationId, messageId: m.id, partIndex: i, part: structuredClone(m.parts[i]) })
  }
  /** The biggest installed model with tools that is smaller than `current`, for when it keeps crashing. */
  private smallerModel(current: string, cfg: Settings, models: ModelInfo[]): string | undefined {
    const size = (n: string): number => models.find((m) => m.name === n)?.sizeBytes ?? 0
    const cur = size(current)
    return [cfg.tiers.max, cfg.tiers.balanced, cfg.tiers.fast, cfg.tiers.code]
      .filter((n): n is string => Boolean(n) && n !== current)
      .filter((n) => size(n) > 0 && size(n) < cur && Boolean(models.find((m) => m.name === n)?.capabilities.includes('tools')))
      .sort((a, b) => size(b) - size(a))[0]
  }

  /** What the model is doing right now, shown under the live answer with a timer. */
  private setActivity(m: ChatMessage, text?: string, keepSince = false): void {
    if (text === m.activity?.text) return
    m.activity = text ? { text, since: keepSince && m.activity ? m.activity.since : Date.now() } : undefined
    this.events.emit({ type: 'activity', conversationId: m.conversationId, messageId: m.id, activity: m.activity })
  }
  private emitStatus(m: ChatMessage): void {
    this.flushDeltas()
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
      // The same spelling the project list uses, so the chat shows under its project.
      const projectDir = mode === 'code' && opts.projectDir ? (repo.getProject(projectKey(opts.projectDir))?.path ?? projectKey(opts.projectDir)) : undefined
      if (projectDir && !isProjectFolder(projectDir)) throw new Error(`Project folder not found: ${opts.projectDir}`)
      conv = {
        id: opts.conversationId ?? uid(),
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        model: opts.model ?? 'auto',
        mode,
        projectDir,
        origin: opts.origin
      }
      repo.upsertConversation(conv)
      this.emitConversation(conv)
    }
    if (conv.projectDir) {
      // The folder was moved, renamed or deleted since the chat began: say so instead of failing later
      // with a command that cannot find its working folder.
      if (!isProjectFolder(conv.projectDir)) throw new Error(`This chat's project folder is gone: ${conv.projectDir}. Open the project where it is now and start a new chat there.`)
      touchProject(conv.projectDir)
    }
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
    // A message from the Image or Video mode stays one: the edited text is the new description.
    await this.send({ conversationId: m.conversationId, text, attachments: m.attachments, media: m.media ? { ...m.media, prompt: text } : undefined })
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
    signal?: AbortSignal,
    /** A slow computer: a much shorter summary, which takes a fraction of the time to write and to read again. */
    brief = false
  ): Promise<number> {
    if (!older.length) return 0
    const transcript = older
      .map((m) => {
        const tools = m.parts
          .filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool')
          .map((p) => `  [${p.call.name} ${p.call.title ?? ''} → ${p.call.status}${p.call.status === 'error' ? `: ${p.call.error}` : ''}]`)
          .join('\n')
        return `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${messageText(m).slice(0, brief ? 1200 : 3000)}${tools ? `\n${tools}` : ''}`
      })
      .join('\n\n')
    const window = Number(options.num_ctx ?? 16384)
    const budgetChars = Math.max(brief ? 2400 : 6000, (window - (brief ? 1000 : 3000)) * 3)
    const input = `${conv.summary ? `Previous summary:\n${conv.summary}\n\n` : ''}Conversation to fold in:\n${transcript.slice(-budgetChars)}`
    const r = await llm.chatOnce(
      {
        model,
        think: false,
        options: { ...options, temperature: 0.2, num_predict: brief ? 260 : 900 },
        messages: [
          { role: 'system', content: brief ? COMPACT_SYSTEM_BRIEF : COMPACT_SYSTEM },
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
    const models = await listModels().catch(() => [] as ModelInfo[])
    const has = (n?: string): n is string => Boolean(n && models.some((m) => m.name === n))
    // The model this chat answers with, else the strongest one set up.
    const lastModel = [...history].reverse().find((m) => m.role === 'assistant' && m.model)?.model
    const model = [conv.model !== 'auto' ? conv.model : undefined, lastModel, cfg.tiers.max, cfg.tiers.balanced, cfg.tiers.fast].find(has)
    if (!model || !older.length) return 0
    const api = llm.isRemote(model)
    const w = ollama.loadedWith.get(model)
    const options: Record<string, unknown> = api
      ? { num_ctx: apiContext(models.find((m) => m.name === model), cfg) }
      : { num_ctx: w?.num_ctx ?? cfg.routing.codeContext, ...(w?.num_gpu !== undefined ? { num_gpu: w.num_gpu } : cfg.engine.processing === 'cpu' ? { num_gpu: 0 } : {}) }
    return this.compactMessages(conv, older, model, options, undefined, isLite(cfg) && !api)
  }

  // ---------------------------------------------------------------- one assistant turn

  private async run(conv: Conversation, opts: RunOptions): Promise<void> {
    const ctrl = new AbortController()
    this.runs.set(conv.id, ctrl)
    // A title or a memory note being written in the background gives way to the person's message.
    cancelBackground()
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
    const stats = { prompt: 0, out: 0, evalNs: 0, loadNs: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: false, unpriced: false, billed: false }
    try {
      const cfg = settings.get()
      const lite = isLite(cfg)
      const fresh = repo.getConversation(conv.id) ?? conv
      Object.assign(conv, fresh)
      const code = conv.mode === 'code' && Boolean(conv.projectDir)
      const mode: ChatMode = code ? 'code' : 'chat'
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
      const historyTokens = buildHistory(history, lite).reduce((s, m) => s + msgTokens(m), 0)
      const explicit = opts.model && opts.model !== 'auto' ? opts.model : conv.model !== 'auto' ? conv.model : undefined
      // A picture or video is being made (maybe in another chat). If it is nearly done, wait for the
      // graphics card; otherwise the router moves this answer to the processor and the chat says why.
      // (A model at an API service does not need this computer's graphics card at all.)
      let mediaNote: string | undefined
      const busyMedia = cfg.engine.processing !== 'cpu' && !llm.isRemote(explicit) ? media.busyInfo() : undefined
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
          mode,
          previous,
          lite
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
      const api = llm.isRemote(decision.model)
      // A slow computer gets the short instructions and only the tools a request needs. A model that
      // runs at an API service is not slowed by this computer, so it gets everything.
      const small = lite && !api
      const info = models.find((m) => m.name === decision.model)
      // Every model can use tools: one without tool calling of its own is given them as text (engines/llm.ts).
      const canSee = (await llm.traits(decision.model)).vision
      const webOn = opts.webAccess ?? cfg.web.enabled
      // Connected services bring their tools only when the chat needs them (named, used before, or asked for).
      const toolContext = (): ChatToolContext => chatToolContext([...history, msg])
      const userMessages = (): ChatMessage[] => history.filter((m) => m.role === 'user')
      let allTools: ToolDef[] = []
      let tools: ToolDef[] = []
      let llmTools: LlmTool[] = []
      let toolTokens = 0
      const pickTools = (): void => {
        const context = toolContext()
        allTools = activeTools(cfg, { webAccess: webOn, mode, context })
        tools = small
          ? selectTools(allTools, {
              mode,
              kinds: [...userMessages().map((m) => analyze(messageText(m), m.attachments ?? []).category), decision.category],
              texts: userMessages().map(messageText),
              used: context.used
            })
          : allTools
        llmTools = toLlmTools(tools, small)
        toolTokens = llmTools.length ? estimateTokens(JSON.stringify(llmTools)) : 0
      }
      pickTools()
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

      // Matching a request to a skill by meaning takes a model call; a slow computer skips it (the
      // skills are still listed for the model to pick from).
      const skillFit = !small && tools.some((t) => t.name === 'use_skill') ? await skills.match(userText) : undefined
      const project = code ? await projectContext(conv.projectDir!) : undefined

      // What changes from message to message goes into a note in front of the user's message, kept with
      // it: the time, memories that fit (each told once per chat), the project's state when it changed.
      if (lastUser) {
        const earlier = history.filter((m) => m.role === 'user' && m.id !== lastUser.id)
        const told = new Set(earlier.flatMap((m) => m.contextMemories ?? []))
        const remembered = cfg.memory.enabled ? await memory.forPrompt(userText, told).catch(() => []) : []
        const state = project ? projectState(project) : undefined
        const lastTold = [...earlier].reverse().find((m) => m.context?.includes(PROJECT_STATE_MARK))?.context
        lastUser.context = contextNote({ memories: remembered, projectState: state && !lastTold?.includes(state) ? state : undefined, skill: skillFit })
        lastUser.contextMemories = remembered.length ? remembered.map((m) => m.id) : undefined
        repo.saveMessage(lastUser)
      }

      const buildSystem = (): string => {
        const names = tools.map((t) => t.name)
        const base = code
          ? codeSystemPrompt(cfg, decision, names, project!, Boolean(conv.autoEdits), { compact: small, lang })
          : systemPrompt(cfg, decision, names, { compact: small, lang })
        return conv.summary ? `${base}\n\n## Earlier in this conversation (summary)\n${conv.summary}` : base
      }
      let sys = buildSystem()
      const reserved = (): number => estimateTokens(sys) + toolTokens
      // The instructions and tool list can take most of a small window, leaving room for only a few
      // messages: the chat was then summarised after four of them and the request got lost. The window
      // grows to leave room for the conversation (not at an API service, whose window is a budget; and
      // only as far as 8K on a slow computer, where a bigger window is more to read).
      if (!api) {
        const [room, cap, stepSize] = small ? [1800, 8192, 2048] : [8000, 32768, 4096]
        if (decision.numCtx - reserved() < room) {
          const grown = Math.min(cap, info?.contextLength || Infinity, Math.ceil((reserved() + room * 1.25) / stepSize) * stepSize)
          if (grown > decision.numCtx) {
            decision.numCtx = grown
            options.num_ctx = grown
          }
        }
      }

      // ---- context compaction: fold older turns into a summary instead of silently dropping them
      let hist = buildHistory(history, small)
      const budget = decision.numCtx - reserved() - answerRoom(decision.numCtx)
      if (cfg.agent.autoCompact && hist.reduce((s, m) => s + msgTokens(m), 0) > budget * cfg.agent.compactAt && history.length > (small ? 4 : 6)) {
        let keepTokens = 0
        let cut = history.length
        while (cut > 1) {
          const t = buildHistory([history[cut - 1]], small).reduce((s, m) => s + msgTokens(m), 0)
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
          const n = await this.compactMessages(conv, older, decision.model, options, ctrl.signal, small)
          msg.parts[ni] = { type: 'notice', text: `Compacted ${n} earlier messages into a summary to keep the context window free.`, tone: 'info' }
          history = history.slice(cut)
          hist = buildHistory(history, small)
          sys = buildSystem()
        } catch (e) {
          if (ctrl.signal.aborted) throw e
          msg.parts[ni] = { type: 'notice', text: 'Could not summarise older messages; the oldest ones are left out instead.', tone: 'warn' }
        }
        this.emitPart(msg, ni)
      }

      const messages: LlmMessage[] = [{ role: 'system', content: sys }, ...fitToContext(hist, decision.numCtx, reserved())]

      // No step limit unless the person set one: the work goes on until it is done. A model that
      // repeats a failing step is told so (and handed to a stronger model when one can run).
      const maxSteps = cfg.agent.maxSteps > 0 ? cfg.agent.maxSteps : Infinity
      const failures = new Map<string, number>()
      let failedSteps = 0
      let same = { sig: '', n: 0 }
      let model = decision.model
      let escalated = false
      let langRetried = false
      /** The request was cut down once because a service said it was too long. */
      let refitted = false
      for (let step = 0; step < maxSteps; step++) {
        let textIdx = -1
        let thinkIdx = -1
        let thinkStart = 0
        let stepText = ''
        const calls: LlmToolCall[] = []
        /** The engine's own copy of this step's answer, passed back unchanged on the next step. */
        let raw: unknown
        let endNote: string | undefined
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
        log.info('agent', `${tag}: ${model}, ${messages.length} messages, ctx ${decision.numCtx}, ${tools.length} tools${small ? ' (low-power)' : ''}`)
        // If the model's process stops part-way (it happens, mostly when the graphics card runs out of memory),
        // drop this step's partial output and run it again: the same way once, then with a smaller model, then
        // on the processor. If the answer comes out in another writing system than the person's, start it
        // again in theirs.
        let crashes = 0
        const resetStep = (): void => {
          closeThinking()
          if (textIdx >= 0) {
            ;(msg.parts[textIdx] as { text: string }).text = ''
            this.emitPart(msg, textIdx)
          }
          stepText = ''
          calls.length = 0
          raw = undefined
          endNote = undefined
          textIdx = -1
          thinkIdx = -1
        }
        for (;;) {
          let drift = false
          const local = !llm.isRemote(model)
          // What is happening before the first word: loading the model, reading the prompt.
          const loadedNow = local ? (await ollama.ps()).some((l) => l.name === model) : true
          const reading =
            step === 0 ? `Reading ${kTokens(reserved() + hist.reduce((s, m) => s + msgTokens(m), 0))} tokens: instructions, tools and the chat…` : 'Reading the results…'
          const sizeGB = (models.find((x) => x.name === model)?.sizeBytes ?? 0) / 2 ** 30
          const where = models.find((x) => x.name === model)?.providerName
          this.setActivity(msg, !local ? `Waiting for ${where ?? 'the service'}…` : loadedNow ? reading : `Loading ${prettyModel(model)} into memory${sizeGB ? ` (${sizeGB.toFixed(1)} GB)` : ''}…`)
          let firstChunk = false
          let gotContent = false
          let lastChunk = Date.now()
          let thinkShown = 0
          const watch = setInterval(() => {
            if (!firstChunk && !loadedNow && msg.activity?.text.startsWith('Loading')) {
              void ollama.ps().then((l) => {
                if (!firstChunk && l.some((x) => x.name === model)) this.setActivity(msg, reading)
              })
            } else if (firstChunk && !gotContent && Date.now() - lastChunk > 2500 && !msg.activity?.text.startsWith('Deciding')) {
              // Thinking ended and nothing streams: the model is writing a tool call.
              this.setActivity(msg, 'Deciding on the next action…')
            }
          }, 1500)
          try {
            for await (const chunk of llm.chat({ model, messages, tools: llmTools.length ? llmTools : undefined, think: decision.think, thinkHard: decision.think && (opts.think ?? cfg.agent.defaultThink) === 'on', options }, ctrl.signal)) {
              if (chunk.restart) {
                // The engine had to send the request again: what this step showed so far is void.
                resetStep()
                continue
              }
              firstChunk = true
              const m = chunk.message
              if (m?.thinking) {
                lastChunk = Date.now()
                if (thinkIdx < 0) {
                  msg.parts.push({ type: 'thinking', text: '' })
                  thinkIdx = msg.parts.length - 1
                  thinkStart = Date.now()
                  this.emitPart(msg, thinkIdx)
                }
                ;(msg.parts[thinkIdx] as { text: string }).text += m.thinking
                this.queueDelta(msg, thinkIdx, 'thinking', m.thinking)
                if (Date.now() - thinkShown > 700) {
                  thinkShown = Date.now()
                  const all = (msg.parts[thinkIdx] as { text: string }).text.replace(/\s+/g, ' ').trim()
                  const tail = all.length > 120 ? `…${all.slice(-120).replace(/^\S*\s/, '')}` : all
                  this.setActivity(msg, `Thinking: ${tail}`, msg.activity?.text.startsWith('Thinking') ?? false)
                }
              }
              if (m?.content) {
                lastChunk = Date.now()
                gotContent = true
                if (msg.activity) this.setActivity(msg, undefined)
                closeThinking()
                if (textIdx < 0) {
                  msg.parts.push({ type: 'text', text: '' })
                  textIdx = msg.parts.length - 1
                  this.emitPart(msg, textIdx)
                }
                ;(msg.parts[textIdx] as { text: string }).text += m.content
                stepText += m.content
                this.queueDelta(msg, textIdx, 'text', m.content)
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
                stats.cacheRead += chunk.cache_read_count ?? 0
                stats.cacheWrite += chunk.cache_write_count ?? 0
                // A model at a service on the internet is paid per token: its cost goes on the answer.
                if (models.find((x) => x.name === model)?.remote === true) {
                  stats.billed = true
                  if (chunk.cost_usd !== undefined) {
                    stats.cost += chunk.cost_usd
                    stats.priced = true
                  } else stats.unpriced = true
                }
                raw = chunk.raw
                endNote = chunk.done_note
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
            // A service says the conversation is longer than its model takes (Maris's token counts are
            // estimates, and some services do not say how much their models take): remember the real
            // size, leave the oldest messages out of this request and send it again, once.
            const over = !local && !ctrl.signal.aborted && !refitted ? contextOverflow(errMsg(e)) : undefined
            if (over) {
              refitted = true
              const real = over.limit ?? Math.floor(decision.numCtx * 0.7)
              noteApiWindow(model, real)
              decision.numCtx = Math.min(decision.numCtx, usableWindow(real))
              resetStep()
              messages.splice(1, messages.length - 1, ...fitToContext(messages.slice(1), decision.numCtx, reserved()))
              log.warn('agent', `${tag}: too long for ${model}${over.limit ? ` (it takes ${over.limit} tokens)` : ''}; sending the newest messages only`)
              msg.parts.push({
                type: 'notice',
                text: `${models.find((x) => x.name === model)?.providerName ?? 'The service'} said this conversation is longer than the model takes${over.limit ? ` (${kTokens(over.limit)} tokens)` : ''}, so the oldest messages were left out of this request. “Summarise now” in the context ring keeps their gist.`,
                tone: 'warn'
              })
              this.emitPart(msg, msg.parts.length - 1)
              continue
            }
            // Only a model on this computer can be started again, shrunk or moved to the processor.
            if (ctrl.signal.aborted || crashes >= 3 || !local || !isRunnerCrash(errMsg(e))) throw e
            crashes++
            resetStep()
            let note = 'The model stopped unexpectedly, so Maris started this step again.'
            if (crashes >= 2) {
              const smaller = crashes === 2 && !options.num_gpu ? this.smallerModel(model, cfg, models) : undefined
              if (smaller) {
                model = smaller
                msg.model = smaller
                note = `The model stopped again, most likely because the graphics card ran out of memory. Maris goes on with the smaller ${prettyModel(smaller)}.`
              } else {
                options.num_gpu = 0
                note =
                  'The model stopped again, most likely because the graphics card ran out of memory. Maris goes on using the processor and system memory instead (slower, but it cannot run out of video memory).'
              }
            }
            log.warn('agent', `${tag}: the model process stopped part-way (${crashes}): ${note}`)
            msg.parts.push({ type: 'notice', text: note, tone: 'info' })
            this.emitPart(msg, msg.parts.length - 1)
            await new Promise((r) => setTimeout(r, 2000))
          } finally {
            clearInterval(watch)
            this.flushDeltas()
            if (msg.activity) this.setActivity(msg, undefined)
          }
        }
        closeThinking()
        log.info('agent', `${tag}: done, ${stepText.length} chars, tools: ${calls.map((c) => c.function.name).join(', ') || 'none'}`)
        // How the answer ended, when not in the ordinary way: cut at the length limit, or declined by the service.
        if (endNote) {
          msg.parts.push({ type: 'notice', text: endNote, tone: 'warn' })
          this.emitPart(msg, msg.parts.length - 1)
        }
        // Calls get an id here when the engine gave none, so each result can name the call it answers.
        calls.forEach((c, i) => (c.id ??= `call_${step}_${i}`))
        messages.push({
          role: 'assistant',
          content: stepText,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } })) } : {}),
          ...(raw !== undefined && calls.length ? { raw } : {})
        })
        if (!calls.length) break
        let endTurn = false
        let stepFailed = calls.length > 0
        let stuck = false
        const offered = new Set(allTools.map((t) => t.name))
        for (const call of calls) {
          if (ctrl.signal.aborted) break
          const r = await this.execTool(msg, conv, call, ctrl, canSee, offered, small)
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
          messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, is_error: r.failed || undefined, content })
          for (const img of r.images) messages.push({ role: 'user', content: img.caption, images: [img.b64] })
          if (r.endTurn) endTurn = true
        }
        repo.saveMessage(msg)
        // A service was asked for (or, on a slow computer, a tool outside the short list was used): the
        // tools on offer change from the next step.
        if (calls.some((c) => c.function.name === 'use_connector') || (small && calls.some((c) => !tools.some((t) => t.name === c.function.name)))) pickTools()
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
            msg.parts.push({ type: 'notice', text: `${prettyName(model)} kept running into errors, so ${stronger.label ?? prettyName(stronger.name)} takes over this task${stronger.remote ? ` (it runs at ${stronger.providerName}, so the rest of this task is sent there)` : ''}.`, tone: 'info' })
            this.emitPart(msg, msg.parts.length - 1)
            model = stronger.name
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
      this.flushDeltas()
      this.runs.delete(conv.id)
      this.live.delete(conv.id)
      // The chat was deleted while answering: nothing left to save it in.
      if (!repo.getConversation(conv.id)) return
      msg.stats = {
        promptTokens: stats.prompt || undefined,
        outputTokens: stats.out || undefined,
        tokensPerSec: stats.evalNs ? Math.round((stats.out / (stats.evalNs / 1e9)) * 10) / 10 : undefined,
        durationMs: Date.now() - started,
        loadMs: stats.loadNs ? Math.round(stats.loadNs / 1e6) : undefined,
        cacheReadTokens: stats.cacheRead || undefined,
        cacheWriteTokens: stats.cacheWrite || undefined,
        costUsd: stats.priced ? stats.cost : undefined,
        costPartial: stats.billed && stats.unpriced ? true : undefined
      }
      // The monthly guide for API costs (Settings → Engine): said once when 80% is passed, once at 100%.
      if (stats.billed) {
        const note = usage.budgetNote()
        if (note) {
          msg.parts.push({ type: 'notice', text: note, tone: 'warn' })
          this.emitPart(msg, msg.parts.length - 1)
        }
      }
      repo.saveMessage(msg)
      this.emitStatus(msg)
      const fresh = repo.getConversation(conv.id)
      if (fresh) {
        fresh.updatedAt = Date.now()
        // A first answer that was stopped or failed still names the chat (from the request's first
        // words), so it can be found again instead of staying "New chat".
        if (msg.status !== 'done' && fresh.title === 'New chat' && userText.trim()) fresh.title = firstWords(userText)
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
    this.mediaRuns.add(conv.id)
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
      this.mediaRuns.delete(conv.id)
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
    const mode: ChatMode = code ? 'code' : 'chat'
    const history = conv
      ? repo.listMessages(conv.id).filter((m) => m.status !== 'streaming' && (!conv.summaryUntil || m.createdAt > conv.summaryUntil))
      : []
    const lastRoute = [...history].reverse().find((m) => m.role === 'assistant' && m.route && m.route.numCtx > 0)?.route
    const models = await listModels().catch(() => [] as ModelInfo[])
    const chosen = conv?.model && conv.model !== 'auto' ? conv.model : draft?.model && draft.model !== 'auto' ? draft.model : undefined
    // An empty role ("Code: same as Max") is an empty string, so || rather than ??.
    const model =
      chosen ||
      lastRoute?.model ||
      (code ? cfg.tiers.code || cfg.tiers.max : cfg.tiers.balanced) ||
      cfg.tiers.fast ||
      models.find((m) => m.capabilities.includes('completion') && !m.capabilities.includes('embedding'))?.name ||
      ''
    const info = models.find((m) => m.name === model)
    const api = llm.isRemote(model)
    // The same short instructions and tool list the agent uses on a slow computer.
    const small = isLite(cfg) && !api
    // The size the next answer uses: the setting for this model's role (the popover changes it), widened
    // like the agent does when the instructions and tools leave too little room.
    const roleTier = (['max', 'balanced', 'fast', 'tiny'] as const).find((t) => cfg.tiers[t] === model) ?? 'balanced'
    let window = api ? apiContext(info, cfg) : Math.min(localContext(cfg, roleTier, code, cfg.engine.processing === 'cpu'), info?.contextLength || Infinity)
    const decision: RouteDecision =
      lastRoute && lastRoute.model === model
        ? lastRoute
        : { model, tier: 'custom', think: false, numCtx: window, cpuOnly: false, reason: '', auto: true, category: code ? 'code' : 'chat', complexity: 0.5, provider: info?.providerName ?? info?.provider, remote: info?.provider ? info.remote !== false : undefined }
    const context = chatToolContext(history)
    const users = history.filter((m) => m.role === 'user')
    const allTools = activeTools(cfg, { webAccess: cfg.web.enabled, mode, context })
    const tools = small
      ? selectTools(allTools, { mode, kinds: users.map((m) => analyze(messageText(m), m.attachments ?? []).category), texts: users.map(messageText), used: context.used })
      : allTools
    const own = tools.filter((t) => !t.name.startsWith('mcp_'))
    const services = tools.filter((t) => t.name.startsWith('mcp_'))
    const toolTokens = (list: typeof tools): number => (list.length ? estimateTokens(JSON.stringify(toLlmTools(list, small))) : 0)
    const lang = conversationLanguage(users.map(messageText))
    const skillBlock = tools.some((t) => t.name === 'use_skill') ? skills.promptBlock() : ''
    const project = code ? await projectContext(projectDir!) : undefined
    const names = tools.map((t) => t.name)
    const sys = code ? codeSystemPrompt(cfg, decision, names, project!, Boolean(conv?.autoEdits), { compact: small, lang }) : systemPrompt(cfg, decision, names, { compact: small, lang })
    // What Maris tells the model along with your messages: the time, memories that fit, the project's state.
    const notesT = users.reduce((s, m) => s + (m.context ? estimateTokens(m.context) : 0), 0)
    const skillsT = estimateTokens(skillBlock)
    const projectT = project ? estimateTokens([project.about ?? '', project.instructions ?? '', project.stack.join(', '), project.path].join('\n')) : 0
    const customT = estimateTokens(cfg.persona.customInstructions?.trim() ?? '')
    const summaryT = conv?.summary ? estimateTokens(conv.summary) + 12 : 0
    const instructionsT = Math.max(0, estimateTokens(sys) - skillsT - projectT - customT)
    let messagesT = -notesT
    let resultsT = 0
    let picturesT = 0
    for (const m of buildHistory(history, small)) {
      picturesT += (m.images?.length ?? 0) * 900
      if (m.role === 'tool') resultsT += estimateTokens(m.content)
      else messagesT += estimateTokens(m.content) + (m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0)
    }
    messagesT = Math.max(0, messagesT)
    const parts = [
      { key: 'instructions', label: 'Maris\'s instructions', hint: 'How Maris works: your name, folders, its style and safety rules.', tokens: instructionsT },
      { key: 'tools', label: 'Tools', hint: `Descriptions of the ${own.length} things Maris can do (read files, run commands, search the web…).`, tokens: toolTokens(own) },
      { key: 'services', label: 'Connected services', hint: `Tools of the services you connected (${services.length}).`, tokens: toolTokens(services) },
      { key: 'skills', label: 'Skills', hint: 'The list of your skills, so Maris knows when to use one.', tokens: skillsT },
      { key: 'memory', label: 'Time and memory notes', hint: 'What Maris tells the model with each of your messages: the time, what it remembers about you that fits, and how the project stands.', tokens: notesT },
      { key: 'project', label: 'Project', hint: 'The project folder, what it is about and its own instructions.', tokens: projectT },
      { key: 'custom', label: 'Your instructions', hint: 'Your own instructions from Settings.', tokens: customT },
      { key: 'summary', label: 'Summary of earlier messages', hint: 'Older messages folded into a short summary.', tokens: summaryT },
      { key: 'messages', label: 'Messages', hint: 'Your messages and the answers, including attached files.', tokens: messagesT },
      { key: 'results', label: 'Tool results', hint: 'What tools returned: file contents, command output, web pages.', tokens: resultsT },
      { key: 'pictures', label: 'Pictures', hint: 'Pictures in the chat that the model looks at.', tokens: picturesT }
    ].filter((p) => p.tokens > 0)
    const used = parts.reduce((s, p) => s + p.tokens, 0)
    const chat = messagesT + resultsT + picturesT + notesT
    const fixed = used - chat
    if (!api) {
      const [room, cap, stepSize] = small ? [1800, 8192, 2048] : [8000, 32768, 4096]
      if (window - fixed < room) window = Math.max(window, Math.min(cap, info?.contextLength || Infinity, Math.ceil((fixed + room * 1.25) / stepSize) * stepSize))
    }
    const reserved = answerRoom(window)
    const budget = window - fixed - reserved
    const untilCompact = cfg.agent.autoCompact ? Math.max(0, Math.round(budget * cfg.agent.compactAt - chat)) : undefined
    return { model, window, parts, used, reserved, untilCompact, summarised: Boolean(conv?.summary), messages: history.length, sizes: await this.contextSizes(cfg, model, code, info) }
  }

  /**
   * The window sizes the context popover offers for this chat's model, with what each would cost here:
   * whether model and window fit in video memory, or how much would run from system memory (slower).
   * For a model at an API service the size is a budget: how much of the chat is sent with each message.
   */
  private async contextSizes(cfg: Settings, model: string, code: boolean, info?: ModelInfo): Promise<ContextSizes> {
    const max = info?.contextLength
    if (llm.isRemote(model)) {
      // One budget for every API model; a model that takes less simply stops at its own limit.
      const current = max ? Math.min(cfg.routing.apiContext, max) : cfg.routing.apiContext
      return { path: 'routing.apiContext', role: 'models at an API service', current, max, options: sizesFor(API_CONTEXT_SIZES, current, max).map((tokens) => ({ tokens, fit: 'api' as const })) }
    }
    const tier = (['max', 'balanced', 'fast', 'tiny'] as const).find((t) => cfg.tiers[t] === model)
    const path = code ? 'routing.codeContext' : `routing.contextByTier.${tier ?? 'balanced'}`
    const current = code ? cfg.routing.codeContext : cfg.routing.contextByTier[tier ?? 'balanced']
    const role = code ? 'Code mode' : `the ${{ max: 'Max', balanced: 'Balanced', fast: 'Fast', tiny: 'Helper' }[tier ?? 'balanced']} model`
    const sizes = sizesFor(RING_CONTEXT_SIZES, current, max)
    // Right after Maris starts the monitor has not read the graphics card yet: wait a moment for it.
    let sys = monitor.snapshot()
    for (let i = 0; i < 16 && !sys.gpu && cfg.engine.processing !== 'cpu'; i++) {
      await sleep(250)
      sys = monitor.snapshot()
    }
    const gpuTotal = sys.gpu?.memTotalMB ?? 0
    const onCpu = cfg.engine.processing === 'cpu' || gpuTotal <= 0
    const available = gpuTotal - sys.external.vramMB - cfg.engine.gpuReserveMB
    const weights = (info?.sizeBytes ?? 0) / 2 ** 20
    const big = code || tier === 'max'
    const options: ContextSizeOption[] = sizes.map((tokens) => {
      const need = vramNeedMB(weights, big, tokens)
      // Model and window together have to fit in this computer's memory at all (a 1M window alone is tens of GB).
      const room = onCpu ? sys.ramTotalMB * 0.85 : Math.max(0, available) + sys.ramTotalMB * 0.8
      if (sys.ramTotalMB > 0 && need > room) return { tokens, fit: 'none', needMB: Math.round(need) }
      if (onCpu) return { tokens, fit: 'cpu' }
      if (need <= available) return { tokens, fit: 'gpu' }
      const spillMB = Math.round(need - Math.max(0, available))
      // Measured: 12% of a 27B model in system memory wrote 2.4× slower (38 → 16 tokens/s).
      return { tokens, fit: 'spill', spillMB, slower: Math.min(8, Math.round((1 + 11.5 * (spillMB / need)) * 10) / 10) }
    })
    return { path, role, current, max, options }
  }

  private async execTool(
    msg: ChatMessage,
    conv: Conversation,
    call: LlmToolCall,
    ctrl: AbortController,
    canSee: boolean,
    /** The tools this chat may use; others do not run (web tools while web access is off, say). */
    offered?: Set<string>,
    /** A small context window: the model is shown a short cut of long results. */
    small = false
  ): Promise<{ content: string; images: { b64: string; caption: string }[]; endTurn: boolean; failed?: boolean }> {
    // The model wrote an action whose arguments are not valid JSON (cut off, or badly quoted). It is
    // never run on a guess at what was meant: the model gets its own text back and writes it again.
    if (call.invalid !== undefined) {
      const rec: ToolCallRecord = { id: uid(), name: call.function.name, args: {}, risk: 'read', status: 'error', startedAt: Date.now(), endedAt: Date.now() }
      rec.title = 'An action that could not be read'
      rec.error = 'The model wrote this action in a form that could not be read, so it was not run. It was asked to write it again.'
      msg.parts.push({ type: 'tool', call: rec })
      this.emitPart(msg, msg.parts.length - 1)
      return {
        content: `${JSON.stringify({ INVALID_JSON: truncate(call.invalid, 1500) })}\nYour tool call was not valid JSON, so it was not run. Write it again as one JSON object: double quotes around every name and string, \\n for a line break inside a string, no text around it.`,
        images: [],
        endTurn: false,
        failed: true
      }
    }
    // Small models make up tool names ("system_information", "system_tool_system_info") or call a shell
    // by name ("sh", "powershell"): those become the real tool, among the ones this chat was offered.
    const asked = call.function.name
    const known = offered ? [...offered] : allToolNames()
    const real = known.includes(asked) ? asked : resolveToolName(asked, known)
    const shell = !real && known.includes('run_command') ? shellAlias(asked, parseArgs(call.function.arguments)) : undefined
    const name = real ?? shell?.name ?? asked
    const def = !offered || offered.has(name) ? findTool(name) : undefined
    const args = shell?.args ?? parseArgs(call.function.arguments)
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
      return {
        content: `Error: there is no tool named "${name}". To run a ${SHELL_LABEL} command use run_command; to find files use search_files; to read a file use read_file. Call one of the listed tools yourself instead of asking the user to run anything.`,
        images,
        endTurn,
        failed: true
      }
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
      },
      endTurn: () => {
        endTurn = true
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
              alwaysAsk: ALWAYS_ASK.has(name) || undefined,
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
            return { content: DENIED, images, endTurn }
          }
          if (answer.rule && !ALWAYS_ASK.has(name)) rec.autoApproved = this.applyRule(answer.rule, { conversationId: conv.id, tool: name, risk: prep.risk, projectDir: live.projectDir, allowPrefix: prep.allowPrefix })
        }
      }
      rec.status = 'running'
      update()
      log.info('agent', `tool ${name} running${rec.autoApproved ? ' (auto-approved)' : ''}`)
      const out = await def.run(args, ctx)
      log.info('agent', `tool ${name} done (${out.length} chars)`)
      rec.status = 'done'
      rec.result = truncate(out, RESULT_KEPT)
      rec.progress = undefined
      rec.endedAt = Date.now()
      update()
      // Commands report failure through their exit code rather than by throwing. Only the status line
      // counts (the first lines of the output), not a file that happens to contain "(exit 1".
      const head = out.split('\n', 3).join('\n')
      const exit = /^\((?:exit code|exit) (-?\d+|\?)/m.exec(head)
      const failed = Boolean(exit && exit[1] !== '0') || /^\((?:timed out after|exit [^)\n]*timed out)/m.test(head)
      // A small window is shown the same short cut that the chat keeps, word for word (see buildHistory).
      return { content: small ? truncate(rec.result, RESULT_SMALL) : truncate(out, 16000), images, endTurn, failed }
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
      if (!m || m.name === current || !m.capabilities.includes('completion')) continue
      // A model the person put in a higher role at an API service counts as stronger; one on this
      // computer has to be bigger than the one that is failing.
      if (m.provider ? !llm.isRemote(current) : m.sizeBytes > sizeNow) return m
    }
    return undefined
  }

  private async makeTitle(conv: Conversation, userText: string, answer: string): Promise<void> {
    let title = firstWords(userText)
    // On a slow computer a title is not worth a model call that the next message would wait behind:
    // the first words of the request name the chat.
    const cfg = settings.get()
    const helperAway = llm.isRemote(cfg.tiers.tiny)
    try {
      if (isLite(cfg) && !helperAway) throw new Error('titles from the first words in low-power mode')
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

/** A chat title made from the first words of the request. */
function firstWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ').slice(0, 60) || 'New chat'
}

export const agent = new Agent()
