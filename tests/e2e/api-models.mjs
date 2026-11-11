// Models that run somewhere else: adding a service on Models → API, picking its models, chatting,
// tools and approvals through them, and how Maris finds out what a model cannot do.
// Usage: npm run build && node tests/e2e/api-models.mjs <shotsDir>   (MARIS_EXE as in the other tests)
// Nothing real is called: fixtures/mock-llm.mjs stands in for the services and for Ollama.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const work = path.join(shots, 'api-work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'alpha.txt'), 'a')
writeFileSync(path.join(work, 'beta.md'), 'b')

const mock = await startMockLlm()
// No model on this computer: everything has to come from the services.
const profile = makeProfile('api', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy` })
const { app, win, logs } = await launch(profile)
const d = driver(win, shots)
const t = checker()
const quirks = () => {
  try {
    return JSON.parse(readFileSync(path.join(profile, 'provider-quirks.json'), 'utf8'))
  } catch {
    return {}
  }
}
const visibleText = () => win.locator('main').innerText()
/** The Think button goes auto → on → off: click until it says on. */
const thinkOn = async () => {
  for (let i = 0; i < 3 && !(await win.getByRole('button', { name: 'Think: on' }).count()); i++) await win.getByRole('button', { name: /^Think: / }).click()
}

try {
  await win.waitForTimeout(1200)
  await d.shot('api-01-no-models')

  // ---- add an OpenAI-compatible service by hand, as a person would
  await win.getByRole('button', { name: 'Models', exact: true }).click()
  await win.getByRole('tab', { name: /API/ }).click()
  await win.getByText('None yet. Add one below').waitFor()
  await d.shot('api-02-tab-empty')
  await win.getByRole('button', { name: /^Other service/ }).click()
  await win.getByRole('textbox', { name: 'Address of the service' }).fill(`${mock.url}/v1/chat/completions`)
  // A wrong key is caught before anything is saved, with words that say so.
  await win.getByLabel('API key').fill('wrong-key')
  await win.getByRole('button', { name: 'Connect', exact: true }).click()
  await win.getByText(/refused the key/).waitFor({ timeout: 15000 })
  t.check(!existsSync(path.join(profile, 'providers.json')) || JSON.parse(readFileSync(path.join(profile, 'providers.json'), 'utf8')).length === 0, 'a wrong key adds nothing')
  await d.shot('api-03-wrong-key')
  await win.getByLabel('API key').fill(mock.key)
  await win.getByRole('textbox', { name: 'Name in Maris' }).fill('Mock Cloud')
  await win.getByRole('button', { name: 'Connect', exact: true }).click()
  await win.getByText(/Ready · \d+ of \d+ models in Maris/).waitFor({ timeout: 15000 })
  const row = await win.getByText(/Ready · \d+ of \d+ models in Maris/).innerText()
  t.check(/6 of 6/.test(row), `the service's chat models are listed, others left out (${row.trim()})`)
  const saved = JSON.parse(readFileSync(path.join(profile, 'providers.json'), 'utf8'))
  t.check(saved[0].baseUrl === `${mock.url}/v1`, `a pasted /chat/completions address is tidied (${saved[0].baseUrl})`)
  t.check(!readFileSync(path.join(profile, 'providers.json'), 'utf8').includes(mock.key), 'the key is not in the plain settings file')
  await d.shot('api-04-service-added')

  // ---- Claude, through the official SDK, pointed at the stand-in (a name that does not look local,
  // so the interface treats it as a service on the internet)
  const claudeUrl = `http://localhost.:${mock.port}/anthropic`
  await win.evaluate(([url, key]) => window.maris.providers.add('anthropic', { key, baseUrl: url }), [claudeUrl, mock.key])
  await win.getByText('Claude (Anthropic)').first().waitFor()
  await win.getByRole('button', { name: 'Show the models of Claude (Anthropic)' }).click()
  await win.waitForTimeout(300)
  await d.shot('api-05-two-services')
  const models = await win.evaluate(() => window.maris.models.list())
  const claude = models.find((m) => m.name === '@anthropic/claude-mock-5')
  t.check(claude?.label === 'Claude Mock 5' && claude.capabilities.includes('thinking') && claude.capabilities.includes('vision') && claude.remote === true, 'Claude models come with their own names and abilities')
  t.check(models.some((m) => m.name === '@custom/mock-large' && m.remote === false), 'a service on this computer is marked as local')

  // ---- plain chat
  await d.newChat()
  await d.pickModel('mock-large')
  await d.send('Hi there, API model')
  await d.waitDone()
  t.check(/Hello from mock-large/.test(await d.lastAnswer()), `an API model answers: ${(await d.lastAnswer()).slice(0, 80)}`)
  const first = mock.of('mock-large')[0]?.body
  t.check(first?.stream === true && Array.isArray(first.tools) && first.tools.length > 10 && first.messages[0].role === 'system', 'the request carries the instructions and the tools')
  t.check(first?.temperature === undefined && first?.think === undefined && first?.options === undefined && first?.keep_alive === undefined, 'nothing Ollama-only is sent to a service')
  await d.shot('api-06-chat')

  // ---- a read-only tool, then one that needs approval
  await d.newChat()
  await d.pickModel('mock-large')
  await d.send(`List the files in this folder: ${work}`)
  await d.waitDone()
  t.check(/alpha\.txt/.test(await d.lastAnswer()) && /beta\.md/.test(await d.lastAnswer()), 'a tool call through an API model returns real files')
  const withResult = mock.of('mock-large').find((r) => r.body.messages.some((m) => m.role === 'tool'))
  const toolMsg = withResult?.body.messages.find((m) => m.role === 'tool')
  const callMsg = withResult?.body.messages.find((m) => m.role === 'assistant' && m.tool_calls)
  t.check(toolMsg && callMsg && toolMsg.tool_call_id === callMsg.tool_calls[0].id, 'the result goes back under the id of its call')
  await d.shot('api-07-tool')

  const target = path.join(work, 'made.txt')
  await d.newChat()
  await d.pickModel('mock-large')
  await d.send(`Create a text file at ${target} containing exactly this text: Hello from Maris`)
  const panel = win.locator('[role="group"][aria-label^="Approval needed"]')
  await panel.waitFor({ timeout: 30000 })
  t.check(!existsSync(target), 'an API model changes nothing before approval')
  await d.shot('api-08-approval')
  await panel.getByRole('button', { name: 'Approve' }).click()
  await d.waitDone()
  t.check(existsSync(target) && readFileSync(target, 'utf8').includes('Hello from Maris'), 'the file is written after approval')

  // ---- a model that thinks first
  await d.newChat()
  await d.pickModel('mock-reasoner')
  await d.send('Hello reasoner')
  await d.waitDone()
  t.check(/Hello from mock-reasoner/.test(await d.lastAnswer()) && (await win.getByText(/Thought for|Thinking/).count()) > 0, 'reasoning is shown apart from the answer')
  await d.shot('api-09-reasoning')

  // ---- a model without tool calling: Maris learns it from the refusal and describes the tools in text
  await d.newChat()
  await d.pickModel('mock-plain')
  await d.send(`List the files in this folder: ${work}`)
  await d.waitDone()
  const plainAnswer = await d.lastAnswer()
  const page = await visibleText()
  t.check(/alpha\.txt/.test(plainAnswer), 'a model without tool calling still uses tools')
  t.check(!/INVENTED|<tool_call>|<tool_result/.test(page), 'the call block and anything after it never show')
  t.check(quirks()['@custom/mock-plain']?.noTools === true, 'the refusal is remembered')
  const plainReqs = mock.of('mock-plain')
  t.check(plainReqs[0].body.tools && !plainReqs[1].body.tools && /<tool_call>/.test(plainReqs[1].body.messages[0].content), 'tools are sent again as text')
  t.check(Array.isArray(plainReqs[1].body.stop) && plainReqs[1].body.stop.includes('</tool_call>'), 'generation stops at the end of a call')
  await d.shot('api-10-text-tools')
  // The next chat with it does not ask the wrong way first.
  const before = plainReqs.length
  await d.newChat()
  await d.pickModel('mock-plain')
  await d.send('Just say hello')
  await d.waitDone()
  t.check(mock.of('mock-plain').slice(before).every((r) => !r.body.tools), 'what was learned is used from then on')

  // ---- a service that refuses request options one by one
  await d.setSettings({ generation: { balanced: { temperature: 0.2, maxTokens: 900 }, fast: { temperature: 0.2, maxTokens: 900 }, max: { temperature: 0.2, maxTokens: 900 } }, tiers: { balanced: '@custom/mock-picky' } })
  await d.newChat()
  await d.pickModel('mock-picky')
  await d.send('Hello picky')
  await d.waitDone()
  t.check(/Hello from mock-picky/.test(await d.lastAnswer()), `refused options are dropped until the request is accepted: ${(await d.lastAnswer()).slice(0, 60)}`)
  const q = quirks()['@custom/mock-picky'] ?? {}
  t.check(q.drop?.includes('stream_options') && q.drop.includes('temperature') && q.maxTokensKey === 'max_completion_tokens', `…and remembered (${JSON.stringify(q)})`)
  const ok = mock.of('mock-picky').pop().body
  t.check(ok.max_completion_tokens === 900 && ok.max_tokens === undefined, 'the answer length goes under the name the service wants')
  await d.setSettings({ tiers: { balanced: undefined } })

  // ---- a service that takes no system message
  await d.newChat()
  await d.pickModel('mock-nosys')
  await d.send('Hello nosys')
  await d.waitDone()
  const nosys = mock.of('mock-nosys').pop().body
  t.check(/Hello from mock-nosys/.test(await d.lastAnswer()) && nosys.messages[0].role === 'user' && /You are Maris|Maris/.test(nosys.messages[0].content), 'instructions move into the first message where a system message is refused')

  // ---- Claude: thinking, a tool, and the answer
  await d.newChat()
  await d.pickModel('Claude Mock 5')
  await thinkOn()
  await d.send(`List the files in this folder: ${work}`)
  await d.waitDone()
  t.check(/alpha\.txt/.test(await d.lastAnswer()), 'Claude uses a tool and answers')
  const c = mock.of('claude-mock-5')
  t.check(c.length === 2, `two requests for one tool step (${c.length})`)
  const c1 = c[0]?.body ?? {}
  t.check(typeof c1.system === 'string' && c1.system.length > 200 && c1.max_tokens === 64000 && c1.temperature === undefined, 'Claude request: instructions apart, room for a long answer, no sampling options')
  t.check(c1.thinking?.type === 'adaptive' && c1.thinking.display === 'summarized', `thinking is asked for the way the model list says (${JSON.stringify(c1.thinking)})`)
  t.check(c1.tools?.length > 10 && c1.tools.every((x) => x.input_schema?.type === 'object') && c1.tool_choice === undefined, 'tools in Claude’s format, none forced')
  t.check(c1.cache_control === undefined && c1.tools.every((x) => x.eager_input_streaming === undefined), 'Anthropic-only extras stay off at another address')
  const c2 = c[1]?.body ?? {}
  const back = c2.messages?.[c2.messages.length - 2]
  const res = c2.messages?.[c2.messages.length - 1]
  t.check(back?.role === 'assistant' && back.content[0]?.type === 'thinking' && back.content[0].signature === 'mock-signature', 'Claude’s own turn goes back unchanged, thinking block included')
  t.check(res?.role === 'user' && res.content[0]?.type === 'tool_result' && res.content[0].tool_use_id === back?.content.find((b) => b.type === 'tool_use')?.id, 'the tool result follows its call in the next turn')
  t.check(c[0].headers.authorization === `Bearer ${mock.key}` && /^Anthropic\/JS/i.test(c[0].headers['user-agent'] ?? '') && c[0].headers['anthropic-version'] === '2026-10-21', `sent by the official SDK (${c[0].headers['user-agent']}, API version ${c[0].headers['anthropic-version']})`)
  await d.shot('api-11-claude-tool')

  // ---- Claude declines: said plainly, nothing is run
  await d.newChat()
  await d.pickModel('Claude Mock 5')
  await d.send('REFUSE-TEST')
  await d.waitDone()
  t.check(/declined this request/.test(await visibleText()), 'a refusal is shown as what it is')
  await d.shot('api-12-refusal')

  // ---- an older Claude: thinking by budget, no pictures
  await win.evaluate(() => window.maris.providers.setPicked('anthropic', ['claude-mock-5', 'claude-mock-old', 'claude-mock-small']))
  await win.waitForTimeout(400)
  await d.newChat()
  await d.pickModel('Claude Mock Old')
  await thinkOn()
  await d.send('Hello old Claude')
  await d.waitDone()
  const old = mock.of('claude-mock-old').pop()?.body ?? {}
  t.check(/Hello from claude-mock-old/.test(await d.lastAnswer()) && old.max_tokens === 8192 && old.thinking?.type === 'enabled' && old.thinking.budget_tokens < 8192, `an older model gets what it supports (${JSON.stringify(old.thinking)}, max ${old.max_tokens})`)

  // ---- context windows up to millions of tokens, and never more than a model takes
  const context = (model) => win.evaluate((m) => window.maris.chat.context(undefined, { mode: 'chat', model: m }), model)
  const before64 = await context('@anthropic/claude-mock-5')
  t.check(before64.window === 65536, `the default budget for API models is 64K (${before64.window})`)
  t.check(before64.sizes.options.some((o) => o.tokens === 1000000) && !before64.sizes.options.some((o) => o.tokens > 1000000), `a 1M model is offered up to 1M (${before64.sizes.options.map((o) => o.tokens).join(', ')})`)
  await d.setSettings({ routing: { apiContext: 2000000 } })
  const wide = await context('@anthropic/claude-mock-5')
  t.check(wide.window > 780000 && wide.window < 1000000, `with the budget at 2M, a 1M model gets four fifths of its window for the chat (${wide.window})`)
  const narrow = await context('@anthropic/claude-mock-old')
  t.check(narrow.window > 150000 && narrow.window < 200000 && Math.max(...narrow.sizes.options.map((o) => o.tokens)) === 200000, `a 200K model stays within its own (${narrow.window})`)
  await d.newChat()
  await d.pickModel('Claude Mock 5')
  await d.send('Hello with a wide window')
  await d.waitDone()
  await win.locator('button[aria-label^="Context:"]').click()
  await win.getByRole('radiogroup', { name: /Context window size/ }).waitFor()
  t.check((await win.getByRole('radio', { name: '1M', exact: true }).count()) === 1 && (await win.getByRole('radio', { name: '2M', exact: true }).count()) === 0, 'the context ring offers 1M for it, and nothing it cannot take')
  await win.getByRole('radio', { name: '1M', exact: true }).hover()
  await win.waitForTimeout(250)
  await d.shot('api-13-context-1m')
  await win.keyboard.press('Escape')

  // ---- a small window: the room asked for the answer shrinks to what is left
  await d.newChat()
  await d.pickModel('Claude Mock Small')
  await d.send('Hello small window')
  await d.waitDone()
  const smallReq = mock.of('claude-mock-small').pop()?.body ?? {}
  t.check(/Hello from claude-mock-small/.test(await d.lastAnswer()) && smallReq.max_tokens < 16000 && smallReq.max_tokens >= 2048, `a model with a small window is asked for only as much answer as fits (${smallReq.max_tokens} of 16000)`)

  // ---- a service that never said how much its model takes says "too long": Maris learns the size and tries again
  await d.newChat()
  await d.pickModel('mock-large')
  const beforeLong = mock.of('mock-large').length
  await d.send('TOO-LONG-TEST please answer anyway')
  await d.waitDone()
  const longPage = await visibleText()
  t.check(/Hello from mock-large/.test(await d.lastAnswer()) && mock.of('mock-large').length - beforeLong === 2, 'a "too long" refusal is answered with one shorter request instead of an error')
  t.check(/longer than the model takes \(60K tokens\)/.test(longPage), 'and the chat says what happened')
  const learned = await context('@custom/mock-large')
  t.check(learned.window < 60000 && learned.window > 40000, `the real size is used from then on (${learned.window})`)
  await d.setSettings({ routing: { apiContext: 65536 } })

  // ---- Auto with nothing on this computer: an API model answers, since there is nothing else
  await d.newChat()
  await d.send('Hello with no roles set')
  await d.waitDone(20000).catch(() => undefined)
  await d.shot('api-13-auto-only-api')
  t.check(/Hello from (mock|claude)/.test(await d.lastAnswer()), 'with no model on this computer, Auto answers with an API model')
  await d.setSettings({ tiers: { fast: '@custom/mock-large', balanced: '@custom/mock-large', max: '@anthropic/claude-mock-5' } })
  await d.newChat()
  await d.send('Hello through Auto')
  await d.waitDone()
  t.check(/Hello from (mock-large|claude-mock-5)/.test(await d.lastAnswer()), `Auto uses API models that hold a role: ${(await d.lastAnswer()).slice(0, 60)}`)
  await d.shot('api-14-auto-api')

  // ---- the model menu and the Models page with services in place
  await win.locator('button[aria-label^="Model:"]').click()
  await win.waitForTimeout(250)
  await d.shot('api-15-model-menu')
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: 'Models', exact: true }).click()
  await win.getByRole('tab', { name: /Text/ }).click()
  await win.waitForTimeout(500)
  await d.shot('api-16-models-text-tab')

  // ---- turned off: its models leave the menu, and a chat that used one says why it cannot answer
  mock.addLocalModel('mock-local:1b', { caps: ['completion', 'tools'] })
  mock.addLocalModel('mock-wide:4b', { sizeGB: 2.5, caps: ['completion', 'tools'], ctx: 1048576 })
  await win.evaluate(() => window.maris.providers.setEnabled('custom', false))
  await win.waitForTimeout(400)
  const left = await win.evaluate(() => window.maris.models.list())
  t.check(!left.some((m) => m.provider === 'custom') && left.some((m) => m.provider === 'anthropic'), 'a service that is turned off takes its models out of the lists')

  // ---- with a model on this computer, Auto never reaches for an API model by itself
  await d.setSettings({ tiers: { fast: 'mock-local:1b', balanced: 'mock-local:1b', max: 'mock-local:1b' } })
  const plain = await win.evaluate(() => window.maris.chat.previewRoute('Hello there, how are you today?', []))
  const picture = [{ id: 'p1', kind: 'image', name: 'p.png', mime: 'image/png', size: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]
  const pic = await win.evaluate((a) => window.maris.chat.previewRoute('What is in this picture?', a), picture)
  const picChosen = await win.evaluate((a) => window.maris.chat.previewRoute('What is in this picture?', a, '@anthropic/claude-mock-5'), picture)
  t.check(plain?.model === 'mock-local:1b', `Auto answers with the model on this computer (${plain?.model})`)
  t.check(pic === undefined, `Auto does not send a picture to an API model nobody chose (${pic?.model ?? 'no model'})`)
  t.check(picChosen?.model === '@anthropic/claude-mock-5' && picChosen.remote === true, 'the same picture goes there when that model is picked for the chat')
  await win.evaluate(() => window.maris.providers.setEnabled('custom', true))

  // ---- a model on this computer with a very large window
  const local = await context('mock-wide:4b')
  const top = local.sizes.options[local.sizes.options.length - 1]
  t.check(top.tokens === 1048576 && local.sizes.options.every((o) => ['gpu', 'spill', 'cpu', 'none'].includes(o.fit)), `a local model that takes 1M is offered 1M, with what it costs here (${top.fit}${top.needMB ? `, needs ${Math.round(top.needMB / 1024)} GB` : top.spillMB ? `, ${Math.round(top.spillMB / 1024)} GB from system memory` : ''})`)
  await d.setSettings({ tiers: { fast: 'mock-wide:4b', balanced: 'mock-wide:4b', max: 'mock-wide:4b' }, routing: { contextByTier: { fast: 262144, balanced: 262144, max: 262144 } } })
  await d.newChat()
  await d.send('Hello with a wide local window')
  await d.waitDone()
  const wideReq = mock.of('mock-wide:4b').pop()?.body
  t.check(wideReq?.options.num_ctx === 262144, `a 256K window reaches the model as set (${wideReq?.options.num_ctx})`)

  // ---- removing a service forgets its key
  await win.evaluate(() => window.maris.providers.remove('anthropic'))
  await win.waitForTimeout(300)
  const after = JSON.parse(readFileSync(path.join(profile, 'providers.json'), 'utf8'))
  t.check(after.length === 1 && after[0].id === 'custom', 'a removed service is gone from the settings')
} catch (e) {
  t.check(false, `stopped: ${e.message}`)
  await d.shot('api-99-error').catch(() => undefined)
} finally {
  const errs = logs.filter((l) => /\berror\b|exception|unhandled|pageerror/i.test(l) && !/ERR_NAME_NOT_RESOLVED|DevTools|GPU process|Autofill/i.test(l)).slice(-25)
  if (errs.length) console.log(`--- app log (errors) ---\n${errs.join('\n')}`)
  await app.close().catch(() => undefined)
  await mock.close()
  try {
    removeProfile(profile)
  } catch {
    /* still held for a moment by the closing app */
  }
  console.log(t.failures ? `${t.failures} check(s) failed` : 'all checks passed')
  process.exit(t.failures ? 1 : 0)
}
