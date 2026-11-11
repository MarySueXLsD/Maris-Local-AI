// Shared types for the Maris main process, preload bridge and renderer.
import type { ApprovalKind, AutoApproveSettings } from './approval'

export type Tier = 'tiny' | 'fast' | 'balanced' | 'max'
export type ThinkMode = 'auto' | 'on' | 'off'
export type TaskCategory =
  | 'quick'
  | 'chat'
  | 'writing'
  | 'code'
  | 'reasoning'
  | 'agent'
  | 'vision'
  | 'web'
  | 'media'

// ---------------------------------------------------------------- models

export interface ModelInfo {
  name: string
  sizeBytes: number
  family?: string
  parameterSize?: string
  quantization?: string
  capabilities: string[] // completion | tools | thinking | vision | embedding
  contextLength?: number
  modifiedAt?: string
  /** A readable name, for models whose id is not one (a service's models). */
  label?: string
  /** Set for models of a service the person added (Claude, an OpenAI-compatible one): its id and name. */
  provider?: string
  providerName?: string
  /** What is sent to this model leaves the computer (false for services on this computer or home network). */
  remote?: boolean
}

export interface LoadedModel {
  name: string
  sizeBytes: number
  vramBytes: number
  expiresAt?: string
  contextLength?: number
}

export interface CatalogModel {
  name: string // ollama tag or hf.co/... reference
  label: string
  tier: Tier | 'embed'
  sizeGB: number
  description: string
  recommended?: boolean
  family?: string
  /** Total parameters in billions. */
  paramsB?: number
  /** Active parameters per token for mixture-of-experts models (decides speed). */
  activeB?: number
  /** KV cache for 16K tokens of context, in MB. */
  kvPer16kMB?: number
  caps?: ('tools' | 'vision' | 'thinking' | 'embedding' | 'audio')[]
  /** Rough overall capability 0..100, used to rank what fits. */
  quality?: number
  /** Rough coding capability 0..100. */
  coding?: number
  /** Roles this model is a sensible choice for. */
  roles?: LlmRole[]
  /** A small or older model meant for slow computers (shown under its own heading). */
  light?: boolean
  /** Only offered on GPUs with at least this much VRAM (custom quantisations sized for one card class). */
  minVramGB?: number
  maxVramGB?: number
}

/** What an installed language model says about itself (Ollama's model information). */
export interface ModelDetails {
  architecture?: string
  /** Parameters, counted. */
  parameters?: number
  /** The longest context the model was trained for, in tokens. */
  contextLength?: number
  quantization?: string
  /** The licence's name, recognised from its text. */
  license?: string
  /** Sampling defaults the model ships with (temperature, top_p, …). */
  defaults: Record<string, string>
  modifiedAt?: string
}

export interface PullProgress {
  model: string
  status: string
  completed?: number
  total?: number
  done?: boolean
  error?: string
}

// ---------------------------------------------------------------- system

export type BusyLevel = 'idle' | 'light' | 'busy' | 'heavy'

export interface GpuStatus {
  name: string
  utilization: number // 0..100
  memUsedMB: number
  memTotalMB: number
  temperatureC?: number
  powerW?: number
}

export interface SystemStatus {
  ts: number
  gpu?: GpuStatus
  cpuLoad: number // 0..1
  ramUsedMB: number
  ramTotalMB: number
  onBattery: boolean
  ollama: { up: boolean; version?: string; loaded: LoadedModel[]; /** Ollama is on this computer at all (it may be absent when only API models are used). */ installed?: boolean }
  comfy: {
    up: boolean
    installed: boolean
    busy: boolean
    queue: number
    starting: boolean
    /** The picture or video being made now, with the time left for it and everything queued after it. */
    job?: { model?: string; kind: 'image' | 'video'; etaSec?: number; conversationId?: string }
  }
  /** Estimated GPU use by other programs (games, renders, browsers). */
  external: { gpuUtil: number; vramMB: number }
  busy: BusyLevel
  activeJobs: { llm: number; media: number }
  /** Low-power mode is in effect (a slow computer, or the person turned it on). */
  lite?: boolean
}

/** A program using video memory, as the status bar's VRAM details list it. */
export interface GpuProgram {
  /** Its main process: ending it ends its helper processes too. */
  pid: number
  /** The name people know it by ("Google Chrome"), else its file name. */
  name: string
  /** The program file (chrome.exe). */
  exe: string
  /** What it runs, when that tells programs apart: the script for Python or Node, for example. */
  detail?: string
  /** Video memory of the program and its helper processes. */
  vramMB: number
  /** Other programs it started, which end with it (a launcher's games, a terminal's scripts). */
  alsoEnds?: string[]
}

/** Who uses the graphics card's memory besides Maris. */
export interface GpuProgramList {
  /** False where the system does not say which program uses how much (macOS, most non-NVIDIA cards on Linux). */
  supported: boolean
  /** Biggest first. Programs Maris may offer to end. */
  programs: GpuProgram[]
  /** Parts of the system (the desktop, drivers, services): shown, never offered for ending. */
  system: { vramMB: number; names: string[] }
  error?: string
  ts: number
}

// ---------------------------------------------------------------- routing

export interface RouteDecision {
  model: string
  tier: Tier | 'custom'
  think: boolean
  numCtx: number
  cpuOnly: boolean
  reason: string
  auto: boolean
  category: TaskCategory
  complexity: number // 0..1
  /** The model belongs to a service the person added: its name, and whether the chat leaves this computer. */
  provider?: string
  remote?: boolean
}

// ---------------------------------------------------------------- chat

export type MessageStatus = 'streaming' | 'waiting' | 'done' | 'error' | 'stopped'

export interface Attachment {
  id: string
  /** snippet: a piece of a file the person selected (its text and line numbers). */
  kind: 'image' | 'file' | 'snippet'
  name: string
  mime: string
  size: number
  path?: string // for files on disk
  dataUrl?: string // for images (base64 data URL)
  /** For snippets: the selected text and the first and last line it covers. */
  text?: string
  lines?: [number, number]
}

/** A picture or video asked for in the composer's Image or Video mode: made directly, no language model. */
export interface MediaRequest {
  kind: 'image' | 'video'
  prompt: string
  /** A model the person picked; otherwise Maris picks by quality. */
  packId?: string
  quality?: 'auto' | 'fast' | 'quality'
  aspect?: 'square' | 'portrait' | 'landscape' | 'wide'
  count?: number
  seconds?: number
  negative?: string
  /** A picture on disk for the video to start from. */
  startImage?: string
}

/** How full a chat's context window is, by what fills it (estimates). */
export interface ContextUsage {
  model: string
  /** The model's context window for this chat, in tokens. */
  window: number
  parts: { key: string; label: string; hint: string; tokens: number }[]
  used: number
  /** Kept free for the answer. */
  reserved: number
  /** Tokens left before older messages are summarised (undefined when automatic summaries are off). */
  untilCompact?: number
  /** Earlier messages are already summarised. */
  summarised: boolean
  /** Messages in the chat that the model still sees in full. */
  messages: number
  /** The window sizes this chat's model can use, and what each costs on this computer. */
  sizes?: ContextSizes
}

export interface ContextSizes {
  /** The setting a choice changes, for example routing.codeContext or routing.contextByTier.max. */
  path: string
  /** Who uses that setting: "Code mode", "the Max model". */
  role: string
  current: number
  /** The model's own limit. */
  max?: number
  options: ContextSizeOption[]
}

export interface ContextSizeOption {
  tokens: number
  /**
   * gpu: fits in video memory; spill: part runs from system memory; cpu: everything runs on the
   * processor; api: the model runs at an API service, where a bigger size means more is sent each time;
   * none: model and window together need more memory than this computer has.
   */
  fit: 'gpu' | 'spill' | 'cpu' | 'api' | 'none'
  /** How much would run from system memory (MB). */
  spillMB?: number
  /** Memory the model and this window need together (MB), where that is the problem. */
  needMB?: number
  /** Rough slowdown of writing compared with fitting in video memory (2 = half as fast). */
  slower?: number
}

export type ToolRisk = 'read' | 'change' | 'system' | 'network' | 'heavy'
export type ToolStatus = 'pending' | 'awaiting-approval' | 'running' | 'done' | 'denied' | 'error'

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  risk: ToolRisk
  status: ToolStatus
  title?: string
  detail?: string
  result?: string
  error?: string
  progress?: string
  preview?: string // small image (data URL) e.g. a web page thumbnail or screenshot
  diff?: string // unified diff of a file change, kept for the Changes panel
  backup?: string // backup of the file before the change (for revert)
  targets?: string[] // files or folders the call touches
  autoApproved?: string // why it ran without asking (only for rules the user enabled)
  startedAt?: number
  endedAt?: number
  approvalId?: string
  /** A picture or video this call is making: model, progress and a time estimate. */
  media?: MediaProgress
}

/** Live state of a picture or video being made for a chat. */
export interface MediaProgress {
  jobId: string
  kind: 'image' | 'video'
  packId: string
  model: string
  status: MediaJobStatus
  /** 0..1 */
  progress: number
  step?: string
  startedAt: number
  /** Seconds left, from the steps so far or from earlier runs on this computer. */
  etaSec?: number
  /** Seconds the whole job is expected to take. */
  expectedSec?: number
  /** Other installed models that make the same kind of result, to switch to. */
  alternatives?: { packId: string; name: string; tier: 'fast' | 'quality'; faster: boolean }[]
  /** Set when the person switched this job to another model. */
  switchedTo?: string
}

export interface MediaResult {
  id: string
  kind: 'image' | 'video'
  path: string
  prompt: string
  model: string
  width?: number
  height?: number
  seed?: number
  frames?: number
  fps?: number
  createdAt: number
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tool'; call: ToolCallRecord }
  | { type: 'media'; media: MediaResult }
  | { type: 'notice'; text: string; tone?: 'info' | 'warn'; /** A chat the notice is about ("the video is being made there"). */ conversationId?: string }

export interface MessageStats {
  promptTokens?: number
  outputTokens?: number
  tokensPerSec?: number
  durationMs?: number
  loadMs?: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  parts: Part[]
  attachments?: Attachment[]
  model?: string
  route?: RouteDecision
  status: MessageStatus
  stats?: MessageStats
  feedback?: 1 | -1
  error?: string
  createdAt: number
  /** A message from the composer's Image or Video mode: what to make. */
  media?: MediaRequest
  /**
   * For your messages: what Maris told the model along with it (the time, memories that fit, the
   * project's state). Kept with the message and sent again unchanged, so a model on a slow computer
   * only has to read what is new instead of the whole chat again.
   */
  context?: string
  /** Memories already given to the model in this chat (ids), so each is told once. */
  contextMemories?: string[]
  /** While an answer is live: what the model is doing right now (loading, reading, thinking). Not saved. */
  activity?: MessageActivity
}

export interface MessageActivity {
  text: string
  /** When this stage began (ms), for the timer next to it. */
  since: number
}

export type ChatMode = 'chat' | 'code'

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  model: string // 'auto' or an explicit model name
  mode: ChatMode
  projectDir?: string
  /** Code mode: file edits inside the project run without asking (opted in by the user). */
  autoEdits?: boolean
  /** Compacted summary of older messages (context compaction). */
  summary?: string
  summaryUntil?: number
  messageCount?: number
  preview?: string
  /** Where the chat was started; 'terminal' for the maris command. */
  origin?: 'terminal'
}

export interface Project {
  path: string
  name: string
  lastOpened: number
  /** Command prefixes the user chose to always allow in this project, e.g. "cargo test". */
  allowedCommands: string[]
  stack?: string[]
  /** What the project is about, in the person's words; every task in the project sees it. */
  description?: string
}

export interface FileEntry {
  name: string
  path: string
  dir: boolean
  size?: number
}

export interface SendOptions {
  conversationId?: string
  /** Make a picture or video directly instead of asking a language model. */
  media?: MediaRequest
  text: string
  attachments?: Attachment[]
  model?: string // 'auto' | model name
  think?: ThinkMode
  webAccess?: boolean
  mode?: ChatMode
  projectDir?: string
  /** Set by the maris terminal command for the chats it starts. */
  origin?: 'terminal'
}

/** The maris terminal command: whether it is on PATH and where it lives. */
export interface TerminalCommandStatus {
  supported: boolean
  installed: boolean
  /** Windows: the bin folder on PATH; macOS/Linux: the script file. */
  location?: string
  scope?: 'user' | 'machine'
  note?: string
}

// ---------------------------------------------------------------- approvals

/** How big an install is, shown with its approval. */
export interface InstallInfo {
  /** One line, e.g. "Downloads about 180 MB and needs about 1.2 GB on C: (139 GB free)". */
  summary: string
  name?: string
  downloadBytes?: number
  diskBytes?: number
  drive?: string
  freeBytes?: number
}

export type ApprovalPreview =
  | { kind: 'diff'; path: string; diff: string; isNew: boolean; additions: number; deletions: number }
  | { kind: 'command'; command: string; cwd?: string; shell: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'text'; text: string }

export interface ApprovalRequest {
  id: string
  conversationId: string
  messageId: string
  toolCallId: string
  tool: string
  title: string
  detail: string
  risk: ToolRisk
  preview?: ApprovalPreview
  /** For commands in a project: the prefix the user may choose to always allow. */
  allowPrefix?: string
  /** The kind of change, for "Always approve …" (absent when no kind rule may cover it). */
  kind?: ApprovalKind
  /** Never covered by "Always approve" (Maris changing its own settings): the box offers no rule. */
  alwaysAsk?: boolean
  createdAt: number
  /** For installs: how much it downloads and needs on disk. */
  install?: InstallInfo
}

// ---------------------------------------------------------------- events

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | {
      type: 'delta'
      conversationId: string
      messageId: string
      partIndex: number
      kind: 'text' | 'thinking'
      text: string
    }
  | { type: 'part'; conversationId: string; messageId: string; partIndex: number; part: Part }
  | {
      type: 'status'
      conversationId: string
      messageId: string
      status: MessageStatus
      stats?: MessageStats
      error?: string
      model?: string
    }
  | { type: 'route'; conversationId: string; messageId: string; route: RouteDecision }
  | { type: 'activity'; conversationId: string; messageId: string; activity?: MessageActivity }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversation-deleted'; id: string }
  | { type: 'message-deleted'; conversationId: string; messageId: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string; approved: boolean }

// ---------------------------------------------------------------- memory

export type MemoryKind = 'fact' | 'preference' | 'instruction' | 'project' | 'person' | 'skill'

export interface Memory {
  id: string
  text: string
  kind: MemoryKind
  source: 'user' | 'learned' | 'feedback'
  importance: number // 0..1
  pinned: boolean
  uses: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  conversationId?: string
}

export interface LearningEvent {
  id: string
  ts: number
  kind: 'memory-added' | 'memory-merged' | 'route-adjusted' | 'skill-learned' | 'feedback'
  text: string
}

// ---------------------------------------------------------------- media

export interface MediaPackFile {
  url: string
  dir: string // ComfyUI models sub-folder, e.g. diffusion_models
  name: string
  sizeBytes?: number
}

export interface MediaPack {
  id: string
  kind: 'image' | 'video'
  tier: 'fast' | 'quality'
  name: string
  description: string
  sizeGB: number
  /** VRAM needed to run fully on the GPU. */
  vramGB: number
  /** Smallest GPU it still works on, with ComfyUI moving weights between RAM and VRAM. */
  vramMinGB: number
  /** Usable without any GPU (slow but practical). */
  cpuOk: boolean
  /** Rough output quality 0..100, used to rank what fits. */
  quality: number
  /** Seconds per result on the reference GPU (RTX 5070 Ti, model already loaded). */
  refSeconds: number
  /** What one result is, e.g. "image" or "3 s clip". */
  unit: string
  license: string
  speed: string
  files: MediaPackFile[]
  installed: boolean
  /** Image-to-video models: they need a picture to start from, or can take one. */
  startImage?: 'needed' | 'optional'
  /** What the model card shows beyond the summary. */
  details?: MediaPackDetails
}

export interface MediaPackDetails {
  maker: string
  /** Model size in plain words, e.g. "6 billion parameters". */
  size: string
  /** What one result is: resolution, length, frame rate. */
  output: string
  /** How it works, in one sentence (steps, guidance). */
  how: string
  goodAt: string[]
  weakAt: string[]
  /** How to write prompts for it. */
  tips: string[]
  /** What the licence allows, in plain words. */
  licenseNote: string
  /** The model's page. */
  link: string
}

export interface MediaParams {
  kind: 'image' | 'video'
  prompt: string
  negative?: string
  packId?: string // explicit pack or undefined for auto
  quality?: 'auto' | 'fast' | 'quality'
  width?: number
  height?: number
  steps?: number
  seed?: number
  frames?: number
  seconds?: number
  count?: number
  inputImage?: string // absolute path for image-to-video / img2img
  /** The chat that asked for it (to link there and to stop it when the chat is deleted). */
  conversationId?: string
}

export type MediaJobStatus = 'queued' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled'

export interface MediaJob {
  id: string
  params: MediaParams
  packId: string
  status: MediaJobStatus
  progress: number // 0..1
  step?: string
  results: MediaResult[]
  error?: string
  createdAt: number
  finishedAt?: number
  reason?: string
  /** Name of the model making it. */
  model?: string
  /** When it started running (after waiting in the queue). */
  startedAt?: number
  /** Seconds left, from the steps so far or from earlier runs on this computer. */
  etaSec?: number
  /** Seconds the whole job is expected to take (known before the first step). */
  expectedSec?: number
}

export interface DownloadProgress {
  id: string // pack id or engine id
  label: string
  receivedBytes: number
  totalBytes: number
  file?: string
  done?: boolean
  error?: string
}

export interface ComfyState {
  installed: boolean
  dir?: string
  up: boolean
  starting: boolean
  installing: boolean
  log: string[]
}

// ---------------------------------------------------------------- hardware scan & setup

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'

export interface GpuInfo {
  name: string
  vendor: GpuVendor
  vramMB: number
  integrated: boolean
  driver?: string
  /** NVIDIA compute capability, e.g. "12.0". */
  computeCap?: string
  /** Approximate memory bandwidth in GB/s (decides how fast language models write). */
  bandwidthGBs: number
  /** Rough compute speed relative to an RTX 5070 Ti (= 1); decides image and video times. */
  perf: number
  /** How Ollama can use it for language models. */
  llm: 'cuda' | 'rocm' | 'vulkan' | 'metal' | 'none'
  /** Which ComfyUI build (Windows) or PyTorch flavour (macOS/Linux) fits it. */
  comfy: 'nvidia' | 'nvidia_cu126' | 'amd' | 'intel' | 'mps' | 'none'
  /** Apple chips: the GPU shares main memory; vramMB is the part macOS lets the GPU use. */
  unified?: boolean
  /** GPU core count where the system reports it (Apple chips). */
  cores?: number
}

export interface DiskInfo {
  root: string
  label?: string
  freeGB: number
  totalGB: number
  fs?: string
}

export type OsPlatform = 'win32' | 'darwin' | 'linux'

export interface PcScan {
  ts: number
  /** Missing in scans saved by older versions, which were all Windows. */
  platform?: OsPlatform
  os: string
  cpu: { name: string; cores: number; threads: number; avx2: boolean; avx512: boolean }
  /** A slow computer (no usable graphics card and little memory or few cores): low-power mode suits it. */
  lite?: boolean
  ram: { totalMB: number; freeMB: number; speedMTs?: number; type?: string; bandwidthGBs: number }
  gpus: GpuInfo[]
  /** The GPU Maris uses (largest dedicated one). */
  gpu?: GpuInfo
  disks: DiskInfo[]
  laptop: boolean
  ollama: { installed: boolean; running: boolean; version?: string; models: string[]; modelsDir: string }
  comfy: { installed: boolean; dir?: string }
  winget: boolean
  /** macOS: Homebrew is installed. */
  brew?: boolean
  notes: string[]
}

/** Where models may run: fully on the GPU, GPU with overflow into RAM, or the CPU only. */
export type Processing = 'gpu' | 'hybrid' | 'cpu'

export type LlmRole = 'fast' | 'balanced' | 'max' | 'code' | 'tiny' | 'embed'
export type MediaRole = 'imageFast' | 'imageQuality' | 'videoFast' | 'videoQuality'
export type SetupRole = LlmRole | MediaRole

export interface Placement {
  where: 'gpu' | 'hybrid' | 'cpu' | 'none'
  /** Share of the model held in VRAM, 0..1. */
  gpuShare: number
  needMB: number
  /** Human estimate, e.g. "≈38 tokens/s" or "≈6 s per image". */
  speed: string
  /** tokens/s for language models, seconds per result for media. */
  speedValue: number
  fits: boolean
  note?: string
}

export interface PlanOption {
  id: string
  label: string
  sizeGB: number
  placement: Placement
  installed: boolean
  quality: number
  description: string
}

export interface PlanItem {
  role: SetupRole
  kind: 'llm' | 'media'
  pick?: string
  options: PlanOption[]
  reason: string
  enabled: boolean
  /** Context window chosen for this role (language models). */
  numCtx?: number
}

export interface SetupPrefs {
  processing: Processing
  images: boolean
  video: boolean
  dataDir: string
}

export interface SetupPlan {
  prefs: SetupPrefs
  items: PlanItem[]
  downloadGB: number
  freeGB: number
  warnings: string[]
}

export interface SetupTask {
  id: string
  label: string
  kind: 'ollama' | 'llm' | 'comfy' | 'pack' | 'settings'
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped'
  received?: number
  total?: number
  detail?: string
  error?: string
}

export interface SetupProgress {
  running: boolean
  done: boolean
  tasks: SetupTask[]
  error?: string
}

// ---------------------------------------------------------------- settings

export type RolePlacement = 'auto' | 'gpu' | 'cpu'

/** Sampling and placement for one model role. Unset numbers mean "the model's own default". */
export interface GenParams {
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  maxTokens?: number
  placement: RolePlacement
}

export interface Settings {
  ollamaUrl: string
  comfyUrl: string
  dataDir: string // where engines and media models live
  tiers: Record<Tier, string | undefined> & { embed?: string; code?: string }
  engine: {
    /** Chosen in setup: keep models on the GPU, let them overflow into RAM, or use the CPU only. */
    processing: Processing
    /**
     * Low-power mode for slow computers: short instructions, only the tools a request needs, one model
     * for everything and a lighter interface. Auto turns it on where it helps.
     */
    profile: 'auto' | 'standard' | 'lite'
    /** Minutes a model stays loaded after its last use. */
    keepAliveMin: number
    /** Closing Maris also stops the Ollama server (its models are unloaded either way). */
    stopOllamaOnQuit: boolean
    /** CPU threads for language models (0 = let Ollama decide). */
    cpuThreads: number
    /** VRAM left free for Windows and other programs, in MB. */
    gpuReserveMB: number
    firstTokenTimeoutSec: number
    idleTimeoutSec: number
  }
  generation: Record<'fast' | 'balanced' | 'max' | 'code', GenParams>
  routing: {
    smartClassifier: boolean // use the tiny model to classify ambiguous prompts
    preferSpeed: number // 0 = always quality, 1 = always speed
    allowCpuFallback: boolean
    contextByTier: Record<Tier, number>
    codeContext: number // context window for Code mode
    /** How much of a conversation is sent to models of an API service before older messages are summarised (tokens). */
    apiContext: number
    stepDownOnBattery: boolean
    preferLoaded: boolean
    learnFromFeedback: boolean
    /** Other programs using more GPU than this (%) count as heavy load. */
    busyGpuPercent: number
    /** Other programs holding more VRAM than this (GB) count as heavy load. */
    busyVramGB: number
  }
  agent: {
    maxSteps: number
    autoRunReadOnlyCommands: boolean
    /** Full control of this PC: run things as administrator and use the mouse and keyboard (each action still asks). */
    fullControl: boolean
    defaultThink: ThinkMode
    autoCompact: boolean
    /** Compact when the conversation fills this share of the context window. */
    compactAt: number
    commandTimeoutSec: number
    /** "Always approve" rules chosen in an approval box or in Settings. All off: every change asks. */
    autoApprove: AutoApproveSettings
  }
  memory: { enabled: boolean; autoLearn: boolean; maxInPrompt: number; learnAfterSec: number }
  web: {
    enabled: boolean
    provider: 'duckduckgo' | 'brave' | 'searxng'
    braveKey?: string
    searxngUrl?: string
    maxResults: number
    pageChars: number
    thumbnails: boolean
  }
  media: {
    autoUnloadLlm: boolean
    outputDir?: string
    /** Which installed pack plays each part (chosen in setup). */
    roles: Partial<Record<MediaRole, string>>
    vramMode: 'auto' | 'high' | 'normal' | 'low' | 'none' | 'cpu'
    autoStart: boolean
    stopAfterIdleMin: number
    extraArgs: string
    imageWidth: number
    imageHeight: number
    videoSeconds: number
  }
  ui: {
    theme: 'system' | 'light' | 'dark'
    accent: string
    fontScale: number
    reduceMotion: boolean
    highContrast: boolean
    hotkey: string
    closeToTray: boolean
    launchAtLogin: boolean
    showThinking: boolean
    density: 'comfortable' | 'compact'
    chatWidth: 'narrow' | 'normal' | 'wide' | 'full'
    sendWithEnter: boolean
    showRouteReason: boolean
    material: 'mica' | 'acrylic' | 'solid'
    status: { ram: boolean; vram: boolean; temp: boolean; power: boolean; models: boolean; load: boolean }
    /** Colour theme: "maris" (follows theme above), a preset such as "neon-pink", or "custom". */
    palette: string
    customTheme: { scheme: 'light' | 'dark'; background: string; surface: string; text: string; accent: string; highlight: string; glow: boolean }
    /** How tool activity is shown: plain-language steps, or every command and change. */
    activityView: 'simple' | 'detailed'
    /** Hover explanations for technical words and extra tips. */
    helpTips: boolean
  }
  persona: {
    assistantName: string
    userName?: string
    customInstructions?: string
    responseStyle: 'concise' | 'balanced' | 'detailed'
    /** Who Maris explains things for: anyone (plain language) or developers (technical). */
    explain: 'everyone' | 'developer'
  }
  system: { monitorIntervalSec: number }
  /** New versions and news posts, from a GitHub repository (releases and its news/ folder). */
  updates: {
    /** Look for new versions while online. */
    check: boolean
    /** Download a new version in the background as soon as it is found (it installs only on your click). */
    autoDownload: boolean
    /** Hours between checks. */
    intervalHours: number
    /** owner/name of the GitHub repository that publishes Maris. */
    repo: string
    /** Show news posts from the same repository. */
    news: boolean
    /** Show the Admin page for writing posts (publishing needs a GitHub token with write access). */
    admin: boolean
  }
  /** Skills (instructions from git) and connectors (outside services) the assistant may use. */
  extensions: {
    skills: boolean
    connectors: boolean
  }
  /** Maris Link: the phone app connects over the home network. Off until the person turns it on. */
  link: {
    enabled: boolean
    port: number
    /** Paired phones may approve changes on this computer. */
    allowApprovals: boolean
  }
  onboarded: boolean
}

/** A phone paired with Maris Link (the key itself never leaves the main process). */
export interface LinkDevice {
  id: string
  name: string
  createdAt: number
  lastSeen?: number
  /** Connected right now (listening for updates). */
  online?: boolean
}

export interface LinkStatus {
  enabled: boolean
  running: boolean
  port: number
  /** Addresses on the local network the phone can use, best first. */
  addresses: string[]
  hostName: string
  devices: LinkDevice[]
  pairing?: { code: string; expiresAt: number; url: string }
  error?: string
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
