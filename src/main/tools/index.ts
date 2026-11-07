import type { ChatMode, Settings, ToolRisk } from '@shared/types'
import { connectorsInPlay } from '@shared/connectorPresets'
import type { OllamaTool } from '../engines/ollama'
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

export const toOllamaTools = (defs: ToolDef[]): OllamaTool[] =>
  defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }))

/** Only changes to the PC need a click; reading, web lookups and media generation run directly. */
export const needsApproval = (risk: ToolRisk): boolean => risk === 'change' || risk === 'system'

/** File-changing tools that "auto-approve edits in this project" may cover (never deletes). */
export const EDIT_TOOLS = new Set(['write_file', 'write_files', 'edit_file', 'multi_edit', 'make_dir', 'copy_path', 'move_path'])
