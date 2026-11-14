// Maris explaining itself. The assistant reads the app's own Help articles (the ones F1 opens) and what
// is set up on this computer right now, so "how do I connect Claude?" is answered from the app instead
// of from what a model happens to believe about AI assistants in general. Both tools only read.
import '../hostPlatform'
import { app } from 'electron'
import { APPROVAL_KINDS, KIND_SHORT } from '@shared/approval'
import { excerpt, searchHelp } from '@shared/helpSearch'
import { pageLink } from '@shared/pages'
import { parseRemoteModel } from '@shared/providers'
import type { ModelInfo, Settings } from '@shared/types'
import { ARTICLES, articleById } from '../../renderer/src/help/articles'
import { SECTIONS } from '../../renderer/src/views/settings/schema'
import { terminalStatus } from '../cli/terminal'
import { connectors } from '../connectors/connectors'
import { ollama } from '../engines/ollama'
import { providers } from '../engines/providers'
import { feed } from '../feed/feed'
import { media } from '../media/jobs'
import { memory } from '../memory/store'
import { isLite } from '../perf'
import { DEVICE_WORD } from '../platform'
import { skills } from '../skills/skills'
import { monitor } from '../system/monitor'
import { schema, type ToolDef } from './types'

// ------------------------------------------------------------------ pages

const settingsPage = (id: string): string => pageLink(`Settings → ${SECTIONS.find((s) => s.id === id)?.title ?? id}`, `settings/${id}`)
const MODELS_API = (): string => pageLink('Models → API', 'models/api')
const MODELS_TEXT = (): string => pageLink('Models → Text', 'models/text')

/** Where in the app each article's subject lives. */
const WHERE: Record<string, () => string[]> = {
  welcome: () => [pageLink('Help', 'help')],
  approvals: () => [settingsPage('access')],
  auto: () => [MODELS_TEXT(), settingsPage('routing')],
  closing: () => [settingsPage('window'), settingsPage('engine')],
  'code-mode': () => [pageLink('Code mode', 'code')],
  context: () => [settingsPage('routing')],
  studio: () => [pageLink('Models → Pictures', 'models/pictures'), pageLink('Models → Videos', 'models/videos'), settingsPage('media')],
  memory: () => [pageLink('Memory', 'memory'), settingsPage('memory')],
  web: () => [settingsPage('web')],
  updates: () => [pageLink('Updates & news', 'news'), settingsPage('updates')],
  terminal: () => [settingsPage('window')],
  skills: () => [pageLink('Skills', 'skills')],
  connectors: () => [pageLink('Connectors', 'connectors')],
  phone: () => [settingsPage('phone')],
  'your-pc': () => [pageLink('Models', 'models')],
  models: () => [MODELS_TEXT()],
  'api-models': () => [MODELS_API(), MODELS_TEXT()],
  'slow-pc': () => [settingsPage('engine'), MODELS_TEXT(), MODELS_API()],
  setup: () => [settingsPage('data'), pageLink('Models', 'models')],
  'status-bar': () => [settingsPage('status')],
  themes: () => [settingsPage('appearance')],
  settings: () => [pageLink('Settings', 'settings')],
  shortcuts: () => [settingsPage('window')],
  troubleshooting: () => [settingsPage('engine'), settingsPage('data')],
  privacy: () => [settingsPage('data')]
}

// ------------------------------------------------------------------ what is set up right now

type Fact = 'version' | 'local' | 'api' | 'media' | 'memory' | 'web' | 'updates' | 'terminal' | 'skills' | 'connectors' | 'approvals' | 'control' | 'phone' | 'lite' | 'data'

const ALL_FACTS: Fact[] = ['version', 'local', 'api', 'media', 'web', 'memory', 'skills', 'connectors', 'phone', 'approvals', 'control', 'lite', 'updates', 'terminal', 'data']

/** Which of them matter for each article. */
const NOW: Record<string, Fact[]> = {
  welcome: ['version', 'local', 'api'],
  approvals: ['approvals', 'control'],
  auto: ['local', 'api', 'lite'],
  studio: ['media'],
  memory: ['memory'],
  web: ['web'],
  updates: ['version', 'updates'],
  terminal: ['terminal'],
  skills: ['skills'],
  connectors: ['connectors'],
  phone: ['phone'],
  'your-pc': ['local', 'lite'],
  models: ['local', 'api'],
  'api-models': ['api', 'local'],
  'slow-pc': ['lite', 'local', 'api'],
  setup: ['local', 'media'],
  troubleshooting: ['version', 'local', 'api'],
  privacy: ['api', 'web', 'connectors', 'data']
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const some = (list: string[], max = 12): string => (list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', '))
const within = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms))])

/** "@anthropic/claude-x" as people see it: "claude-x at Claude". */
function modelLabel(name: string): string {
  const remote = parseRemoteModel(name)
  if (!remote) return name
  const service = providers.list().find((p) => p.id === remote.provider)
  return `${remote.model} at ${service?.name ?? remote.provider}`
}

async function localFact(cfg: Settings): Promise<string> {
  let models: ModelInfo[] | undefined
  try {
    models = await within(ollama.list(), 4000)
  } catch {
    models = undefined
  }
  const roles = (['fast', 'balanced', 'max', 'code'] as const).flatMap((r) => (cfg.tiers[r] ? [`${cap(r)} = ${modelLabel(cfg.tiers[r]!)}`] : []))
  const rolesLine = roles.length ? ` Roles (what Auto uses): ${roles.join(', ')}.` : ' No model has a role yet.'
  if (!models) {
    const installed = (monitor.snapshot() as { ollama?: { installed?: boolean } } | undefined)?.ollama?.installed
    return installed === false
      ? `Models on this ${DEVICE_WORD}: none. Ollama, the engine for them, is not installed (the setup assistant installs it).${rolesLine}`
      : `Models on this ${DEVICE_WORD}: Ollama, the engine for them, is not running right now, so the list could not be read.${rolesLine}`
  }
  const chat = models.filter((m) => !(m.capabilities.includes('embedding') && !m.capabilities.includes('completion')))
  return `Models on this ${DEVICE_WORD} (they run through Ollama): ${chat.length ? some(chat.map((m) => m.name)) : 'none installed yet'}.${rolesLine}`
}

function apiFact(): string {
  const list = providers.list()
  if (!list.length) return `API services (Claude, GPT, Gemini and others): none added yet. The user adds one on ${MODELS_API()} with their own key.`
  const lines = list.map((p) => {
    const status = p.status === 'ready' ? 'connected' : p.status === 'off' ? 'turned off' : p.status === 'checking' ? 'being checked' : `error: ${p.error ?? 'unknown'}`
    const names = p.picked.map((id) => p.models.find((m) => m.id === id)?.label ?? id)
    const picked = names.length ? `${names.length} of its ${p.models.length} models are ticked for use: ${some(names, 8)}` : `none of its ${p.models.length} models is ticked yet`
    return `${p.name} (${status}${p.local ? ', on this computer or network' : ''}; ${picked})`
  })
  return `API services added on ${MODELS_API()}: ${lines.join('; ')}. Ticked models are in the model menu at the top of a chat.`
}

function mediaFact(cfg: Settings): string {
  const installed = media.packs().filter((p) => p.installed)
  const comfy = (monitor.snapshot() as { comfy?: { installed?: boolean } } | undefined)?.comfy?.installed
  if (!installed.length) return `Picture and video models: none installed${comfy === false ? ' (the picture engine, ComfyUI, is not installed either)' : ''}. They are installed on Models → Pictures and Models → Videos.`
  const of = (kind: 'image' | 'video'): string => some(installed.filter((p) => p.kind === kind).map((p) => p.name)) || 'none'
  const roles = Object.entries(cfg.media.roles).flatMap(([role, id]) => (id ? [`${role} = ${installed.find((p) => p.id === id)?.name ?? id}`] : []))
  return `Picture models installed: ${of('image')}. Video models installed: ${of('video')}.${roles.length ? ` Roles: ${roles.join(', ')}.` : ''}`
}

function approvalsFact(cfg: Settings): string {
  const rules = cfg.agent.autoApprove
  if (rules.everything) return 'Approved without asking: everything, everywhere (the user turned this on; changing Maris settings still asks).'
  const on = APPROVAL_KINDS.filter((k) => rules[k]).map((k) => KIND_SHORT[k])
  return on.length ? `Approved without asking: ${on.join(', ')}. Every other change asks.` : 'Approved without asking: nothing. Every change waits for the user.'
}

async function phoneFact(cfg: Settings): Promise<string> {
  if (!cfg.link.enabled) return `Phone app: the link is off. It is turned on in ${settingsPage('phone')}.`
  // Loaded here, not at the top: the link server reaches back to the chat machinery that owns these tools.
  const { link } = await import('../link/server')
  const st = link.status()
  const devices = st.devices
  const phones = devices.length ? `${devices.length} paired (${some(devices.map((d) => `${d.name}${d.online ? (d.via === 'relay' ? ', connected now through the relay' : ', connected now') : ''}`), 5)})` : 'no phone paired yet'
  const away = !cfg.link.anywhere
    ? `Connect from anywhere is off, so phones connect only on this network (it is turned on in ${settingsPage('phone')}).`
    : st.relay?.state === 'online'
      ? 'Connect from anywhere is on: phones reach Maris from any network through the Maris relay, end-to-end encrypted.'
      : `Connect from anywhere is on, but Maris is not connected to the relay right now${st.relay?.url ? '' : ' (no relay address is set)'}.`
  return `Phone app: the link is on, ${phones}. ${away} Approving changes from the phone is ${cfg.link.allowApprovals ? 'allowed' : 'not allowed'}.`
}

function updatesFact(cfg: Settings): string {
  const st = feed.updateState()
  if (st.available) return `Updates: version ${st.available.version} is ${st.ready ? 'downloaded and checked; "Restart to update" in the sidebar installs it' : 'available'}.`
  if (!cfg.updates.check) return 'Updates: looking for new versions is turned off.'
  return st.checkedAt ? `Updates: no newer version is known (last looked ${new Date(st.checkedAt).toLocaleString('en-GB')}).` : 'Updates: Maris has not looked for a new version yet in this session.'
}

async function fact(key: Fact, cfg: Settings): Promise<string> {
  switch (key) {
    case 'version':
      return `This is Maris ${app.getVersion()}.`
    case 'local':
      return localFact(cfg)
    case 'api':
      return apiFact()
    case 'media':
      return mediaFact(cfg)
    case 'memory':
      return cfg.memory.enabled ? `Memory: on, ${memory.list().length} memories kept; learning from chats by itself is ${cfg.memory.autoLearn ? 'on' : 'off'}.` : 'Memory: turned off.'
    case 'web':
      return cfg.web.enabled ? `Web access: on by default, searching with ${cfg.web.provider === 'duckduckgo' ? 'DuckDuckGo' : cfg.web.provider === 'brave' ? 'Brave Search' : 'SearXNG'}.` : 'Web access: turned off in Settings.'
    case 'updates':
      return updatesFact(cfg)
    case 'terminal': {
      const st = await within(terminalStatus(), 5000)
      return st.supported ? `Terminal command "maris": ${st.installed ? 'turned on' : 'turned off'}.` : `Terminal command "maris": not available in this copy${st.note ? ` (${st.note})` : ''}.`
    }
    case 'skills': {
      if (!cfg.extensions.skills) return 'Skills: turned off for all chats.'
      const list = skills.list()
      const on = list.filter((s) => s.enabled)
      return list.length ? `Skills: ${list.length} installed, ${on.length} turned on${on.length ? ` (${some(on.map((s) => s.name))})` : ''}.` : 'Skills: none installed yet.'
    }
    case 'connectors': {
      if (!cfg.extensions.connectors) return 'Connectors: turned off for all chats.'
      const list = connectors.list()
      if (!list.length) return 'Connectors: none added yet.'
      const say = (c: (typeof list)[number]): string => `${c.name} (${c.status === 'ready' ? `connected, ${c.tools.length} tools` : c.status === 'off' ? 'turned off' : c.status === 'connecting' ? 'connecting' : `error: ${c.error ?? 'unknown'}`})`
      return `Connectors: ${some(list.map(say))}.`
    }
    case 'approvals':
      return approvalsFact(cfg)
    case 'control':
      return `Full control of this ${DEVICE_WORD} (administrator rights, mouse and keyboard): ${cfg.agent.fullControl ? 'on' : 'off'}.`
    case 'phone':
      return phoneFact(cfg)
    case 'lite': {
      const where = cfg.engine.processing === 'gpu' ? 'GPU only' : cfg.engine.processing === 'cpu' ? 'CPU only' : 'GPU + CPU'
      return `Low-power mode: ${isLite(cfg) ? 'on' : 'off'} (set to ${cfg.engine.profile === 'auto' ? 'Auto' : cfg.engine.profile === 'lite' ? 'On' : 'Off'}). Models run: ${where}.`
    }
    case 'data':
      return `Chats, memories and settings are kept in ${app.getPath('userData')}; models and creations in ${cfg.dataDir}.`
  }
}

/** The facts as lines; one that cannot be read is left out rather than failing the answer. */
async function facts(keys: Fact[], cfg: Settings): Promise<string[]> {
  const out = await Promise.all(keys.map((k) => fact(k, cfg).catch(() => '')))
  return out.filter(Boolean)
}

// ------------------------------------------------------------------ the tools

const articleList = (): string => ARTICLES.map((a) => `- ${a.id} — ${a.title}: ${a.summary}`).join('\n')

const ANSWER_FROM_THIS =
  "Answer the user from this, in their language and your own words. Keep the names of pages and buttons as written (Models → API), and keep links like [Models → API](page:models/api) and [title](help:id): a click on them opens that page or article. Keys and passwords are typed by the user on the page; never ask for one in the chat."

const ANSWER_FROM_THIS_SHORT = "Answer from this in the user's language. Keep page names and links like [Models → API](page:models/api) as written. Keys are typed by the user on the page, never in the chat."

/** What a tool may return in low-power mode before the chat machinery cuts it (RESULT_SMALL in agent.ts is 1800). */
const LITE_RESULT = 1750

export const appTools: ToolDef[] = [
  {
    name: 'maris_help',
    risk: 'read',
    description:
      'Look up how the Maris app works and how to do something in it (API models such as Claude or GPT, models, connectors, skills, phone app, updates, settings, problems). Returns the text of the app\'s own Help and what is set up right now. Call it before you answer any question about Maris, "this app" or what you can do, such as "how do I connect Claude?", "can you make videos?", "how do I use you on my phone?". Pass the question as topic, in English; without a topic it lists every article.',
    parameters: schema({ topic: { type: 'string', description: 'What the user wants to know or do, in English, e.g. "connect Claude with an API key", "phone app", "dark theme"; or an article id' } }),
    async prepare(args) {
      const topic = String(args.topic ?? args.question ?? args.query ?? '').trim()
      return { risk: 'read', title: topic ? `Look up in Maris help: ${topic.slice(0, 80)}` : 'Look at the Maris help' }
    },
    async run(args, ctx) {
      const topic = String(args.topic ?? args.question ?? args.query ?? '').trim()
      const cfg = ctx.settings
      if (!topic) {
        return [`Maris ${app.getVersion()}, the app you are the assistant of. Its help articles (call maris_help again with a topic or an id to read one):`, articleList(), '', 'maris_status tells what is set up right now.'].join('\n')
      }
      const hits = articleById(topic.toLowerCase()) ? [articleById(topic.toLowerCase())!] : searchHelp(ARTICLES, topic)
      const main = hits[0]
      if (!main) return `No help article matches "${topic}". Try other words, or pick one of these by id:\n${articleList()}`
      // A slow computer reads a few dozen words a second, and what a tool returns is cut short for it
      // (LITE_RESULT): it gets the part of the article that answers the question, and the page and the
      // facts are sized first so that they are never the part that is cut.
      const lite = isLite(cfg)
      const tail: string[] = []
      const where = WHERE[main.id]?.() ?? []
      if (where.length) tail.push(`Where in the app: ${(lite ? where.slice(0, 2) : where).join(', ')}.`)
      const now = await facts((NOW[main.id] ?? []).slice(0, lite ? 1 : 9), cfg)
      if (now.length) tail.push(`Right now in this copy of Maris:\n${now.map((l) => `- ${l}`).join('\n')}`)
      const more = hits.slice(1, 4)
      if (more.length && !lite) tail.push(`Related articles: ${more.map((a) => `${a.id} (${a.title})`).join('; ')}.`)
      tail.push(lite ? ANSWER_FROM_THIS_SHORT : ANSWER_FROM_THIS)
      const part = excerpt(main, topic, lite ? Math.max(600, LITE_RESULT - tail.join('\n\n').length - 200) : 7000)
      const out = [part.text]
      if (part.left.length) out.push(lite ? `(More in this article: ${part.left.slice(0, 4).join('; ')}.)` : `(Left out of this article: ${part.left.join('; ')}. To read one, call maris_help with "${main.id}" and its heading.)`)
      return [...out, ...tail].join('\n\n')
    }
  },
  {
    name: 'maris_status',
    risk: 'read',
    description:
      'See what is set up in Maris right now: version, models and their roles, API services, connectors, skills, memory, phone link, approvals, updates. Use it for questions like "which models do I have?", "is Claude connected?", "what version are you?", "is my phone linked?". How to change any of it: maris_help.',
    parameters: schema({ about: { type: 'string', description: 'Optional: only this part, e.g. "models", "api", "connectors", "phone", "updates"' } }),
    async prepare(args) {
      return { risk: 'read', title: args.about ? `Look at what is set up in Maris: ${String(args.about).slice(0, 60)}` : 'Look at what is set up in Maris' }
    },
    async run(args, ctx) {
      const about = String(args.about ?? '').toLowerCase()
      const wanted = ALL_FACTS.filter((k) => about.includes(k) || (k === 'local' && /model|ollama/.test(about)) || (k === 'api' && /claude|gpt|service|key|cloud/.test(about)) || (k === 'media' && /picture|image|video/.test(about)) || (k === 'approvals' && /approv/.test(about)) || (k === 'updates' && /version/.test(about)))
      // On a slow computer a long result is cut short: leave out what is asked about least.
      const everything = isLite(ctx.settings) ? ALL_FACTS.filter((k) => k !== 'terminal' && k !== 'data' && k !== 'media') : ALL_FACTS
      const lines = await facts(wanted.length ? wanted : everything, ctx.settings)
      return `${lines.map((l) => `- ${l}`).join('\n')}\n\nHow to change any of this: maris_help. Settings themselves: maris_settings.`
    }
  }
]
