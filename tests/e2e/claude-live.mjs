// A live check of the Claude integration, with a real key against the real service: reads the model
// list, then runs a plain answer, tool use, reading a file, thinking (on, off, and together with a
// tool), an approved file change, a picture and Stop through several models, and adds up what the
// service counted and what that comes to at each model's price.
//
// Unlike the other tests this one costs money on the account whose key is used (short prompts: from
// a few cents to a dollar or two, depending on the models), so it only runs when you start it:
//
//   node tests/e2e/claude-live.mjs [shotsDir] [--max 6] [--models id,id] [--all] [--only pong,tool]
//   node tests/e2e/claude-live.mjs --dry      (tries the test itself against the stand-in: no key, no cost)
//
// The key is asked for in the terminal (not shown), or taken from ANTHROPIC_API_KEY when that is
// set. It is never printed or written to a file by this script. It goes into the app's own keychain
// store in a throwaway profile, which is deleted when the test ends, and from there only to
// api.anthropic.com. Nothing else is real: fixtures/mock-llm.mjs stands in for Ollama.
import { deflateSync, crc32 } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, makeProfile, removeProfile, root } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : undefined
}
const shots = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : path.join(root, 'test-results', 'claude-live'))
const MAX = Number(flag('--max')) || 6
const WANTED = (flag('--models') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const ALL = argv.includes('--all')
const ONLY = new Set((flag('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const DRY = argv.includes('--dry')
mkdirSync(shots, { recursive: true })

// The packaged app is the one to test when it has been built (npm run dist:dir).
const built = path.join(root, 'release', 'windows', 'win-unpacked', 'Maris.exe')
if (!process.env.MARIS_EXE && !process.env.MARIS_ELECTRON && existsSync(built)) process.env.MARIS_EXE = built

/** Ask for the key without showing it. */
async function askKey() {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const { stdin, stdout } = process
  stdout.write('Paste your Claude API key and press Enter (it is not shown): ')
  if (!stdin.isTTY) {
    let data = ''
    for await (const chunk of stdin) {
      data += chunk
      if (data.includes('\n')) break
    }
    return data.split(/\r?\n/)[0].trim()
  }
  return await new Promise((resolve) => {
    let buf = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (value) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      // A paste may arrive wrapped in bracketed-paste marks.
      for (const ch of String(chunk).replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return done(buf.trim())
        if (ch === '\u0003') {
          done('')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else if (ch >= ' ') buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** A small picture of one colour, as a PNG data URL (no picture library needed). */
function solidPng(r, g, b, size = 64) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).map((_, i) => [r, g, b][i % 3])])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, size: png.length }
}

const mock = await startMockLlm()
const key = DRY ? mock.key : await askKey()
if (!key) {
  console.error('No key given, so nothing was tested.')
  process.exit(2)
}

const work = path.join(os.tmpdir(), `maris-claude-live-${Date.now()}`)
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'alpha.txt'), 'first file')
writeFileSync(path.join(work, 'beta.md'), 'second file')
writeFileSync(path.join(work, 'secret.txt'), 'The secret word is pineapple.')

const profile = makeProfile('claude-live', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, web: { enabled: false } })
const { app, win, logs } = await launch(profile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (e) => String(e?.message ?? e).replace(/^.*Error invoking remote method '[^']+': (\w*Error: )?/s, '').replaceAll(key, '<key>')

/** Send one message to one model in a new chat and wait for the answer (or for an approval to appear). */
async function ask(model, text, { think = 'auto', attachments = [], timeout = 240000, untilApproval = false, untilText = false } = {}) {
  const { conversationId } = await win.evaluate((o) => window.maris.chat.send(o), { text, attachments, model, think, webAccess: false })
  await win.evaluate((id) => window.__marisStore.getState().open(id), conversationId)
  const t0 = Date.now()
  for (;;) {
    await sleep(400)
    const r = await win.evaluate((id) => window.maris.conv.get(id), conversationId)
    const last = r?.messages.filter((m) => m.role === 'assistant').pop()
    if (untilApproval) {
      const waiting = (await win.evaluate(() => window.maris.chat.approvals())).find((a) => a.conversationId === conversationId)
      if (waiting) return { conversationId, last, approval: waiting }
    }
    if (untilText && last?.parts.some((p) => p.type === 'text' && p.text.length > 200)) return { conversationId, last }
    if (r && !r.running && last && last.status !== 'streaming' && last.status !== 'waiting') return { conversationId, last }
    if (Date.now() - t0 > timeout) return { conversationId, last, timedOut: true }
  }
}
const finish = async (conversationId, timeout = 240000) => {
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    await sleep(400)
    const r = await win.evaluate((id) => window.maris.conv.get(id), conversationId)
    const last = r?.messages.filter((m) => m.role === 'assistant').pop()
    if (r && !r.running && last && last.status !== 'streaming' && last.status !== 'waiting') return last
  }
  return undefined
}
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
const toolsOf = (m) => (m?.parts ?? []).filter((p) => p.type === 'tool').map((p) => p.call)
const notesOf = (m) => (m?.parts ?? []).filter((p) => p.type === 'notice').map((p) => p.text)

const results = []
let exitCode = 0
try {
  // ---- connect, the way the Connect button does
  // (A dry run points the same code at the stand-in, under a name that does not look local.)
  const list = await win
    .evaluate(([k, baseUrl]) => window.maris.providers.add('anthropic', { key: k, ...(baseUrl ? { baseUrl } : {}) }), [key, DRY ? `http://localhost.:${mock.port}/anthropic` : ''])
    .catch((e) => {
      throw new Error(`could not connect: ${clean(e)}`)
    })
  const service = list.find((p) => p.id === 'anthropic')
  console.log(`\nConnected. Claude lists ${service.models.length} models:\n`)
  const newest = [...service.models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  for (const m of newest) {
    const can = [m.vision ? 'sees pictures' : m.vision === false ? 'no pictures' : 'pictures: not said', m.thinking ? `thinking (${m.thinkingMode ?? 'mode not said'})` : m.thinking === false ? 'no thinking' : 'thinking: not said']
    console.log(`  ${(m.label ?? m.id).padEnd(26)} ${m.id.padEnd(34)} ${String(m.contextLength ?? '?').padStart(8)} in  ${String(m.maxOutput ?? '?').padStart(7)} out  ${can.join(', ')}`)
  }

  // ---- which models: the newest of each family and the oldest one listed, unless told otherwise
  let chosen
  if (WANTED.length) chosen = WANTED.map((id) => service.models.find((m) => m.id === id) ?? { id })
  else if (ALL) chosen = newest
  else {
    const family = (m) => (m.label ?? m.id).replace(/[\d.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    const seen = new Set()
    chosen = newest.filter((m) => !seen.has(family(m)) && seen.add(family(m))).slice(0, MAX - 1)
    const oldest = newest[newest.length - 1]
    if (oldest && !chosen.includes(oldest)) chosen.push(oldest)
  }
  await win.evaluate((ids) => window.maris.providers.setPicked('anthropic', ids), chosen.map((m) => m.id))
  console.log(`\nTesting ${chosen.length}: ${chosen.map((m) => m.label ?? m.id).join(', ')}\n`)

  const red = solidPng(220, 30, 30)
  for (const info of chosen) {
    const model = `@anthropic/${info.id}`
    const name = info.label ?? info.id
    const row = { name, id: info.id, checks: {}, tokensIn: 0, tokensOut: 0, cached: 0, cost: 0, priced: true, ms: 0, notes: [] }
    results.push(row)
    const note = (check, m, ok, detail) => {
      row.checks[check] = ok
      row.tokensIn += m?.stats?.promptTokens ?? 0
      row.tokensOut += m?.stats?.outputTokens ?? 0
      row.cached += m?.stats?.cacheReadTokens ?? 0
      row.cost += m?.stats?.costUsd ?? 0
      if (m?.stats && (m.stats.costUsd === undefined || m.stats.costPartial)) row.priced = false
      row.ms += m?.stats?.durationMs ?? 0
      const why = m?.error ?? detail ?? ''
      if (!ok) exitCode = 1
      for (const n of notesOf(m)) row.notes.push(`${check}: ${n}`)
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: ${check}${ok ? '' : ` — ${clean(why).replace(/\s+/g, ' ').slice(0, 300)}`}`)
    }
    const run = async (check, fn) => {
      if (ONLY.size && !ONLY.has(check)) return
      try {
        await fn()
      } catch (e) {
        note(check, undefined, false, clean(e))
      }
    }

    await run('pong', async () => {
      const { last, timedOut } = await ask(model, 'Reply with exactly one word: pong')
      note('pong', last, !timedOut && last?.status === 'done' && /pong/i.test(textOf(last)), timedOut ? 'no answer in time' : `answered: ${textOf(last).slice(0, 120)}`)
    })
    // The service must accept what Maris sends on a first plain message before anything else is worth trying.
    if (row.checks.pong === false && !ONLY.size) continue

    await run('tool', async () => {
      const { last, timedOut } = await ask(model, `List the files in this folder and reply with only the file names, comma-separated: ${work}`)
      const used = toolsOf(last).some((c) => c.name === 'list_dir' && c.status === 'done')
      note('tool', last, !timedOut && used && /alpha\.txt/.test(textOf(last)) && /beta\.md/.test(textOf(last)), used ? `answered: ${textOf(last).slice(0, 160)}` : `no list_dir call; answered: ${textOf(last).slice(0, 160)}`)
    })

    await run('read', async () => {
      const { last, timedOut } = await ask(model, `Read the file ${path.join(work, 'secret.txt')} and reply with only the secret word it contains.`)
      note('read', last, !timedOut && /pineapple/i.test(textOf(last)), `answered: ${textOf(last).slice(0, 160)}`)
    })

    await run('think', async () => {
      const { last, timedOut } = await ask(model, 'What is 17 × 23? Work it out, then give just the number.', { think: 'on' })
      const thought = last?.parts.some((p) => p.type === 'thinking' && p.text.trim())
      row.thought = thought ? 'yes' : info.thinking ? 'not shown' : 'n/a'
      note('think', last, !timedOut && last?.status === 'done' && /391/.test(textOf(last)), `answered: ${textOf(last).slice(0, 160)}`)
    })

    // Thinking and a tool in one turn: the model's own thinking has to go back to it unchanged with the result.
    await run('thinktool', async () => {
      const { last, timedOut } = await ask(model, `List the files in this folder and reply with only the file names, comma-separated: ${work}`, { think: 'on' })
      const used = toolsOf(last).some((c) => c.name === 'list_dir' && c.status === 'done')
      note('thinktool', last, !timedOut && last?.status === 'done' && used && /alpha\.txt/.test(textOf(last)), used ? `answered: ${textOf(last).slice(0, 160)}` : `no list_dir call; answered: ${textOf(last).slice(0, 160)}`)
    })

    // Thinking turned off by the person: the answer has to come all the same, whatever the model allows.
    await run('quiet', async () => {
      const { last, timedOut } = await ask(model, 'Reply with exactly one word: quiet', { think: 'off' })
      row.quietThought = last?.parts.some((p) => p.type === 'thinking' && p.text.trim()) ? 'thought anyway (shown)' : 'no thinking shown'
      note('quiet', last, !timedOut && last?.status === 'done' && /quiet/i.test(textOf(last)), `answered: ${textOf(last).slice(0, 120)}`)
    })

    await run('write', async () => {
      const target = path.join(work, `made-by-${info.id.replace(/[^\w.-]+/g, '_')}.txt`)
      const first = await ask(model, `Create a text file at ${target} containing exactly this text: hello from Claude`, { untilApproval: true })
      if (!first.approval) return note('write', first.last, false, `no approval was asked for; answered: ${textOf(first.last).slice(0, 160)}`)
      const before = existsSync(target)
      await win.evaluate((id) => window.maris.chat.approve(id, true), first.approval.id)
      const last = await finish(first.conversationId)
      note('write', last, !before && existsSync(target) && readFileSync(target, 'utf8').includes('hello from Claude'), before ? 'the file existed before approval' : 'the file was not written after approval')
    })

    await run('picture', async () => {
      if (info.vision === false) {
        row.checks.picture = null
        return
      }
      const { last, timedOut } = await ask(model, 'What colour fills this picture? Answer with one word.', {
        attachments: [{ id: `red-${Date.now()}`, kind: 'image', name: 'colour.png', mime: 'image/png', size: red.size, dataUrl: red.dataUrl }]
      })
      note('picture', last, !timedOut && /\bred\b/i.test(textOf(last)), `answered: ${textOf(last).slice(0, 160)}`)
    })

    await run('stop', async () => {
      const first = await ask(model, 'Write a detailed essay of about 900 words on the history of the bicycle.', { untilText: true, timeout: 120000 })
      if (!first.last || first.last.status === 'done') return note('stop', first.last, first.last?.status === 'done', 'the answer never started')
      await win.evaluate((id) => window.maris.chat.stop(id), first.conversationId)
      const last = await finish(first.conversationId, 20000)
      note('stop', last, last?.status === 'stopped' && !last.error && textOf(last).length > 100, `status ${last?.status}`)
    })
    await win.screenshot({ path: path.join(shots, `claude-live-${info.id.replace(/[^\w.-]+/g, '_')}.png`) }).catch(() => undefined)
  }

  // ---- what it came to: the prices in effect, and Maris's own record of the run
  const pricedNow = (await win.evaluate(() => window.maris.providers.list())).find((p) => p.id === 'anthropic')?.priced ?? {}
  const record = await win.evaluate(() => window.maris.providers.usage())

  // ---- what Maris had to learn along the way (nothing, when the model list told the truth)
  let learned = {}
  try {
    learned = JSON.parse(readFileSync(path.join(profile, 'provider-quirks.json'), 'utf8'))
  } catch {
    /* nothing learned */
  }

  // ---- report
  const CHECKS = ['pong', 'tool', 'read', 'think', 'thinktool', 'quiet', 'write', 'picture', 'stop'].filter((c) => !ONLY.size || ONLY.has(c))
  const money = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
  const priceOf = (id) => {
    const p = pricedNow[id]
    return p ? `$${p.price.in} / $${p.price.out} (${p.source === 'list' ? 'list price' : p.source === 'yours' ? 'your price' : 'from the service'})` : 'not known'
  }
  const mark = (v) => (v === true ? 'pass' : v === false ? 'FAIL' : v === null ? 'n/a' : '-')
  const lines = [
    '# Claude live test',
    '',
    `Run on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC against ${DRY ? 'the stand-in (a dry run, no real model answered)' : 'api.anthropic.com'} with ${chosen.length} of the ${service.models.length} models the service lists.`,
    '',
    `| Model | ${CHECKS.join(' | ')} | thinking shown | tokens in / out | time |`,
    `| --- | ${CHECKS.map(() => '---').join(' | ')} | --- | --- | --- |`,
    ...results.map((r) => `| ${r.name} (\`${r.id}\`) | ${CHECKS.map((c) => mark(r.checks[c])).join(' | ')} | ${r.thought ?? '-'} | ${r.tokensIn} / ${r.tokensOut} | ${Math.round(r.ms / 1000)} s |`),
    '',
    'What it came to, as Maris shows it (an estimate from each model’s price; the bill at the service is what counts):',
    '',
    '| Model | price per 1M read / written | tokens read | of them cached | written | cost | with "Think: off" |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${priceOf(r.id)} | ${r.tokensIn} | ${r.cached} | ${r.tokensOut} | ${r.priced ? money(r.cost) : r.cost ? `over ${money(r.cost)}` : 'not known'} | ${r.quietThought ?? '-'} |`),
    `| **All** | | ${results.reduce((a, r) => a + r.tokensIn, 0)} | ${results.reduce((a, r) => a + r.cached, 0)} | ${results.reduce((a, r) => a + r.tokensOut, 0)} | **${money(results.reduce((a, r) => a + r.cost, 0))}** | |`,
    '',
    `Maris's own record for this run: ${record.month.requests} requests, ${record.month.input + record.month.output} tokens, ${money(record.month.cost)}${record.month.unpriced ? ` (${record.month.unpriced} requests without a price)` : ''}.`,
    '',
    `Learned from refusals: ${Object.keys(learned).length ? `\`${JSON.stringify(learned)}\`` : 'nothing (every request was accepted as sent).'}`
  ]
  const notes = results.flatMap((r) => r.notes.map((n) => `- ${r.name}: ${n}`))
  if (notes.length) lines.push('', 'Notices shown in the chats:', ...notes)
  const warn = logs.filter((l) => /anthropic|providers|\[llm\]|quirk/i.test(l) && /warn|error|learned|could not/i.test(l)).map((l) => l.replaceAll(key, '<key>').trim().slice(0, 400))
  if (warn.length) lines.push('', 'From the app log:', '```', ...warn.slice(-30), '```')
  const report = path.join(shots, 'claude-live-report.md')
  writeFileSync(report, `${lines.join('\n')}\n`)
  console.log(`\n${lines.slice(4).join('\n')}\n\nReport: ${report}`)
} catch (e) {
  exitCode = 1
  console.error(`Stopped: ${clean(e)}`)
  await win.screenshot({ path: path.join(shots, 'claude-live-error.png') }).catch(() => undefined)
} finally {
  // The key leaves with the throwaway profile.
  await win.evaluate(() => window.maris.providers.remove('anthropic')).catch(() => undefined)
  await app.close().catch(() => undefined)
  await mock.close()
  try {
    removeProfile(profile)
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* still held for a moment by the closing app */
  }
  console.log(exitCode ? 'Some checks failed.' : 'All checks passed.')
  process.exit(exitCode)
}
