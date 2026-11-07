// Terminal output for the maris command: colours, a status line with a spinner, clickable links and
// single-key questions. Everything degrades to plain text when the output is piped or NO_COLOR is set.
import { pathToFileURL } from 'node:url'
import { PLAIN_STYLE, textWidth, type ProseStyle } from './prose'

const env = process.env

export interface Caps {
  color: boolean
  truecolor: boolean
  unicode: boolean
  /** Spinners and rewriting the current line. */
  live: boolean
  /** OSC 8 hyperlinks. */
  links: boolean
}

export function detectCaps(stream: NodeJS.WriteStream, plain: boolean): Caps {
  const tty = Boolean(stream.isTTY)
  const noColor = 'NO_COLOR' in env || env.TERM === 'dumb'
  const force = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0'
  const color = !plain && ((tty && !noColor) || force)
  // The old Windows console host draws braille and box characters as boxes; Windows Terminal and
  // every other modern terminal set one of these.
  const modern = process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.ALACRITTY_LOG || env.WEZTERM_PANE)
  const term = env.TERM_PROGRAM ?? ''
  return {
    color,
    truecolor: color && (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || Boolean(env.WT_SESSION) || /vscode|iTerm|WezTerm|ghostty/i.test(term)),
    unicode: modern,
    live: !plain && tty && env.TERM !== 'dumb',
    links: !plain && tty && (Boolean(env.WT_SESSION || env.VTE_VERSION || env.KITTY_WINDOW_ID || env.WEZTERM_PANE) || /vscode|iTerm|WezTerm|ghostty/i.test(term))
  }
}

export class Paint {
  constructor(readonly caps: Caps) {}
  private sgr(open: string, close: string, s: string): string {
    return this.caps.color && s ? `\x1b[${open}m${s}\x1b[${close}m` : s
  }
  private rgb(r: number, g: number, b: number, c256: number, s: string): string {
    if (!this.caps.color || !s) return s
    return this.caps.truecolor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : `\x1b[38;5;${c256}m${s}\x1b[39m`
  }
  bold = (s: string): string => this.sgr('1', '22', s)
  dim = (s: string): string => this.sgr('2', '22', s)
  italic = (s: string): string => this.sgr('3', '23', s)
  /** Maris violet. */
  accent = (s: string): string => this.rgb(164, 147, 255, 141, s)
  /** Maris gold, for things that need attention. */
  gold = (s: string): string => this.rgb(242, 181, 68, 214, s)
  ok = (s: string): string => this.rgb(110, 214, 140, 114, s)
  bad = (s: string): string => this.rgb(248, 113, 113, 203, s)
  code = (s: string): string => this.rgb(147, 197, 253, 117, s)
  /** A clickable link where the terminal supports it. */
  link = (text: string, url: string): string => (this.caps.links ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text === url ? url : `${text} ${this.dim(`(${url})`)}`)
  file = (p: string): string => (this.caps.links ? `\x1b]8;;${pathToFileURL(p).href}\x1b\\${p}\x1b]8;;\x1b\\` : p)
  get sym(): { ok: string; bad: string; no: string; warn: string; dot: string; arrow: string; bullet: string; bar: string; rule: string; mark: string } {
    return this.caps.unicode
      ? { ok: '✓', bad: '✗', no: '⊘', warn: '!', dot: '·', arrow: '›', bullet: '•', bar: '│', rule: '─', mark: '◆' }
      : { ok: '+', bad: 'x', no: '-', warn: '!', dot: '-', arrow: '>', bullet: '-', bar: '|', rule: '-', mark: '*' }
  }
  prose(): ProseStyle {
    if (!this.caps.color && !this.caps.unicode) return PLAIN_STYLE
    const s = this.sym
    return { bold: this.bold, dim: this.dim, accent: this.accent, code: this.code, link: this.link, bullet: s.bullet, bar: s.bar, rule: s.rule }
  }
}

const SPIN_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_ASCII = ['-', '\\', '|', '/']

/** One line at the bottom that shows what is happening now; everything else prints above it. */
export class StatusLine {
  private text = ''
  private timer?: NodeJS.Timeout
  private frame = 0
  private shown = false
  private since = 0

  constructor(
    private stream: NodeJS.WriteStream,
    private paint: Paint,
    private margin: string
  ) {}

  /** Show (or change) the status; a timer appears after a few seconds. */
  set(text: string, resetTimer = true): void {
    if (resetTimer || !this.since) this.since = Date.now()
    this.text = text
    if (!this.paint.caps.live) return
    if (!this.timer) this.timer = setInterval(() => this.draw(), 90)
    this.draw()
  }

  get active(): boolean {
    return Boolean(this.text)
  }

  /** Remove the line (for example before printing above it). */
  clear(): void {
    if (this.shown) {
      this.stream.write('\r\x1b[2K')
      this.shown = false
    }
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.clear()
    this.text = ''
    this.since = 0
  }

  /** Print a finished line above the status line. */
  print(line: string): void {
    this.clear()
    this.stream.write(`${line}\n`)
    if (this.timer) this.draw()
  }

  private draw(): void {
    if (!this.text) return
    const frames = this.paint.caps.unicode ? SPIN_UNICODE : SPIN_ASCII
    const secs = Math.floor((Date.now() - this.since) / 1000)
    const timer = secs >= 3 ? ` ${secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`}` : ''
    const max = (this.stream.columns || 80) - this.margin.length - timer.length - 3
    const shown = fit(this.text, max)
    this.stream.write(`\r\x1b[2K${this.margin}${this.paint.accent(frames[this.frame++ % frames.length])} ${shown}${this.paint.dim(timer)}`)
    this.shown = true
  }
}

/** Cut a string to a display width, with an ellipsis. */
export function fit(s: string, max: number): string {
  if (textWidth(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch) > max - 1) break
    out += ch
  }
  return `${out}…`
}

/**
 * Wait for one of the allowed keys. The caller keeps stdin in raw mode and flowing. Resolves with the key
 * in lower case ("ctrl-c", "enter", "escape" for those), or "aborted" when the signal fires.
 */
export function readKey(allowed: string[], signal?: AbortSignal): Promise<string> {
  const stdin = process.stdin
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('aborted')
    const done = (key: string): void => {
      stdin.off('data', onData)
      signal?.removeEventListener('abort', onAbort)
      resolve(key)
    }
    const onAbort = (): void => done('aborted')
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8')
      const key = s === '\x03' ? 'ctrl-c' : s === '\r' || s === '\n' ? 'enter' : s === '\x1b' ? 'escape' : s.toLowerCase()
      if (allowed.includes(key)) done(key)
    }
    signal?.addEventListener('abort', onAbort)
    stdin.on('data', onData)
  })
}

/** Set the terminal window's title. */
export function setTitle(stream: NodeJS.WriteStream, caps: Caps, title: string): void {
  if (caps.live) stream.write(`\x1b]0;${title.replace(/[\x00-\x1f]/g, ' ')}\x07`)
}
