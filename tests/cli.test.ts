import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, Usage } from '../src/cli/args.ts'
import { PLAIN_STYLE, Prose, textWidth, type ProseStyle } from '../src/cli/prose.ts'

/** Render Markdown through the streaming formatter, fed in pieces of the given size. */
function render(md: string, width: number, piece: number, style: ProseStyle = PLAIN_STYLE, margin = ''): string {
  let out = ''
  const p = new Prose((s) => (out += s), style, () => width, margin)
  for (let i = 0; i < md.length; i += piece) p.push(md.slice(i, i + piece))
  p.end()
  return out
}

const SAMPLE = [
  '# Disk space',
  '',
  'Your **C:** drive has `140 GB` free. The biggest folders are below; see [the guide](https://example.com/guide) for more.',
  '',
  '- Downloads: 52 GB of installers and videos you probably no longer need',
  '- Games',
  '  - Steam: 210 GB',
  '1. Empty the Recycle Bin',
  '',
  '```powershell',
  'Get-ChildItem C:\\ -Directory | Sort-Object Length',
  '```',
  '',
  '> Deleting files cannot be undone.',
  '',
  '---',
  'Done 2 * 3 = 6.'
].join('\n')

test('cli: streamed Markdown looks the same however it is chunked', () => {
  const whole = render(SAMPLE, 60, SAMPLE.length)
  for (const piece of [1, 2, 3, 7, 13]) assert.equal(render(SAMPLE, 60, piece), whole, `pieces of ${piece}`)
})

test('cli: Markdown becomes readable terminal text', () => {
  const out = render(SAMPLE, 60, 5)
  const lines = out.split('\n')
  assert.equal(lines[0], 'Disk space', 'heading without the #')
  assert.ok(out.includes('Your C: drive has 140 GB free.'), 'bold and code markers removed')
  assert.ok(out.includes('the guide (https://example.com/guide)'), 'links keep their address in plain text')
  assert.ok(lines.includes('- Games'), 'bullets')
  assert.ok(lines.some((l) => l === '  - Steam: 210 GB'), 'nested bullets are indented')
  assert.ok(lines.includes('1. Empty the Recycle Bin'), 'numbered items')
  assert.ok(lines.includes('powershell'), 'code block language')
  assert.ok(lines.includes('| Get-ChildItem C:\\ -Directory | Sort-Object Length'), 'code keeps its text, with a gutter')
  assert.ok(!out.includes('```'), 'fences are not printed')
  assert.ok(lines.includes('| Deleting files cannot be undone.'), 'quotes')
  assert.ok(lines.some((l) => /^-{8,}$/.test(l)), 'horizontal rule')
  assert.ok(out.includes('Done 2 * 3 = 6.'), 'a lone * stays')
  assert.ok(!/\n\n\n/.test(out), 'no runs of blank lines')
})

test('cli: long lines wrap at word boundaries under the bullet', () => {
  const out = render('- Downloads: 52 GB of installers and videos you probably no longer need\n', 30, 4)
  const lines = out.trimEnd().split('\n')
  assert.ok(lines.length > 1, 'wrapped')
  for (const l of lines) assert.ok(textWidth(l) <= 29, `fits: "${l}"`)
  assert.ok(lines[0].startsWith('- '))
  for (const l of lines.slice(1)) assert.ok(l.startsWith('  ') && !l.startsWith('   '), `hanging indent: "${l}"`)
  assert.equal(lines.join(' ').replace(/\s+/g, ' ').replace('- ', ''), 'Downloads: 52 GB of installers and videos you probably no longer need')
})

test('cli: a margin is kept on every line and markers split across pieces still work', () => {
  const style: ProseStyle = { ...PLAIN_STYLE, bold: (s) => `<b>${s}</b>`, code: (s) => `<c>${s}</c>` }
  const out = render('Say **hello** to `maris`\nnext', 80, 1, style, '  ')
  assert.equal(out, '  Say <b>h</b><b>e</b><b>l</b><b>l</b><b>o</b> to <c>m</c><c>a</c><c>r</c><c>i</c><c>s</c>\n  next\n')
  assert.equal(textWidth('日本'), 4)
  assert.equal(textWidth('héllo'), 5)
})

test('cli: text that continues after a step keeps its margin', () => {
  let out = ''
  const p = new Prose((s) => (out += s), PLAIN_STYLE, () => 80, '  ')
  p.push('Checking **the')
  p.end()
  out += '  ✓ Read the file\n'
  p.push('All good.\n')
  p.end()
  assert.equal(out, '  Checking the\n  ✓ Read the file\n  All good.\n')
})

test('cli: arguments', () => {
  assert.deepEqual(parse(['how', 'much', 'RAM']).words, ['how', 'much', 'RAM'])
  const a = parse(['code', '.', 'fix the tests', '-m', 'max', '--no-web'])
  assert.equal(a.sub, 'code')
  assert.deepEqual(a.words, ['.', 'fix the tests'])
  assert.equal(a.model, 'max')
  assert.equal(a.web, false)
  assert.equal(parse(['--model=fast', 'hi']).model, 'fast')
  assert.equal(parse(['image', 'a fox', '--quality', 'fast', '-n', '2', '--open']).count, 2)
  assert.deepEqual(parse(['--', '-not-an-option']).words, ['-not-an-option'])
  // A word that looks like a subcommand later in a question stays part of the question.
  assert.deepEqual(parse(['please', 'open', 'it']).words, ['please', 'open', 'it'])
  assert.equal(parse(['-c']).cont, true)
  assert.equal(parse(['--chat', 'a1b2c3']).chat, 'a1b2c3')
  assert.throws(() => parse(['--bogus']), Usage)
  assert.throws(() => parse(['--model']), Usage)
  assert.throws(() => parse(['image', 'x', '--quality', 'best']), Usage)
})
