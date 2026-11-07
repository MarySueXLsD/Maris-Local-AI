// A small GitHub client for update checks, the news feed and publishing posts.
// MARIS_GITHUB_API / MARIS_GITHUB_RAW point it at a test server (tests/e2e/news.mjs).

const API = (): string => process.env.MARIS_GITHUB_API ?? 'https://api.github.com'
const RAW = (): string => process.env.MARIS_GITHUB_RAW ?? 'https://raw.githubusercontent.com'

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function gh<T>(path: string, opts: { token?: string; method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API()}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'User-Agent': 'Maris',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000)
    })
  } catch (e) {
    throw new GitHubError(0, `Could not reach GitHub (${(e as Error).message}). Check the internet connection.`)
  }
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const msg = (json as { message?: string } | undefined)?.message ?? text.slice(0, 200)
    throw new GitHubError(res.status, res.status === 401 ? 'GitHub did not accept the token.' : res.status === 403 && /rate limit/i.test(msg) ? 'GitHub asked to wait a little (too many requests). Try again later.' : `GitHub: ${msg} (${res.status})`)
  }
  return json as T
}

/** A file from the repository's branch, through GitHub's file server (no API rate limit). */
export async function raw(repo: string, branch: string, path: string, opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
  // The file server caches for a few minutes; a changing query lets a check see new posts sooner.
  const bust = opts.fresh ? `?v=${Math.floor(Date.now() / 60000)}` : ''
  const url = `${RAW()}/${repo}/${branch}/${path.split('/').map(encodeURIComponent).join('/')}${bust}`
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Maris' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20000) })
  } catch (e) {
    throw new GitHubError(0, `Could not reach GitHub (${(e as Error).message}).`)
  }
  if (!res.ok) throw new GitHubError(res.status, `${path}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export const rawBase = (repo: string, branch: string): string => `${RAW()}/${repo}/${branch}/`

/**
 * Write several files (and delete others) in one commit on a branch, with the Git Data API:
 * blobs → tree on top of the current one → commit → move the branch.
 */
export async function commitFiles(
  repo: string,
  branch: string,
  token: string,
  files: { path: string; content?: Buffer; delete?: boolean }[],
  message: string
): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { token })
  const head = await gh<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${ref.object.sha}`, { token })
  const entries: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
  for (const f of files) {
    if (f.delete) {
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await gh<{ sha: string }>(`/repos/${repo}/git/blobs`, { token, method: 'POST', body: { content: (f.content ?? Buffer.alloc(0)).toString('base64'), encoding: 'base64' }, timeoutMs: 60000 })
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const tree = await gh<{ sha: string }>(`/repos/${repo}/git/trees`, { token, method: 'POST', body: { base_tree: head.tree.sha, tree: entries } })
  const commit = await gh<{ sha: string }>(`/repos/${repo}/git/commits`, { token, method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } })
  await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { token, method: 'PATCH', body: { sha: commit.sha } })
  return commit.sha
}

export { isNewer, parseVersion } from './pure'
