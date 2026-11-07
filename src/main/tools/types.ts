import type { ApprovalPreview, ChatMode, InstallInfo, MediaProgress, MediaResult, Settings, ToolRisk } from '@shared/types'

export type Args = Record<string, unknown>

export interface ToolContext {
  conversationId: string
  messageId: string
  signal: AbortSignal
  settings: Settings
  mode: ChatMode
  /** Base folder for relative paths and commands: the project in Code mode, otherwise home. */
  cwd: string
  projectDir?: string
  /** Model currently answering (lets tools know about vision support). */
  modelSupportsVision: boolean
  progress: (text: string) => void
  setPreview: (dataUrl: string) => void
  addMedia: (m: MediaResult) => void
  /** Live state of a picture or video this call is making (shown on its card). */
  setMedia: (m: MediaProgress) => void
  /** Queue an image for the model to look at after this tool returns. */
  attachImageForModel: (base64: string, caption: string) => void
  /** Record where the previous version of a changed file was backed up. */
  reportBackup: (path: string) => void
  /** End the model's turn after this tool (it asked the person something and waits for them). */
  endTurn?: () => void
}

export interface PreparedCall {
  risk: ToolRisk
  title: string
  detail?: string
  preview?: ApprovalPreview
  /** Paths this call changes; used for "inside the project" checks. */
  targets?: string[]
  /** For commands: the prefix the user could choose to always allow. */
  allowPrefix?: string
  /** For installs: download size and disk space, shown with the approval. */
  install?: InstallInfo
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk: ToolRisk
  enabled?: (s: Settings) => boolean
  /** Validate args and describe the action before it runs (and before approval). */
  prepare?: (args: Args, ctx: ToolContext) => Promise<PreparedCall>
  run: (args: Args, ctx: ToolContext) => Promise<string>
}

export class ToolError extends Error {}

export const str = (v: unknown, name: string, required = true): string => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`Missing required argument "${name}"`)
    return ''
  }
  return String(v)
}

export const num = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const bool = (v: unknown, fallback = false): boolean =>
  v === undefined || v === null ? fallback : v === true || v === 'true' || v === 1

export function schema(
  properties: Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required }
}
