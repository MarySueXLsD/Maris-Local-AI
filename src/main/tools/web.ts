import { settings } from '../settings'
import { fetchPage, webSearch } from '../web/browser'
import { num, schema, str, type ToolDef } from './types'

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
      'Open a web page in a hidden browser and return its main content as Markdown, plus links. JavaScript-heavy sites work.',
    parameters: schema({ url: { type: 'string', description: 'Full URL' } }, ['url']),
    async prepare(args) {
      return { risk: 'network', title: `Read ${str(args.url, 'url')}` }
    },
    async run(args, ctx) {
      const w = settings.get().web
      const page = await fetchPage(str(args.url, 'url'), { maxChars: w.pageChars, screenshot: w.thumbnails })
      if (page.screenshot) ctx.setPreview(page.screenshot)
      const links = page.links
        .slice(0, 15)
        .map((l) => `- [${l.text}](${l.url})`)
        .join('\n')
      return `# ${page.title || page.url}\nURL: ${page.url}\n\n${page.markdown}${links ? `\n\n## Links on the page\n${links}` : ''}`
    }
  }
]
