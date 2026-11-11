// Finding the Help article, and the part of it, that answers a question about Maris. The assistant's
// maris_help tool uses it, so the model answers from the same pages the person can open with F1.
// No imports: unit tests load this file with plain Node.

export interface HelpDoc {
  id: string
  title: string
  summary: string
  keywords: string
  body: string
  category?: string
}

/** Words that say nothing about the topic ("how do I … in Maris"). */
const STOP = new Set(
  (
    'a an the to of in on at for from into with by as and or but if so not no yes is are was be been am do does did can could ' +
    'should would will may might must have has had i me my mine we our you your it its this that these those there here ' +
    'how what where why when which who whom wanna want wants like need needs please help tell show explain know ' +
    'maris app application program use using used get got make makes made way ways possible thing things something ' +
    'work works working about any some all just also then than them they he she his her up out off via'
  ).split(' ')
)

/** "connected", "connecting", "connectors" and "connect" should meet: cut the common endings. */
const stem = (w: string): string => {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []

/** The words of a question that carry its topic. */
export function queryTerms(query: string): string[] {
  const out: string[] = []
  for (const w of words(query)) {
    const clean = w.replace(/[.+#-]+$/, '')
    if (clean.length < 2 || STOP.has(clean)) continue
    const s = stem(clean)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/** True when the text has a word that starts with the term ("model" finds "models"). */
const hasTerm = (textWords: string[], term: string): boolean => textWords.some((w) => w.startsWith(term))

interface Indexed {
  doc: HelpDoc
  title: string[]
  keywords: string[]
  summary: string[]
  body: string[]
}

const index = (doc: HelpDoc): Indexed => ({ doc, title: words(doc.title), keywords: words(doc.keywords), summary: words(doc.summary), body: words(doc.body) })

/**
 * The articles that answer a question, best first. A word counts more when few articles have it
 * ("claude" says more than "connect"), more in a title or the keywords than in the text, and an
 * article that covers more of the question's words wins over one that repeats a single word.
 */
export function searchHelp(docs: HelpDoc[], query: string): HelpDoc[] {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const all = docs.map(index)
  const scored = all
    .map((d) => {
      let score = 0
      let matched = 0
      for (const t of terms) {
        const where = hasTerm(d.title, t) ? 6 : hasTerm(d.keywords, t) ? 5 : hasTerm(d.summary, t) ? 3 : hasTerm(d.body, t) ? 1 : 0
        if (!where) continue
        const inDocs = all.filter((x) => hasTerm(x.title, t) || hasTerm(x.keywords, t) || hasTerm(x.summary, t) || hasTerm(x.body, t)).length
        score += where * Math.log(1 + all.length / inDocs)
        matched++
      }
      // The article's own id asked for by name ("api-models") always fits.
      if (query.toLowerCase().includes(d.doc.id)) score += 20
      return { doc: d.doc, score: score * (0.5 + matched / terms.length), matched }
    })
    .filter((x) => x.matched > 0)
    .sort((a, b) => b.score - a.score)
  const best = scored[0]?.score ?? 0
  // Articles far behind the best one are noise, not answers.
  return scored.filter((x) => x.score >= best * 0.35).map((x) => x.doc)
}

export interface HelpSection {
  /** Empty for the text before the first heading. */
  heading: string
  text: string
}

/** An article's body cut at its "## " headings. */
export function helpSections(body: string): HelpSection[] {
  const out: HelpSection[] = []
  let current: HelpSection = { heading: '', text: '' }
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+)/.exec(line)
    if (h) {
      if (current.heading || current.text.trim()) out.push(current)
      current = { heading: h[1]!.trim(), text: '' }
    } else current.text += `${line}\n`
  }
  if (current.heading || current.text.trim()) out.push(current)
  return out.map((s) => ({ heading: s.heading, text: s.text.trim() }))
}

/**
 * An article for the model to read, within `budget` characters: the whole article when it fits,
 * otherwise its opening and the sections that answer the question (in the article's order), with the
 * headings that were left out named so the model can ask for them.
 */
export function excerpt(doc: HelpDoc, query: string, budget: number): { text: string; left: string[] } {
  const head = `# ${doc.title}\n${doc.summary}`
  const sections = helpSections(doc.body)
  const render = (s: HelpSection): string => (s.heading ? `## ${s.heading}\n${s.text}` : s.text)
  const whole = [head, ...sections.map(render)].join('\n\n')
  if (whole.length <= budget) return { text: whole, left: [] }
  const terms = queryTerms(query)
  const ranked = sections
    .map((s, i) => {
      const hw = words(s.heading)
      const tw = words(s.text)
      const score = terms.reduce((n, t) => n + (hasTerm(hw, t) ? 4 : 0) + (hasTerm(tw, t) ? 1 : 0), 0)
      // The opening says what the article is about; then the best matches; then the article's order.
      return { s, i, score: s.heading ? score : 1000 }
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
  const keep = new Set<number>()
  let size = head.length
  for (const r of ranked) {
    const len = render(r.s).length + 2
    if (size + len > budget && keep.size > 0) continue
    keep.add(r.i)
    size += len
    if (size >= budget) break
  }
  const kept = sections.filter((_, i) => keep.has(i))
  const left = sections.filter((s, i) => !keep.has(i) && s.heading).map((s) => s.heading)
  let text = [head, ...kept.map(render)].join('\n\n')
  // A single section longer than the whole budget is cut at a paragraph.
  if (text.length > budget * 1.4) text = `${text.slice(0, Math.max(200, text.lastIndexOf('\n\n', budget * 1.4)))}\n\n…`
  return { text, left }
}

// ------------------------------------------------------------------ is this a question about Maris?

/** A request that is about Maris itself: what it can do, or how to set something up in it. */
export const APP_QUESTION =
  /\b(maris|this (app|program|application)|the app|api keys?|claude|anthropic|chatgpt|gpt|openai|gemini|openrouter|ollama|comfyui|connectors?|mcp|skills?|phone|android|mobile|updates?|new version|low-power|approv\w*|shortcuts?|hotkey|what can you do|can you (make|draw|generate|search|browse|see|remember|run|use|connect)|how (do|can|to) (i |you |we )?(add|connect|install|set ?up|use|turn|enable|disable|switch|change|link|pair|download|remove|update))\b|как (мне )?(подключить|добавить|установить|настроить|включить|выключить|обновить)|что ты умеешь|приложени/i

/** A request about what is set up right now: which models, which version, is something connected. */
export const APP_STATE_QUESTION =
  /\b(which|what) (models?|version)\b|\b(is|are) .{0,30}\b(connected|installed|linked|paired|set up)\b|какая версия|какие модели/i
