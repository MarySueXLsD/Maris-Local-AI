// Streams Markdown from the model to a terminal as it arrives: headings, bullets with hanging indents,
// **bold**, `code`, code blocks with a gutter, links, and word wrapping at the terminal's width.
// It never rewrites what it already printed, so it works on any terminal and with any chunking.

export interface ProseStyle {
  bold: (s: string) => string
  dim: (s: string) => string
  accent: (s: string) => string
  code: (s: string) => string
  link: (text: string, url: string) => string
  /** Characters for bullets, quotes and code gutters, and for horizontal rules. */
  bullet: string
  bar: string
  rule: string
}

export const PLAIN_STYLE: ProseStyle = {
  bold: (s) => s,
  dim: (s) => s,
  accent: (s) => s,
  code: (s) => s,
  link: (t, u) => (t === u ? u : `${t} (${u})`),
  bullet: '-',
  bar: '|',
  rule: '-'
}

/** Display width of a string in a terminal (wide CJK characters and most emoji take two cells). */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1
  }
  return w
}

export class Prose {
  private col = 0
  /** Start of the current line, held until it shows what kind of line it is. */
  private head = ''
  private lineStart = true
  private block: 'para' | 'code' | 'table' = 'para'
  private fence = ''
  /** Rest of a fence line: the code block's language (opening) or nothing (closing). */
  private fenceRest: string | undefined
  private opening = false
  /** What wrapped lines start with (a bullet's text lines up after the bullet), and its width. */
  private hang = ''
  private hangW = 0
  private heading = false
  private bold = false
  private code = false
  private word = ''
  private wordStyled = ''
  /** Characters held back because they may start a marker ("*" before "**", "[" of a link). */
  private hold = ''
  private wrote = false
  private blanks = 0

  private out: (s: string) => void
  private style: ProseStyle
  private width: () => number
  private margin: string

  constructor(out: (s: string) => void, style: ProseStyle, width: () => number, margin = '') {
    this.out = out
    this.style = style
    this.width = width
    this.margin = margin
  }

  /** Feed the next piece of the answer. */
  push(text: string): void {
    for (const ch of text.replace(/\r\n?/g, '\n')) this.char(ch)
  }

  /** This stretch of text is complete: print what is still held back and end the line. More may follow. */
  end(): void {
    if (this.lineStart && this.head) this.decide(true)
    this.releaseHold()
    this.flushWord()
    if (this.col > 0) this.newline()
    this.lineStart = true
    this.head = ''
    this.fenceRest = undefined
    this.bold = this.code = this.heading = false
    if (this.block === 'table') this.block = 'para'
    this.hang = this.margin
    this.hangW = textWidth(this.margin)
  }

  /** Something was printed. */
  get started(): boolean {
    return this.wrote
  }

  // ------------------------------------------------------------------ lines

  private char(ch: string): void {
    if (this.fenceRest !== undefined) {
      if (ch === '\n') return this.endLine()
      this.fenceRest += ch
      return
    }
    if (this.lineStart) {
      if (ch === '\n') {
        this.decide(true)
        return this.endLine()
      }
      this.head += ch
      if (!this.undecided()) this.decide(false)
      return
    }
    if (ch === '\n') return this.endLine()
    if (this.block !== 'para') return this.raw(ch)
    this.inline(ch, false)
  }

  /** The start of the line could still turn into a marker. */
  private undecided(): boolean {
    const h = this.head
    if (h.length > 40) return false
    if (this.block === 'code') return /^\s*(`{0,3}|~{0,3})$/.test(h)
    return (
      /^\s*$/.test(h) ||
      /^\s*(`{1,3}|~{1,3})$/.test(h) ||
      /^\s{0,3}#{1,6}$/.test(h) ||
      /^\s*[-*+]$/.test(h) ||
      /^\s{0,3}([-*_])\1+$/.test(h) ||
      /^\s*\d{1,3}[.)]?$/.test(h)
    )
  }

  private decide(wholeLine: boolean): void {
    const h = this.head
    this.head = ''
    this.lineStart = false
    const fence = /^\s*(`{3,}|~{3,})/.exec(h)
    if (fence && this.block === 'code' && fence[1].startsWith(this.fence)) {
      this.block = 'para'
      this.opening = false
      this.fenceRest = ''
      return
    }
    if (fence && this.block !== 'code') {
      this.block = 'code'
      this.fence = fence[1]
      this.opening = true
      this.fenceRest = h.slice(fence[0].length)
      return
    }
    if (this.block === 'code') {
      this.put(`${this.margin}${this.style.dim(this.style.bar)} `, textWidth(this.margin) + 2)
      for (const c of h) this.raw(c)
      return
    }
    if (/^\s*\|/.test(h)) {
      this.block = 'table'
      this.put(this.margin, textWidth(this.margin))
      for (const c of h.replace(/^\s+/, '')) this.raw(c)
      return
    }
    if (wholeLine && /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(h)) {
      const max = this.width() - textWidth(this.margin) - 1
      const n = Number.isFinite(max) ? Math.max(8, Math.min(48, max)) : 24
      this.put(this.margin + this.style.dim(this.style.rule.repeat(n)), textWidth(this.margin) + n)
      return
    }
    const setHang = (lead: string, extra: number): void => {
      this.hang = lead + ' '.repeat(extra)
      this.hangW = textWidth(lead) + extra
    }
    const heading = /^\s{0,3}#{1,6}\s+/.exec(h)
    if (heading) {
      this.heading = true
      setHang(this.margin, 0)
      this.put(this.margin, this.hangW)
      return this.feed(h.slice(heading[0].length))
    }
    const bullet = /^(\s*)[-*+]\s+/.exec(h)
    if (bullet) {
      const lead = this.margin + '  '.repeat(Math.min(3, Math.floor(bullet[1].length / 2)))
      setHang(lead, 2)
      this.put(`${lead}${this.style.accent(this.style.bullet)} `, this.hangW)
      return this.feed(h.slice(bullet[0].length))
    }
    const numbered = /^(\s*)(\d{1,3}[.)])\s+/.exec(h)
    if (numbered) {
      const lead = this.margin + '  '.repeat(Math.min(3, Math.floor(numbered[1].length / 2)))
      setHang(lead, numbered[2].length + 1)
      this.put(`${lead}${this.style.accent(numbered[2])} `, this.hangW)
      return this.feed(h.slice(numbered[0].length))
    }
    const quote = /^\s{0,3}>\s?/.exec(h)
    if (quote) {
      this.hang = `${this.margin}${this.style.dim(this.style.bar)} `
      this.hangW = textWidth(this.margin) + 2
      this.put(this.hang, this.hangW)
      return this.feed(h.slice(quote[0].length))
    }
    setHang(this.margin, 0)
    this.put(this.margin, this.hangW)
    this.feed(h.replace(/^\s+/, ''))
  }

  private feed(s: string): void {
    for (const c of s) this.inline(c, false)
  }

  private raw(ch: string): void {
    this.put(this.block === 'code' ? this.style.code(ch) : ch, textWidth(ch))
  }

  private endLine(): void {
    if (this.fenceRest !== undefined) {
      const lang = this.fenceRest.trim()
      this.fenceRest = undefined
      if (this.opening && lang) {
        this.put(this.style.dim(`${this.margin}${lang}`), 0)
        this.newline()
      }
      this.lineStart = true
      return
    }
    this.releaseHold()
    this.flushWord()
    if (this.block === 'table') this.block = 'para'
    const blank = this.block === 'para' && this.col <= this.hangW && !this.heading
    this.bold = this.code = this.heading = false
    if (blank) {
      // Runs of empty lines become one.
      if (this.blanks++ === 0 && this.wrote) this.newline()
      this.col = 0
    } else {
      this.blanks = 0
      this.newline()
    }
    this.lineStart = true
    this.hang = this.margin
    this.hangW = textWidth(this.margin)
  }

  // ------------------------------------------------------------------ inline

  private inline(ch: string, final: boolean): void {
    if (this.hold || ch === '*' || ch === '`' || ch === '[') {
      this.hold += ch
      if (!final && this.holding()) return
      const h = this.hold
      this.hold = ''
      this.resolve(h, final)
      return
    }
    this.text(ch)
  }

  private releaseHold(): void {
    while (this.hold) {
      const h = this.hold
      this.hold = ''
      this.resolve(h, true)
    }
  }

  /** Keep holding while the held text can still become "**" or a [link](url). */
  private holding(): boolean {
    const h = this.hold
    if (h === '*') return true
    if (h.startsWith('[')) return h.length < 400 && /^\[[^\]\n]*(\](\([^)\s]*)?)?$/.test(h)
    return false
  }

  private resolve(h: string, final: boolean): void {
    if (h.startsWith('[')) {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(h)
      if (link) {
        this.flushWord()
        const text = link[1] || link[2]
        this.word = text
        this.wordStyled = this.style.link(text, link[2])
        return this.flushWord()
      }
      this.text('[')
      for (const c of h.slice(1)) this.inline(c, final)
      return
    }
    if (h.startsWith('**')) {
      this.bold = !this.bold
      for (const c of h.slice(2)) this.inline(c, final)
      return
    }
    if (h === '`') {
      this.code = !this.code
      return
    }
    // A single "*" stays as it is: it may be a multiplication sign or part of a path pattern.
    this.text(h[0])
    for (const c of h.slice(1)) this.inline(c, final)
  }

  private text(ch: string): void {
    if (ch === ' ' || ch === '\t') {
      this.flushWord()
      if (this.col > this.hangW) this.put(' ', 1)
      return
    }
    const s = this.code ? this.style.code(ch) : this.heading ? this.style.bold(this.style.accent(ch)) : this.bold ? this.style.bold(ch) : ch
    this.word += ch
    this.wordStyled += s
  }

  private flushWord(): void {
    if (!this.word) return
    const w = textWidth(this.word)
    const max = this.width()
    if (Number.isFinite(max) && this.col + w > max - 1 && this.col > this.hangW) {
      this.newline()
      this.put(this.hang, this.hangW)
    }
    this.put(this.wordStyled, w)
    this.word = ''
    this.wordStyled = ''
  }

  // ------------------------------------------------------------------ output

  private put(s: string, w: number): void {
    if (!s) return
    this.out(s)
    this.col += w
    this.wrote = true
  }

  private newline(): void {
    this.out('\n')
    this.col = 0
  }
}
