import { BrowserWindow, session, type Session } from 'electron'
import { readFileSync } from 'node:fs'
import TurndownService from 'turndown'
import { settings } from '../settings'
import { isLocalHost } from '../tools/webGuard'
import { log, sleep, truncate } from '../util'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface PageResult {
  url: string
  title: string
  markdown: string
  links: { text: string; url: string }[]
  screenshot?: string // small JPEG data URL
}

const PARTITION = 'persist:maris-web'
let webSession: Session | undefined
let readabilitySrc: string | undefined
const cache = new Map<string, { at: number; page: PageResult }>()

/**
 * Hosts on this computer or the home network that a page the person approved may reach while it is open
 * (counted: such pages can overlap). Everything else that is local stays out of reach of web pages.
 */
const localAllowed = new Map<string, number>()

function getSession(): Session {
  if (webSession) return webSession
  const s = session.fromPartition(PARTITION)
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  s.setPermissionCheckHandler(() => false)
  s.on('will-download', (e) => e.preventDefault())
  // A web page may not reach into this computer or the home network (Ollama, ComfyUI, the router, a
  // printer): not by a redirect, a picture, a script or a form. Only a local page the person approved
  // reaches its own host.
  s.webRequest.onBeforeRequest((details, cb) => {
    if (!/^(https?|wss?):/i.test(details.url)) return cb({})
    let host = ''
    try {
      host = new URL(details.url).hostname.toLowerCase()
    } catch {
      return cb({ cancel: true })
    }
    cb({ cancel: isLocalHost(host) && !localAllowed.has(host) })
  })
  s.setUserAgent(s.getUserAgent().replace(/\s(Electron|maris|Maris)\/\S+/g, ''))
  webSession = s
  return s
}

function readability(): string {
  if (!readabilitySrc) {
    readabilitySrc = readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8')
  }
  return readabilitySrc
}

async function withPage<T>(url: string, fn: (win: BrowserWindow) => Promise<T>, timeoutMs = 25000): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: getSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      javascript: true,
      webgl: false,
      spellcheck: false
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out loading ${url}`)), timeoutMs))
    ]).catch((e: Error) => {
      // ERR_ABORTED often happens on client-side redirects; the page is usually usable.
      if (!/ERR_ABORTED|Timed out/.test(e.message)) throw e
    })
    // Give client-side rendering a moment to settle.
    for (let i = 0; i < 10; i++) {
      const ready = await win.webContents
        .executeJavaScript('document.readyState', true)
        .catch(() => 'loading')
      if (ready === 'complete') break
      await sleep(300)
    }
    await sleep(700)
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button'] as (keyof HTMLElementTagNameMap)[])

export async function fetchPage(url: string, opts: { screenshot?: boolean; maxChars?: number; allowLocalHost?: string } = {}): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.page
  const local = opts.allowLocalHost?.toLowerCase()
  if (local) localAllowed.set(local, (localAllowed.get(local) ?? 0) + 1)
  const release = (): void => {
    if (!local) return
    const n = (localAllowed.get(local) ?? 1) - 1
    if (n > 0) localAllowed.set(local, n)
    else localAllowed.delete(local)
  }
  const page = await withPage(url, async (win) => {
    const data = (await win.webContents.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `${readability()}
;(() => {
  let art = null
  try { art = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse() } catch (e) {}
  const links = [...document.querySelectorAll('a[href]')]
    .map(a => ({ text: (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 100), url: a.href }))
    .filter(l => l.text && /^https?:/.test(l.url))
  const seen = new Set()
  const uniq = links.filter(l => !seen.has(l.url) && seen.add(l.url)).slice(0, 40)
  return {
    url: location.href,
    title: (art && art.title) || document.title || '',
    html: art && art.content ? art.content : '',
    text: document.body ? document.body.innerText : '',
    links: uniq
  }
})()`
      }
    ])) as { url: string; title: string; html: string; text: string; links: PageResult['links'] }
    let markdown = ''
    if (data.html) {
      try {
        markdown = turndown.turndown(data.html)
      } catch {
        markdown = ''
      }
    }
    if (markdown.trim().length < 200) markdown = data.text
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
    if (opts.maxChars && markdown.length > opts.maxChars) markdown = `${markdown.slice(0, opts.maxChars)}\n\n[…the rest of the page was cut to fit]`
    let screenshot: string | undefined
    if (opts.screenshot !== false) {
      try {
        const img = await win.webContents.capturePage()
        screenshot = `data:image/jpeg;base64,${img.resize({ width: 480 }).toJPEG(72).toString('base64')}`
      } catch {
        /* ignore */
      }
    }
    return { url: data.url, title: data.title, markdown, links: data.links, screenshot }
  }).finally(release)
  page.markdown = truncate(page.markdown, opts.maxChars ?? 14000)
  cache.set(url, { at: Date.now(), page })
  if (cache.size > 40) cache.delete(cache.keys().next().value as string)
  return page
}

async function scrape(url: string, script: string): Promise<SearchResult[]> {
  return withPage(
    url,
    async (win) =>
      (await win.webContents.executeJavaScriptInIsolatedWorld(998, [{ code: script }])) as SearchResult[],
    20000
  )
}

const DDG = `(() => {
  const out = []
  for (const r of document.querySelectorAll('.result')) {
    if (r.classList.contains('result--ad')) continue
    const a = r.querySelector('.result__a'); if (!a) continue
    let href = a.getAttribute('href') || ''
    try { const u = new URL(href, location.href); const real = u.searchParams.get('uddg'); if (real) href = real; else href = u.href } catch (e) {}
    const sn = r.querySelector('.result__snippet')
    out.push({ title: a.innerText.trim(), url: href, snippet: sn ? sn.innerText.trim() : '' })
  }
  return out
})()`

const BING = `(() => [...document.querySelectorAll('li.b_algo')].map(li => {
  const a = li.querySelector('h2 a'); const p = li.querySelector('.b_caption p, p')
  return a ? { title: a.innerText.trim(), url: a.href, snippet: p ? p.innerText.trim() : '' } : null
}).filter(Boolean))()`

const MOJEEK = `(() => [...document.querySelectorAll('ul.results-standard li')].map(li => {
  const a = li.querySelector('a.title'); const p = li.querySelector('p.s')
  return a ? { title: a.innerText.trim(), url: a.href, snippet: p ? p.innerText.trim() : '' } : null
}).filter(Boolean))()`

export async function webSearch(query: string, count = 8): Promise<{ provider: string; results: SearchResult[] }> {
  const cfg = settings.get().web
  const q = encodeURIComponent(query)
  if (cfg.provider === 'brave' && cfg.braveKey) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${count}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.braveKey }
    })
    if (!r.ok) throw new Error(`Brave search failed: HTTP ${r.status}`)
    const j = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } }
    return {
      provider: 'Brave',
      results: (j.web?.results ?? []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: x.description ?? '' }))
    }
  }
  if (cfg.provider === 'searxng' && cfg.searxngUrl) {
    const r = await fetch(`${cfg.searxngUrl.replace(/\/+$/, '')}/search?q=${q}&format=json`)
    if (!r.ok) throw new Error(`SearXNG failed: HTTP ${r.status}`)
    const j = (await r.json()) as { results?: { title: string; url: string; content?: string }[] }
    return {
      provider: 'SearXNG',
      results: (j.results ?? []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? '' }))
    }
  }
  const chain: [string, string, string][] = [
    ['DuckDuckGo', `https://html.duckduckgo.com/html/?q=${q}`, DDG],
    ['Bing', `https://www.bing.com/search?q=${q}&setlang=en`, BING],
    ['Mojeek', `https://www.mojeek.com/search?q=${q}`, MOJEEK]
  ]
  const errors: string[] = []
  for (const [name, url, script] of chain) {
    try {
      const results = (await scrape(url, script)).filter((r) => r.url && r.title)
      if (results.length) return { provider: name, results: results.slice(0, count) }
      errors.push(`${name}: no results`)
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
      log.warn('web', name, e)
    }
  }
  throw new Error(`Web search failed (${errors.join('; ')})`)
}
