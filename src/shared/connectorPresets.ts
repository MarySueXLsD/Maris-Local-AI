import type { ConnectorPreset } from './extensions'

/**
 * Popular services Maris can connect to through the Model Context Protocol (MCP). Hosted ones need
 * only a key; the ones marked needsNode run a small program with Node.js (npx) on this computer.
 * Addresses checked against each service's documentation in November 2026.
 */
export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and repositories.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        secret: true,
        placeholder: 'github_pat_…',
        help: 'Create one in GitHub → Settings → Developer settings → Personal access tokens, with the access you want Maris to have.',
        target: { header: 'Authorization', prefix: 'Bearer ' },
        pattern: '^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|[0-9a-f]{40})$',
        patternHint: 'That is not a GitHub token. A token starts with github_pat_ or ghp_; copy the token itself (it is shown once, right after you create it), not its name.'
      }
    ],
    docs: 'https://github.com/settings/personal-access-tokens'
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and edit the pages and databases you share with the integration.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    fields: [
      {
        key: 'token',
        label: 'Integration secret',
        secret: true,
        placeholder: 'ntn_…',
        help: 'Create an internal integration in Notion, copy its secret, and share the pages you want with it.',
        target: { env: 'NOTION_TOKEN' }
      }
    ],
    docs: 'https://www.notion.so/profile/integrations',
    needsNode: true
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets, papers and Spaces, and use Spaces as tools.',
    transport: 'http',
    url: 'https://huggingface.co/mcp',
    fields: [
      {
        key: 'token',
        label: 'Access token',
        secret: true,
        optional: true,
        placeholder: 'hf_…',
        help: 'Optional. With a token, Maris can see your private repositories and your chosen tools.',
        target: { header: 'Authorization', prefix: 'Bearer ' }
      }
    ],
    docs: 'https://huggingface.co/settings/tokens'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Web, news, image and local search through the Brave Search API (free plan available).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    fields: [{ key: 'key', label: 'API key', secret: true, help: 'Get a key at brave.com/search/api.', target: { env: 'BRAVE_API_KEY' } }],
    docs: 'https://brave.com/search/api/',
    needsNode: true
  },
  {
    id: 'homeassistant',
    name: 'Home Assistant',
    description: 'Turn lights and devices on and off and read their state. Add the "Model Context Protocol" integration in Home Assistant first.',
    transport: 'http',
    url: '{url}/api/mcp',
    fields: [
      { key: 'url', label: 'Home Assistant address', placeholder: 'http://homeassistant.local:8123', target: { url: true } },
      {
        key: 'token',
        label: 'Long-lived access token',
        secret: true,
        help: 'In Home Assistant: your profile → Security → Long-lived access tokens.',
        target: { header: 'Authorization', prefix: 'Bearer ' }
      }
    ],
    docs: 'https://www.home-assistant.io/integrations/mcp_server/'
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for programming libraries, for Code mode.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    fields: [{ key: 'key', label: 'API key', secret: true, optional: true, help: 'Optional; raises the request limit.', target: { header: 'CONTEXT7_API_KEY' } }],
    docs: 'https://context7.com'
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'Ask questions about the code and documentation of any public GitHub repository. No key needed.',
    transport: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    fields: [],
    docs: 'https://deepwiki.com',
    readOnly: true
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Customers, payments, invoices and subscriptions in your Stripe account.',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    fields: [
      {
        key: 'key',
        label: 'Restricted API key',
        secret: true,
        placeholder: 'rk_live_…',
        help: 'A restricted key limits what Maris can do in Stripe.',
        target: { header: 'Authorization', prefix: 'Bearer ' }
      }
    ],
    docs: 'https://dashboard.stripe.com/apikeys'
  },
  {
    id: 'custom-http',
    name: 'Other service (web address)',
    description: 'Any MCP server reachable over HTTP (Streamable HTTP or SSE).',
    transport: 'http',
    url: '{url}',
    fields: [
      { key: 'url', label: 'Server address', placeholder: 'https://example.com/mcp', target: { url: true } },
      { key: 'token', label: 'Bearer token', secret: true, optional: true, target: { header: 'Authorization', prefix: 'Bearer ' } }
    ]
  },
  {
    id: 'custom-stdio',
    name: 'Other service (program)',
    description: 'An MCP server that runs as a program on this computer, such as an npx or uvx package.',
    transport: 'stdio',
    fields: [
      { key: 'command', label: 'Command', placeholder: 'npx -y @some/mcp-server', target: { command: true } },
      { key: 'env', label: 'Environment variables (NAME=value, one per line)', secret: true, optional: true, multiline: true, target: { envList: true } }
    ]
  }
]

/** Split a command line into program and arguments (quotes group words). */
/**
 * A pasted key without what tends to come with it: surrounding quotes, a "Bearer " or "token " in front,
 * spaces, line breaks and invisible characters from web pages or password managers.
 */
export function cleanSecret(value: string): string {
  return value
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(authorization:\s*)?(bearer|token)\s+/i, '')
    .replace(/\s+/g, '')
}

export function splitCommand(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''))
}

/** Tool names the model sees: mcp_<connector>_<tool>, at most 64 characters of [A-Za-z0-9_]. */
export function connectorToolName(connectorId: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return `mcp_${clean(connectorId).slice(0, 20)}_${clean(tool)}`.slice(0, 64)
}
