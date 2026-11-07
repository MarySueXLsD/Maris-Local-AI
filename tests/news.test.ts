import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyForDisplay, entryFromMarkdown, mergeNews, parseChecksums, splitFrontMatter } from '../src/main/feed/pure.ts'

test('front matter: fields at the top of a post, and the text after them', () => {
  const { meta, body } = splitFrontMatter('---\ntitle: "Skills, explained"\nDate: 2026-11-05\npinned: yes\n---\n# Skills\n\nText.\n')
  assert.equal(meta.title, 'Skills, explained')
  assert.equal(meta.date, '2026-11-05')
  assert.equal(meta.pinned, 'yes')
  assert.equal(body, '# Skills\n\nText.\n')
  // Windows line ends and a byte-order mark, as editors on Windows write them.
  assert.equal(splitFrontMatter('﻿---\r\ntitle: Hi\r\n---\r\nBody').meta.title, 'Hi')
  // No front matter: the text as it is.
  assert.deepEqual(splitFrontMatter('# Just text\n'), { meta: {}, body: '# Just text\n' })
})

test('a plain Markdown file is a post: title from its heading, date from its name, summary from its first paragraph', () => {
  const e = entryFromMarkdown('2026-11-05-plain-post.md', '# Plain Markdown post\n\nWritten straight into the **news** folder in [git](https://github.com).\n\nMore text.\n')
  assert.equal(e.id, '2026-11-05-plain-post')
  assert.equal(e.title, 'Plain Markdown post')
  assert.equal(e.date, '2026-11-05T12:00:00.000Z')
  assert.equal(e.summary, 'Written straight into the news folder in git.')
  assert.equal(e.kind, 'news')
  assert.equal(e.file, '2026-11-05-plain-post.md')
  assert.equal(e.source, 'file')
})

test('front matter wins over what the text says', () => {
  const md = '---\ntitle: Maris 0.3.0\nkind: update\nversion: v0.3.0\ndate: 2026-12-01\nsummary: Faster pictures.\ncover: images/030.png\nauthor: MarySue\n---\n# Something else\n\nFirst paragraph.\n'
  const e = entryFromMarkdown('posts/release-030.md', md)
  assert.equal(e.title, 'Maris 0.3.0')
  assert.equal(e.kind, 'update')
  assert.equal(e.version, '0.3.0')
  assert.equal(e.summary, 'Faster pictures.')
  assert.equal(e.cover, 'images/030.png')
  assert.equal(e.author, 'MarySue')
  assert.equal(e.file, 'posts/release-030.md')
  assert.equal(e.id, 'release-030')
})

test('without a heading the file name becomes the title; the first picture becomes the cover', () => {
  const e = entryFromMarkdown('new_skills-tab.md', '![The new tab](images/skills.png)\n\nSkills now have a tab of their own.\n')
  assert.equal(e.title, 'New skills tab')
  assert.equal(e.cover, 'images/skills.png')
  assert.equal(e.summary, 'Skills now have a tab of their own.')
  assert.equal(e.date, '')
  // A version in the front matter alone makes it update notes.
  assert.equal(entryFromMarkdown('x.md', '---\nversion: 1.2.0\n---\nText').kind, 'update')
})

test('long first paragraphs are cut at a word', () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const e = entryFromMarkdown('long.md', `# Long\n\n${words}\n`)
  assert.ok(e.summary.length <= 220, `${e.summary.length} characters`)
  // Cut after a whole word, not in the middle of one.
  assert.match(e.summary, / word\d+…$/)
  assert.ok(words.includes(e.summary.slice(0, -1)))
})

test('index.json posts and Markdown files are listed once each', () => {
  const indexed = [
    { id: 'welcome', title: 'Welcome', kind: 'news' as const, date: '2026-11-01', summary: '', file: 'posts/welcome.md' }
  ]
  const files = [
    entryFromMarkdown('posts/welcome.md', '# Welcome (from the file)\n\nx'),
    entryFromMarkdown('welcome.md', '# Same id, other file\n\nx'),
    entryFromMarkdown('plain.md', '# Plain\n\nx')
  ]
  const merged = mergeNews(indexed, files)
  assert.deepEqual(
    merged.map((p) => p.title),
    ['Welcome', 'Plain']
  )
  // Either list may be empty.
  assert.equal(mergeNews([], files).length, 2)
  assert.equal(mergeNews(indexed, []).length, 1)
})

test('the reader shows a post without its front matter or a heading that repeats the title', () => {
  assert.equal(bodyForDisplay('---\ntitle: Hello\n---\n# Hello\n\nText.\n', 'Hello'), 'Text.\n')
  assert.equal(bodyForDisplay('# Another heading\n\nText.', 'Hello'), '# Another heading\n\nText.')
  assert.equal(bodyForDisplay('## Hello\n\nText.', 'Hello'), '## Hello\n\nText.')
})

test('SHA256SUMS lists: file name to fingerprint', () => {
  const a = 'a'.repeat(64)
  const b = 'B'.repeat(64)
  const sums = parseChecksums(`${a}  Maris-Setup-0.3.0.exe\n${b} *win-unpacked/Maris.exe\r\nnot a line\n`)
  assert.equal(sums.get('Maris-Setup-0.3.0.exe'), a)
  assert.equal(sums.get('Maris.exe'), 'b'.repeat(64))
  assert.equal(sums.size, 2)
})
