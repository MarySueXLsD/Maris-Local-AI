// Kinds of approval requests and the "always approve" rules the person can turn on.
// Shared by the main process (which applies them) and the interface (which offers and shows them).
// Pure, so tests/approval.test.ts can check the decisions directly.

/** Groups of changes a person can choose to always approve. */
export type ApprovalKind = 'files' | 'delete' | 'commands' | 'programs' | 'clipboard' | 'memory' | 'connectors'

/** What "Always approve" applies to, narrowest first. */
export type ApprovalRule =
  /** This command (by its prefix, e.g. "cargo test") inside this project. */
  | 'prefix'
  /** This kind of request, in every chat. */
  | 'kind'
  /** Everything in this chat until Maris closes. */
  | 'session'
  /** Everything, in every chat, until turned off. */
  | 'everything'

export interface AutoApproveSettings {
  everything: boolean
  files: boolean
  delete: boolean
  commands: boolean
  programs: boolean
  clipboard: boolean
  memory: boolean
  connectors: boolean
}

export const APPROVAL_KINDS: ApprovalKind[] = ['files', 'delete', 'commands', 'programs', 'clipboard', 'memory', 'connectors']

const TOOL_KIND: Record<string, ApprovalKind> = {
  write_file: 'files',
  write_files: 'files',
  edit_file: 'files',
  multi_edit: 'files',
  make_dir: 'files',
  copy_path: 'files',
  move_path: 'files',
  delete_path: 'delete',
  run_command: 'commands',
  run_script: 'commands',
  start_process: 'commands',
  open_target: 'programs',
  kill_process: 'programs',
  set_clipboard: 'clipboard',
  forget: 'memory'
}

/**
 * The kind of an approval request, or undefined when it fits no kind rule. File changes in system
 * folders (risk "system") are their own case: a rule for ordinary file edits never covers them.
 */
export function approvalKind(tool: string, risk: string): ApprovalKind | undefined {
  // Tools of connected services (GitHub, Notion, …) are named mcp_<connector>_<tool>.
  if (tool.startsWith('mcp_')) return 'connectors'
  const kind = TOOL_KIND[tool]
  if (!kind) return undefined
  if ((kind === 'files' || kind === 'delete') && risk === 'system') return undefined
  return kind
}

/** Completes "Always approve …" in the approval box and names the rule in lists. */
export function kindLabel(kind: ApprovalKind, trash = 'Recycle Bin'): string {
  return {
    files: 'creating and editing files',
    delete: `moving files to the ${trash}`,
    commands: 'running commands',
    programs: 'opening and closing programs',
    clipboard: 'copying to the clipboard',
    memory: 'changing memories',
    connectors: 'actions in connected services'
  }[kind]
}

/** Two-word names for the status bar. */
export const KIND_SHORT: Record<ApprovalKind, string> = {
  files: 'file edits',
  delete: 'deleting',
  commands: 'commands',
  programs: 'programs',
  clipboard: 'clipboard',
  memory: 'memories',
  connectors: 'connectors'
}

/**
 * Why a request may run without asking, or undefined when the person must decide. Project rules
 * (Code mode) are checked by the agent itself before this.
 */
/** Requests that always ask, whatever "Always approve" rules are on: Maris changing its own settings. */
export const ALWAYS_ASK = new Set(['change_maris_settings'])

export function autoApproveReason(
  rules: AutoApproveSettings | undefined,
  req: { tool: string; risk: string; inSession: boolean },
  trash = 'Recycle Bin'
): string | undefined {
  if (ALWAYS_ASK.has(req.tool)) return undefined
  if (!rules && !req.inSession) return undefined
  if (rules?.everything) return 'Approved automatically: you approve everything, everywhere.'
  if (req.inSession) return 'Approved automatically: you approve everything in this session.'
  const kind = approvalKind(req.tool, req.risk)
  if (kind && rules?.[kind]) return `Approved automatically: you always approve ${kindLabel(kind, trash)}.`
  return undefined
}

/** True when any rule skips questions for this chat (for the reminder at the bottom of the window). */
export function anyAutoApprove(rules: AutoApproveSettings | undefined, inSession: boolean): boolean {
  return inSession || Boolean(rules && (rules.everything || APPROVAL_KINDS.some((k) => rules[k])))
}
