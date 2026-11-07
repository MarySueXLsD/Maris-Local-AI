import type { ChatMode, Settings, ToolRisk } from '@shared/types'
import type { OllamaTool } from '../engines/ollama'
import { codeTools } from './code'
import { fsTools } from './fs'
import { mediaTools } from './media'
import { memoryTools } from './memory'
import { shellTools } from './shell'
import { systemTools } from './system'
import type { ToolDef } from './types'
import { webTools } from './web'
import { connectors } from '../connectors/connectors'
import { skills } from '../skills/skills'

const ALL: ToolDef[] = [...fsTools, ...shellTools, ...codeTools, ...systemTools, ...webTools, ...memoryTools, ...mediaTools]

/** Tools that only make sense while working on a project. */
const CODE_ONLY = new Set(['project_tree', 'grep', 'multi_edit', 'start_process', 'process_output', 'stop_process', 'dev_environment', 'update_plan'])
/** Tools that add noise when coding. */
const CHAT_ONLY = new Set(['set_clipboard', 'search_files'])

export function activeTools(s: Settings, opts: { webAccess: boolean; mode: ChatMode }): ToolDef[] {
  const own = ALL.filter((t) => {
    if (t.enabled && !t.enabled(s)) return false
    if (!opts.webAccess && t.risk === 'network') return false
    if (opts.mode !== 'code' && CODE_ONLY.has(t.name)) return false
    if (opts.mode === 'code' && CHAT_ONLY.has(t.name)) return false
    return true
  })
  // Skills the person installed, and tools of connected services (GitHub, Notion, …).
  return [...own, ...(s.extensions.skills ? skills.tools() : []), ...(s.extensions.connectors ? connectors.tools() : [])]
}

export const findTool = (name: string): ToolDef | undefined =>
  ALL.find((t) => t.name === name) ?? skills.tools().find((t) => t.name === name) ?? (name.startsWith('mcp_') ? connectors.find(name) : undefined)

export const toOllamaTools = (defs: ToolDef[]): OllamaTool[] =>
  defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }))

/** Only changes to the PC need a click; reading, web lookups and media generation run directly. */
export const needsApproval = (risk: ToolRisk): boolean => risk === 'change' || risk === 'system'

/** File-changing tools that "auto-approve edits in this project" may cover (never deletes). */
export const EDIT_TOOLS = new Set(['write_file', 'write_files', 'edit_file', 'multi_edit', 'make_dir', 'copy_path', 'move_path'])
