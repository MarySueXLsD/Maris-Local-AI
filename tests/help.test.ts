// Maris answering questions about itself: finding the Help article that fits a question (maris_help),
// links to its own pages in answers, and knowing when a request is about the app at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { APP_QUESTION, APP_STATE_QUESTION, excerpt, helpSections, queryTerms, searchHelp, type HelpDoc } from '../src/shared/helpSearch.ts'
import { isPageLink, pageLink, pageNames, parsePage, splitPages } from '../src/shared/pages.ts'
import { SECTIONS } from '../src/renderer/src/views/settings/schema.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const doc = (id: string, title: string, keywords: string, body: string, summary = ''): HelpDoc => ({ id, title, keywords, body, summary })

test('the words of a question that carry its topic', () => {
  assert.deepEqual(queryTerms('i wanna connect claude to this app how can i do it'), ['connect', 'claude'])
  assert.deepEqual(queryTerms('How do I use Maris on my phone?'), ['phone'])
  assert.deepEqual(queryTerms('connecting connectors'), ['connect', 'connector'])
  assert.deepEqual(queryTerms('what is it'), [])
})

test('an article that covers more of the question wins over one that repeats a word', () => {
  const docs = [
    doc('connectors', 'Connectors: linking Maris to other services', 'connectors connect services github notion', 'Press Connect. Connect GitHub. Connected.', 'Connect GitHub and Notion.'),
    doc('api-models', 'Claude, GPT and other API models', 'api key claude anthropic openai gpt', 'Paste the key and click Connect.'),
    doc('themes', 'Themes and colours', 'theme dark light', 'Pick a card.')
  ]
  assert.equal(searchHelp(docs, 'i wanna connect claude to this app')[0]?.id, 'api-models')
  assert.equal(searchHelp(docs, 'connect github')[0]?.id, 'connectors')
  assert.equal(searchHelp(docs, 'dark')[0]?.id, 'themes')
  assert.deepEqual(searchHelp(docs, 'quantum gardening'), [], 'nothing fits: nothing is returned')
  assert.equal(searchHelp(docs, 'themes cost')[0]?.id, 'themes', 'an id asked for by name')
})

test('a long article is cut to the parts that answer the question', () => {
  const body = ['Opening words.', '## Adding a service', 'Open Models → API and paste the key.', '## What it costs', 'x '.repeat(400), '## Thinking', 'y '.repeat(400)].join('\n')
  const d = doc('api-models', 'API models', 'api', body, 'Summary.')
  assert.deepEqual(
    helpSections(body).map((s) => s.heading),
    ['', 'Adding a service', 'What it costs', 'Thinking']
  )
  const whole = excerpt(d, 'add a key', 10000)
  assert.deepEqual(whole.left, [], 'it fits: all of it')
  assert.match(whole.text, /^# API models\nSummary\./)
  const part = excerpt(d, 'adding a service with a key', 400)
  assert.match(part.text, /Opening words/)
  assert.match(part.text, /Open Models → API/)
  assert.deepEqual(part.left, ['What it costs', 'Thinking'], 'what was left out is named')
  const cost = excerpt(d, 'what it costs', 1100)
  assert.match(cost.text, /## What it costs/)
  assert.ok(!/## Thinking/.test(cost.text))
})

test('links to Maris pages', () => {
  assert.deepEqual(parsePage('page:models/api'), { view: 'models', tab: 'api' })
  assert.deepEqual(parsePage('page:models/pictures'), { view: 'models', tab: 'image' })
  assert.deepEqual(parsePage('page:settings/phone'), { view: 'settings', section: 'phone' })
  assert.deepEqual(parsePage('page:connectors'), { view: 'connectors' })
  assert.deepEqual(parsePage('page:code'), { view: 'chat', mode: 'code' })
  assert.equal(parsePage('page:models/nothing'), undefined)
  assert.equal(parsePage('page:admin'), undefined, 'not a page an answer may open')
  assert.ok(isPageLink('page:models/api'))
  assert.ok(!isPageLink('page:models/api?x=1'))
  assert.ok(!isPageLink('javascript:alert(1)'))
  assert.equal(pageLink('Models → API', 'models/api'), '[Models → API](page:models/api)')
})

test('page names written as plain text become links', () => {
  const names = pageNames(SECTIONS)
  const pages = (text: string): (string | undefined)[] => splitPages(text, names).map((p) => p.page ?? undefined).filter(Boolean)
  assert.deepEqual(splitPages('Open Models → API in the app.', names), [{ text: 'Open ' }, { text: 'Models → API', page: 'models/api' }, { text: ' in the app.' }])
  assert.deepEqual(pages('Go to Settings -> Phone, then models > api'), ['settings/phone', 'models/api'])
  assert.deepEqual(pages('Settings → Window and startup → Terminal command'), ['settings/window'], 'the longest page name, and what follows stays text')
  assert.deepEqual(pages('Settings → Images and video'), ['settings/media'])
  assert.deepEqual(pages('Models → Text → Roles'), ['models/text'])
  assert.deepEqual(pages('The Models page and the Settings page'), [], 'plain words are left alone')
  assert.deepEqual(pages('a -> b and x > y'), [])
  assert.deepEqual(pages('Models → APIs'), [], 'not inside a longer word')
  for (const n of names) assert.ok(parsePage(n.target), `${n.name} leads to a page`)
})

test('a request about the app is recognised, ordinary requests are not', () => {
  for (const t of [
    'i wanna connect claude to this app how can i do it',
    'I mean i want to connect maris to claude',
    'how do I add a model',
    'can you make videos?',
    'how can I use you on my phone',
    'where do I put my API key',
    'как подключить claude'
  ]) {
    assert.ok(APP_QUESTION.test(t), t)
  }
  for (const t of ['what is the capital of France', 'write a poem about autumn', 'translate this to German', 'summarise the text below']) assert.ok(!APP_QUESTION.test(t), t)
  assert.ok(APP_STATE_QUESTION.test('which models do I have?'))
  assert.ok(APP_STATE_QUESTION.test('is Claude connected'))
  assert.ok(!APP_STATE_QUESTION.test('tell me a joke'))
})

// ------------------------------------------------------------------ the real articles

/** The app's help articles, loaded the way the unit tests can: a copy with file extensions on its imports. */
async function realArticles(): Promise<HelpDoc[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maris-help-'))
  try {
    cpSync(path.join(root, 'src/renderer/src/help/glossary.ts'), path.join(dir, 'glossary.ts'))
    cpSync(path.join(root, 'src/renderer/src/lib/platform.ts'), path.join(dir, 'platform.ts'))
    const src = read('src/renderer/src/help/articles.ts').replace("'../lib/platform'", "'./platform.ts'").replace("'./glossary'", "'./glossary.ts'")
    writeFileSync(path.join(dir, 'articles.ts'), src)
    return ((await import(pathToFileURL(path.join(dir, 'articles.ts')).href)) as { ARTICLES: HelpDoc[] }).ARTICLES
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('real questions find the right article', async () => {
  const articles = await realArticles()
  const cases: [string, string][] = [
    ['i wanna connect claude to this app how can i do it', 'api-models'],
    ['I mean i want to connect maris to claude', 'api-models'],
    ['add chatgpt', 'api-models'],
    ['how much does an api model cost', 'api-models'],
    ['use maris on my phone', 'phone'],
    ['android app pairing', 'phone'],
    ['connect github', 'connectors'],
    ['install a skill from git', 'skills'],
    ['dark theme', 'themes'],
    ['can you draw pictures', 'studio'],
    ['make a video', 'studio'],
    ['update maris to a new version', 'updates'],
    ['what does maris remember about me', 'memory'],
    ['stop asking for approval every time', 'approvals'],
    ['terminal command', 'terminal'],
    ['keyboard shortcuts', 'shortcuts'],
    ['is my data private', 'privacy'],
    ['old laptop without graphics card', 'slow-pc'],
    ['ollama is stopped', 'troubleshooting']
  ]
  for (const [question, want] of cases) assert.equal(searchHelp(articles, question)[0]?.id, want, question)
})

test('help links, page links and the assistant’s article tables point at things that exist', async () => {
  const articles = await realArticles()
  const ids = new Set(articles.map((a) => a.id))
  assert.equal(ids.size, articles.length, 'article ids are unique')
  for (const a of articles) {
    for (const m of a.body.matchAll(/\]\(help:([a-z0-9-]+)\)/g)) assert.ok(ids.has(m[1]!), `${a.id} links to help:${m[1]}`)
  }
  // src/main/tools/app.ts names articles (where each lives in the app, which facts fit) and settings sections.
  const tool = read('src/main/tools/app.ts')
  const table = (name: string): string => new RegExp(`const ${name}: Record<.+?> = \\{([\\s\\S]*?)\\r?\\n\\}`).exec(tool)?.[1] ?? ''
  for (const name of ['WHERE', 'NOW']) {
    const keys = [...table(name).matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]!)
    assert.ok(keys.length > 5, `${name} was read`)
    for (const k of keys) assert.ok(ids.has(k), `${name} names the article "${k}"`)
  }
  const sections = new Set<string>(SECTIONS.map((s) => s.id))
  for (const m of tool.matchAll(/settingsPage\('([a-z]+)'\)/g)) assert.ok(sections.has(m[1]!), `Settings has a section "${m[1]}"`)
  for (const m of tool.matchAll(/pageLink\('[^']+', '([a-z/]+)'\)/g)) assert.ok(parsePage(m[1]!), `page:${m[1]} is a page`)
  // Every article says where its subject lives, so an answer can link to the page.
  const where = new Set([...table('WHERE').matchAll(/^\s+'?([a-z-]+)'?:/gm)].map((m) => m[1]!))
  for (const a of articles) if (!['chatting', 'code-tips', 'glossary'].includes(a.id)) assert.ok(where.has(a.id), `WHERE covers "${a.id}"`)
})

test('the assistant is told about the app and its help in every kind of instructions', () => {
  const prompts = read('src/main/agent/prompts.ts')
  assert.match(prompts, /## Maris, the app you are part of/)
  assert.match(prompts, /Models → API/)
  assert.ok((prompts.match(/maris_help/g) ?? []).length >= 3, 'chat, Code mode and the short instructions all name maris_help')
})
