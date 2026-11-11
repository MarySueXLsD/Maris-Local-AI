export function bytes(n?: number): string {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`
}

export function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

export function duration(ms?: number): string {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s % 60)} s`
}

export function relativeDay(ts: number): 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older' {
  const d = new Date(ts)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= start) return 'Today'
  if (ts >= start - 86400000) return 'Yesterday'
  if (ts >= start - 6 * 86400000) return 'This week'
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return 'This month'
  return 'Older'
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function shortModel(name?: string): string {
  if (!name) return ''
  // A model of an API service is named "@service/model": show the model's own id.
  if (name[0] === '@' && name.includes('/')) return name.slice(name.indexOf('/') + 1).replace(/^models\//, '')
  return name
    .replace(/^hf\.co\/[^/]+\//, '')
    .replace(/-GGUF/i, '')
    .replace(/:latest$/, '')
}

/** Human label for an Ollama tag, e.g. qwen3.8:27b-q3 → Qwen3.8 27B */
export function prettyModel(name?: string): string {
  if (!name) return ''
  const n = shortModel(name)
  if (name[0] === '@') return n
  const [base, tag = ''] = n.split(':')
  const fam = base.replace(/^qwen/i, 'Qwen').replace(/-embedding/i, ' Embedding').replace(/^embeddinggemma/i, 'EmbeddingGemma')
  const size = /(\d+(\.\d+)?)b/i.exec(tag)?.[1]
  return size ? `${fam} ${size}B` : fam
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Still up'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}
