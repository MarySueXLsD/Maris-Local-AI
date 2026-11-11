// Declarative list of every user-facing setting. The Settings page renders from it, search runs over it,
// and tests/settings-schema.test.ts checks that every key in DEFAULT_SETTINGS appears here.

// The computer's OS from the preload bridge (absent in unit tests, which describe Windows).
const HOST = (globalThis as { maris?: { platform?: string } }).maris?.platform ?? 'win32'
const IS_WIN = HOST === 'win32'
const IS_MAC = HOST === 'darwin'
const DEVICE = IS_MAC ? 'Mac' : 'PC'
const OS_NAME = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'
const MAC_KEYS = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad/.test(navigator.userAgent)
const keys = (key: string): string => (MAC_KEYS ? `⌘${key}` : `Ctrl+${key}`)

export type SettingType =
  | 'switch'
  | 'segmented'
  | 'select'
  | 'slider'
  | 'number'
  | 'text'
  | 'secret'
  | 'textarea'
  | 'color'
  | 'hexcolor'
  | 'palette'
  | 'folder'
  | 'model'
  | 'pack'
  | 'hotkey'

export interface SettingDef {
  path: string
  section: SectionId
  label: string
  hint?: string
  type: SettingType
  options?: { value: string | number; label: string }[]
  min?: number
  max?: number
  step?: number
  unit?: string
  /** For sliders: how to show the value. */
  format?: 'percent' | 'ctx' | 'plain' | 'speed'
  placeholder?: string
  /** Number settings that may be left empty ("use the model's default"). */
  optional?: boolean
  emptyLabel?: string
  /** For model/pack pickers: which role filters the list. */
  role?: string
  /** Shown only when another setting has a given value. */
  when?: { path: string; equals: unknown }
  keywords?: string
  /** Group heading inside a section. */
  group?: string
  /** Help article that explains this setting (opens from the row). */
  help?: string
}

export type SectionId =
  | 'appearance'
  | 'assistant'
  | 'routing'
  | 'generation'
  | 'engine'
  | 'access'
  | 'memory'
  | 'web'
  | 'media'
  | 'status'
  | 'window'
  | 'updates'
  | 'extensions'
  | 'phone'
  | 'data'

export const SECTIONS: { id: SectionId; title: string; description: string }[] = [
  { id: 'appearance', title: 'Appearance', description: 'Theme, colour, text size and how chats are laid out.' },
  { id: 'assistant', title: 'Assistant', description: 'How Maris addresses you, how long its answers are, and how you send messages.' },
  { id: 'routing', title: 'Auto model choice', description: `Which model answers each message, and when Maris steps down to keep your ${DEVICE} responsive.` },
  { id: 'generation', title: 'Generation', description: 'Sampling and placement for each model role. Empty fields use the model’s own defaults.' },
  { id: 'engine', title: 'Engine', description: 'Where models run, how long they stay loaded and how long Maris waits for them.' },
  { id: 'access', title: `${DEVICE} access`, description: `Maris reads freely. Anything that changes your ${DEVICE} waits for your approval, unless you chose to approve it without asking below.` },
  { id: 'memory', title: 'Memory', description: 'What Maris remembers between chats and when it learns.' },
  { id: 'web', title: 'Web', description: 'Searching and reading web pages.' },
  { id: 'media', title: 'Images and video', description: 'Image and video models, default sizes and the ComfyUI engine.' },
  { id: 'status', title: 'Status bar', description: 'The always-visible CPU and GPU readout at the bottom of the window.' },
  { id: 'window', title: 'Window and startup', description: 'Tray, startup and the global shortcut.' },
  { id: 'updates', title: 'Updates and news', description: 'Checking for new versions, news posts, and the Admin page for publishing them.' },
  { id: 'extensions', title: 'Skills and connectors', description: 'Instructions from git and outside services Maris can use.' },
  { id: 'phone', title: 'Phone', description: `Use Maris from your Android phone over your home Wi-Fi. Everything still runs on this ${DEVICE}.` },
  { id: 'data', title: 'Data and setup', description: 'Where models and creations live, backups of these settings, and the setup assistant.' }
]

// Context windows from 4K up to 2M tokens (a model never gets more than it can take). The same sizes
// and names as src/shared/context.ts, written out here because this file has to load without imports
// (tests/context.test.ts checks that the two agree).
const ctxLabel = (n: number): string => {
  const unit = n % 1024 === 0 ? 1024 : 1000
  const round = (x: number): string => String(Math.round(x * 10) / 10)
  return n / unit >= unit ? `${round(n / unit / unit)}M` : `${round(n / unit)}K`
}
const CTX = [4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144, 393216, 524288, 1048576, 2097152].map((n) => ({ value: n, label: ctxLabel(n) }))
const API_CTX = [16384, 32768, 65536, 131072, 200000, 400000, 1000000, 2000000].map((n) => ({ value: n, label: ctxLabel(n) }))

const ROLES = [
  ['fast', 'Fast'],
  ['balanced', 'Balanced'],
  ['max', 'Max'],
  ['code', 'Code']
] as const

const genDefs: SettingDef[] = ROLES.flatMap(([r, title]) => [
  {
    path: `generation.${r}.placement`,
    section: 'generation',
    group: title,
    label: 'Where it runs',
    hint: 'Auto follows the engine setting. GPU forces every layer onto the graphics card; CPU keeps it off the GPU entirely.',
    type: 'segmented',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'gpu', label: 'GPU' },
      { value: 'cpu', label: 'CPU' }
    ],
    keywords: 'num_gpu offload placement layers'
  },
  { path: `generation.${r}.temperature`, section: 'generation', group: title, label: 'Temperature', hint: 'Higher is more creative, lower is more focused.', type: 'number', min: 0, max: 2, step: 0.05, optional: true, emptyLabel: 'Model default', keywords: 'creativity randomness' },
  { path: `generation.${r}.topP`, section: 'generation', group: title, label: 'Top P', hint: 'Considers only the most likely words that add up to this probability.', type: 'number', min: 0, max: 1, step: 0.01, optional: true, emptyLabel: 'Model default', keywords: 'nucleus sampling' },
  { path: `generation.${r}.topK`, section: 'generation', group: title, label: 'Top K', hint: 'Considers only this many of the most likely next words.', type: 'number', min: 0, max: 200, step: 1, optional: true, emptyLabel: 'Model default', keywords: 'sampling' },
  { path: `generation.${r}.repeatPenalty`, section: 'generation', group: title, label: 'Repeat penalty', hint: 'Above 1 discourages repeating itself.', type: 'number', min: 0.5, max: 2, step: 0.01, optional: true, emptyLabel: 'Model default', keywords: 'repetition' },
  { path: `generation.${r}.maxTokens`, section: 'generation', group: title, label: 'Longest answer', hint: 'Upper limit on tokens per answer step.', type: 'number', min: 64, max: 131072, step: 64, unit: 'tokens', optional: true, emptyLabel: 'No limit', keywords: 'num_predict length max tokens' }
])

export const SETTINGS_SCHEMA: SettingDef[] = [
  // ------------------------------------------------------------- appearance
  { path: 'ui.palette', section: 'appearance', group: 'Theme', label: 'Colour theme', hint: 'Pick a look. Neon themes glow; Custom lets you choose every main colour.', type: 'palette', keywords: 'theme neon purple pink sakura midnight forest ember daylight custom colors skin', help: 'themes' },
  { path: 'ui.theme', section: 'appearance', group: 'Theme', label: 'Light or dark', hint: 'For the Maris theme. Other themes have their own.', type: 'segmented', options: [{ value: 'system', label: 'Match Windows' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], keywords: 'dark mode light mode', when: { path: 'ui.palette', equals: 'maris' } },
  { path: 'ui.customTheme.scheme', section: 'appearance', group: 'Custom theme', label: 'Base', hint: 'Whether your theme is dark or light (sets the window buttons and code colours).', type: 'segmented', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }], when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.background', section: 'appearance', group: 'Custom theme', label: 'Background', type: 'hexcolor', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.surface', section: 'appearance', group: 'Custom theme', label: 'Panels', hint: 'Chat area, cards and menus.', type: 'hexcolor', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.text', section: 'appearance', group: 'Custom theme', label: 'Text', type: 'hexcolor', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.accent', section: 'appearance', group: 'Custom theme', label: 'Accent', hint: 'Buttons, selection and your messages.', type: 'hexcolor', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.highlight', section: 'appearance', group: 'Custom theme', label: 'Highlight', hint: 'Live activity: thinking, rendering, approvals.', type: 'hexcolor', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.customTheme.glow', section: 'appearance', group: 'Custom theme', label: 'Neon glow', hint: 'Buttons, focus rings and the logo softly glow in the accent colour.', type: 'switch', when: { path: 'ui.palette', equals: 'custom' } },
  { path: 'ui.accent', section: 'appearance', group: 'Colour and text', label: 'Accent colour', hint: 'Overrides the theme accent. "Theme" keeps the theme\'s own.', type: 'color', keywords: 'color highlight' },
  { path: 'ui.fontScale', section: 'appearance', group: 'Colour and text', label: 'Text size', type: 'slider', min: 0.85, max: 1.4, step: 0.05, format: 'percent', keywords: 'font zoom scale' },
  { path: 'ui.density', section: 'appearance', group: 'Layout', label: 'Density', hint: 'Compact fits more of a conversation on screen.', type: 'segmented', options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }], keywords: 'spacing' },
  { path: 'ui.chatWidth', section: 'appearance', group: 'Layout', label: 'Chat width', hint: 'Grows with the window, so wide and ultrawide screens use more of their width. Full uses all of it.', type: 'segmented', options: [{ value: 'narrow', label: 'Narrow' }, { value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full' }], keywords: 'line length column ultrawide monitor' },
  { path: 'ui.material', section: 'appearance', group: 'Layout', label: 'Window material', hint: IS_WIN ? 'Mica and Acrylic let the desktop colour show through on Windows 11.' : IS_MAC ? 'Mica and Acrylic let the desktop colour show through (macOS vibrancy).' : 'Linux windows are always solid.', type: 'segmented', options: [{ value: 'mica', label: 'Mica' }, { value: 'acrylic', label: 'Acrylic' }, { value: 'solid', label: 'Solid' }], keywords: 'transparency backdrop blur' },
  { path: 'ui.highContrast', section: 'appearance', group: 'Accessibility', label: 'High contrast', hint: 'Solid backgrounds and stronger borders.', type: 'switch', keywords: 'accessibility' },
  { path: 'ui.reduceMotion', section: 'appearance', group: 'Accessibility', label: 'Reduce motion', hint: 'Turns off animations, including the logo slotting in.', type: 'switch', keywords: 'accessibility animation' },
  { path: 'ui.helpTips', section: 'appearance', group: 'Accessibility', label: 'Explain technical words', hint: 'Words such as VRAM or context window get a dotted underline; point at them for a plain-language explanation.', type: 'switch', keywords: 'tooltips hover help glossary beginner', help: 'glossary' },
  { path: 'ui.showThinking', section: 'appearance', group: 'Conversation', label: 'Show thinking while it happens', hint: 'Stream the model’s reasoning as it thinks. It is always available afterwards.', type: 'switch', keywords: 'reasoning' },
  { path: 'ui.showRouteReason', section: 'appearance', group: 'Conversation', label: 'Explain the model choice', hint: 'Pointing at the model name under an answer shows why Auto picked it.', type: 'switch', keywords: 'router reason' },

  // ------------------------------------------------------------- assistant
  { path: 'persona.assistantName', section: 'assistant', group: 'About you', label: 'Assistant name', type: 'text', placeholder: 'Maris', keywords: 'persona' },
  { path: 'persona.userName', section: 'assistant', group: 'About you', label: 'What should Maris call you?', type: 'text', placeholder: 'Your name', keywords: 'persona name' },
  { path: 'persona.responseStyle', section: 'assistant', group: 'About you', label: 'Answer length', type: 'segmented', options: [{ value: 'concise', label: 'Short' }, { value: 'balanced', label: 'Balanced' }, { value: 'detailed', label: 'Detailed' }], keywords: 'verbosity style' },
  { path: 'persona.customInstructions', section: 'assistant', group: 'About you', label: 'Instructions for every chat', hint: 'For example: answer in Russian unless I write in English; keep code in TypeScript.', type: 'textarea', keywords: 'system prompt custom' },
  { path: 'agent.defaultThink', section: 'assistant', group: 'Messages', label: 'Thinking', hint: 'Auto thinks first only for harder tasks.', type: 'segmented', options: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Always' }, { value: 'off', label: 'Never' }], keywords: 'reasoning think' },
  {
    path: 'ui.activityView',
    section: 'assistant',
    group: 'How Maris shows its work',
    label: 'Show work as',
    hint: 'Simple describes each step in plain words and keeps commands and code out of the way, except ones that need your attention. Detailed shows every command, file and change.',
    type: 'segmented',
    options: [
      { value: 'simple', label: 'Simple' },
      { value: 'detailed', label: 'Detailed' }
    ],
    keywords: 'code mode commands hide technical details beginner developer tool cards',
    help: 'code-mode'
  },
  {
    path: 'persona.explain',
    section: 'assistant',
    group: 'How Maris shows its work',
    label: 'Explain things for',
    hint: 'Everyone: plain language, with any jargon explained. Developers: short and technical.',
    type: 'segmented',
    options: [
      { value: 'everyone', label: 'Everyone' },
      { value: 'developer', label: 'Developers' }
    ],
    keywords: 'beginner plain language jargon technical'
  },
  { path: 'ui.sendWithEnter', section: 'assistant', group: 'Messages', label: 'Send with Enter', hint: `Off: Enter adds a new line and ${keys('Enter')} sends.`, type: 'switch', keywords: 'keyboard shortcut' },

  // ------------------------------------------------------------- routing
  { path: 'tiers.fast', section: 'routing', group: 'Models for each role', label: 'Fast', hint: 'Small talk and quick answers.', type: 'model', role: 'chat', keywords: 'tier' },
  { path: 'tiers.balanced', section: 'routing', group: 'Models for each role', label: 'Balanced', hint: 'Everyday questions and writing.', type: 'model', role: 'chat', keywords: 'tier' },
  { path: 'tiers.max', section: 'routing', group: 'Models for each role', label: 'Max', hint: 'Reasoning, coding and multi-step work.', type: 'model', role: 'chat', keywords: 'tier' },
  { path: 'tiers.code', section: 'routing', group: 'Models for each role', label: 'Code', hint: 'Optional dedicated model for Code mode.', type: 'model', role: 'chat', emptyLabel: 'Same as Max', keywords: 'tier coding' },
  { path: 'tiers.tiny', section: 'routing', group: 'Models for each role', label: 'Helper', hint: 'Runs on the CPU for routing, titles and memory upkeep.', type: 'model', role: 'chat', keywords: 'tier tiny utility' },
  { path: 'tiers.embed', section: 'routing', group: 'Models for each role', label: 'Memory search', hint: 'Embedding model that finds relevant memories.', type: 'model', role: 'embed', keywords: 'embedding' },
  { path: 'routing.preferSpeed', section: 'routing', group: 'Choosing', label: 'Lean toward', hint: 'Left picks bigger models more often; right answers faster.', type: 'slider', min: 0, max: 1, step: 0.1, format: 'speed', keywords: 'quality speed balance' },
  { path: 'routing.smartClassifier', section: 'routing', group: 'Choosing', label: 'Ask the helper model when unsure', hint: 'For ambiguous messages a tiny model on the CPU grades difficulty (adds about half a second).', type: 'switch' },
  { path: 'routing.learnFromFeedback', section: 'routing', group: 'Choosing', label: 'Learn from my ratings', hint: 'Thumbs and “try another model” nudge future choices.', type: 'switch', keywords: 'feedback learning' },
  { path: 'routing.preferLoaded', section: 'routing', group: 'Choosing', label: 'Prefer a model that is already loaded', hint: 'On borderline messages, avoid a reload.', type: 'switch' },
  { path: 'routing.allowCpuFallback', section: 'routing', group: 'Stepping down', label: 'Use the CPU when the GPU is full', hint: 'Keeps chat working while images render or a game runs.', type: 'switch', keywords: 'fallback' },
  { path: 'routing.stepDownOnBattery', section: 'routing', group: 'Stepping down', label: 'Use lighter models on battery', type: 'switch', keywords: 'laptop power' },
  { path: 'routing.busyGpuPercent', section: 'routing', group: 'Stepping down', label: 'Other apps count as heavy GPU load above', type: 'slider', min: 10, max: 100, step: 5, unit: '%', format: 'plain', keywords: 'game busy threshold' },
  { path: 'routing.busyVramGB', section: 'routing', group: 'Stepping down', label: 'Other apps count as heavy VRAM use above', type: 'slider', min: 1, max: 32, step: 1, unit: 'GB', format: 'plain', keywords: 'game busy threshold memory' },
  { path: 'routing.contextByTier.fast', section: 'routing', group: 'Context windows', label: 'Fast', type: 'select', options: CTX, keywords: 'context num_ctx' },
  { path: 'routing.contextByTier.balanced', section: 'routing', group: 'Context windows', label: 'Balanced', type: 'select', options: CTX, keywords: 'context num_ctx' },
  { path: 'routing.contextByTier.max', section: 'routing', group: 'Context windows', label: 'Max', hint: `Sizes go up to 2M tokens; a model never gets more than it takes, and a very large window needs a lot of memory on this ${DEVICE}. The context ring next to Send shows what each size costs here.`, type: 'select', options: CTX, keywords: 'context num_ctx million 1m 2m large big window' },
  { path: 'routing.contextByTier.tiny', section: 'routing', group: 'Context windows', label: 'Helper', type: 'select', options: CTX, keywords: 'context num_ctx' },
  { path: 'routing.apiContext', section: 'routing', group: 'Context windows', label: 'Models at an API service', hint: 'How much of a long conversation is sent with each message before older messages are summarised, up to 2M tokens. A model never gets more than it takes. More keeps more in view and costs more per message, because a full window is sent again every time.', type: 'select', options: API_CTX, keywords: 'context api cloud claude gpt gemini tokens cost budget million 1m 2m large big window' },
  { path: 'routing.codeContext', section: 'routing', group: 'Context windows', label: 'Code mode', hint: 'Longer windows hold more files and steps but need more video memory; what does not fit runs from system memory, which is slower. The context ring next to Send shows what each size costs on this PC.', type: 'select', options: CTX, keywords: 'context num_ctx' },

  // ------------------------------------------------------------- generation
  ...genDefs,

  // ------------------------------------------------------------- engine
  {
    path: 'engine.processing',
    section: 'engine',
    label: 'Where models run',
    hint: 'GPU only is fastest. GPU + CPU lets bigger models overflow into RAM. CPU only needs no graphics card.',
    type: 'segmented',
    options: [
      { value: 'gpu', label: 'GPU only' },
      { value: 'hybrid', label: 'GPU + CPU' },
      { value: 'cpu', label: 'CPU only' }
    ],
    keywords: 'offload hybrid processing'
  },
  {
    path: 'engine.profile',
    section: 'engine',
    label: 'Low-power mode',
    hint: `For slow computers: short instructions, only the tools a request needs, no extra model calls and a lighter interface, so a small model answers as quickly as this ${DEVICE} allows. Auto turns it on when the hardware scan finds no usable graphics card and little memory or few cores. Models at an API service are never held back by it.`,
    type: 'segmented',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'lite', label: 'On' },
      { value: 'standard', label: 'Off' }
    ],
    keywords: 'slow old pc laptop cpu only performance lite weak speed faster low end light'
  },
  { path: 'engine.keepAliveMin', section: 'engine', label: 'Keep models loaded for', hint: 'After the last use. 0 frees memory right away; follow-up questions then wait for a reload.', type: 'number', min: 0, max: 1440, step: 5, unit: 'min', keywords: 'keep_alive unload' },
  { path: 'engine.cpuThreads', section: 'engine', label: 'CPU threads', hint: '0 lets Ollama decide.', type: 'number', min: 0, max: 128, step: 1, keywords: 'num_thread cores' },
  { path: 'engine.gpuReserveMB', section: 'engine', label: 'VRAM to leave free', hint: `For ${OS_NAME}, your browser and games.`, type: 'number', min: 0, max: 16384, step: 50, unit: 'MB', keywords: 'reserve memory' },
  { path: 'engine.firstTokenTimeoutSec', section: 'engine', label: 'Wait for a model to start answering', hint: 'Large models can take minutes to load the first time.', type: 'number', min: 30, max: 1800, step: 10, unit: 's', keywords: 'timeout' },
  { path: 'engine.idleTimeoutSec', section: 'engine', label: 'Give up when a model goes silent for', type: 'number', min: 30, max: 1800, step: 10, unit: 's', keywords: 'timeout stall' },
  { path: 'engine.stopOllamaOnQuit', section: 'engine', label: 'Stop Ollama when Maris closes', hint: 'Closing Maris always unloads its models, so no video memory stays in use. On: the Ollama server is stopped too (Maris starts it again next time). Off: Ollama keeps running for other programs.', type: 'switch', keywords: 'quit exit close vram video memory server background free' },
  { path: 'usage.track', section: 'engine', group: 'API models', label: 'Keep a record of API use', hint: `Counts the tokens each model at an API service uses and what that costs, per day. Shown on Models → API and under each answer. The record stays on this ${DEVICE}.`, type: 'switch', keywords: 'usage cost price tokens spend bill money claude gpt api', help: 'api-models' },
  { path: 'usage.priceLookup', section: 'engine', group: 'API models', label: 'Look up list prices', hint: 'Once a day, while a service on the internet is set up, Maris reads the makers’ current prices from the public list at openrouter.ai. Nothing about you, your key or your chats is sent. Off: Maris uses the prices it shipped with, the ones a service gives itself and the ones you set.', type: 'switch', keywords: 'price pricing cost list online openrouter update', help: 'api-models' },
  { path: 'usage.monthlyBudget', section: 'engine', group: 'API models', label: 'Monthly guide for API costs', hint: 'Maris tells you in the chat when this month’s estimated API costs pass 80% and then 100% of this amount. It never stops answering because of it. 0: no guide.', type: 'number', min: 0, max: 100000, step: 1, unit: '$', keywords: 'budget limit spend cost money warning monthly', help: 'api-models' },
  { path: 'ollamaUrl', section: 'engine', label: 'Ollama address', hint: 'Change only if Ollama runs on another port or computer.', type: 'text', placeholder: 'http://127.0.0.1:11434', keywords: 'url host port server' },

  // ------------------------------------------------------------- access
  { path: 'agent.autoApprove.everything', section: 'access', group: 'Approve without asking', label: 'Everything, everywhere', hint: 'Every change in every chat happens without asking, until you turn this off. Only for when you trust everything Maris reads, including web pages and files.', type: 'switch', keywords: 'auto approve always allow trust permission skip ask', help: 'approvals' },
  { path: 'agent.autoApprove.files', section: 'access', group: 'Approve without asking', label: 'Creating and editing files', hint: 'In every chat. Files in system folders still ask.', type: 'switch', keywords: 'auto approve always allow write edit' },
  { path: 'agent.autoApprove.delete', section: 'access', group: 'Approve without asking', label: `Moving files to the ${IS_WIN ? 'Recycle Bin' : 'Trash'}`, hint: 'In every chat. Files in system folders still ask.', type: 'switch', keywords: 'auto approve always allow delete remove' },
  { path: 'agent.autoApprove.commands', section: 'access', group: 'Approve without asking', label: 'Running commands', hint: 'Commands, scripts and background processes, in every chat.', type: 'switch', keywords: 'auto approve always allow shell terminal' },
  { path: 'agent.autoApprove.programs', section: 'access', group: 'Approve without asking', label: 'Opening and closing programs', type: 'switch', keywords: 'auto approve always allow apps kill' },
  { path: 'agent.autoApprove.clipboard', section: 'access', group: 'Approve without asking', label: 'Copying to the clipboard', type: 'switch', keywords: 'auto approve always allow copy' },
  { path: 'agent.autoApprove.memory', section: 'access', group: 'Approve without asking', label: 'Changing memories', hint: 'Forgetting things Maris remembers.', type: 'switch', keywords: 'auto approve always allow forget' },
  { path: 'agent.autoRunReadOnlyCommands', section: 'access', label: 'Run read-only commands without asking', hint: `Commands such as ${IS_WIN ? 'Get-ChildItem, ipconfig' : 'ls, df'} or git status run straight away. Anything Maris cannot prove is read-only still asks.`, type: 'switch', keywords: 'approval powershell' },
  { path: 'agent.fullControl', section: 'access', label: `Full control of this ${DEVICE}`, hint: `Lets Maris run things as administrator (${IS_WIN ? 'Windows asks with its permission prompt' : 'the system asks for your password'}) and use the mouse and keyboard in other programs. Every action still waits for your approval, unless you approve everything automatically. When this is off, Maris asks for it in the chat when a task needs it.`, type: 'switch', keywords: 'admin administrator elevated uac root sudo mouse keyboard click type desktop automation control windows' },
  { path: 'agent.maxSteps', section: 'access', label: 'Most steps per answer', hint: '0 means no limit: Maris keeps working until the task is done. A number makes it pause after that many steps and ask you to continue.', type: 'number', min: 0, max: 500, step: 1, keywords: 'tool loop limit unlimited steps stop' },
  { path: 'agent.commandTimeoutSec', section: 'access', label: 'Default command time limit', type: 'number', min: 5, max: 1800, step: 5, unit: 's', keywords: 'timeout powershell' },
  { path: 'agent.autoCompact', section: 'access', label: 'Summarise long conversations automatically', hint: 'Older messages are folded into a summary instead of being dropped.', type: 'switch', keywords: 'compaction context' },
  { path: 'agent.compactAt', section: 'access', label: 'Summarise when the context is this full', type: 'slider', min: 0.5, max: 0.98, step: 0.02, format: 'percent', keywords: 'compaction threshold', when: { path: 'agent.autoCompact', equals: true } },

  // ------------------------------------------------------------- memory
  { path: 'memory.enabled', section: 'memory', label: 'Use memories in chats', type: 'switch', keywords: 'remember' },
  { path: 'memory.autoLearn', section: 'memory', label: 'Learn from conversations', hint: 'After a chat goes quiet, a model that is already loaded saves durable facts and preferences.', type: 'switch', keywords: 'learning' },
  { path: 'memory.learnAfterSec', section: 'memory', label: 'Learn after a chat is quiet for', type: 'number', min: 5, max: 3600, step: 5, unit: 's', when: { path: 'memory.autoLearn', equals: true } },
  { path: 'memory.maxInPrompt', section: 'memory', label: 'Memories added to each chat', type: 'number', min: 0, max: 50, step: 1, keywords: 'context' },

  // ------------------------------------------------------------- web
  { path: 'web.enabled', section: 'web', label: 'Allow web search and browsing', type: 'switch', keywords: 'internet' },
  { path: 'web.provider', section: 'web', label: 'Search with', hint: 'DuckDuckGo needs no account. Brave and SearXNG are more reliable if you have them.', type: 'segmented', options: [{ value: 'duckduckgo', label: 'DuckDuckGo' }, { value: 'brave', label: 'Brave API' }, { value: 'searxng', label: 'SearXNG' }], keywords: 'search engine' },
  { path: 'web.braveKey', section: 'web', label: 'Brave Search API key', type: 'secret', when: { path: 'web.provider', equals: 'brave' } },
  { path: 'web.searxngUrl', section: 'web', label: 'SearXNG address', type: 'text', placeholder: 'http://localhost:8080', when: { path: 'web.provider', equals: 'searxng' } },
  { path: 'web.maxResults', section: 'web', label: 'Results per search', type: 'number', min: 1, max: 20, step: 1 },
  { path: 'web.pageChars', section: 'web', label: 'Longest page Maris reads', hint: 'Characters of page text passed to the model.', type: 'number', min: 2000, max: 16000, step: 1000, unit: 'characters' },
  { path: 'web.thumbnails', section: 'web', label: 'Show page thumbnails in chat', type: 'switch', keywords: 'screenshot preview' },

  // ------------------------------------------------------------- media
  { path: 'media.roles.imageFast', section: 'media', group: 'Models', label: 'Images, fast', type: 'pack', role: 'image', emptyLabel: 'Automatic' },
  { path: 'media.roles.imageQuality', section: 'media', group: 'Models', label: 'Images, quality', type: 'pack', role: 'image', emptyLabel: 'Automatic' },
  { path: 'media.roles.videoFast', section: 'media', group: 'Models', label: 'Video, fast', type: 'pack', role: 'video', emptyLabel: 'Automatic' },
  { path: 'media.roles.videoQuality', section: 'media', group: 'Models', label: 'Video, quality', type: 'pack', role: 'video', emptyLabel: 'Automatic' },
  { path: 'media.imageWidth', section: 'media', group: 'Defaults', label: 'Picture width', type: 'number', min: 256, max: 2048, step: 16, unit: 'px', keywords: 'size resolution' },
  { path: 'media.imageHeight', section: 'media', group: 'Defaults', label: 'Picture height', type: 'number', min: 256, max: 2048, step: 16, unit: 'px', keywords: 'size resolution' },
  { path: 'media.videoSeconds', section: 'media', group: 'Defaults', label: 'Clip length', type: 'number', min: 1, max: 10, step: 1, unit: 's', keywords: 'duration' },
  { path: 'media.autoUnloadLlm', section: 'media', group: 'Engine', label: 'Free GPU memory before rendering', hint: 'Unloads chat models so image and video models get the whole GPU. Chat continues on the CPU meanwhile.', type: 'switch', keywords: 'vram unload' },
  {
    path: 'media.vramMode',
    section: 'media',
    group: 'Engine',
    label: 'ComfyUI memory mode',
    hint: 'Auto suits most PCs. Low and None trade speed for running big models on small GPUs. Applies the next time ComfyUI starts.',
    type: 'select',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'high', label: 'High (keep models in VRAM)' },
      { value: 'normal', label: 'Normal' },
      { value: 'low', label: 'Low (offload aggressively)' },
      { value: 'none', label: 'None (everything from RAM)' },
      { value: 'cpu', label: 'CPU only' }
    ],
    keywords: 'lowvram novram highvram'
  },
  { path: 'media.autoStart', section: 'media', group: 'Engine', label: 'Start ComfyUI with Maris', hint: 'The first picture after launch is then quicker.', type: 'switch' },
  { path: 'media.stopAfterIdleMin', section: 'media', group: 'Engine', label: 'Stop ComfyUI after it is idle for', hint: '0 keeps it running.', type: 'number', min: 0, max: 1440, step: 5, unit: 'min' },
  { path: 'media.extraArgs', section: 'media', group: 'Engine', label: 'Extra ComfyUI launch options', hint: 'Advanced, for example --fast or --use-sage-attention.', type: 'text', placeholder: '--fast', keywords: 'arguments flags' },
  { path: 'media.outputDir', section: 'media', group: 'Engine', label: 'Save creations to', type: 'folder', emptyLabel: 'Data folder → outputs', keywords: 'output folder gallery' },
  { path: 'comfyUrl', section: 'media', group: 'Engine', label: 'ComfyUI address', type: 'text', placeholder: 'http://127.0.0.1:8188', keywords: 'url port' },

  // ------------------------------------------------------------- status bar
  { path: 'ui.status.load', section: 'status', label: 'Load level', hint: 'Idle, light, busy or heavy, as the router sees it. CPU and GPU usage are always shown.', type: 'switch' },
  { path: 'ui.status.ram', section: 'status', label: 'System memory', type: 'switch' },
  { path: 'ui.status.vram', section: 'status', label: 'Video memory', type: 'switch', keywords: 'vram' },
  { path: 'ui.status.temp', section: 'status', label: 'GPU temperature', type: 'switch' },
  { path: 'ui.status.power', section: 'status', label: 'GPU power draw', type: 'switch', keywords: 'watts' },
  { path: 'ui.status.models', section: 'status', label: 'Loaded models', type: 'switch' },
  { path: 'system.monitorIntervalSec', section: 'status', label: 'Update every', type: 'number', min: 1, max: 30, step: 1, unit: 's', keywords: 'refresh interval' },

  // ------------------------------------------------------------- window
  {
    path: 'ui.closeToTray',
    section: 'window',
    label: IS_MAC ? 'Keep running in the menu bar when closed' : 'Keep running in the tray when closed',
    hint: `Off: closing the window closes Maris completely and frees the graphics card's memory (it asks first if an answer, a picture or a download is still going). On: Maris stays in the ${IS_MAC ? 'menu bar' : 'tray'} for the shortcut, the phone app and the maris command, and lets go of video memory about a minute after its window closes.`,
    type: 'switch',
    keywords: 'quit exit close background vram memory tray minimize'
  },
  { path: 'ui.launchAtLogin', section: 'window', label: `Start with ${OS_NAME}`, type: 'switch', keywords: 'autostart login' },
  { path: 'ui.hotkey', section: 'window', label: 'Shortcut to show Maris from anywhere', hint: 'Electron accelerator names, for example Control+Shift+Space or Alt+A.', type: 'hotkey', keywords: 'keyboard global' },

  // ------------------------------------------------------------- updates and news
  { path: 'updates.check', section: 'updates', label: 'Check for new versions', hint: 'While you are online. Nothing is installed until you choose to.', type: 'switch', keywords: 'update upgrade version release' },
  { path: 'updates.autoDownload', section: 'updates', label: 'Get new versions ready in the background', hint: 'Downloads and checks a new version as soon as it is out, so "Restart and update" takes about a minute. It installs only when you click.', type: 'switch', keywords: 'update download automatic background' },
  { path: 'updates.news', section: 'updates', label: 'Show news posts', hint: 'Posts from the makers of Maris in Updates & news.', type: 'switch', keywords: 'blog news posts feed' },
  { path: 'updates.intervalHours', section: 'updates', label: 'Check every', type: 'number', min: 1, max: 168, step: 1, unit: 'h', keywords: 'interval hours' },
  { path: 'updates.repo', section: 'updates', label: 'Where updates and news come from', hint: 'A GitHub repository (owner/name) with releases and a news folder.', type: 'text', keywords: 'github repository source feed' },
  { path: 'updates.admin', section: 'updates', label: 'Show the Admin page', hint: 'For writing and publishing posts. Publishing needs a GitHub token that may write to the repository.', type: 'switch', keywords: 'admin publish blog write' },

  // ------------------------------------------------------------- skills and connectors
  { path: 'extensions.skills', section: 'extensions', label: 'Let Maris use skills', hint: 'Installed on the Skills page.', type: 'switch', keywords: 'skills git instructions' },
  { path: 'extensions.connectors', section: 'extensions', label: 'Let Maris use connectors', hint: 'Set up on the Connectors page. Changes in a service wait for your approval.', type: 'switch', keywords: 'connectors mcp github notion services' },
  { path: 'agent.autoApprove.connectors', section: 'access', group: 'Approve without asking', label: 'Actions in connected services', hint: 'Changes in GitHub, Notion and other connectors, in every chat.', type: 'switch', keywords: 'auto approve connectors mcp' },

  // ------------------------------------------------------------- phone (Maris Link)
  { path: 'link.enabled', section: 'phone', label: 'Allow the phone app to connect', hint: 'Only devices you pair with a one-time code can connect, and everything they send is encrypted.', type: 'switch', keywords: 'android mobile remote link wifi lan' },
  { path: 'link.allowApprovals', section: 'phone', label: 'Approve changes from the phone', hint: `Off: the phone shows what Maris wants to change, but you approve it at this ${DEVICE}.`, type: 'switch', keywords: 'approval remote' },
  { path: 'link.port', section: 'phone', label: 'Network port', hint: 'Change it only if another program already uses 7341.', type: 'number', min: 1024, max: 65535, step: 1, keywords: 'tcp firewall' },

  // ------------------------------------------------------------- data
  { path: 'dataDir', section: 'data', label: 'Data folder', hint: 'Image and video models, the ComfyUI engine and your creations (20–80 GB).', type: 'folder', keywords: 'storage disk' }
]

/** Leaf keys that are not settings a person edits (internal flags). */
export const NOT_EDITABLE = ['onboarded']
