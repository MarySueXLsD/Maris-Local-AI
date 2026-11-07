// A stand-in for GitHub (the parts Maris uses), so update, news and publishing tests never touch a
// real repository. Start it, then run Maris with MARIS_GITHUB_API=<url>/api and MARIS_GITHUB_RAW=<url>/raw.
import { createHash } from 'node:crypto'
import http from 'node:http'

export async function startMockGitHub({ repo = 'test/maris', branch = 'main', token = 'good-token', login = 'test-admin' } = {}) {
  /** The branch's files: path → Buffer. */
  const files = new Map()
  const blobs = new Map()
  const trees = new Map()
  const commits = new Map()
  let head = 'c0'
  commits.set('c0', { tree: 't0' })
  trees.set('t0', new Map())
  let release
  const commitLog = []

  const sha = (b) => createHash('sha1').update(b).digest('hex')
  const send = (res, status, body, type = 'application/json') => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length })
    res.end(data)
  }
  const authed = (req) => req.headers.authorization === `Bearer ${token}`
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}))
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = decodeURIComponent(url.pathname)
    const base = `/api/repos/${repo}`
    try {
      if (p.startsWith(`/raw/${repo}/${branch}/`)) {
        const f = files.get(p.slice(`/raw/${repo}/${branch}/`.length))
        return f ? send(res, 200, f, 'application/octet-stream') : send(res, 404, 'Not found', 'text/plain')
      }
      if (p.startsWith('/download/')) return send(res, 200, Buffer.alloc(200_000, 7), 'application/octet-stream')
      if (p === '/api/user') return authed(req) ? send(res, 200, { login }) : send(res, 401, { message: 'Bad credentials' })
      if (p === base) return send(res, 200, { full_name: repo, private: false, permissions: authed(req) ? { push: true } : undefined })
      if (p === `${base}/releases/latest`) return release ? send(res, 200, release) : send(res, 404, { message: 'Not Found' })
      if (p.startsWith(`${base}/contents/`)) {
        const path = p.slice(`${base}/contents/`.length)
        const f = files.get(path)
        if (f) return send(res, 200, { path, content: f.toString('base64'), encoding: 'base64' })
        const inside = [...files.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
        return inside.length ? send(res, 200, inside.map((k) => ({ path: k, type: 'file' }))) : send(res, 404, { message: 'Not Found' })
      }
      if (!authed(req) && req.method !== 'GET') return send(res, 401, { message: 'Bad credentials' })
      if (p === `${base}/git/ref/heads/${branch}`) return send(res, 200, { object: { sha: head } })
      if (p.startsWith(`${base}/git/commits/`) && req.method === 'GET') {
        const c = commits.get(p.split('/').pop())
        return c ? send(res, 200, { tree: { sha: c.tree } }) : send(res, 404, { message: 'Not Found' })
      }
      if (p === `${base}/git/blobs` && req.method === 'POST') {
        const b = await readBody(req)
        const data = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8')
        const s = sha(data)
        blobs.set(s, data)
        return send(res, 201, { sha: s })
      }
      if (p === `${base}/git/trees` && req.method === 'POST') {
        const b = await readBody(req)
        const next = new Map(trees.get(b.base_tree) ?? new Map())
        for (const e of b.tree) {
          if (e.sha === null) next.delete(e.path)
          else next.set(e.path, blobs.get(e.sha))
        }
        const s = sha(JSON.stringify([...next.keys()]) + Date.now() + Math.random())
        trees.set(s, next)
        return send(res, 201, { sha: s })
      }
      if (p === `${base}/git/commits` && req.method === 'POST') {
        const b = await readBody(req)
        const s = sha(JSON.stringify(b) + Math.random())
        commits.set(s, { tree: b.tree, message: b.message })
        return send(res, 201, { sha: s })
      }
      if (p === `${base}/git/refs/heads/${branch}` && req.method === 'PATCH') {
        const b = await readBody(req)
        const c = commits.get(b.sha)
        head = b.sha
        files.clear()
        for (const [k, v] of trees.get(c.tree)) files.set(k, v)
        commitLog.push(c.message)
        return send(res, 200, { object: { sha: head } })
      }
      send(res, 404, { message: `Not Found: ${req.method} ${p}` })
    } catch (e) {
      send(res, 500, { message: String(e) })
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  /** Put files on the branch directly (as if pushed earlier). */
  const seed = (path, content) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    files.set(path, data)
    trees.get(commits.get(head).tree).set(path, data)
  }
  const setRelease = (version, assets) => {
    release = {
      tag_name: `v${version}`,
      name: `Maris ${version}`,
      body: `## What is new\n\n- Skills and connectors\n- Updates & news`,
      html_url: `${origin}/releases/v${version}`,
      published_at: new Date().toISOString(),
      assets: assets.map((name) => ({ name, browser_download_url: `${origin}/download/${name}`, size: 200_000 }))
    }
  }
  return { origin, files, seed, setRelease, commitLog, close: () => server.close() }
}
