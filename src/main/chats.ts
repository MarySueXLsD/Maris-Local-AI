// Things done with a whole chat or answer: export it, branch it, undo what an answer changed.
import { shell } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { answerPlan, chatToMarkdown, exportFileName, undoSummary, type UndoResult } from '@shared/chatExport'
import type { Conversation } from '@shared/types'
import { agent } from './agent/agent'
import { repo } from './db'
import { TRASH_LABEL } from './platform'
import { backup } from './tools/fs'
import { backupDir, isInside } from './tools/paths'
import { uid } from './util'

/** A chat as a file: Markdown to read, or JSON with everything in it. */
export function exportChat(id: string, format: 'md' | 'json'): { name: string; content: string } {
  const conv = repo.getConversation(id)
  if (!conv) throw new Error('This chat no longer exists.')
  const messages = repo.listMessages(id).filter((m) => m.status !== 'streaming' && m.status !== 'waiting')
  if (format === 'json') return { name: exportFileName(conv.title, 'json'), content: JSON.stringify({ app: 'Maris', version: 1, conversation: conv, messages }, null, 2) }
  return { name: exportFileName(conv.title, 'md'), content: chatToMarkdown(conv, messages) }
}

/** A new chat with this one's messages up to and including `messageId`, to go on in another direction. */
export function branchChat(messageId: string): Conversation {
  const at = repo.getMessage(messageId)
  const conv = at && repo.getConversation(at.conversationId)
  if (!at || !conv) throw new Error('That message no longer exists.')
  if (at.status === 'streaming' || at.status === 'waiting') throw new Error('Wait until the answer is finished, then branch from it.')
  const all = repo.listMessages(conv.id)
  const upto = all.slice(0, all.findIndex((m) => m.id === messageId) + 1).filter((m) => m.status !== 'streaming' && m.status !== 'waiting')
  const now = Date.now()
  const copy: Conversation = { id: uid(), title: `${conv.title} (branch)`.slice(0, 80), createdAt: now, updatedAt: now, pinned: false, model: conv.model, mode: conv.mode, projectDir: conv.projectDir, autoEdits: false }
  repo.upsertConversation(copy)
  // The summary of earlier messages comes along when everything it covers is in the branch.
  if (conv.summary && conv.summaryUntil !== undefined && conv.summaryUntil <= at.createdAt) {
    repo.setSummary(copy.id, conv.summary, conv.summaryUntil)
    copy.summary = conv.summary
    copy.summaryUntil = conv.summaryUntil
  }
  for (const m of upto) repo.saveMessage({ ...m, id: uid(), conversationId: copy.id, feedback: undefined })
  // What it learned from these messages is in memory already.
  repo.setLearnedUntil(copy.id, upto.at(-1)?.createdAt ?? 0)
  return { ...copy, messageCount: upto.length }
}

/**
 * Undo what an answer changed in files (the window shows the same plan first): edited files go back to
 * Maris's backup (the version being replaced is backed up too), created ones go to the Recycle Bin or
 * Trash, moved ones move back. A note on the answer says what happened; the model reads it later.
 */
export async function undoAnswer(messageId: string): Promise<UndoResult[]> {
  const m = repo.getMessage(messageId)
  if (!m || m.role !== 'assistant') throw new Error('That answer no longer exists.')
  if (agent.isRunning(m.conversationId)) throw new Error('Wait until Maris has finished in this chat.')
  if (m.parts.some((p) => p.type === 'notice' && p.kind === 'undo')) throw new Error('These changes were undone already.')
  const out: UndoResult[] = []
  for (const step of answerPlan(m.parts, TRASH_LABEL)) {
    try {
      if (step.action === 'restore') {
        // Only Maris's own backups are copied back.
        if (!step.from || !isInside(path.resolve(step.from), backupDir()) || !existsSync(step.from)) throw new Error('the backup is gone')
        await backup(step.path)
        await fs.mkdir(path.dirname(step.path), { recursive: true })
        await fs.copyFile(step.from, step.path)
      } else if (step.action === 'remove') {
        if (existsSync(step.path)) await shell.trashItem(step.path)
      } else if (step.action === 'remove-folder') {
        if (existsSync(step.path) && statSync(step.path).isDirectory()) {
          if (readdirSync(step.path).length) throw new Error('it has files in it now, so it was kept')
          await shell.trashItem(step.path)
        }
      } else if (step.action === 'move-back') {
        if (!step.from || !existsSync(step.from)) throw new Error('it is no longer where Maris moved it')
        if (existsSync(step.path)) throw new Error('something else is in its old place now')
        await fs.mkdir(path.dirname(step.path), { recursive: true })
        await fs.rename(step.from, step.path)
      } else {
        out.push({ step, ok: false, error: step.why })
        continue
      }
      out.push({ step, ok: true })
    } catch (e) {
      out.push({ step, ok: false, error: (e as Error).message })
    }
  }
  if (out.some((r) => r.ok)) {
    const fresh = repo.getMessage(messageId)
    if (fresh) {
      fresh.parts.push({ type: 'notice', text: undoSummary(out, TRASH_LABEL), tone: 'info', kind: 'undo' })
      repo.saveMessage(fresh)
      agent.events.emit({ type: 'message', message: structuredClone(fresh) })
    }
  }
  return out
}
