// Links to Maris's own pages, written as [Models → API](page:models/api). The assistant gets them from
// maris_help and puts them in its answers; a click opens the page. No imports (unit tests load it).

export type PageView = 'chat' | 'memory' | 'models' | 'settings' | 'help' | 'news' | 'skills' | 'connectors'
export type ModelsTab = 'text' | 'image' | 'video' | 'api'

export interface PageTarget {
  view: PageView
  /** Models: which tab. */
  tab?: ModelsTab
  /** Settings: which section (an id from the settings schema). */
  section?: string
  /** Chat or Code mode. */
  mode?: 'chat' | 'code'
}

const MODEL_TABS: Record<string, ModelsTab> = { text: 'text', pictures: 'image', images: 'image', image: 'image', videos: 'video', video: 'video', api: 'api' }
const VIEWS: Record<string, PageView> = { memory: 'memory', models: 'models', settings: 'settings', help: 'help', news: 'news', updates: 'news', skills: 'skills', connectors: 'connectors' }

/** "page:models/api" or "models/api" → where to go; undefined for a page Maris does not have. */
export function parsePage(link: string): PageTarget | undefined {
  const [first = '', second = ''] = link
    .replace(/^page:/i, '')
    .toLowerCase()
    .split('/')
    .map((p) => p.trim())
  if (first === 'chat' || first === 'code') return { view: 'chat', mode: first }
  const view = VIEWS[first]
  if (!view) return undefined
  if (view === 'models') return second ? (MODEL_TABS[second] ? { view, tab: MODEL_TABS[second] } : undefined) : { view }
  if (view === 'settings') return second ? (/^[a-z]+$/.test(second) ? { view, section: second } : undefined) : { view }
  return second ? undefined : { view }
}

/** Only links of this shape are kept as page links in Markdown. */
export const isPageLink = (url: string): boolean => /^page:[a-z]+(\/[a-z]+)?$/i.test(url) && parsePage(url) !== undefined

// ------------------------------------------------------------------ page names written as plain text

export interface PageName {
  /** As it is written: "Models → API". */
  name: string
  /** Where it leads: "models/api". */
  target: string
}

/**
 * The pages people are sent to by name. A model often writes "Open **Models → API**" instead of copying
 * the link it was given, and the help articles write page names the same way: these become links too.
 * Only names with an arrow are listed, so the plain words "Models" or "Settings" are left alone.
 */
export function pageNames(settingsSections: { id: string; title: string }[]): PageName[] {
  return [
    { name: 'Models → API', target: 'models/api' },
    { name: 'Models → Text', target: 'models/text' },
    { name: 'Models → Pictures', target: 'models/pictures' },
    { name: 'Models → Videos', target: 'models/videos' },
    ...settingsSections.map((s) => ({ name: `Settings → ${s.title}`, target: `settings/${s.id}` }))
  ]
}

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Text cut into plain parts and page names ("Models → API", also written with -> or >). */
export function splitPages(text: string, names: PageName[]): { text: string; page?: string }[] {
  if (!/→|->|›|>/.test(text) || !names.length) return [{ text }]
  // Longest first, so "Settings → Images and video" is not taken for a shorter name.
  const sorted = [...names].sort((a, b) => b.name.length - a.name.length)
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map((n) => n.name.split(' → ').map(escapeRx).join('\\s*(?:→|->|›|>)\\s*')).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  const key = (s: string): string => s.replace(/\s*(?:→|->|›|>)\s*/g, ' → ').toLowerCase()
  const out: { text: string; page?: string }[] = []
  let last = 0
  for (const m of text.matchAll(rx)) {
    const target = sorted.find((n) => n.name.toLowerCase() === key(m[0]))?.target
    if (!target) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], page: target })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** A Markdown link to a page: pageLink('Models → API', 'models/api'). */
export const pageLink = (label: string, target: string): string => `[${label}](page:${target})`
