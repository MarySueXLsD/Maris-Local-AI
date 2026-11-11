import type { ChatMode, Settings, TaskCategory, ToolRisk } from '@shared/types'
import { connectorsInPlay } from '@shared/connectorPresets'
import type { LlmTool } from '../engines/types'
import { codeTools } from './code'
import { controlTools } from './control'
import { fsTools } from './fs'
import { mediaTools } from './media'
import { memoryTools } from './memory'
import { settingsTools } from './settings'
import { shellTools } from './shell'
import { systemTools } from './system'
import { schema, ToolError, type ToolDef } from './types'
import { webTools } from './web'
import { connectors } from '../connectors/connectors'
import { skills } from '../skills/skills'

const ALL: ToolDef[] = [...fsTools, ...shellTools, ...codeTools, ...systemTools, ...webTools, ...memoryTools, ...mediaTools, ...settingsTools, ...controlTools]

/** Tools that only make sense while working on a project. */
const CODE_ONLY = new Set(['project_tree', 'grep', 'multi_edit', 'start_process', 'process_output', 'stop_process', 'dev_environment', 'update_plan'])
/** Tools that add noise when coding. */
const CHAT_ONLY = new Set(['set_clipboard', 'search_files'])

/** What the chat is about, so only the connected services it needs bring their tools. */
export interface ChatToolContext {
  /** The latest request (and a little before it). */
  text: string
  /** Tool names used earlier in the chat, and services passed to use_connector. */
  used: string[]
}

/** Makes a connected service's tools available when the request needs one that was not named. */
function useConnectorTool(names: string[]): ToolDef {
  return {
    name: 'use_connector',
    risk: 'read',
    description: `Make the tools of a connected service available in this chat: ${names.join(', ')}. Call it first when the request needs one of these services; its tools can be used from the next step.`,
    parameters: schema({ service: { type: 'string', description: 'The service', enum: names } }, ['service']),
    async prepare(args) {
      return { risk: 'read', title: `Use ${String(args.service ?? 'a connected service')}` }
    },
    async run(args) {
      const want = String(args.service ?? '').toLowerCase()
      const c = connectors.ready().find((x) => x.name.toLowerCase() === want || x.id.toLowerCase() === want)
      if (!c) throw new ToolError(`No connected service called "${String(args.service)}". Connected: ${names.join(', ')}.`)
      const list = connectors.tools(new Set([c.id])).map((t) => t.name)
      return `${c.name} is ready: its ${list.length} tools can be used from the next step (${list.slice(0, 40).join(', ')}${list.length > 40 ? ', …' : ''}).`
    }
  }
}

export function activeTools(s: Settings, opts: { webAccess: boolean; mode: ChatMode; context?: ChatToolContext }): ToolDef[] {
  const own = ALL.filter((t) => {
    if (t.enabled && !t.enabled(s)) return false
    if (!opts.webAccess && t.risk === 'network') return false
    if (opts.mode !== 'code' && CODE_ONLY.has(t.name)) return false
    if (opts.mode === 'code' && CHAT_ONLY.has(t.name)) return false
    return true
  })
  // Skills the person installed, and tools of connected services (GitHub, Notion, …) this chat needs.
  const extra: ToolDef[] = s.extensions.skills ? skills.tools() : []
  if (s.extensions.connectors) {
    const ready = connectors.ready()
    if (!opts.context) extra.push(...connectors.tools())
    else if (ready.length) {
      const inPlay = connectorsInPlay(ready, opts.context.text, opts.context.used)
      extra.push(...connectors.tools(inPlay))
      const rest = ready.filter((c) => !inPlay.has(c.id)).map((c) => c.name)
      if (rest.length) extra.push(useConnectorTool(rest))
    }
  }
  return [...own, ...extra]
}

export const findTool = (name: string): ToolDef | undefined =>
  ALL.find((t) => t.name === name) ??
  skills.tools().find((t) => t.name === name) ??
  (name.startsWith('mcp_') ? connectors.find(name) : name === 'use_connector' ? useConnectorTool(connectors.ready().map((c) => c.name)) : undefined)

/** Every tool name the assistant could be offered, for matching a misspelled name to a real one. */
export const allToolNames = (): string[] => [...ALL.map((t) => t.name), ...skills.tools().map((t) => t.name), 'use_connector']

/** The first sentence of a description: what the tool is for, without the detail. */
const firstSentence = (text: string): string => {
  const first = /^.*?[.!?](?=\s|$)/.exec(text.replace(/\s+/g, ' ').trim())?.[0] ?? text
  return first.length > 170 ? `${first.slice(0, 167)}…` : first
}

/**
 * Tools in the form models are given them. `brief` (a slow computer) keeps one sentence per tool: every
 * word of a tool list is read again whenever the list changes, at a few dozen words a second there.
 */
export const toLlmTools = (defs: ToolDef[], brief = false): LlmTool[] =>
  defs.map((d) => ({ type: 'function', function: { name: d.name, description: brief ? firstSentence(d.description) : d.description, parameters: d.parameters } }))

/** What each kind of request needs on a slow computer. Everything else stays reachable through run_command. */
const LITE_SETS: Record<'pc' | 'web' | 'media' | 'see' | 'code', string[]> = {
  pc: ['list_dir', 'read_file', 'search_files', 'write_file', 'move_path', 'delete_path', 'run_command', 'open_target', 'system_info'],
  web: ['web_search', 'read_webpage'],
  media: ['generate_image', 'generate_video'],
  see: ['take_screenshot', 'view_image'],
  code: ['project_tree', 'grep', 'read_file', 'write_file', 'write_files', 'edit_file', 'run_command']
}

/** Words that ask for a tool outside the sets above. */
const LITE_HINTS: [RegExp, string[]][] = [
  [/\b(remember|don'?t forget|memor(y|ize|ise)|what do you (know|remember) about me)\b|запомни|помнишь/i, ['remember', 'recall']],
  [/\b(forget (that|this|what))\b|забудь/i, ['recall', 'forget']],
  [/\b(theme|dark mode|light mode|text size|font size|maris settings?|your settings?)\b|настройк|тем(а|у) оформлени/i, ['maris_settings', 'change_maris_settings']],
  [/\bclipboard\b|буфер обмена/i, ['get_clipboard', 'set_clipboard']],
  [/\b(screenshot|my screen|on (the|my) screen)\b|скриншот|на экране/i, ['take_screenshot']],
  [/\b(process(es)?|task manager|running programs?|close (the )?(program|app)|kill)\b|процесс|диспетчер задач/i, ['list_processes', 'kill_process']],
  [/\b(earlier (chat|conversation)|we (talked|spoke) about|last time|previous chat)\b|прошл(ом|ый) (чат|раз)/i, ['search_chats']],
  [/\b(folder|directory|file info|how (big|large) is)\b/i, ['file_info']],
  [/\b(copy|duplicate)\b|скопируй/i, ['copy_path']],
  [/\b(new folder|create (a )?folder|make (a )?folder|mkdir)\b|создай папку/i, ['make_dir']],
  [/\b(edit|change|replace|fix)\b.{0,30}\b(file|text|line)\b|исправь|измени/i, ['edit_file']],
  [/\b(dev server|run (the )?(app|game|server)|start (the )?(app|game|server)|watch)\b/i, ['start_process', 'process_output', 'stop_process']],
  [/\b(plan|steps?|todo)\b/i, ['update_plan']],
  [/\b(install|sdk|compiler|toolchain|dotnet|cargo|haxe|cmake)\b|установ/i, ['dev_environment']],
  [/\b(administrator|admin rights|as admin|elevated|service)\b|администратор/i, ['request_full_control', 'run_as_admin']]
]

/**
 * The few tools a request needs, for a slow computer. `kinds` are the kinds of request this chat has
 * seen (the router's categories, newest last) and `texts` its user messages: a chat that only talks gets
 * no tools at all, one that asked about files keeps the file tools from then on. The set only grows
 * within a chat, because a model re-reads its whole prompt whenever the tool list changes.
 */
export function selectTools(all: ToolDef[], opts: { mode: ChatMode; kinds: TaskCategory[]; texts: string[]; used: string[] }): ToolDef[] {
  const want = new Set<string>()
  const add = (names: string[]): void => names.forEach((n) => want.add(n))
  if (opts.mode === 'code') add(LITE_SETS.code)
  for (const k of opts.kinds) {
    if (k === 'agent') add(LITE_SETS.pc)
    else if (k === 'web') add(LITE_SETS.web)
    else if (k === 'media') add(LITE_SETS.media)
    else if (k === 'vision') add(LITE_SETS.see)
    else if (k === 'code' && opts.mode !== 'code') add(['read_file', 'write_file', 'run_command'])
  }
  const text = opts.texts.join('\n')
  for (const [rx, names] of LITE_HINTS) if (rx.test(text)) add(names)
  // Whatever the chat used before stays, so earlier steps still make sense to the model.
  add(opts.used)
  // Skills the person installed are always on offer, and a connected service the chat named brings its
  // tools (activeTools already narrowed those down to the services this chat is about).
  return all.filter((t) => want.has(t.name) || t.name === 'use_skill' || t.name.startsWith('mcp_') || (t.name === 'use_connector' && want.size > 0))
}

/** Only changes to the PC need a click; reading, web lookups and media generation run directly. */
export const needsApproval = (risk: ToolRisk): boolean => risk === 'change' || risk === 'system'

/** File-changing tools that "auto-approve edits in this project" may cover (never deletes). */
export const EDIT_TOOLS = new Set(['write_file', 'write_files', 'edit_file', 'multi_edit', 'make_dir', 'copy_path', 'move_path'])
