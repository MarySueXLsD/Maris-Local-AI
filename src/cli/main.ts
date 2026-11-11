// The maris terminal command: chat with Maris, work on a folder in Code mode, make pictures, check status.
// It runs on Maris's own runtime (ELECTRON_RUN_AS_NODE) and talks to the running app; see connect.ts.
import './host'
import { spawn } from 'node:child_process'
import { existsSync, fstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Attachment, Conversation, MediaJob, MediaParams, ModelInfo, Settings, SystemStatus, ThinkMode } from '@shared/types'
import { usd, type UsageSummary } from '@shared/pricing'
import { type Args, parse, Usage } from './args'
import { bytes, duration, prettyModel } from '../renderer/src/lib/format'
import { connect, profileDir, type Rpc } from './connect'
import { Session, type Io } from './session'
import { detectCaps, fit, Paint, setTitle, StatusLine } from './term'

declare const __MARIS_VERSION__: string
const VERSION = typeof __MARIS_VERSION__ === 'string' ? __MARIS_VERSION__ : 'dev'

// ------------------------------------------------------------------ output setup

const plainFlag = process.argv.includes('--plain')
const out = process.stdout
const ui = out.isTTY ? out : process.stderr
const outPaint = new Paint(detectCaps(out, plainFlag))
const p = new Paint(detectCaps(ui, plainFlag))
const s = p.sym
const M = ui.isTTY && !plainFlag ? '  ' : ''
const say = (line = ''): void => {
  ui.write(`${line}\n`)
}

function help(): void {
  const p = outPaint
  const s = p.sym
  const c = (x: string): string => p.accent(x)
  const lines = [
    `${p.accent(s.mark)} ${p.bold('Maris')} ${p.dim(VERSION)}  ${p.dim('Your local AI assistant, in the terminal')}`,
    '',
    p.bold('Usage'),
    `  ${c('maris')}                       Chat with Maris (type /help inside)`,
    `  ${c('maris')} "question"            Ask once and print the answer`,
    `  ${c('maris code')} [folder]         Work on a folder (this one by default) in Code mode`,
    `  ${c('maris -c')}                    Continue your last terminal chat`,
    `  ${c('maris image')} "description"   Make a picture`,
    `  ${c('maris video')} "description"   Make a short video clip`,
    `  ${c('maris chats')}                 Recent chats`,
    `  ${c('maris open')} [chat]           Show a chat in the Maris window`,
    `  ${c('maris status')}                Models, graphics card and memory right now`,
    `  ${c('maris models')}                Installed models and what each one is for`,
    '',
    p.bold('Options'),
    '  -m, --model <name>    auto, fast, balanced, max or a model name',
    '      --think           Think step by step first (--no-think: never)',
    '      --no-web          Do not look things up on the web',
    '  -f, --file <path>     Attach a file or picture (repeatable)',
    '      --chat <id>       Continue a particular chat (ids from maris chats)',
    '      --show-thinking   Print the model\'s thinking as it goes',
    '      --plain           No colours or animation (automatic when output is piped)',
    '  -h, --help            This help',
    '  -v, --version         Version',
    '',
    p.bold('Pictures and videos'),
    '      --quality fast|quality   Faster model or the best one installed',
    '  -n, --count <1-4>            Pictures to make',
    '      --seconds <1-8>          Video length',
    '  -o, --open                   Open the result when it is ready',
    '',
    p.bold('Examples'),
    `  ${p.dim('maris "what is using my disk space?"')}`,
    `  ${p.dim('git diff | maris "write a commit message for this"')}`,
    `  ${p.dim('maris code . "fix the failing test"')}`,
    `  ${p.dim('maris -f photo.jpg "what plant is this?"')}`,
    '',
    p.dim('Maris looks around freely but asks before it changes anything. Answer with a single key: y, n, a (always) or s (all in this chat).')
  ]
  for (const l of lines) out.write(`${l}\n`)
}

const COMMANDS: [string, string][] = [
  ['/new', 'Start a new chat'],
  ['/code [folder]', 'Work on a folder in Code mode (this one by default)'],
  ['/chat', 'Back to a normal chat'],
  ['/model [name]', 'auto, fast, balanced, max or a model name; without a name: list'],
  ['/think on|off|auto', 'Whether Maris thinks step by step first'],
  ['/web on|off', 'Whether Maris may look things up on the web'],
  ['/open', 'Show this chat in the Maris window'],
  ['/copy', 'Copy the last answer'],
  ['/clear', 'Clear the screen'],
  ['/exit', 'Leave (also Ctrl+D)']
]

// ------------------------------------------------------------------ helpers

function ago(ts: number): string {
  const sec = Math.max(0, (Date.now() - ts) / 1000)
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`
  const d = Math.floor(sec / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/**
 * The keyboard is a terminal: a real one, or on Windows the launcher passing the console's keys on
 * through a pipe (MARIS_TTY=1, see resources/cli/MarisLauncher.cs).
 */
const keyboard = Boolean(process.stdin.isTTY) || process.env.MARIS_TTY === '1'

async function readPipedStdin(): Promise<string | undefined> {
  if (keyboard) return undefined
  try {
    // A pipe or a file. (On Windows isFIFO() is false even for pipes, so look at the mode bits.)
    const type = fstatSync(0).mode & 0o170000
    if (type !== 0o010000 && type !== 0o100000) return undefined
  } catch {
    return undefined
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() ? text : undefined
}

function withInput(question: string, input?: string): string {
  if (!input) return question
  const max = 120000
  const body = input.length > max ? `${input.slice(0, max)}\n… (${input.length - max} more characters not included)` : input
  return `${question || 'Here is some text from my terminal.'}\n\nInput from the terminal:\n\`\`\`\n${body.replace(/\s+$/, '')}\n\`\`\``
}

async function attachments(rpc: Rpc, files: string[]): Promise<Attachment[]> {
  if (!files.length) return []
  const abs = files.map((f) => path.resolve(f))
  for (const f of abs) if (!existsSync(f) || !statSync(f).isFile()) throw new Usage(`File not found: ${f}`)
  return rpc.call<Attachment[]>('files:attach', abs)
}

function copy(text: string): boolean {
  try {
    if (process.platform === 'win32') {
      // clip.exe reads UTF-16 when the text starts with a byte-order mark.
      const p = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      p.stdin.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
      return true
    }
    const cmd = process.platform === 'darwin' ? ['pbcopy', []] : process.env.WAYLAND_DISPLAY ? ['wl-copy', []] : ['xclip', ['-selection', 'clipboard']]
    const p = spawn(cmd[0] as string, cmd[1] as string[], { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => undefined)
    p.stdin.end(text)
    return true
  } catch {
    return false
  }
}

function openFile(file: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${file}"`]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]]
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }).unref()
}

/** What to call a model: the name its service gives it, or the readable form of an Ollama tag. */
const nameOf = (m: ModelInfo): string => m.label ?? prettyModel(m.name)

async function resolveModel(rpc: Rpc, want: string): Promise<string> {
  const w = want.trim().toLowerCase()
  if (!w || w === 'auto') return 'auto'
  const cfg = await rpc.call<Settings>('settings:get')
  if (w === 'fast' || w === 'balanced' || w === 'max' || w === 'code') {
    const name = w === 'code' ? (cfg.tiers.code ?? cfg.tiers.max) : cfg.tiers[w]
    if (!name) throw new Usage(`No ${w} model is set up. See maris models.`)
    return name
  }
  const models = await rpc.call<ModelInfo[]>('models:list')
  const squeezed = (t: string): string => t.toLowerCase().replace(/\s+/g, '')
  const hit =
    models.find((m) => m.name.toLowerCase() === w) ??
    models.find((m) => nameOf(m).toLowerCase() === w) ??
    models.find((m) => m.name.toLowerCase().startsWith(w)) ??
    models.find((m) => squeezed(nameOf(m)).includes(squeezed(w))) ??
    // "claude-…" also finds "@anthropic/claude-…".
    models.find((m) => m.provider && squeezed(m.name).includes(squeezed(w)))
  if (!hit) throw new Usage(`No model matches "${want}". See maris models.`)
  return hit.name
}

function historyFile(): string {
  return path.join(profileDir(), 'cli-history.txt')
}

function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500)
  } catch {
    return []
  }
}

function saveHistory(h: string[]): void {
  try {
    mkdirSync(profileDir(), { recursive: true })
    writeFileSync(historyFile(), `${h.slice(0, 500).reverse().join('\n')}\n`)
  } catch {
    /* history is a convenience */
  }
}

/** Read one message from the keyboard. Lines ending in "\" continue; pasted lines arrive as one message. */
function promptLine(prompt: string, cont: string, history: string[]): Promise<string | null | 'ctrl-c'> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: ui, terminal: true, history: history.slice(), historySize: 500, removeHistoryDuplicates: true, prompt })
    const lines: string[] = []
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (v: string | null | 'ctrl-c'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      resolve(v)
    }
    rl.on('history', (h: string[]) => history.splice(0, history.length, ...h))
    rl.on('line', (l) => {
      if (l.endsWith('\\')) {
        lines.push(l.slice(0, -1))
        rl.setPrompt(cont)
        rl.prompt()
        return
      }
      lines.push(l)
      clearTimeout(timer)
      // More lines within a moment are a paste: keep collecting them into one message.
      timer = setTimeout(() => finish(lines.join('\n')), 35)
    })
    rl.on('SIGINT', () => {
      if (rl.line) {
        rl.write(null, { ctrl: true, name: 'u' })
        return
      }
      ui.write('\n')
      finish('ctrl-c')
    })
    rl.on('close', () => finish(lines.length ? lines.join('\n') : null))
    rl.prompt()
  })
}

// ------------------------------------------------------------------ commands

async function chats(rpc: Rpc): Promise<number> {
  const list = (await rpc.call<Conversation[]>('conv:list')).slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20)
  if (!list.length) {
    say(`${M}No chats yet. Start one with ${p.accent('maris')}.`)
    return 0
  }
  say(`${M}${p.bold('Recent chats')}`)
  const width = (ui.columns || 100) - M.length - 34
  for (const c of list) {
    const where = c.mode === 'code' && c.projectDir ? p.dim(` · ${path.basename(c.projectDir)}`) : ''
    const from = c.origin === 'terminal' ? p.dim(` ${s.dot} terminal`) : ''
    say(`${M}${p.accent(c.id.slice(0, 6))}  ${p.dim(ago(c.updatedAt).padEnd(12))} ${fit(c.mode === 'code' && c.title === 'New chat' ? 'New task' : c.title, Math.max(20, width))}${where}${from}`)
  }
  say('')
  say(`${M}${p.dim(`Continue one: maris --chat <id>   ${s.dot}   Show one in the app: maris open <id>`)}`)
  return 0
}

async function findChat(rpc: Rpc, id?: string, terminalOnly = false): Promise<Conversation | undefined> {
  const list = (await rpc.call<Conversation[]>('conv:list')).slice().sort((a, b) => b.updatedAt - a.updatedAt)
  if (id) {
    const hit = list.find((c) => c.id === id) ?? list.find((c) => c.id.startsWith(id))
    if (!hit) throw new Usage(`No chat with id ${id}. See maris chats.`)
    return hit
  }
  return (terminalOnly ? list.find((c) => c.origin === 'terminal') : undefined) ?? list[0]
}

async function status(rpc: Rpc): Promise<number> {
  let st = await rpc.call<SystemStatus>('system:status')
  // A Maris that just started has not read the graphics card yet.
  for (let i = 0; i < 6 && !st.gpu; i++) {
    await new Promise((r) => setTimeout(r, 500))
    st = await rpc.call<SystemStatus>('system:status')
  }
  const row = (k: string, v: string): void => say(`${M}${p.dim(k.padEnd(11))} ${v}`)
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  say(`${M}${p.accent(s.mark)} ${p.bold('Maris')} ${rpc.version} ${p.dim(`${s.dot} running`)}`)
  row('Processor', pct(st.cpuLoad))
  row('Memory', `${(st.ramUsedMB / 1024).toFixed(1)} of ${(st.ramTotalMB / 1024).toFixed(1)} GB`)
  if (st.gpu) {
    const g = st.gpu
    row('Graphics', [g.name, `${g.utilization}%`, `${(g.memUsedMB / 1024).toFixed(1)} of ${(g.memTotalMB / 1024).toFixed(1)} GB`, g.temperatureC ? `${g.temperatureC}°C` : '', g.powerW ? `${Math.round(g.powerW)} W` : ''].filter(Boolean).join(` ${s.dot} `))
  }
  const apiModels = st.ollama.up ? 0 : (await rpc.call<ModelInfo[]>('models:list').catch(() => [] as ModelInfo[])).filter((m) => m.provider).length
  row(
    'Models',
    st.ollama.up
      ? st.ollama.loaded.map((l) => `${prettyModel(l.name)}${l.vramBytes < l.sizeBytes * 0.5 ? p.dim(' (processor)') : ''}`).join(', ') || p.dim('none loaded')
      : apiModels
        ? `${apiModels} API model${apiModels === 1 ? '' : 's'} ${p.dim('(Ollama is not running)')}`
        : p.bad('Ollama is not running')
  )
  if (st.lite) row('Mode', 'low-power')
  // What the models at API services came to this month (an older Maris that is still running has no such record).
  const use = await rpc.call<UsageSummary>('providers:usage').catch(() => undefined)
  if (use?.month.requests) {
    const m = use.month
    row('API use', `${usd(m.cost)} this month ${p.dim(`(${Math.round((m.input + m.output) / 1000)}K tokens, ${m.requests} request${m.requests === 1 ? '' : 's'}${m.unpriced ? `, ${m.unpriced} without a known price` : ''})`)}`)
  }
  row('Pictures', !st.comfy.installed ? p.dim('not set up (Studio in the app)') : st.comfy.busy ? `drawing${st.comfy.queue ? `, ${st.comfy.queue} waiting` : ''}` : st.comfy.up ? 'ready' : p.dim('starts when needed'))
  row('Load', st.busy === 'heavy' ? p.gold('heavy: answers use smaller models') : st.busy === 'busy' ? p.gold('busy') : st.busy)
  return 0
}

async function models(rpc: Rpc): Promise<number> {
  const [list, cfg] = await Promise.all([rpc.call<ModelInfo[]>('models:list'), rpc.call<Settings>('settings:get')])
  const roles = (name: string): string[] =>
    [
      cfg.tiers.fast === name && 'Fast',
      cfg.tiers.balanced === name && 'Balanced',
      cfg.tiers.max === name && 'Max',
      cfg.tiers.code === name && 'Code',
      cfg.tiers.tiny === name && 'Helper',
      cfg.tiers.embed === name && 'Memory'
    ].filter(Boolean) as string[]
  const line = (mdl: ModelInfo, size: string): void => {
    const r = roles(mdl.name).join(', ')
    const caps = mdl.capabilities.filter((c) => c === 'tools' || c === 'vision' || c === 'thinking')
    const role = (r || '-').padEnd(18)
    say(`${M}${nameOf(mdl).slice(0, 30).padEnd(30)} ${p.dim(size.padStart(8))}  ${r ? p.accent(role) : p.dim(role)} ${p.dim(caps.join(` ${s.dot} `))}`)
  }
  const local = list.filter((m) => !m.provider)
  if (local.length) {
    say(`${M}${p.bold('Installed models')}`)
    for (const mdl of local.slice().sort((a, b) => b.sizeBytes - a.sizeBytes)) line(mdl, bytes(mdl.sizeBytes))
  }
  // Models of the API services added in Models → API, under each service's name.
  let printed = local.length > 0
  for (const id of [...new Set(list.filter((m) => m.provider).map((m) => m.provider!))]) {
    const theirs = list.filter((m) => m.provider === id)
    if (printed) say('')
    printed = true
    say(`${M}${p.bold(theirs[0]!.providerName ?? id)} ${p.dim(theirs[0]!.remote === false ? '(on this computer)' : '(chats are sent there)')}`)
    for (const mdl of theirs) line(mdl, 'API')
  }
  if (!list.length) say(`${M}${p.dim('No models yet. Open Maris → Models to download one or add an API key.')}`)
  say('')
  say(`${M}${p.dim('Pick one for a chat with -m fast|balanced|max or a name, for example: maris -m max "…"')}`)
  return 0
}

async function media(rpc: Rpc, kind: 'image' | 'video', a: Args): Promise<number> {
  const prompt = a.words.join(' ').trim() || (await readPipedStdin())?.trim()
  if (!prompt) throw new Usage(`Describe the ${kind === 'image' ? 'picture' : 'video'}: maris ${kind} "a red fox in fresh snow"`)
  const params: MediaParams = {
    kind,
    prompt,
    quality: a.quality ?? 'auto',
    count: kind === 'image' ? Math.max(1, Math.min(4, a.count ?? 1)) : 1,
    seconds: kind === 'video' && a.seconds ? Math.max(1, Math.min(8, a.seconds)) : undefined
  }
  const status = new StatusLine(ui, p, M)
  const started = Date.now()
  let jobId: string | undefined
  rpc.subscribe(['media:job'])
  rpc.on('media:job', (j: MediaJob) => {
    if (!jobId && j.params.prompt === prompt && j.createdAt >= started - 2000) jobId = j.id
    if (j.id !== jobId || j.status === 'done' || j.status === 'error' || j.status === 'cancelled') return
    const name = j.model ?? j.packId
    const pctTxt = j.progress > 0.01 ? ` ${s.dot} ${Math.round(j.progress * 100)}%` : ''
    const eta = j.etaSec ? ` ${s.dot} about ${j.etaSec < 60 ? `${Math.max(1, Math.round(j.etaSec))} s` : `${Math.round(j.etaSec / 60)} min`} left` : ''
    status.set(`${j.status === 'queued' ? 'Waiting for the image engine' : j.status === 'preparing' ? (j.step ?? 'Getting ready') : kind === 'image' ? `Drawing with ${name}` : `Rendering with ${name}`}${pctTxt}${eta}`, false)
  })
  status.set(kind === 'image' ? 'Getting ready to draw…' : 'Getting ready to render…')
  let stopping = false
  const onSig = (): void => {
    if (stopping || !jobId) process.exit(130)
    stopping = true
    status.set('Stopping…')
    void rpc.call('media:cancel', jobId)
  }
  process.on('SIGINT', onSig)
  try {
    const job = await rpc.call<MediaJob>('media:generate', params)
    status.stop()
    if (job.status !== 'done') {
      say(`${M}${job.status === 'cancelled' ? p.dim('Stopped.') : p.bad(`${s.bad} ${job.error ?? 'It did not work.'}`)}`)
      return job.status === 'cancelled' ? 130 : 1
    }
    const took = duration(Date.now() - started)
    for (const r of job.results) {
      if (ui !== out) out.write(`${r.path}\n`)
      say(`${M}${p.ok(s.ok)} ${kind === 'image' ? 'Picture' : 'Video'} saved: ${p.file(r.path)}`)
      if (a.open) openFile(r.path)
    }
    say(`${M}${p.dim([job.results[0]?.model, job.results[0]?.width ? `${job.results[0].width}×${job.results[0].height}` : '', took].filter(Boolean).join(` ${s.dot} `))}`)
    return 0
  } finally {
    process.off('SIGINT', onSig)
  }
}

function banner(rpc: Rpc, session: Session): void {
  const where = session.mode === 'code' ? `Code ${s.dot} ${session.projectDir}` : 'Chat'
  const bits = [where, session.model === 'auto' ? 'picks a model for each message' : prettyModel(session.model), session.web ? 'web on' : 'web off']
  say(`${M}${p.accent(s.mark)} ${p.bold('Maris')} ${p.dim(rpc.version)}`)
  say(`${M}${p.dim(bits.join(` ${s.dot} `))}`)
  say(`${M}${p.dim(`/help for commands ${s.dot} Ctrl+C stops an answer ${s.dot} Ctrl+D leaves`)}`)
  say('')
}

async function repl(rpc: Rpc, session: Session, io: Io): Promise<number> {
  banner(rpc, session)
  setTitle(ui, p.caps, session.mode === 'code' ? `Maris · ${path.basename(session.projectDir ?? '')}` : 'Maris')
  const history = loadHistory()
  let lastCtrlC = 0
  for (;;) {
    const label = session.mode === 'code' ? `${p.dim(path.basename(session.projectDir ?? ''))} ` : ''
    const input = await promptLine(`${label}${p.accent(s.arrow)} `, `${p.dim(s.dot)} `, history)
    saveHistory(history)
    if (input === null) break
    if (input === 'ctrl-c') {
      if (Date.now() - lastCtrlC < 3000) break
      lastCtrlC = Date.now()
      say(`${M}${p.dim('Press Ctrl+C again or Ctrl+D to leave.')}`)
      continue
    }
    const t = input.trim()
    if (!t) continue
    if (t.startsWith('/') && !t.includes('\n')) {
      const [cmd, ...rest] = t.split(/\s+/)
      const arg = rest.join(' ')
      try {
        switch (cmd.toLowerCase()) {
          case '/exit':
          case '/quit':
          case '/q':
            return 0
          case '/help':
          case '/?':
            for (const [c, d] of COMMANDS) say(`${M}${p.accent(c.padEnd(20))} ${d}`)
            say(`${M}${p.dim('End a line with \\ to keep writing on the next one. Pasted text is sent as one message.')}`)
            break
          case '/new':
            session.conversationId = undefined
            say(`${M}${p.dim('New chat.')}`)
            break
          case '/code': {
            const dir = path.resolve(arg || process.cwd())
            if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Usage(`Not a folder: ${dir}`)
            session.mode = 'code'
            session.projectDir = dir
            session.conversationId = undefined
            say(`${M}${p.dim(`Code mode in ${dir}. Maris asks before it changes anything.`)}`)
            setTitle(ui, p.caps, `Maris · ${path.basename(dir)}`)
            break
          }
          case '/chat':
            session.mode = 'chat'
            session.projectDir = undefined
            session.conversationId = undefined
            say(`${M}${p.dim('Chat mode, new chat.')}`)
            setTitle(ui, p.caps, 'Maris')
            break
          case '/model':
            if (!arg) {
              await models(rpc)
              say(`${M}${p.dim(`Now: ${session.model === 'auto' ? 'auto' : prettyModel(session.model)}`)}`)
            } else {
              session.model = await resolveModel(rpc, arg)
              say(`${M}${p.dim(`Model: ${session.model === 'auto' ? 'auto (picked for each message)' : prettyModel(session.model)}`)}`)
            }
            break
          case '/think':
            if (!['on', 'off', 'auto'].includes(arg)) throw new Usage('Use /think on, /think off or /think auto.')
            session.think = arg as ThinkMode
            say(`${M}${p.dim(`Thinking: ${arg}`)}`)
            break
          case '/web':
            if (!['on', 'off'].includes(arg)) throw new Usage('Use /web on or /web off.')
            session.web = arg === 'on'
            say(`${M}${p.dim(`Web: ${arg}`)}`)
            break
          case '/open':
            await rpc.call('cli:show', session.conversationId)
            say(`${M}${p.dim(session.conversationId ? 'Opened this chat in the Maris window.' : 'Opened Maris.')}`)
            break
          case '/copy':
            if (!session.lastAnswer) throw new Usage('Nothing to copy yet.')
            say(`${M}${p.dim(copy(session.lastAnswer) ? 'Copied the last answer.' : 'Could not reach the clipboard.')}`)
            break
          case '/clear':
            ui.write('\x1b[2J\x1b[3J\x1b[H')
            banner(rpc, session)
            break
          default:
            say(`${M}${p.dim(`Unknown command ${cmd}. Type /help for the list.`)}`)
        }
      } catch (e) {
        say(`${M}${p.bad((e as Error).message)}`)
      }
      continue
    }
    await session.ask(t)
    if (session.conversationId) setTitle(ui, p.caps, `Maris · ${fit(t.split('\n')[0], 40)}`)
    say('')
    void io
  }
  return 0
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  let a: Args
  try {
    a = parse(process.argv.slice(2))
  } catch (e) {
    say(`${p.bad((e as Error).message)} ${p.dim('See maris --help.')}`)
    return 2
  }
  if (a.version) {
    out.write(`maris ${VERSION}\n`)
    return 0
  }
  if (a.help || a.sub === 'help') {
    help()
    return 0
  }

  const spinner = new StatusLine(ui, p, M)
  let rpc: Rpc
  try {
    rpc = await connect((what) => spinner.set(what))
  } catch (e) {
    spinner.stop()
    say(`${M}${p.bad(`${s.bad} ${(e as Error).message}`)}`)
    return 1
  } finally {
    spinner.stop()
  }

  try {
    if (a.sub === 'chats') return await chats(rpc)
    if (a.sub === 'status') return await status(rpc)
    if (a.sub === 'models') return await models(rpc)
    if (a.sub === 'image' || a.sub === 'video') return await media(rpc, a.sub, a)
    if (a.sub === 'open') {
      const c = a.words[0] ? await findChat(rpc, a.words[0]) : await findChat(rpc, undefined, true)
      await rpc.call('cli:show', c?.id)
      say(`${M}${p.dim(c ? `Showing “${c.title}” in the Maris window.` : 'Opened Maris.')}`)
      return 0
    }

    const interactive = keyboard
    const io: Io = { out, outPaint, ui, paint: p, interactive, showThinking: a.showThinking, margin: M }
    const session = new Session(rpc, io)
    if (a.model) session.model = await resolveModel(rpc, a.model)
    if (a.think) session.think = a.think
    if (a.web !== undefined) session.web = a.web

    let words = a.words
    if (a.sub === 'code') {
      const first = words[0]
      const dir = first && existsSync(path.resolve(first)) && statSync(path.resolve(first)).isDirectory() ? path.resolve(first) : undefined
      if (dir) words = words.slice(1)
      session.mode = 'code'
      session.projectDir = dir ?? process.cwd()
    }
    if (a.cont || a.chat) {
      const c = await findChat(rpc, a.chat, true)
      if (c) {
        session.conversationId = c.id
        session.mode = c.mode
        session.projectDir = c.projectDir
        if (interactive && !words.length) say(`${M}${p.dim(`Continuing “${c.title}” (${ago(c.updatedAt)})`)}`)
      }
    }

    const piped = await readPipedStdin()
    const files = await attachments(rpc, a.files)
    const question = words.join(' ').trim()
    if (question || piped || files.length) {
      const r = await session.ask(withInput(question, piped), files)
      return r === 'done' ? 0 : r === 'stopped' ? 130 : 1
    }
    if (!interactive) {
      say(`${p.bad('Nothing to ask.')} ${p.dim('Pass a question, pipe some text in, or run maris in a terminal to chat.')}`)
      return 2
    }
    return await repl(rpc, session, io)
  } catch (e) {
    say(`${M}${p.bad(e instanceof Usage ? (e as Error).message : `${s.bad} ${(e as Error).message}`)}`)
    return e instanceof Usage ? 2 : 1
  } finally {
    rpc.close()
  }
}

main().then(
  (code) => {
    process.exitCode = code
    // Leave once the output is written; a lingering handle should not keep the terminal waiting.
    setTimeout(() => process.exit(code), 50).unref()
  },
  (e) => {
    ui.write(`${(e as Error).stack ?? e}\n`)
    process.exit(1)
  }
)
