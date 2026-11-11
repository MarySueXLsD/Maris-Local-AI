import { DatabaseSync } from 'node:sqlite'
import type {
  ChatMessage,
  Conversation,
  LearningEvent,
  MediaResult,
  Memory,
  Project
} from '@shared/types'

let db: DatabaseSync

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT 'auto',
  learned_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, message_id UNINDEXED, conversation_id UNINDEXED, tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  pinned INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  conversation_id TEXT,
  embedding BLOB,
  embed_model TEXT
);

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_stats (
  category TEXT NOT NULL,
  tier TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, tier)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_opened INTEGER NOT NULL,
  json TEXT NOT NULL DEFAULT '{}'
);
`

/** Columns added after the first release; created on demand. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['conversations', 'mode', "ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'"],
  ['conversations', 'project_dir', 'ALTER TABLE conversations ADD COLUMN project_dir TEXT'],
  ['conversations', 'auto_edits', 'ALTER TABLE conversations ADD COLUMN auto_edits INTEGER NOT NULL DEFAULT 0'],
  ['conversations', 'summary', 'ALTER TABLE conversations ADD COLUMN summary TEXT'],
  ['conversations', 'summary_until', 'ALTER TABLE conversations ADD COLUMN summary_until INTEGER'],
  ['conversations', 'origin', 'ALTER TABLE conversations ADD COLUMN origin TEXT']
]

export function openDb(path: string): void {
  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name))
    if (!cols.includes(column)) db.exec(ddl)
  }
}

export function closeDb(): void {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
}

type Row = Record<string, unknown>

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    pinned: Number(r.pinned) === 1,
    model: String(r.model),
    mode: r.mode === 'code' ? 'code' : 'chat',
    projectDir: r.project_dir ? String(r.project_dir) : undefined,
    autoEdits: Number(r.auto_edits) === 1,
    summary: r.summary ? String(r.summary) : undefined,
    summaryUntil: r.summary_until ? Number(r.summary_until) : undefined,
    messageCount: r.message_count !== undefined ? Number(r.message_count) : undefined,
    preview: r.preview ? String(r.preview) : undefined,
    origin: r.origin === 'terminal' ? 'terminal' : undefined
  }
}

function toProject(r: Row): Project {
  const extra = JSON.parse(String(r.json || '{}')) as Partial<Project>
  return {
    path: String(r.path),
    name: String(r.name),
    lastOpened: Number(r.last_opened),
    allowedCommands: extra.allowedCommands ?? [],
    stack: extra.stack,
    description: extra.description
  }
}

function toMemory(r: Row): Memory {
  return {
    id: String(r.id),
    text: String(r.text),
    kind: String(r.kind) as Memory['kind'],
    source: String(r.source) as Memory['source'],
    importance: Number(r.importance),
    pinned: Number(r.pinned) === 1,
    uses: Number(r.uses),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: r.last_used_at ? Number(r.last_used_at) : undefined,
    conversationId: r.conversation_id ? String(r.conversation_id) : undefined
  }
}

export function messageText(m: ChatMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'media' ? `[${p.media.kind}: ${p.media.prompt}]` : ''))
    .filter(Boolean)
    .join('\n')
}

/** Escape user text into a safe FTS5 query (quoted terms, implicit AND). */
function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*^():]/g, '').trim())
    .filter((t) => t.length > 1)
    .slice(0, 8)
  return terms.map((t) => `"${t}"*`).join(' ')
}

export const repo = {
  // ------------------------------------------------------------ kv
  getKv<T>(key: string): T | undefined {
    const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined
    return r ? (JSON.parse(String(r.value)) as T) : undefined
  },
  setKv(key: string, value: unknown): void {
    db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      JSON.stringify(value)
    )
  },

  // ------------------------------------------------------------ conversations
  listConversations(): Conversation[] {
    const rows = db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 500`
      )
      .all() as Row[]
    return rows.map(toConversation)
  },
  getConversation(id: string): Conversation | undefined {
    const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined
    return r ? toConversation(r) : undefined
  },
  upsertConversation(c: Conversation): void {
    db.prepare(
      `INSERT INTO conversations(id, title, created_at, updated_at, pinned, model, mode, project_dir, auto_edits, origin)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
         pinned = excluded.pinned, model = excluded.model, auto_edits = excluded.auto_edits`
    ).run(c.id, c.title, c.createdAt, c.updatedAt, c.pinned ? 1 : 0, c.model, c.mode ?? 'chat', c.projectDir ?? null, c.autoEdits ? 1 : 0, c.origin ?? null)
  },
  setSummary(id: string, summary: string | null, until: number | null): void {
    db.prepare('UPDATE conversations SET summary = ?, summary_until = ? WHERE id = ?').run(summary, until, id)
  },

  // ------------------------------------------------------------ projects
  listProjects(): Project[] {
    return (db.prepare('SELECT * FROM projects ORDER BY last_opened DESC LIMIT 30').all() as Row[]).map(toProject)
  },
  getProject(path: string): Project | undefined {
    const r = db.prepare('SELECT * FROM projects WHERE lower(path) = lower(?)').get(path) as Row | undefined
    return r ? toProject(r) : undefined
  },
  upsertProject(p: Project): void {
    db.prepare(
      `INSERT INTO projects(path, name, last_opened, json) VALUES(?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened, json = excluded.json`
    ).run(p.path, p.name, p.lastOpened, JSON.stringify({ allowedCommands: p.allowedCommands, stack: p.stack, description: p.description }))
  },
  removeProject(path: string): void {
    db.prepare('DELETE FROM projects WHERE lower(path) = lower(?)').run(path)
  },
  deleteConversation(id: string): void {
    db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  },
  getLearnedUntil(id: string): number {
    const r = db.prepare('SELECT learned_until FROM conversations WHERE id = ?').get(id) as Row | undefined
    return r ? Number(r.learned_until) : 0
  },
  setLearnedUntil(id: string, ts: number): void {
    db.prepare('UPDATE conversations SET learned_until = ? WHERE id = ?').run(ts, id)
  },

  // ------------------------------------------------------------ messages
  listMessages(conversationId: string): ChatMessage[] {
    const rows = db
      .prepare('SELECT json FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as Row[]
    return rows.map((r) => JSON.parse(String(r.json)) as ChatMessage)
  },
  getMessage(id: string): ChatMessage | undefined {
    const r = db.prepare('SELECT json FROM messages WHERE id = ?').get(id) as Row | undefined
    return r ? (JSON.parse(String(r.json)) as ChatMessage) : undefined
  },
  saveMessage(m: ChatMessage): void {
    db.prepare(
      `INSERT INTO messages(id, conversation_id, role, created_at, json) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`
    ).run(m.id, m.conversationId, m.role, m.createdAt, JSON.stringify(m))
    db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(m.id)
    const text = messageText(m)
    if (text.trim()) {
      db.prepare('INSERT INTO messages_fts(content, message_id, conversation_id) VALUES(?, ?, ?)').run(
        text,
        m.id,
        m.conversationId
      )
    }
  },
  deleteMessage(id: string): void {
    db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  },
  searchMessages(q: string, limit = 20): { conversationId: string; messageId: string; snippet: string; title: string }[] {
    const query = ftsQuery(q)
    if (!query) return []
    try {
      const rows = db
        .prepare(
          `SELECT f.message_id, f.conversation_id, snippet(messages_fts, 0, '[', ']', '…', 18) AS snip, c.title
           FROM messages_fts f JOIN conversations c ON c.id = f.conversation_id
           WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(query, limit) as Row[]
      return rows.map((r) => ({
        conversationId: String(r.conversation_id),
        messageId: String(r.message_id),
        snippet: String(r.snip),
        title: String(r.title)
      }))
    } catch {
      return []
    }
  },

  // ------------------------------------------------------------ memories
  listMemories(): (Memory & { embedding?: Float32Array; embedModel?: string })[] {
    const rows = db.prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC').all() as Row[]
    return rows.map((r) => {
      const m = toMemory(r) as Memory & { embedding?: Float32Array; embedModel?: string }
      const blob = r.embedding as Uint8Array | null
      if (blob && blob.byteLength) {
        m.embedding = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
      }
      m.embedModel = r.embed_model ? String(r.embed_model) : undefined
      return m
    })
  },
  insertMemory(m: Memory, embedding?: Float32Array, embedModel?: string): void {
    db.prepare(
      `INSERT INTO memories(id, text, kind, source, importance, pinned, uses, created_at, updated_at, last_used_at,
         conversation_id, embedding, embed_model) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.id,
      m.text,
      m.kind,
      m.source,
      m.importance,
      m.pinned ? 1 : 0,
      m.uses,
      m.createdAt,
      m.updatedAt,
      m.lastUsedAt ?? null,
      m.conversationId ?? null,
      embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null,
      embedModel ?? null
    )
  },
  updateMemory(m: Memory, embedding?: Float32Array, embedModel?: string): void {
    db.prepare(
      `UPDATE memories SET text = ?, kind = ?, importance = ?, pinned = ?, uses = ?, updated_at = ?, last_used_at = ? WHERE id = ?`
    ).run(m.text, m.kind, m.importance, m.pinned ? 1 : 0, m.uses, m.updatedAt, m.lastUsedAt ?? null, m.id)
    if (embedding) {
      db.prepare('UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?').run(
        new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        embedModel ?? null,
        m.id
      )
    }
  },
  touchMemories(ids: string[], ts: number): void {
    const st = db.prepare('UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id = ?')
    for (const id of ids) st.run(ts, id)
  },
  deleteMemory(id: string): void {
    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  },

  // ------------------------------------------------------------ learning events
  addEvent(e: LearningEvent): void {
    db.prepare('INSERT INTO learning_events(id, ts, kind, text) VALUES(?, ?, ?, ?)').run(e.id, e.ts, e.kind, e.text)
    db.prepare('DELETE FROM learning_events WHERE id NOT IN (SELECT id FROM learning_events ORDER BY ts DESC LIMIT 300)').run()
  },
  listEvents(limit = 100): LearningEvent[] {
    const rows = db.prepare('SELECT * FROM learning_events ORDER BY ts DESC LIMIT ?').all(limit) as Row[]
    return rows.map((r) => ({
      id: String(r.id),
      ts: Number(r.ts),
      kind: String(r.kind) as LearningEvent['kind'],
      text: String(r.text)
    }))
  },

  // ------------------------------------------------------------ routing stats
  routeStats(): { category: string; tier: string; score: number; n: number }[] {
    return (db.prepare('SELECT * FROM route_stats').all() as Row[]).map((r) => ({
      category: String(r.category),
      tier: String(r.tier),
      score: Number(r.score),
      n: Number(r.n)
    }))
  },
  bumpRouteStat(category: string, tier: string, delta: number): void {
    db.prepare(
      `INSERT INTO route_stats(category, tier, score, n) VALUES(?, ?, ?, 1)
       ON CONFLICT(category, tier) DO UPDATE SET score = MAX(-5, MIN(5, score * 0.95 + excluded.score)), n = n + 1`
    ).run(category, tier, delta)
  },
  resetRouteStats(): void {
    db.prepare('DELETE FROM route_stats').run()
  },

  // ------------------------------------------------------------ media
  addMedia(r: MediaResult): void {
    db.prepare('INSERT OR REPLACE INTO media(id, created_at, json) VALUES(?, ?, ?)').run(r.id, r.createdAt, JSON.stringify(r))
  },
  listMedia(limit = 200): MediaResult[] {
    return (db.prepare('SELECT json FROM media ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(
      (r) => JSON.parse(String(r.json)) as MediaResult
    )
  },
  deleteMedia(id: string): void {
    db.prepare('DELETE FROM media WHERE id = ?').run(id)
  }
}
