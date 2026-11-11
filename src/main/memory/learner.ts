import { isLite } from '../perf'
import type { ChatMessage, MemoryKind } from '@shared/types'
import { messageText, repo } from '../db'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { log } from '../util'
import { memory } from './store'
import { quickJson } from './utility'

const KINDS: MemoryKind[] = ['fact', 'preference', 'instruction', 'project', 'person', 'skill']
const SECRET_RX =
  /(password|passwd|пароль|api[_ -]?key|secret|token|private key|seed phrase|\b\d{13,19}\b|sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,})/i

const SYSTEM = `You maintain the long-term memory of a personal desktop assistant.
Read the new conversation excerpt and extract only durable, useful knowledge for future conversations:
- fact: stable facts about the user (name, location, job, hardware, software they use)
- preference: how they like answers, tools, styles, languages
- instruction: standing rules for the assistant ("always ...", "never ...")
- project: ongoing projects, goals or deadlines
- person: important people in the user's life or work
- skill: if the assistant completed a task with tools, ONE short generalisable note on the approach that worked
Rules:
- Write each memory as one short sentence in third person ("The user ...").
- Skip one-off requests, small talk, and anything already covered by the existing memories below unless it changes them.
- If a new fact supersedes an existing memory, set "replaces" to that memory's id.
- Never store passwords, keys, card numbers or other secrets.
- At most 5 items. Return {"memories": []} when nothing qualifies.`

const SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          importance: { type: 'number' },
          replaces: { type: 'string' }
        },
        required: ['text', 'kind', 'importance']
      }
    }
  },
  required: ['memories']
}

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const tools = m.parts
        .filter((p) => p.type === 'tool')
        .map((p) => (p.type === 'tool' ? `[tool ${p.call.name} → ${p.call.status}]` : ''))
        .join(' ')
      const text = messageText(m).slice(0, 2500)
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}${tools ? `\n${tools}` : ''}`
    })
    .join('\n\n')
    .slice(-12000)
}

class Learner {
  private timers = new Map<string, NodeJS.Timeout>()
  private running = false

  /** Debounced: learn from a conversation once it has been quiet for a while. */
  // On a slow computer learning waits four times as long: there the one model is better left free for
  // the next message than busy reading the last chat (a message that does arrive stops it anyway).
  schedule(conversationId: string, delayMs = Math.max(5, settings.get().memory.learnAfterSec) * 1000 * (isLite() ? 4 : 1)): void {
    if (!settings.get().memory.enabled || !settings.get().memory.autoLearn) return
    clearTimeout(this.timers.get(conversationId))
    this.timers.set(
      conversationId,
      setTimeout(() => void this.learnFrom(conversationId), delayMs)
    )
  }

  /** After a restart, learn from recent chats that ended before learning could run. */
  catchUp(): void {
    const recent = repo.listConversations().slice(0, 8)
    let delay = 90000
    for (const c of recent) {
      if (repo.getLearnedUntil(c.id) < c.updatedAt - 1000) {
        this.schedule(c.id, delay)
        delay += 30000
      }
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  async learnFrom(conversationId: string): Promise<number> {
    this.timers.delete(conversationId)
    if (this.running || ollama.activeCalls > 0) {
      // Don't compete with a live chat; try again later.
      this.schedule(conversationId, 60000)
      return 0
    }
    const since = repo.getLearnedUntil(conversationId)
    const fresh = repo.listMessages(conversationId).filter((m) => m.createdAt > since && m.status !== 'streaming')
    if (fresh.length < 2 || !fresh.some((m) => m.role === 'user')) return 0
    this.running = true
    try {
      const userText = fresh
        .filter((m) => m.role === 'user')
        .map(messageText)
        .join('\n')
      const related = await memory.search(userText, 10, 0.35)
      const existing = related.length
        ? related.map((r) => `- [${r.memory.id}] ${r.memory.text}`).join('\n')
        : '(none)'
      const out = await quickJson<{
        memories: { text: string; kind: MemoryKind; importance: number; replaces?: string }[]
      }>(SYSTEM, `Existing memories:\n${existing}\n\nNew conversation excerpt:\n${transcript(fresh)}`, SCHEMA)
      let added = 0
      for (const item of out?.memories ?? []) {
        if (!item.text || item.text.length < 8 || SECRET_RX.test(item.text)) continue
        const kind = KINDS.includes(item.kind) ? item.kind : 'fact'
        if (item.replaces && memory.get(item.replaces)) {
          await memory.update(item.replaces, { text: item.text, kind })
          memory.logEvent('memory-merged', `Updated: ${item.text}`)
        } else {
          await memory.add({
            text: item.text,
            kind,
            source: 'learned',
            importance: Number.isFinite(item.importance) ? item.importance : 0.5,
            conversationId
          })
        }
        added++
      }
      const last = fresh[fresh.length - 1]
      repo.setLearnedUntil(conversationId, last.createdAt)
      if (added) log.info('learner', `learned ${added} item(s) from ${conversationId}`)
      return added
    } catch (e) {
      log.warn('learner', e)
      return 0
    } finally {
      this.running = false
    }
  }

  async fromFeedback(message: ChatMessage, value: 1 | -1, note?: string): Promise<void> {
    memory.logEvent('feedback', `${value > 0 ? '👍' : '👎'} on ${message.model ?? 'answer'}${note ? `: ${note}` : ''}`)
    if (value < 0 && note && note.trim().length > 3 && settings.get().memory.enabled) {
      await memory.add({
        text: `The user disliked an answer because: ${note.trim()}`,
        kind: 'preference',
        source: 'feedback',
        importance: 0.75
      })
    }
  }
}

export const learner = new Learner()
