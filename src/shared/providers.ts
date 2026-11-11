// Model services Maris can use besides Ollama on this computer: Claude, and anything that speaks the
// OpenAI chat format (OpenAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, LM Studio, llama.cpp …).
// A service is an address and, usually, a key. Its models are read from the service itself, so a
// model that comes out tomorrow shows up without a new version of Maris. Pure, shared by the main
// process and the interface.

/** How Maris talks to a service: Claude's Messages API, or the OpenAI chat-completions format. */
export type ProviderKind = 'anthropic' | 'openai'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  /** The address requests go to (for OpenAI-style services: the part before /chat/completions). */
  baseUrl: string
  description: string
  /** Where to get a key. */
  keyUrl?: string
  keyPlaceholder?: string
  /** Runs on this computer or the home network: nothing leaves it, and no key is needed. */
  local?: boolean
  /** The address is the person's own to fill in. */
  custom?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    description: 'The Claude models, through the Anthropic API.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyPlaceholder: 'sk-ant-…'
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    description: 'The GPT models, through the OpenAI API.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…'
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    description: 'The Gemini models, through Google AI Studio.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    description: 'One key for hundreds of models from many makers, some of them free.',
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-…'
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    description: 'Open models served very fast.',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    description: 'The Mistral models.',
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    description: 'The DeepSeek chat and reasoning models.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-…'
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    description: 'The Grok models.',
    keyUrl: 'https://console.x.ai',
    keyPlaceholder: 'xai-…'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    description: 'Models you run in LM Studio on this computer (turn on its local server).',
    local: true
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    description: 'A llama-server, KoboldCpp, vLLM or similar server on this computer or your network.',
    local: true,
    custom: true
  },
  {
    id: 'custom',
    name: 'Other service',
    kind: 'openai',
    baseUrl: '',
    description: 'Any service with an OpenAI-compatible address: paste the address and, if it needs one, a key.',
    custom: true
  }
]

/** One model of a service, as the service lists it. */
export interface ProviderModel {
  id: string
  /** A readable name, when the service gives one. */
  label?: string
  /** The longest prompt it takes, in tokens, when the service says. */
  contextLength?: number
  /** The longest answer it writes, in tokens, when the service says. */
  maxOutput?: number
  /** What the service says it can do; missing means "not said" (Maris then finds out by trying). */
  vision?: boolean
  tools?: boolean
  thinking?: boolean
  /** How thinking is asked for, where the service says: the model decides how much, or a fixed budget. */
  thinkingMode?: 'adaptive' | 'budget'
  /** When the service released it (ms), for showing the newest first. */
  created?: number
}

export interface ProviderConfig {
  id: string
  preset: string
  kind: ProviderKind
  name: string
  baseUrl: string
  enabled: boolean
  /** A key is saved for it (the key itself never leaves the main process). */
  hasKey: boolean
  /** The service's models, from the last time they were read. */
  models: ProviderModel[]
  /** The models the person uses in Maris (shown in the model picker and the role lists). */
  picked: string[]
  fetchedAt?: number
  createdAt: number
}

export interface ProviderInfo extends ProviderConfig {
  status: 'off' | 'ready' | 'error' | 'checking'
  error?: string
  /** Nothing sent to it leaves this computer or home network. */
  local: boolean
}

// ------------------------------------------------------------------ names

/**
 * The name of a service's model inside Maris: "@<service id>/<model id>". Ollama's own names never
 * start with "@", so one string says where a model runs.
 */
export const remoteModelName = (providerId: string, model: string): string => `@${providerId}/${model}`

export function parseRemoteModel(name: string | undefined): { provider: string; model: string } | undefined {
  if (!name || name[0] !== '@') return undefined
  const slash = name.indexOf('/')
  if (slash < 2 || slash === name.length - 1) return undefined
  return { provider: name.slice(1, slash), model: name.slice(slash + 1) }
}

export const isRemoteModel = (name: string | undefined): boolean => Boolean(name && name[0] === '@' && parseRemoteModel(name))

/** Ids that are not chat models: embeddings, speech, pictures, moderation. Kept out of the lists. */
const NOT_CHAT = /embed|whisper|tts|speech|transcri|audio|dall-?e|image|imagen|veo|sora|video|moderation|rerank|guard|realtime|computer-use|aqa$|bge-|e5-|clip|ocr\b/i

export const looksLikeChatModel = (id: string): boolean => !NOT_CHAT.test(id)

/** What to call a service's model: the service's own name for it, else its id as it is. */
export function remoteModelLabel(name: string, label?: string): string {
  if (label) return label
  return (parseRemoteModel(name)?.model ?? name).replace(/^models\//, '')
}

/** A base address without a trailing slash or a pasted "/chat/completions". */
export function cleanBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\s+/g, '')
  if (u && !/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(u) ? 'http' : 'https'}://${u}`
  return u.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models|messages)$/i, '')
}

/** True for addresses on this computer or a private network, where nothing leaves the home. */
export function isLocalAddress(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return (
      h === 'localhost' ||
      h === '::1' ||
      h.endsWith('.local') ||
      h.endsWith('.lan') ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
      /^f[cd][0-9a-f]{2}:/i.test(h)
    )
  } catch {
    return false
  }
}

/** The models to tick when a service is first added: its newest few chat models. */
export function defaultPicks(models: ProviderModel[], max = 6): string[] {
  const chat = models.filter((m) => looksLikeChatModel(m.id))
  const dated = chat.filter((m) => m.created)
  const list = dated.length >= Math.min(3, chat.length) ? [...dated].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)) : chat
  return list.slice(0, max).map((m) => m.id)
}
