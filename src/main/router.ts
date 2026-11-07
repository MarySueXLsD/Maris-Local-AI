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
import { repo } from './db'
import { ollama } from './engines/ollama'
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
    const r = await ollama.chatOnce(
      {
        model: tiny,
        think: false,
        format: {
          type: 'object',
          properties: { difficulty: { type: 'integer', minimum: 1, maximum: 5 } },
          required: ['difficulty']
        },
        // Same num_ctx/num_gpu as the background helper calls so Ollama never reloads the tiny model.
        options: { num_gpu: 0, num_ctx: 8192, temperature: 0, num_predict: 20 },
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
    const d = Number((JSON.parse(r.content) as { difficulty: number }).difficulty)
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
export function assignTiers(models: ModelInfo[], tiers: Settings['tiers'], vramTotalMB: number): Settings['tiers'] {
  const names = new Set(models.map((m) => m.name))
  const out = { ...tiers }
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

  // Explicit model chosen by the user: respect it, only decide think/context.
  if (input.explicitModel && input.explicitModel !== 'auto') {
    const name = input.explicitModel
    const tier = tierOf(name)
    const numCtx = ctxFor(tier)
    return {
      model: name,
      tier,
      think: decideThink(name, a.complexity, cpuMode),
      numCtx,
      cpuOnly: cpuMode,
      reason: `You chose ${prettyModel(name)} for this chat.${cpuMode ? ' It runs on the CPU (Settings → Engine).' : ''}`,
      auto: false,
      category: a.category,
      complexity: a.complexity
    }
  }

  let complexity = a.complexity
  const reasons: string[] = []
  if (!a.confident && cfg.routing.smartClassifier && cfg.tiers.tiny && byName.has(cfg.tiers.tiny)) {
    const llm = await classifyWithTiny(input.text, cfg.tiers.tiny)
    if (llm !== undefined) {
      complexity = clamp(0.4 * complexity + 0.6 * llm, 0, 1)
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

  // ---- system constraints
  let cpuOnly = cpuMode
  if (cpuMode) reasons.push('models run on the CPU (Settings → Engine)')
  const comfyBusy = sys.comfy.busy || sys.activeJobs.media > 0
  if (comfyBusy && !cpuMode) {
    wanted = 'fast'
    cpuOnly = cfg.routing.allowCpuFallback
    reasons.push('the GPU is busy generating media')
  } else if (sys.busy === 'heavy') {
    // Code work and PC tasks need a capable model more than a quick one: one step down, not to the smallest.
    const lower: Tier = code || pcTask ? (wanted === 'max' ? 'balanced' : wanted) : 'fast'
    if (wanted !== lower) reasons.push('another app is using the GPU heavily')
    wanted = lower
  } else if (sys.busy === 'busy' && wanted === 'max') {
    wanted = 'balanced'
    reasons.push('your PC is busy')
  }
  if (sys.onBattery && wanted === 'max' && cfg.routing.stepDownOnBattery) {
    wanted = 'balanced'
    reasons.push('you are on battery')
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
  // A dedicated coding model (Models → Roles → Code) takes the Max slot in Code mode.
  const slot = (t: Tier): string | undefined => (code && t === 'max' && usable(cfg.tiers.code) ? cfg.tiers.code : cfg.tiers[t])
  for (const t of candidates(wanted)) {
    if (usable(slot(t))) {
      tier = t
      model = slot(t)
      break
    }
  }
  if (!model) {
    model = models.find((m) => usable(m.name))?.name
    tier = 'fast'
  }
  if (!model) throw new Error('No chat model is installed. Open Models and download one (for example qwen3.5:4b).')
  if (tier !== wanted && !comfyBusy) reasons.push(`the ${TIER_LABEL[wanted].toLowerCase()} model is not installed`)
  // While the graphics card makes a picture or video, everything runs on the processor: there a small
  // model answers a quick question or a chat message many times faster than the Fast one.
  if (comfyBusy && cpuOnly && !code && (a.category === 'quick' || a.category === 'chat') && usable(cfg.tiers.tiny)) {
    model = cfg.tiers.tiny
    tier = 'tiny'
    reasons.push('a small model answers quickly on the processor')
  }

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
  if (gpuTotal > 0 && !cpuOnly) {
    const available = gpuTotal - sys.external.vramMB - cfg.engine.gpuReserveMB
    // The context window is the person's choice (Settings, or the context popover, which says what it
    // costs). Which model fits is judged without its extra room, so a big window does not swap Max for a
    // smaller model; if the window does not fit, Ollama keeps part of it in system memory (slower).
    const fitCtx = Math.min(numCtx, 16384)
    let need = needOf(model, tier, fitCtx)
    while (need > available * stepFactor && tier !== 'fast') {
      const lower: Tier = tier === 'max' ? 'balanced' : 'fast'
      const lowerModel = slot(lower)
      if (!usable(lowerModel)) break
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
  if (cfg.routing.preferLoaded && !cpuOnly && !loaded.has(model) && !code) {
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

  if (!code && input.historyTokens + 3000 > numCtx) numCtx = Math.min(32768, Math.max(numCtx, 2 ** Math.ceil(Math.log2(input.historyTokens + 3000))))
  // CPU prompt processing is slow; keep the window small (Code mode still needs room for files).
  // Reading a long prompt is slow on a processor: at most 16K there (Maris widens it if the tools need room).
  if (cpuOnly) numCtx = Math.min(numCtx, 16384)

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
    complexity: c
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
