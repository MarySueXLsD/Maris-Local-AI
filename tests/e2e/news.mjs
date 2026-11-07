// End-to-end test of update checks, Updates & news, and publishing posts from the Admin page.
// Uses a local stand-in for GitHub (fixtures/mock-github.mjs), never the real repository.
// Usage: npm run build && node tests/e2e/news.mjs <shotsDir>   (MARIS_EXE=<Maris.exe> for a packaged build)
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { startMockGitHub } from './fixtures/mock-github.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const profile = path.join(os.tmpdir(), `maris-news-${Date.now()}`)

/** A small solid-colour PNG. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const gh = await startMockGitHub()
gh.setRelease('9.9.9', ['Maris-Setup-9.9.9.exe', 'Maris-9.9.9-arm64.dmg', 'Maris-9.9.9-x86_64.AppImage'])
gh.seed('news/images/2026-11-01-welcome/cover.png', png(320, 180, [124, 92, 255]))
gh.seed('news/posts/2026-11-01-welcome.md', '## Hello\n\nThis is the first post, with a picture:\n\n![violet](images/2026-11-01-welcome/cover.png)\n')
gh.seed(
  'news/index.json',
  JSON.stringify({
    version: 1,
    updated: new Date().toISOString(),
    posts: [{ id: '2026-11-01-welcome', title: 'Welcome to Maris news', kind: 'news', date: '2026-11-01T10:00:00Z', summary: 'What this page is for.', file: 'posts/2026-11-01-welcome.md', cover: 'images/2026-11-01-welcome/cover.png' }]
  })
)
const picture = path.join(os.tmpdir(), `maris-test-picture-${Date.now()}.png`)
writeFileSync(picture, png(200, 120, [240, 168, 64]))

const packaged = process.env.MARIS_EXE
const app = await electron.launch({
  executablePath: packaged ?? process.env.MARIS_ELECTRON ?? (await import('electron')).default,
  args: packaged ? [] : [root],
  env: { ...process.env, MARIS_USER_DATA: profile, MARIS_GITHUB_API: `${gh.origin}/api`, MARIS_GITHUB_RAW: `${gh.origin}/raw`, ELECTRON_ENABLE_LOGGING: '1' },
  timeout: 60000
})
const win = await app.firstWindow()
const logs = []
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
const shot = async (name) => {
  await win.screenshot({ path: path.join(shots, `${name}.png`) })
  console.log('shot', name)
}
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

try {
  await win.locator('textarea[aria-label="Message Maris"]').waitFor({ timeout: 30000 })
  const skip = win.getByRole('button', { name: 'Skip setup for now' })
  await skip.waitFor({ timeout: 30000 }).then(() => skip.click()).catch(() => undefined)
  await win.getByRole('dialog', { name: 'Set up Maris' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined)
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => undefined)
  await win.evaluate(() => window.maris.settings.set({ updates: { repo: 'test/maris' } }))
  await win.evaluate(() => Promise.all([window.maris.updates.check(), window.maris.news.refresh()]))
  await win.waitForTimeout(800)

  // ---- Sidebar badge and the update card
  const nav = win.getByRole('button', { name: /Updates & news/ })
  check(/New/.test(await nav.innerText()), `sidebar shows a badge: ${(await nav.innerText()).replace(/\s+/g, ' ')}`)
  await nav.click()
  await win.getByText('Maris 9.9.9 is available').waitFor({ timeout: 10000 })
  check(true, 'update card: Maris 9.9.9 is available')
  check(await win.getByText('Welcome to Maris news').isVisible(), 'post listed')
  check(await win.locator('li img').first().isVisible().catch(() => false), 'post cover picture shown')
  await win.getByRole('button', { name: 'What is new' }).click()
  check(await win.getByText('Skills and connectors').isVisible(), 'release notes shown')
  await shot('news-01-list')

  // ---- Download the update (not installed in the test)
  await win.getByRole('button', { name: /^Download/ }).click()
  await win.getByRole('button', { name: 'Install now' }).waitFor({ timeout: 20000 })
  check(true, 'update downloaded; "Install now" offered')

  // ---- Read a post: text and picture
  await win.getByText('Welcome to Maris news').click()
  await win.getByRole('heading', { name: 'Welcome to Maris news' }).waitFor({ timeout: 10000 })
  check(await win.locator('article .prose-maris img').first().isVisible(), 'picture inside the post shown')
  await shot('news-02-post')
  await win.getByRole('button', { name: 'All posts' }).click()
  const st = await win.evaluate(() => window.maris.news.state())
  check(st.unread === 0, 'opened post counts as read')

  // ---- Admin: token, write a post with a picture, publish
  await win.evaluate(() => window.maris.settings.set({ updates: { admin: true } }))
  await win.getByRole('button', { name: 'Admin', exact: true }).click()
  await win.getByLabel('GitHub token').fill('bad-token')
  await win.getByRole('button', { name: 'Save token' }).click()
  check(await win.getByText(/did not accept the token/).waitFor({ timeout: 10000 }).then(() => true).catch(() => false), 'a wrong token is refused')
  await win.getByLabel('GitHub token').fill('good-token')
  await win.getByRole('button', { name: 'Save token' }).click()
  await win.getByText(/Signed in to GitHub as/).waitFor({ timeout: 10000 })
  check(true, 'token accepted: signed in as test-admin')
  await win.getByLabel('Title').fill('Skills are here')
  await win.getByLabel('Summary').fill('Teach Maris new tasks from git.')
  await win.getByLabel('Post text (Markdown)').fill('## Skills\n\nInstall them from the Skills page.\n\n')
  await win.locator('input[type="file"]').setInputFiles(picture)
  await win.waitForTimeout(400)
  check(/!\[maris-test-picture-\d+\]\(images\/maris-test-picture-\d+\.png\)/.test(await win.getByLabel('Post text (Markdown)').inputValue()), 'picture inserted into the text')
  await win.getByRole('radio', { name: 'Preview' }).click()
  check(await win.locator('section[aria-label="Post editor"] .prose-maris img').isVisible(), 'preview shows the picture')
  await shot('news-03-editor')
  await win.getByRole('button', { name: 'Publish', exact: true }).click()
  await win.getByText('Publish to everyone?').waitFor()
  await win.getByRole('button', { name: 'Publish', exact: true }).click()
  await win.getByText(/Published "Skills are here"/).waitFor({ timeout: 20000 })
  const index = JSON.parse(gh.files.get('news/index.json').toString())
  const post = index.posts.find((p) => p.title === 'Skills are here')
  check(Boolean(post) && index.posts.length === 2, `index.json has the new post (${index.posts.length} posts)`)
  const md = post ? gh.files.get(`news/${post.file}`)?.toString() : ''
  check(Boolean(md) && md.includes(`images/${post.id}/`), 'post Markdown committed with picture paths under its own folder')
  check([...gh.files.keys()].some((k) => k.startsWith(`news/images/${post?.id}/`)), 'picture committed')
  check(gh.commitLog.length === 1, `one commit for the whole post (${gh.commitLog.join(' | ')})`)
  check(post?.cover?.startsWith(`images/${post.id}/`), 'first picture became the cover')
  await shot('news-04-published')

  // ---- Edit, then remove
  await win.getByRole('button', { name: 'Edit' }).first().click()
  await win.getByText('Editing a published post').waitFor({ timeout: 10000 })
  await win.getByLabel('Title').fill('Skills are here!')
  await win.getByRole('button', { name: 'Publish changes' }).click()
  await win.getByRole('button', { name: 'Publish', exact: true }).click()
  await win.getByText(/Published "Skills are here!"/).waitFor({ timeout: 20000 })
  const index2 = JSON.parse(gh.files.get('news/index.json').toString())
  check(index2.posts.length === 2 && index2.posts.some((p) => p.id === post.id && p.title === 'Skills are here!'), 'edit kept the same post and changed its title')
  await win.getByRole('button', { name: 'Remove Skills are here!' }).click()
  await win.getByRole('button', { name: /Remove for everyone/ }).click()
  await win.getByText(/Post removed/).waitFor({ timeout: 20000 })
  const index3 = JSON.parse(gh.files.get('news/index.json').toString())
  check(index3.posts.length === 1 && !gh.files.has(`news/${post.file}`) && ![...gh.files.keys()].some((k) => k.startsWith(`news/images/${post.id}/`)), 'removed: post, pictures and list entry')
} catch (e) {
  failures++
  console.error('ERROR', e)
  await shot('news-error').catch(() => undefined)
} finally {
  if (logs.length) console.log(logs.slice(-10).join('\n'))
  await app.close().catch(() => undefined)
  gh.close()
  rmSync(profile, { recursive: true, force: true })
  rmSync(picture, { force: true })
}
console.log(failures ? `${failures} check(s) failed` : 'all news checks passed')
process.exit(failures ? 1 : 0)
