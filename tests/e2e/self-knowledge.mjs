// Maris knows the app it is part of: asked how to connect Claude, add a phone or change something, it
// reads the app's own help (maris_help), says what is set up right now (maris_status) and links to the
// page, which opens on a click.
// Usage: npm run build && node tests/e2e/self-knowledge.mjs <shotsDir>   (MARIS_EXE as in the other tests)
//   Nothing real is called: fixtures/mock-llm.mjs stands in for Ollama and for a model service.
//
//   node tests/e2e/self-knowledge.mjs <shotsDir> --live
//   asks the models installed on this computer instead (the real Ollama, a throwaway profile), in the
//   words people use, and prints the answers. Slower, and the wording of a real model varies.
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checker, driver, launch, makeProfile, removeProfile } from './fixtures/app.mjs'
import { startMockLlm } from './fixtures/mock-llm.mjs'

const args = process.argv.slice(2)
const live = args.includes('--live')
const shots = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(os.tmpdir(), 'maris-shots'))
mkdirSync(shots, { recursive: true })
const t = checker()
const profiles = []

/** The names of the tools a request offered, whether as tool definitions or described in text. */
const offered = (body) => (body.tools?.length ? body.tools.map((x) => x.function.name) : [...String(body.messages[0].content).matchAll(/^- ([\w.-]+)\(/gm)].map((m) => m[1]))

async function withMock() {
  const mock = await startMockLlm()
  const MODEL = 'mock-local:4b'
  mock.addLocalModel(MODEL, { sizeGB: 2.5, caps: ['completion', 'tools'] })
  const one = { tiny: MODEL, fast: MODEL, balanced: MODEL, max: MODEL }
  try {
    // ------------------------------------------------------------ an ordinary computer
    {
      const profile = makeProfile('self', { ollamaUrl: mock.url, comfyUrl: `${mock.url}/comfy`, tiers: one })
      profiles.push(profile)
      const { app, win, logs } = await launch(profile)
      const d = driver(win, shots)
      try {
        // ---- the instructions describe the app
        await d.send('Hello there')
        await d.waitDone()
        const first = mock.of(MODEL)[0].body
        const sys = String(first.messages[0].content)
        t.check(/## Maris, the app you are part of/.test(sys), 'the instructions say what the app is')
        t.check(/Models → API/.test(sys) && /Claude/.test(sys), 'they say where Claude and other API models are added')
        t.check(/call maris_help/.test(sys), 'and to look questions about Maris up in its help')
        t.check(offered(first).includes('maris_help') && offered(first).includes('maris_status'), 'the model is offered maris_help and maris_status')
        t.check(!/runs entirely on/.test(sys), 'nothing claims Maris can only ever run on this computer')

        // ---- "how do I connect Claude": the article, the page, and what is set up now
        await d.newChat()
        await d.send('Ask the Maris help: i wanna connect claude to this app how can i do it')
        await d.waitDone()
        let answer = await d.lastAnswer()
        console.log(`  answer: ${answer.slice(0, 400)}`)
        t.check(/Claude, GPT and other API models/.test(answer), 'the question finds the article on API models')
        t.check(/none added yet/.test(answer), 'the answer knows no service is connected yet')
        const call = mock.of(MODEL).map((r) => r.body.messages).flat().filter((m) => m.role === 'tool').pop()
        const result = String(call?.content ?? '')
        t.check(/1\. Open \*\*Models → API\*\*/.test(result) && /Paste the key and click \*\*Connect\*\*/.test(result), 'the tool result holds the steps from the help')
        t.check(/never ask for one in the chat/.test(result), 'and says keys are typed on the page, not in the chat')
        const steps = await win.locator('[role="group"][aria-label^="Approval needed"]').count()
        t.check(steps === 0, 'reading the help needs no approval')
        await d.shot('self-01-connect-claude')

        // ---- the page link in the answer opens Models → API
        const link = win.locator('.prose-maris a', { hasText: 'Models → API' }).last()
        t.check((await link.count()) > 0, 'the answer links to Models → API')
        await link.click()
        const opened = await win
          .getByText('OpenRouter')
          .first()
          .waitFor({ timeout: 8000 })
          .then(() => true, () => false)
        const onModels = await win.evaluate(() => window.__marisStore.getState().view === 'models' && window.__marisStore.getState().modelsTab === 'api')
        t.check(onModels && opened, 'a click on it opens the Models page on its API tab, where the services are')
        await d.shot('self-02-models-api')

        // ---- other questions land on their articles, with their pages
        const ask = async (question, title, linkText) => {
          await win.evaluate(() => window.__marisStore.getState().setView('chat'))
          await d.newChat()
          await d.send(`Ask the Maris help: ${question}`)
          await d.waitDone()
          answer = await d.lastAnswer()
          t.check(answer.includes(title), `"${question}" → ${title}${answer.includes(title) ? '' : ` (got: ${answer.slice(0, 120)})`}`)
          if (linkText) t.check((await win.locator('.prose-maris a', { hasText: linkText }).count()) > 0, `  with a link to ${linkText}`)
        }
        await ask('how can I use you on my phone', 'Maris on your phone', 'Settings → Phone')
        t.check(/the link is off/.test(answer), '  and it knows the phone link is off')
        await win.locator('.prose-maris a', { hasText: 'Settings → Phone' }).last().click()
        const phoneSection = await win
          .getByText('Allow the phone app to connect')
          .first()
          .waitFor({ timeout: 8000 })
          .then(() => true, () => false)
        t.check(phoneSection, '  a click opens Settings on its Phone section')
        await d.shot('self-03-settings-phone')
        await ask('connect github', 'Connectors: linking Maris to other services', 'Connectors')
        await ask('can you make videos', 'Making pictures and videos', 'Models → Videos')
        await ask('how do I get a new version', 'Updates and news', 'Updates & news')

        // ---- a page named in plain words (as real models often write it) is a link too
        await win.evaluate(() => window.__marisStore.getState().setView('chat'))
        await d.newChat()
        await d.send('Repeat after me: open Settings -> Appearance')
        await d.waitDone()
        const plain = win.locator('.prose-maris a', { hasText: /Settings -> Appearance/ }).last()
        t.check((await plain.count()) > 0, 'a page name written as plain text becomes a link')
        await plain.click().catch(() => undefined)
        t.check(await win.getByText('Colour theme').first().waitFor({ timeout: 8000 }).then(() => true, () => false), '  and opens Settings → Appearance')

        // ---- what is set up right now
        await win.evaluate(() => window.__marisStore.getState().setView('chat'))
        await d.newChat()
        await d.send('What is set up in Maris?')
        await d.waitDone()
        answer = await d.lastAnswer()
        console.log(`  status: ${answer.slice(0, 500)}`)
        t.check(/This is Maris \d+\.\d+\.\d+/.test(answer), 'maris_status gives the version')
        t.check(answer.includes(MODEL) && /Fast = mock-local:4b/.test(answer), 'the installed model and its roles')
        t.check(/API services[^.]*none added yet/.test(answer), 'that no API service is added')
        t.check(/Approved without asking: nothing/.test(answer) && /Full control[^.]*: off/.test(answer), 'and that every change still asks')
        await d.shot('self-04-status')

        // ---- with a service added, the same question says so
        await win.evaluate(({ url, key }) => window.maris.providers.add('custom', { baseUrl: `${url}/v1`, key, name: 'Mock Cloud' }), { url: mock.url, key: mock.key }).catch((e) => console.log(`  could not add the service: ${e.message}`))
        await win.waitForTimeout(800)
        await d.newChat()
        await d.send('Ask the Maris help: is claude connected, api key')
        await d.waitDone()
        answer = await d.lastAnswer()
        t.check(/Mock Cloud \(connected/.test(answer), `after a service is added the answer names it (${answer.replace(/\s+/g, ' ').slice(-220)})`)

        const errs = logs.filter((l) => /\berror\b|exception|unhandled|pageerror/i.test(l) && !/DevTools|GPU process|Autofill/i.test(l)).slice(-12)
        if (errs.length) console.log(`--- app log (errors) ---\n${errs.join('\n')}`)
      } catch (e) {
        t.check(false, `stopped: ${e.message}`)
        await d.shot('self-99-error').catch(() => undefined)
      }
      await app.close().catch(() => undefined)
    }

    // ------------------------------------------------------------ a slow computer (low-power mode)
    {
      const SMALL = 'gemma3:1b'
      mock.addLocalModel(SMALL, { sizeGB: 0.8, caps: ['completion'], ctx: 32768, family: 'gemma3', params: '1B' })
      const profile = makeProfile('self-lite', {
        ollamaUrl: mock.url,
        comfyUrl: `${mock.url}/comfy`,
        tiers: { tiny: SMALL, fast: SMALL, balanced: SMALL, max: SMALL },
        engine: { profile: 'lite', processing: 'cpu' },
        routing: { contextByTier: { tiny: 4096, fast: 4096, balanced: 4096, max: 4096 } }
      })
      profiles.push(profile)
      const { app, win } = await launch(profile)
      const d = driver(win, shots)
      try {
        await win.waitForTimeout(2000)
        await d.send('Ask the Maris help: i wanna connect claude to this app how can i do it')
        await d.waitDone()
        const answer = await d.lastAnswer()
        const req = mock.of(SMALL)[0].body
        const sys = String(req.messages[0].content)
        t.check(offered(req).includes('maris_help'), `low-power mode: a question about the app brings maris_help (${offered(req).join(', ')})`)
        t.check(/Models → API/.test(sys) && sys.length < 2600, `its short instructions still name Models → API (${sys.length} characters)`)
        t.check(/Claude, GPT and other API models/.test(answer) && /Models → API/.test(answer), 'and the small model answers from the help')
        const result = String(mock.of(SMALL).map((r) => r.body.messages).flat().filter((m) => /<tool_result name="maris_help">/.test(String(m.content))).pop()?.content ?? '')
        t.check(result.length > 500 && result.length < 2200, `it reads only the part that answers the question (${result.length} characters)`)
        t.check(/1\. Open \*\*Models → API\*\*/.test(result) && !/chars omitted/.test(result), 'with the steps in it, and nothing cut off in the middle')
        t.check((await win.locator('.prose-maris a', { hasText: 'Models → API' }).count()) > 0, 'and the link to the page')
        await d.shot('self-05-low-power')
      } catch (e) {
        t.check(false, `low-power: ${e.message}`)
        await d.shot('self-98-error').catch(() => undefined)
      }
      await app.close().catch(() => undefined)
    }
  } finally {
    await mock.close()
  }
}

/** The real models of this computer, asked the way people ask. Prints what they say. */
async function withRealModels() {
  const profile = makeProfile('self-live', {})
  profiles.push(profile)
  const { app, win } = await launch(profile)
  const d = driver(win, shots)
  const questions = [
    ['i wanna connect claude to this app how can i do it', /Models\s*(→|->|>)\s*API/i],
    ['can i use you from my phone?', /Settings\s*(→|->|>)\s*Phone|Android/i],
    ['which models do i have installed?', /./]
  ]
  try {
    let n = 0
    for (const [q, want] of questions) {
      await d.newChat()
      await d.send(q)
      await d.waitDone(420000)
      const answer = await d.lastAnswer()
      const main = await win.locator('main').last().innerText()
      const used = /Maris help|set up in Maris/i.test(main)
      console.log(`\nQ: ${q}\n   looked it up: ${used ? 'yes' : 'no'}; answered by ${(/Auto: [\w.:-]+|[\w.-]+:[\w.-]+/.exec(main) ?? ['?'])[0]}\nA: ${answer.slice(0, 900)}\n`)
      t.check(want.test(answer), `"${q}" is answered from the app`)
      t.check(!/operates independently|different AI service|isn't something I .* can set up|cannot (be )?connect/i.test(answer), '  without claiming it cannot be done')
      if (n < 2) t.check((await win.locator('.prose-maris a[href^="page:"]').count()) > 0, '  with a link that opens the page')
      await d.shot(`self-live-${++n}`)
    }
  } catch (e) {
    t.check(false, `live: ${e.message}`)
    await d.shot('self-live-error').catch(() => undefined)
  }
  await app.close().catch(() => undefined)
}

try {
  if (live) await withRealModels()
  else await withMock()
} finally {
  for (const p of profiles) {
    try {
      removeProfile(p)
    } catch {
      /* still held for a moment */
    }
  }
  console.log(t.failures ? `${t.failures} check(s) failed` : 'all checks passed')
  process.exit(t.failures ? 1 : 0)
}
