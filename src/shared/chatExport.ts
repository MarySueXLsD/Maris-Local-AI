// A chat as a Markdown document ("Export as Markdown"), and the plan for undoing what an answer changed.
// Pure, so tests can load it directly.
import type { ChatMessage, Conversation, Part, ToolCallRecord } from './types'

const when = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
const fileUrl = (p: string): string => encodeURI(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`)

/** A file name for an exported chat, from its title. */
export function exportFileName(title: string, ext: 'md' | 'json'): string {
  const base = title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '')
  return `${base || 'Chat'}.${ext}`
}

/** One line for what an action did. */
function toolLine(c: ToolCallRecord): string {
  const what = c.title ?? c.name.replace(/_/g, ' ')
  const state = c.status === 'denied' ? ' (you said no)' : c.status === 'error' ? ` (failed${c.error ? `: ${c.error}` : ''})` : c.status === 'done' ? '' : ` (${c.status})`
  return `- ${what}${state}`
}

/** The chat as Markdown: who wrote what, when, with the actions as short lists and pictures as links. */
export function chatToMarkdown(conv: Conversation, messages: ChatMessage[]): string {
  const out = [`# ${conv.title}`, '', `${conv.mode === 'code' && conv.projectDir ? `Code mode, project ${conv.projectDir}. ` : ''}Started ${when(conv.createdAt)}, exported from Maris.`, '']
  if (conv.summary) out.push('> **Earlier messages, summarised:**', ...conv.summary.split('\n').map((l) => `> ${l}`), '')
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(`## You · ${when(m.createdAt)}`, '')
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim()
      if (text) out.push(text, '')
      for (const a of m.attachments ?? []) out.push(`*Attached: ${a.name}${a.path ? ` (${a.path})` : ''}*`, '')
      continue
    }
    out.push(`## Maris${m.model ? ` (${m.model})` : ''} · ${when(m.createdAt)}`, '')
    let actions: string[] = []
    const flush = (): void => {
      if (actions.length) out.push(...actions, '')
      actions = []
    }
    for (const p of m.parts) {
      if (p.type === 'tool') actions.push(toolLine(p.call))
      else if (p.type === 'text' && p.text.trim()) {
        flush()
        out.push(p.text.trim(), '')
      } else if (p.type === 'media') {
        flush()
        out.push(p.media.kind === 'image' ? `![${p.media.prompt}](${fileUrl(p.media.path)})` : `[Video: ${p.media.prompt}](${fileUrl(p.media.path)})`, '')
      } else if (p.type === 'notice') {
        flush()
        out.push(`> ${p.text}`, '')
      }
    }
    flush()
    if (m.status === 'error' && m.error) out.push(`> Error: ${m.error}`, '')
    if (m.status === 'stopped') out.push('> Stopped before the end.', '')
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** One step of undoing an answer: put a file back from its backup, remove what it created, move something back. */
export interface UndoStep {
  action: 'restore' | 'remove' | 'remove-folder' | 'move-back' | 'none'
  path: string
  /** restore: the backup; move-back: where the thing is now. */
  from?: string
  /** Shown to the person: what happens, or why it cannot be undone. */
  why: string
}

/** C:\…, \\server\…, /… */
const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)

/** Tools that change things outside files Maris can put back: they are listed, never "undone". */
const NOT_UNDOABLE = new Set(['run_command', 'start_process', 'run_as_admin', 'desktop_action', 'kill_process', 'open_target', 'set_clipboard', 'stop_process'])

/**
 * What undoing an answer would do, latest change first, from the actions it ran: edited files go back to
 * the backup Maris made, files and folders it created go to the Recycle Bin or Trash, moved things move back.
 */
export function undoPlan(calls: ToolCallRecord[], trash = 'Recycle Bin'): UndoStep[] {
  const steps: UndoStep[] = []
  for (const c of [...calls].reverse()) {
    if (c.status !== 'done') continue
    // Only a full path is acted on: a relative one would be read from the wrong folder.
    const given = c.targets?.[0] ?? (typeof c.args.path === 'string' ? c.args.path : '')
    const target = isAbsolute(given) ? given : ''
    switch (c.name) {
      case 'write_file':
        if (c.backup) steps.push({ action: 'restore', path: target, from: c.backup, why: 'Back to how it was before.' })
        // Without a backup it was a new file; a result that mentions one means the record is incomplete.
        else if (target && !/backed up/i.test(c.result ?? '')) steps.push({ action: 'remove', path: target, why: `It did not exist before: it goes to the ${trash}.` })
        else steps.push({ action: 'none', path: given, why: 'No backup was kept of this file.' })
        break
      case 'edit_file':
      case 'multi_edit':
        if (c.backup && target) steps.push({ action: 'restore', path: target, from: c.backup, why: 'Back to how it was before.' })
        else steps.push({ action: 'none', path: given, why: 'No backup was kept of this file.' })
        break
      case 'write_files':
        for (const line of (c.result ?? '').split('\n').reverse()) {
          const r = /^Replaced (.+?) \([^)]*\), backup (.+)$/.exec(line)
          const n = /^Created (.+?) \([^)]*\)$/.exec(line)
          if (r && isAbsolute(r[1]!)) steps.push({ action: 'restore', path: r[1]!, from: r[2]!, why: 'Back to how it was before.' })
          else if (n && isAbsolute(n[1]!)) steps.push({ action: 'remove', path: n[1]!, why: `It did not exist before: it goes to the ${trash}.` })
        }
        break
      case 'make_dir':
        if (target && /^Created folder /.test(c.result ?? '')) steps.push({ action: 'remove-folder', path: target, why: `Removed if it is still empty (to the ${trash}).` })
        break
      case 'copy_path':
        if (target) steps.push({ action: 'remove', path: target, why: `The copy goes to the ${trash}.` })
        break
      case 'move_path': {
        const [from, to] = c.targets ?? []
        if (from && to && isAbsolute(from) && isAbsolute(to) && /^Moved /.test(c.result ?? '')) steps.push({ action: 'move-back', path: from, from: to, why: 'Moved back to where it was.' })
        else steps.push({ action: 'none', path: from ?? '', why: `It was copied to another drive and the original went to the ${trash}: restore it from there.` })
        break
      }
      case 'delete_path':
        steps.push({ action: 'none', path: given, why: `It went to the ${trash}: restore it from there if you want it back.` })
        break
      default:
        if (NOT_UNDOABLE.has(c.name) || c.name.startsWith('mcp_')) steps.push({ action: 'none', path: c.title ?? c.name, why: 'Commands and actions in other programs or services cannot be undone.' })
    }
  }
  return steps
}

const toolCalls = (parts: Part[]): ToolCallRecord[] => parts.flatMap((p) => (p.type === 'tool' ? [p.call] : []))

/** The undo plan for an answer's parts. */
export const answerPlan = (parts: Part[], trash = 'Recycle Bin'): UndoStep[] => undoPlan(toolCalls(parts), trash)

/** Whether "Undo changes" has something to put back in this answer (and it was not undone already). */
export function canUndo(parts: Part[]): boolean {
  if (parts.some((p) => p.type === 'notice' && p.kind === 'undo')) return false
  return answerPlan(parts).some((s) => s.action !== 'none')
}

export interface UndoResult {
  step: UndoStep
  ok: boolean
  error?: string
}

/** What undoing did, in a few sentences: shown in the chat, and the model reads it in later turns. */
export function undoSummary(results: UndoResult[], trash = 'Recycle Bin'): string {
  const did = (...a: UndoStep['action'][]): string[] => results.filter((r) => r.ok && a.includes(r.step.action)).map((r) => r.step.path)
  const out: string[] = []
  const restored = did('restore')
  const removed = did('remove', 'remove-folder')
  const moved = did('move-back')
  if (restored.length) out.push(`Back to how ${restored.length === 1 ? 'it was' : 'they were'} before: ${restored.join(', ')}.`)
  if (removed.length) out.push(`Removed (in the ${trash}): ${removed.join(', ')}.`)
  if (moved.length) out.push(`Moved back: ${moved.join(', ')}.`)
  const failed = results.filter((r) => !r.ok && r.step.action !== 'none')
  if (failed.length) out.push(`Could not undo: ${failed.map((r) => `${r.step.path} (${r.error ?? 'failed'})`).join('; ')}.`)
  const left = results.filter((r) => r.step.action === 'none' && r.step.path)
  if (left.length) out.push(`Left as they are: ${left.map((r) => r.step.path).join(', ')}.`)
  return out.join(' ') || 'There was nothing to undo.'
}
