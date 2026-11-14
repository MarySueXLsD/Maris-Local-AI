import type { GenParams, Settings } from './types'

const gen = (temperature?: number): GenParams => ({ placement: 'auto', ...(temperature === undefined ? {} : { temperature }) })

/** Factory settings. Shared so the renderer can show "reset to default" without a round trip. */
export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  comfyUrl: 'http://127.0.0.1:8188',
  dataDir: '',
  tiers: { tiny: undefined, fast: undefined, balanced: undefined, max: undefined, embed: undefined, code: undefined },
  engine: {
    processing: 'gpu',
    profile: 'auto',
    keepAliveMin: 30,
    stopOllamaOnQuit: true,
    cpuThreads: 0,
    gpuReserveMB: 250,
    firstTokenTimeoutSec: 240,
    idleTimeoutSec: 180,
    flashAttention: true,
    kvCache: 'q8_0'
  },
  generation: { fast: gen(), balanced: gen(), max: gen(), code: gen() },
  routing: {
    smartClassifier: true,
    preferSpeed: 0.5,
    allowCpuFallback: true,
    contextByTier: { tiny: 8192, fast: 32768, balanced: 32768, max: 32768 },
    codeContext: 32768,
    apiContext: 65536,
    stepDownOnBattery: true,
    preferLoaded: true,
    learnFromFeedback: true,
    busyGpuPercent: 60,
    busyVramGB: 9
  },
  agent: {
    maxSteps: 0,
    autoRunReadOnlyCommands: true,
    fullControl: false,
    defaultThink: 'auto',
    autoCompact: true,
    compactAt: 0.9,
    commandTimeoutSec: 120,
    autoApprove: { everything: false, files: false, delete: false, commands: false, programs: false, clipboard: false, memory: false, connectors: false }
  },
  memory: { enabled: true, autoLearn: true, maxInPrompt: 12, learnAfterSec: 45 },
  web: { enabled: true, provider: 'duckduckgo', maxResults: 6, pageChars: 12000, thumbnails: true },
  media: {
    autoUnloadLlm: true,
    roles: {},
    vramMode: 'auto',
    autoStart: false,
    stopAfterIdleMin: 20,
    extraArgs: '',
    imageWidth: 1024,
    imageHeight: 1024,
    videoSeconds: 3
  },
  ui: {
    theme: 'system',
    accent: '',
    fontScale: 1,
    reduceMotion: false,
    highContrast: false,
    hotkey: 'Control+Shift+Space',
    closeToTray: false,
    launchAtLogin: false,
    showThinking: true,
    density: 'comfortable',
    chatWidth: 'normal',
    sendWithEnter: true,
    showRouteReason: true,
    material: 'mica',
    status: { ram: true, vram: true, temp: true, power: true, models: true, load: true },
    palette: 'maris',
    customTheme: { scheme: 'dark', background: '#0b0614', surface: '#140b26', text: '#f3eaff', accent: '#ff3ea5', highlight: '#39f0ff', glow: true },
    activityView: 'simple',
    helpTips: true
  },
  persona: { assistantName: 'Maris', responseStyle: 'balanced', explain: 'everyone' },
  system: { monitorIntervalSec: 2 },
  usage: { track: true, priceLookup: true, monthlyBudget: 0 },
  updates: { check: true, autoDownload: true, intervalHours: 6, repo: 'MarySueXLsD/Maris-Local-AI', news: true, admin: false },
  extensions: { skills: true, connectors: true },
  link: { enabled: false, port: 7341, allowApprovals: true, anywhere: false, relayUrl: '' },
  onboarded: false
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Merge a partial patch into a settings object (objects merge, everything else replaces). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : (patch as T))
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

/** The range a number setting may take (from the Settings page's own limits). */
export type NumberRanges = Map<string, { min?: number; max?: number }>

const plain = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * A settings change without values of the wrong kind: a number where a number belongs (kept within the
 * range the Settings page allows), a switch where a switch belongs, and so on. What does not fit is left
 * out, so a broken or hand-edited backup, or an older phone app, cannot leave Maris with a setting it
 * cannot use. Settings without a default (a model for a role, a temperature) take any plain value.
 */
export function cleanPatch(patch: unknown, base: unknown = DEFAULT_SETTINGS, ranges: NumberRanges = new Map(), prefix = ''): Record<string, unknown> {
  if (!isObj(patch)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key
    const def = isObj(base) ? base[key] : undefined
    if (isObj(def) || (def === undefined && isObj(value))) {
      if (isObj(value)) out[key] = cleanPatch(value, def, ranges, path)
      continue
    }
    if (def === undefined ? !plain(value) : typeof value !== typeof def) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      const r = ranges.get(path)
      out[key] = Math.min(r?.max ?? value, Math.max(r?.min ?? value, value))
    } else out[key] = value
  }
  return out
}

/**
 * Settings that a settings file being loaded never changes: what Maris may do without asking, full control,
 * the phone link, where updates come from and where chats and pictures are sent. A file someone shares
 * ("my theme") could otherwise switch them on without a word.
 */
export const PROTECTED_ON_IMPORT = ['agent.autoApprove', 'agent.fullControl', 'link', 'updates.repo', 'updates.admin', 'ollamaUrl', 'comfyUrl', 'media.extraArgs'] as const

/** Read a dotted path such as "ui.status.ram". */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Build a nested patch object for a dotted path. */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  const out: Record<string, unknown> = {}
  let cur = out
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value
    else cur = cur[k] = {} as Record<string, unknown>
  })
  return out
}

/** Every leaf path of the settings object (used to check that each one is editable). */
export function leafPaths(obj: unknown, prefix = ''): string[] {
  if (!isObj(obj)) return [prefix]
  return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
}
