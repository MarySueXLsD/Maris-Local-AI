import { lookup } from 'node:dns/promises'
import { messageText, repo } from '../db'
import { settings } from '../settings'
import { fetchPage, webSearch } from '../web/browser'
import { num, schema, str, ToolError, type ToolDef } from './types'
import { checkWebAddress, isLocalAddress, isLocalHost } from './webGuard'

/** "example.com/page" → "https://example.com/page"; other schemes (file:, javascript:) stay as they are, to be refused. */
const withScheme = (raw: string): string => (/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)

/**
 * What the person wrote in this chat and what tools brought back (search results, links on pages): an
 * address found there did not come from the model alone.
 */
function knownText(conversationId: string): string {
  try {
    return repo
      .listMessages(conversationId)
      .flatMap((m) => (m.role === 'user' ? [messageText(m)] : m.parts.map((p) => (p.type === 'tool' ? (p.call.result ?? '') : ''))))
      .join('\n')
  } catch {
    return ''
  }
}

/** A public-looking name that leads to this computer or the home network all the same. */
async function resolvesLocally(host: string): Promise<boolean> {
  try {
    const found = await Promise.race([lookup(host, { all: true }), new Promise<[]>((r) => setTimeout(() => r([]), 2000))])
    return found.some((a) => isLocalAddress(a.address))
  } catch {
    return false
  }
}

export const webTools: ToolDef[] = [
  {
    name: 'web_search',
    risk: 'network',
    enabled: (s) => s.web.enabled,
    description:
      'Search the internet. Use for current events, prices, facts you are unsure about, documentation, or anything after your training data. Returns titles, URLs and snippets; then use read_webpage on the best results.',
    parameters: schema(
      {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'integer', description: 'Number of results (default from settings, max 20)' }
      },
      ['query']
    ),
    async prepare(args) {
      return { risk: 'network', title: `Search the web: ${str(args.query, 'query')}` }
    },
    async run(args) {
      const { provider, results } = await webSearch(str(args.query, 'query'), Math.min(20, Math.max(1, num(args.count, settings.get().web.maxResults))))
      return `Results from ${provider}:\n${results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`)
        .join('\n')}`
    }
  },
  {
    name: 'read_webpage',
    risk: 'network',
    enabled: (s) => s.web.enabled,
    description:
      'Open a web page in a hidden browser and return its main content as Markdown, plus links. JavaScript-heavy sites work. Addresses on this computer or the home network, and addresses that carry a lot of data, need the user to approve them first.',
    parameters: schema({ url: { type: 'string', description: 'Full URL' } }, ['url']),
    async prepare(args, ctx) {
      const url = withScheme(str(args.url, 'url'))
      let known: string | undefined
      let check = checkWebAddress(url, (u) => (known ??= knownText(ctx.conversationId)).includes(u))
      if ('ok' in check) {
        const host = new URL(url).hostname
        if (await resolvesLocally(host)) check = { ask: `${host} leads to an address on this computer or the home network. Opening it can make a program or device there do something, so Maris asks first.` }
      }
      if ('refuse' in check) throw new ToolError(check.refuse)
      if ('ask' in check) return { risk: 'change', title: `Read ${url}`, detail: check.ask, preview: { kind: 'list', items: [url] } }
      return { risk: 'network', title: `Read ${url}` }
    },
    async run(args, ctx) {
      const w = settings.get().web
      const url = withScheme(str(args.url, 'url'))
      const host = new URL(url).hostname
      // A page on this computer or network runs only after the person approved it (prepare asked); then it may
      // reach its own host, and nothing else that is local.
      const page = await fetchPage(url, { maxChars: w.pageChars, screenshot: w.thumbnails, allowLocalHost: isLocalHost(host) || (await resolvesLocally(host)) ? host : undefined })
      if (page.screenshot) ctx.setPreview(page.screenshot)
      const links = page.links
        .slice(0, 15)
        .map((l) => `- [${l.text}](${l.url})`)
        .join('\n')
      return `# ${page.title || page.url}\nURL: ${page.url}\n\n${page.markdown}${links ? `\n\n## Links on the page\n${links}` : ''}`
    }
  }
]
