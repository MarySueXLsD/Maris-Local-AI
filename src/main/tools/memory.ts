import type { MemoryKind } from '@shared/types'
import { repo } from '../db'
import { memory } from '../memory/store'
import { num, schema, str, ToolError, type ToolDef } from './types'

const KINDS: MemoryKind[] = ['fact', 'preference', 'instruction', 'project', 'person', 'skill']

export const memoryTools: ToolDef[] = [
  {
    name: 'remember',
    risk: 'read',
    enabled: (s) => s.memory.enabled,
    description:
      'Save a durable fact, preference or instruction about the user to long-term memory. Use when the user tells you something worth remembering or asks you to remember it. Never store passwords or secrets.',
    parameters: schema(
      {
        text: { type: 'string', description: 'One short sentence, e.g. "The user prefers metric units."' },
        kind: { type: 'string', description: 'Memory type', enum: KINDS }
      },
      ['text']
    ),
    async prepare(args) {
      return { risk: 'read', title: `Remember: ${str(args.text, 'text')}` }
    },
    async run(args, ctx) {
      const kind = KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : 'fact'
      const r = await memory.add({
        text: str(args.text, 'text'),
        kind,
        source: 'user',
        importance: 0.75,
        conversationId: ctx.conversationId
      })
      return r.merged ? `Already knew this; reinforced memory ${r.memory.id}.` : `Saved to memory (${r.memory.id}).`
    }
  },
  {
    name: 'recall',
    risk: 'read',
    enabled: (s) => s.memory.enabled,
    description: 'Search long-term memory for what you know about the user or past topics.',
    parameters: schema({ query: { type: 'string', description: 'What to look for' } }, ['query']),
    async prepare(args) {
      return { risk: 'read', title: `Recall: ${str(args.query, 'query')}` }
    },
    async run(args) {
      const hits = await memory.search(str(args.query, 'query'), 10, 0.3)
      if (!hits.length) return 'Nothing relevant in memory.'
      return hits.map((h) => `- [${h.memory.id}] (${h.memory.kind}) ${h.memory.text}`).join('\n')
    }
  },
  {
    name: 'forget',
    risk: 'change',
    enabled: (s) => s.memory.enabled,
    description: 'Delete a memory by id (find ids with recall). The user must approve.',
    parameters: schema({ memory_id: { type: 'string', description: 'Memory id' } }, ['memory_id']),
    async prepare(args) {
      const m = memory.get(str(args.memory_id, 'memory_id'))
      if (!m) throw new ToolError('No memory with that id. Use recall to find the id.')
      return { risk: 'change', title: 'Forget a memory', preview: { kind: 'text', text: m.text } }
    },
    async run(args) {
      return memory.delete(str(args.memory_id, 'memory_id')) ? 'Forgotten.' : 'Memory not found.'
    }
  },
  {
    name: 'search_chats',
    risk: 'read',
    description: 'Full-text search over past conversations with the user.',
    parameters: schema(
      {
        query: { type: 'string', description: 'Words to search for' },
        limit: { type: 'integer', description: 'Max results (default 8)' }
      },
      ['query']
    ),
    async prepare(args) {
      return { risk: 'read', title: `Search past chats: ${str(args.query, 'query')}` }
    },
    async run(args, ctx) {
      const hits = repo
        .searchMessages(str(args.query, 'query'), num(args.limit, 8) + 2)
        .filter((h) => h.conversationId !== ctx.conversationId)
        .slice(0, num(args.limit, 8))
      if (!hits.length) return 'No matching past conversations.'
      return hits.map((h) => `- "${h.title}": ${h.snippet}`).join('\n')
    }
  }
]
