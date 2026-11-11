import type {
  Attachment,
  ChatMode,
  ModelInfo,
  RouteDecision,
  Settings,
  SystemStatus,
  TaskCategory,
  ThinkMode,
  Tier
} from '@shared/types'
import { usableWindow } from '@shared/context'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { isRemoteModel } from '@shared/providers'
import { looseJson } from '@shared/textTools'
import { repo } from './db'
import { llm } from './engines/llm'
import { localOptions } from './memory/utility'
import { clamp, log } from './util'

export const USER_TIERS: Tier[] = ['fast', 'balanced', 'max']
const TIER_LABEL: Record<Tier, string> = { tiny: 'Tiny', fast: 'Fast', balanced: 'Balanced', max: 'Max' }

export interface Analysis {
  category: TaskCategory
  complexity: number
  needsVision: boolean
  signals: string[]
  confident: boolean
}

// Keyword groups (English + Russian stems; the user may write in either).
const RX = {
  quick: /^(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|nice|great|good (morning|night|evening)|привет|спасибо|ок|хорошо)[\s!.?]*$/i,
  codeBlock: /```|^\s{4,}\S|\b(def|class|function|const|let|var|import|export|return|public|private|#include|SELECT\s.+\sFROM)\b/m,
  code: /\b(code|coding|bug|debug|error|exception|stack ?trace|traceback|compile|refactor|regex|script|python|typescript|javascript|node|react|c#|c\+\+|rust|golang|java|sql|api|endpoint|function|unit test|segfault|null ?pointer|git|docker|json|yaml)\b|код|ошибк|скрипт|функци/i,
  reasoning: /\b(prove|proof|derive|calculate|compute|solve|math|equation|integral|probability|statistic|logic|puzzle|riddle|step[- ]by[- ]step|analy[sz]e|analysis|compare|trade-?offs?|evaluate|pros and cons|plan|strategy|architecture|design|optimi[sz]e|why (does|is|do|would)|explain why|root cause)\b|докаж|реши|почему|сравни|проанализ|объясни/i,
  writing: /\b(write|rewrite|essay|article|story|poem|lyrics|email|letter|cover letter|blog|post|tweet|summari[sz]e|summary|translate|draft|proofread|paraphrase|outline)\b|напиши|переведи|перескажи|письмо|статью/i,
  agent: /\b(files?|folders?|director(y|ies)|disk|drive|[a-z]:\\|path|install|uninstall|process(es)?|task manager|my (pc|computer|laptop|desktop|downloads|documents)|rename|move|delete|remove|copy|organi[sz]e|clean ?up|run|execute|command|powershell|cmd|terminal|registry|startup|service|screenshot|clipboard|open)\b|файл|папк|диск|компьютер|удали|переимен|запусти|установи/i,
  web: /\b(search|google|look ?up|latest|news|today|tonight|this week|current(ly)?|recent|price|weather|stock|score|website|browse|internet|online|web)\b|https?:\/\/|www\.|найди|поиск|интернет|новост|сегодня|погод/i,
  media:
    /\b(generate|draw|paint|create|make|render|design|imagine|show me)\b.{0,40}\b(image|picture|photo|illustration|logo|wallpaper|art|artwork|portrait|poster|icon|sticker|video|animation|clip|gif|movie)\b|нарису|сгенерир|картин|изображен|видео/i,
  quality: /\b(in detail|detailed|thorough(ly)?|deep ?dive|carefully|comprehensive|rigorous|best possible|high[- ]quality|production[- ]ready|complete solution|exhaustive)\b|подробно|детально/i,
  speed: /\b(quick(ly)?|brief(ly)?|short answer|tl;?dr|fast|one (line|sentence|word)|just tell me|in short)\b|кратко|быстро/i
}

export function analyze(text: string, attachments: Attachment[] = [], historyTokens = 0): Analysis {
  const t = text.trim()
  const words = t.split(/\s+/).filter(Boolean).length
  const signals: string[] = []
  const needsVision = attachments.some((a) => a.kind === 'image')
  const has = (k: keyof typeof RX): boolean => RX[k].test(t)

  if (!needsVision && words <= 6 && RX.quick.test(t)) {
    return { category: 'quick', complexity: 0.05, needsVision, signals: ['greeting'], confident: true }
  }

  let c = 0.15 + Math.min(0.3, (words / 400) * 0.3)
  const isCode = has('codeBlock') || has('code')
  const isReason = has('reasoning')
  const isWriting = has('writing')
  const isAgent = has('agent')
  const isWeb = has('web')
  const isMedia = has('media')

  if (has('codeBlock')) {
    c += 0.35
    signals.push('code block')
  } else if (isCode) {
    c += 0.25
    signals.push('code')
  }
  if (isReason) {
    c += 0.25
    signals.push('reasoning')
  }
  if (isAgent) {
    c += 0.15
    signals.push('PC task')
  }
  if (isWriting) {
    c += words > 30 ? 0.15 : 0.08
    signals.push('writing')
  }
  if (/(^|\n)\s*(\d+[.)]|[-*•])\s+\S/.test(t) || /\b(and then|after that|finally|also)\b/i.test(t)) {
    c += 0.08
    signals.push('multi-step')
  }
  if (has('quality')) {
    c += 0.2
    signals.push('quality requested')
  }
  if (has('speed')) {
    c -= 0.2
    signals.push('speed requested')
  }
  if (historyTokens > 6000) {
    c += 0.1
    signals.push('long context')
  }
  if (needsVision) signals.push('image attached')

  const category: TaskCategory = isMedia
    ? 'media'
    : isAgent
      ? 'agent'
      : isCode
        ? 'code'
        : isReason
          ? 'reasoning'
          : isWeb
            ? 'web'
            : isWriting
              ? 'writing'
              : needsVision
                ? 'vision'
                : words < 6
                  ? 'quick'
                  : 'chat'
  if (category === 'web') signals.push('web')
  if (category === 'media') signals.push('media')

  const confident = signals.length > 0 || words < 8
  return { category, complexity: clamp(c, 0, 1), needsVision, signals, confident }
}

/** Ask the tiny utility model to grade an ambiguous prompt. Returns 0..1 or undefined on timeout. */
async function classifyWithTiny(text: string, tiny: string, timeoutMs = 2500): Promise<number | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await llm.chatOnce(
      {
        model: tiny,
        think: false,
        format: {
          type: 'object',
          properties: { difficulty: { type: 'integer', minimum: 1, maximum: 5 } },
          required: ['difficulty']
        },
        // Same num_ctx/num_gpu as the background helper calls so Ollama never reloads the tiny model.
        options: { ...localOptions(tiny), temperature: 0, num_predict: 20 },
        keep_alive: '60m',
        messages: [
          {
            role: 'system',
            content:
              'Rate how hard it is for an AI assistant to answer the user message well. 1 = small talk or a trivial fact, 2 = simple question, 3 = moderate explanation or short writing, 4 = complex analysis, coding or long writing, 5 = expert-level reasoning, large code or multi-step work. Reply with JSON only.'
          },
          { role: 'user', content: text.slice(0, 1500) }
        ]
      },
      ctrl.signal
    )
    const d = Number((looseJson(r.content) as { difficulty?: number } | undefined)?.difficulty)
    return Number.isFinite(d) ? clamp((d - 1) / 4, 0, 1) : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Learned bias per category from user feedback (positive → prefer larger models). */
export function learnedBias(category: TaskCategory): number {
  const dir: Record<string, number> = { fast: -1, balanced: 0, max: 1, tiny: -1 }
  let b = 0
  for (const s of repo.routeStats()) {
    if (s.category === category) b += s.score * (dir[s.tier] ?? 0) * 0.04
  }
  return clamp(b, -0.2, 0.2)
}

/** Fill tier slots from installed models without overriding valid user choices. */
export function assignTiers(all: ModelInfo[], tiers: Settings['tiers'], vramTotalMB: number): Settings['tiers'] {
  const names = new Set(all.map((m) => m.name))
  const out = { ...tiers }
  // Roles are only ever filled in by themselves with models on this computer. A model of an API
  // service plays a role when the person puts it there (what is sent to it leaves the computer).
  const models = all.filter((m) => !m.provider)
  const chatModels = models
    .filter((m) => !m.capabilities.includes('embedding') && m.capabilities.includes('completion'))
    .sort((a, b) => a.sizeBytes - b.sizeBytes)
  const GB = 1024 ** 3
  const valid = (n?: string): boolean => Boolean(n && names.has(n))
  if (!valid(out.embed)) out.embed = models.find((m) => m.capabilities.includes('embedding'))?.name
  if (!valid(out.tiny)) out.tiny = chatModels.find((m) => m.sizeBytes < 2 * GB)?.name ?? chatModels[0]?.name
  if (!valid(out.fast)) {
    out.fast =
      chatModels.find((m) => m.sizeBytes >= 2 * GB && m.sizeBytes < 5 * GB)?.name ??
      chatModels.find((m) => m.name !== out.tiny)?.name ??
      out.tiny
  }
  const fitLimit = vramTotalMB > 0 ? vramTotalMB * 2 ** 20 * 0.95 : 24 * GB
  if (!valid(out.max)) {
    const fitting = chatModels.filter((m) => m.sizeBytes <= fitLimit)
    out.max = fitting[fitting.length - 1]?.name ?? chatModels[chatModels.length - 1]?.name
  }
  if (!valid(out.balanced)) {
    const fastSize = models.find((m) => m.name === out.fast)?.sizeBytes ?? 0
    const maxSize = models.find((m) => m.name === out.max)?.sizeBytes ?? Infinity
    out.balanced =
      chatModels.find((m) => m.sizeBytes > fastSize && m.sizeBytes < maxSize)?.name ?? out.max ?? out.fast
  }
  return out
}

export interface RouteInput {
  text: string
  attachments: Attachment[]
  historyTokens: number
  think: ThinkMode
  explicitModel?: string
  mode?: ChatMode
  /** "continue", "go on": the kind of task the answer before was, so it carries on the same way. */
  previous?: { category: TaskCategory; complexity: number }
  /** Low-power mode: no extra model call to grade the request. */
  lite?: boolean
}

/** What a service said a model really takes, learned when a request was too long for it (kept while Maris runs). */
const learnedWindow = new Map<string, number>()

export function noteApiWindow(model: string, tokens: number): void {
  if (tokens >= 2048) learnedWindow.set(model, Math.min(tokens, learnedWindow.get(model) ?? Infinity))
}

/**
 * The window for a model at an API service: the budget set in Settings (up to millions of tokens),
 * and never more than the model takes, with a margin because Maris's token counts are estimates.
 */
export function apiContext(info: ModelInfo | undefined, cfg: Settings): number {
  const budget = Math.max(8192, cfg.routing.apiContext || 65536)
  const takes = Math.min(info?.contextLength || Infinity, (info && learnedWindow.get(info.name)) || Infinity)
  return Number.isFinite(takes) ? Math.min(budget, usableWindow(takes)) : budget
}

/**
 * The window for a model on this computer: the size set for its role. On the processor it is at most
 * 16K (reading a long prompt is slow there), unless the person chose the size themselves.
 */
export function localContext(cfg: Settings, tier: Tier | 'custom', code: boolean, cpuOnly: boolean): number {
  const key = tier === 'custom' ? 'balanced' : tier
  const set = code ? cfg.routing.codeContext : cfg.routing.contextByTier[key]
  const untouched = set === (code ? DEFAULT_SETTINGS.routing.codeContext : DEFAULT_SETTINGS.routing.contextByTier[key])
  return cpuOnly && untouched ? Math.min(set, 16384) : set
}

/**
 * Video memory a model needs, in MB: its weights (with the vision projector), the context window's
 * cache (about 0.5 GB per 16K tokens for the big models, 0.3 GB for the others) and buffers. Calibrated on
 * a 16 GB card; the context popover uses the same estimate to say what a bigger window costs.
 */
export function vramNeedMB(weightsMB: number, big: boolean, ctx: number): number {
  return weightsMB + (ctx / 16384) * (big ? 520 : 320) + 350
}

export function prettyModel(name: string): string {
  return name.replace(/^hf\.co\/[^/]+\//, '').replace(/-GGUF/i, '')
}

export async function route(
  input: RouteInput,
  cfg: Settings,
  sys: SystemStatus,
  models: ModelInfo[]
): Promise<RouteDecision> {
  const a = analyze(input.text, input.attachments, input.historyTokens)
  if (input.previous) {
    a.category = input.previous.category
    a.complexity = Math.max(a.complexity, input.previous.complexity)
    a.confident = true
    a.signals.push('continues the task')
  }
  const byName = new Map(models.map((m) => [m.name, m]))
  const tierOf = (name: string): Tier | 'custom' =>
    (Object.entries(cfg.tiers).find(([k, v]) => v === name && k !== 'embed')?.[0] as Tier) ?? 'custom'
  const supportsThink = (name: string): boolean => byName.get(name)?.capabilities.includes('thinking') ?? false

  const decideThink = (name: string, complexity: number, cpuOnly: boolean): boolean => {
    if (!supportsThink(name)) return false
    if (input.think === 'on') return true
    if (input.think === 'off') return false
    if (cpuOnly || a.category === 'quick' || a.category === 'chat') return false
    if (a.category === 'reasoning') return complexity >= 0.4
    if (a.category === 'code' || a.category === 'agent') return complexity >= 0.55
    return complexity >= 0.7
  }

  const code = input.mode === 'code'
  // In Code mode almost everything is real engineering work: lean towards the strongest model.
  if (code && a.category !== 'quick' && a.category !== 'media') {
    a.category = 'code'
    a.complexity = Math.max(a.complexity, 0.62)
    a.confident = true
  }
  const ctxFor = (t: Tier | 'custom'): number => (code ? cfg.routing.codeContext : cfg.routing.contextByTier[t === 'custom' ? 'balanced' : t])

  const cpuMode = cfg.engine.processing === 'cpu'
  /** Where a model of an API service runs, for the decision and its explanation. */
  const away = (name: string): { provider?: string; remote?: boolean; where: string } => {
    const info = byName.get(name)
    if (!info?.provider) return { where: '' }
    return {
      provider: info.providerName ?? info.provider,
      remote: info.remote !== false,
      where: info.remote === false ? ` It runs in ${info.providerName ?? 'a server'} on your own computer or network.` : ` It runs at ${info.providerName ?? 'an API service'}, so this chat is sent there.`
    }
  }

  // Explicit model chosen by the user: respect it, only decide think/context.
  if (input.explicitModel && input.explicitModel !== 'auto') {
    const name = input.explicitModel
    const tier = tierOf(name)
    const api = isRemoteModel(name)
    const at = away(name)
    return {
      model: name,
      tier,
      think: decideThink(name, a.complexity, cpuMode && !api),
      // A window is never wider than the model takes (Settings offers sizes up to 2M for every role).
      numCtx: api ? apiContext(byName.get(name), cfg) : Math.min(localContext(cfg, tier, code, cpuMode), byName.get(name)?.contextLength || Infinity),
      cpuOnly: cpuMode && !api,
      reason: `You chose ${byName.get(name)?.label ?? prettyModel(name)} for this chat.${api ? at.where : cpuMode ? ' It runs on the CPU (Settings → Engine).' : ''}`,
      auto: false,
      category: a.category,
      complexity: a.complexity,
      provider: at.provider,
      remote: at.remote
    }
  }

  let complexity = a.complexity
  const reasons: string[] = []
  // Grading an unclear request with the helper model costs a model call: worth it on a quick computer,
  // not on a slow one, and not when the helper sits at an API service.
  if (!a.confident && cfg.routing.smartClassifier && !input.lite && cfg.tiers.tiny && byName.has(cfg.tiers.tiny) && !isRemoteModel(cfg.tiers.tiny)) {
    const graded = await classifyWithTiny(input.text, cfg.tiers.tiny)
    if (graded !== undefined) {
      complexity = clamp(0.4 * complexity + 0.6 * graded, 0, 1)
      reasons.push('the tiny model helped grade the request')
    }
  }
  const bias = cfg.routing.learnFromFeedback ? learnedBias(a.category) : 0
  if (Math.abs(bias) >= 0.04) reasons.push(bias > 0 ? 'you have preferred bigger models for this kind of task' : 'you have preferred faster models for this kind of task')
  const c = clamp(complexity + bias, 0, 1)

  const shift = (cfg.routing.preferSpeed - 0.5) * 0.3
  const tFast = 0.3 + shift
  const tBalanced = 0.58 + shift
  let wanted: Tier = c < tFast ? 'fast' : c < tBalanced ? 'balanced' : 'max'
  // Doing things on the PC means choosing tools and writing commands, which the smallest model gets wrong
  // (it called a "sh" tool on Windows and then argued it could not run PowerShell).
  const pcTask = a.category === 'agent'
  if (pcTask && wanted === 'fast') {
    wanted = 'balanced'
    reasons.push('tasks on the PC need a model that uses tools reliably')
  }

  // A dedicated coding model (Models → Roles → Code) takes the Max slot in Code mode.
  const slotOf = (t: Tier): string | undefined => (code && t === 'max' && cfg.tiers.code && byName.has(cfg.tiers.code) ? cfg.tiers.code : cfg.tiers[t])

  // ---- system constraints: about this computer, so they do not hold back a model that runs elsewhere
  const wantedAway = isRemoteModel(slotOf(wanted))
  let cpuOnly = cpuMode
  const comfyBusy = sys.comfy.busy || sys.activeJobs.media > 0
  if (!wantedAway) {
    if (cpuMode) reasons.push('models run on the CPU (Settings → Engine)')
    if (comfyBusy && !cpuMode) {
      wanted = 'fast'
      cpuOnly = cfg.routing.allowCpuFallback
      reasons.push('the GPU is busy generating media')
    } else if (sys.busy === 'heavy') {
      // Code work and PC tasks need a capable model more than a quick one: one step down, not to the smallest.
      const lower: Tier = code || pcTask ? (wanted === 'max' ? 'balanced' : wanted) : 'fast'
      if (wanted !== lower) reasons.push(sys.gpu && !cpuMode ? 'another app is using the GPU heavily' : 'other programs are keeping the processor busy')
      wanted = lower
    } else if (sys.busy === 'busy' && wanted === 'max') {
      wanted = 'balanced'
      reasons.push('your PC is busy')
    }
    if (sys.onBattery && wanted === 'max' && cfg.routing.stepDownOnBattery) {
      wanted = 'balanced'
      reasons.push('you are on battery')
    }
  }

  // ---- availability + capability fallback
  const order: Tier[] = ['fast', 'balanced', 'max']
  const candidates = (from: Tier): Tier[] => {
    const i = order.indexOf(from)
    // Try the wanted tier, then smaller ones, then larger ones.
    return [...order.slice(0, i + 1).reverse(), ...order.slice(i + 1)]
  }
  const usable = (name?: string): name is string => {
    if (!name || !byName.has(name)) return false
    const caps = byName.get(name)!.capabilities
    if (a.needsVision && !caps.includes('vision')) return false
    return caps.includes('completion')
  }
  let tier: Tier = wanted
  let model: string | undefined
  const slot = (t: Tier): string | undefined => (code && t === 'max' && usable(cfg.tiers.code) ? cfg.tiers.code : cfg.tiers[t])
  for (const t of candidates(wanted)) {
    if (usable(slot(t))) {
      tier = t
      model = slot(t)
      break
    }
  }
  const noRoles = !order.some((t) => cfg.tiers[t] && byName.has(cfg.tiers[t]!))
  if (!model) {
    // No model in a role can take this. A model that runs here comes first (Ollama, then another server
    // on this computer or network). One at an API service answers by itself only when nothing runs here
    // at all: what is sent to it leaves the computer, so otherwise it has to be picked for the chat or
    // given a role.
    const chat = (m: ModelInfo): boolean => m.capabilities.includes('completion') && !m.capabilities.includes('embedding')
    const here = models.filter((m) => !m.remote && chat(m))
    model = here.find((m) => !m.provider && usable(m.name))?.name ?? here.find((m) => usable(m.name))?.name ?? (here.length ? undefined : models.find((m) => usable(m.name))?.name)
    tier = 'fast'
  }
  if (!model) {
    const others = models.filter((m) => m.capabilities.includes('completion') && !m.capabilities.includes('embedding'))
    throw new Error(
      a.needsVision && others.length
        ? others.some((m) => m.remote && m.capabilities.includes('vision'))
          ? 'None of the models on this computer can see pictures. Pick one that can in the model menu above the chat (one of your API models, for example), or remove the picture.'
          : 'None of your models can see pictures. Open Models and install one that does, or remove the picture.'
        : 'No chat model is set up yet. Open Models to download one, or add an API key there (Models → API).'
    )
  }
  if (noRoles) reasons.push('no models are assigned to Fast, Balanced and Max yet (Models → Roles), so the first one available answers')
  else if (tier !== wanted && !comfyBusy) reasons.push(`the ${TIER_LABEL[wanted].toLowerCase()} model is not installed`)
  // While the graphics card makes a picture or video, everything runs on the processor: there a small
  // model answers a quick question or a chat message many times faster than the Fast one.
  if (comfyBusy && cpuOnly && !code && !isRemoteModel(model) && (a.category === 'quick' || a.category === 'chat') && usable(cfg.tiers.tiny) && !isRemoteModel(cfg.tiers.tiny)) {
    model = cfg.tiers.tiny!
    tier = 'tiny'
    reasons.push('a small model answers quickly on the processor')
  }
  // A model at an API service is not limited by this computer's processor or graphics card.
  let api = isRemoteModel(model)
  if (api) cpuOnly = false

  // ---- VRAM fit: allow some CPU offload for the big model, otherwise step down.
  let numCtx = ctxFor(tier)
  const gpuTotal = sys.gpu?.memTotalMB ?? 0
  const sizeOf = (name: string): number => (byName.get(name)?.sizeBytes ?? 0) / 2 ** 20
  const needOf = (name: string, t: Tier, ctx: number): number => vramNeedMB(sizeOf(name), t === 'max', ctx)
  // GPU only: step down as soon as a model would spill. GPU + CPU: keep the bigger model and let
  // Ollama run the overflow from RAM, unless most of it would end up there.
  const hybrid = cfg.engine.processing === 'hybrid'
  const stepFactor = hybrid ? 2.5 : 1
  const cpuFactor = hybrid ? 3 : 1.6
  if (gpuTotal > 0 && !cpuOnly && !api) {
    const available = gpuTotal - sys.external.vramMB - cfg.engine.gpuReserveMB
    // The context window is the person's choice (Settings, or the context popover, which says what it
    // costs). Which model fits is judged without its extra room, so a big window does not swap Max for a
    // smaller model; if the window does not fit, Ollama keeps part of it in system memory (slower).
    const fitCtx = Math.min(numCtx, 16384)
    let need = needOf(model, tier, fitCtx)
    while (need > available * stepFactor && tier !== 'fast') {
      const lower: Tier = tier === 'max' ? 'balanced' : 'fast'
      const lowerModel = slot(lower)
      // The next model down must be one on this computer: a full graphics card is no reason to send a chat away.
      if (!usable(lowerModel) || isRemoteModel(lowerModel)) break
      reasons.push(`only ${Math.max(0, Math.round(available / 1024))} GB of VRAM is free`)
      tier = lower
      model = lowerModel
      numCtx = code ? numCtx : ctxFor(lower)
      need = needOf(model, tier, Math.min(numCtx, 16384))
    }
    if (need > available * cpuFactor && cfg.routing.allowCpuFallback) {
      cpuOnly = true
      reasons.push('it runs on the CPU')
    } else if (hybrid && need > available) {
      reasons.push(`about ${Math.round((1 - available / need) * 100)}% of it runs from RAM`)
    }
    const withCtx = needOf(model, tier, numCtx)
    if (!cpuOnly && withCtx > available && need <= available) {
      reasons.push(`the ${numCtx / 1024}K context window does not all fit in video memory, so part of it runs from RAM`)
    }
  }

  // ---- prefer an already-loaded neighbour when the score is borderline (avoids a reload).
  const loaded = new Set(sys.ollama.loaded.map((m) => m.name))
  if (cfg.routing.preferLoaded && !cpuOnly && !api && !loaded.has(model) && !code) {
    const near = Math.min(Math.abs(c - tFast), Math.abs(c - tBalanced)) < 0.07
    if (near) {
      for (const t of order) {
        const n = cfg.tiers[t]
        if (n && loaded.has(n) && usable(n) && Math.abs(order.indexOf(t) - order.indexOf(tier)) === 1 && !(pcTask && t === 'fast')) {
          reasons.push(`the ${TIER_LABEL[t].toLowerCase()} model was already loaded, which avoids a reload`)
          tier = t
          model = n
          numCtx = ctxFor(t)
          break
        }
      }
    }
  }

  api = isRemoteModel(model)
  const at = away(model)
  if (api) {
    numCtx = apiContext(byName.get(model), cfg)
    reasons.push(at.remote ? `it runs at ${at.provider}, so this chat is sent there` : `it runs in ${at.provider} on your own computer or network`)
  } else {
    // A long chat gets a wider window, except on a slow computer, where the window stays as set and
    // older messages are summarised instead (a bigger window means more to read, slowly).
    // (Only ever wider: a window the person set larger than 32K stays as it is.)
    if (!code && !input.lite && input.historyTokens + 3000 > numCtx) numCtx = Math.max(numCtx, Math.min(32768, 2 ** Math.ceil(Math.log2(input.historyTokens + 3000))))
    // Reading a long prompt is slow on a processor: at most 16K there, unless the person chose the size
    // themselves (Maris widens it if the tools need room).
    if (cpuOnly) numCtx = Math.min(numCtx, Math.max(16384, localContext(cfg, tier, code, true)))
  }

  // A window is never wider than the model takes (Settings offers sizes up to 2M for every role).
  if (!api) numCtx = Math.min(numCtx, byName.get(model)?.contextLength || Infinity)

  const think = decideThink(model, c, cpuOnly)
  const categoryLabel: Record<TaskCategory, string> = {
    quick: 'Small talk',
    chat: 'A conversational question',
    writing: 'A writing task',
    code: 'A coding task',
    reasoning: 'A reasoning question',
    agent: 'A task on your PC',
    vision: 'A question about an image',
    web: 'A web lookup',
    media: 'A media request'
  }
  const level = c < 0.3 ? 'simple' : c < 0.6 ? 'moderately complex' : 'complex'
  const head =
    a.category === 'quick'
      ? `Small talk, so the ${TIER_LABEL[tier].toLowerCase()} model answers.`
      : `${categoryLabel[a.category]} that looks ${level}, so the ${TIER_LABEL[tier].toLowerCase()} model answers.`
  const extra = reasons.map((r) => r.charAt(0).toUpperCase() + r.slice(1) + '.')
  const reason = [head, ...extra].join(' ')
  log.info('router', reason, { c: c.toFixed(2), signals: a.signals })
  return {
    model,
    tier,
    think,
    numCtx,
    cpuOnly,
    reason,
    auto: true,
    category: a.category,
    complexity: c,
    provider: at.provider,
    remote: at.remote
  }
}

/** Feedback hooks that teach the router. */
export const routerLearning = {
  regenerated(category: TaskCategory, fromTier: string, toTier: string): void {
    const rank: Record<string, number> = { tiny: 0, fast: 1, balanced: 2, max: 3 }
    if (!(fromTier in rank) || !(toTier in rank) || fromTier === toTier) return
    repo.bumpRouteStat(category, toTier, 1)
    repo.bumpRouteStat(category, fromTier, -1)
  },
  rated(category: TaskCategory, tier: string, value: 1 | -1): void {
    if (value > 0) repo.bumpRouteStat(category, tier, 0.5)
    else if (tier === 'fast') repo.bumpRouteStat(category, 'fast', -1)
    else if (tier === 'balanced') repo.bumpRouteStat(category, 'max', 0.7)
  }
}
