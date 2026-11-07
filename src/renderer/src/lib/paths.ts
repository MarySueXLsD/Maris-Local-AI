// Paths in answers ("H:\Projects\test", "~/projects/x") that open in the file manager when clicked.
// Pure (no imports), so tests/paths.test.ts can check it directly.

// "H:\Projects\test" or "~/projects/x" in an answer opens the folder (or shows the file) in the file manager.
// Middle folders may contain spaces (they are followed by another backslash); the last part may not.
const WIN_PATH = /(?<![A-Za-z0-9])[A-Za-z]:\\(?:[^\\\n<>"|?*:`]*\\)*[^\\\s<>"|?*:`,;)\]]*/g
const NIX_PATH = /(?<![\w/:.])(?:~\/|\/(?:Users|home|tmp|opt|usr|etc|var|Volumes|mnt|media|srv|Applications|private)\/)[^\s<>"|?*:`,;)\]]*/g

// A path in quotes may have spaces anywhere: "C:\My Files\a b.txt".
const QUOTED_PATH = /(?<=["“'‘])(?:[A-Za-z]:\\|~\/|\/(?:Users|home|tmp|opt|usr|etc|var|Volumes|mnt|media|srv|Applications|private)\/)[^"”'’\n<>|?*]*(?=["”'’])/g

// Inline code is delimited, so a whole code span that is a path may contain spaces anywhere: `H:\Unreal Projects`.
const WHOLE_WIN = /^(?:[A-Za-z]:\\|\\\\[^\\\s]+\\)[^<>"|?*\n:]*$/
const WHOLE_NIX = /^(?:~|~\/[^\n<>"|?*]*|\/(?:Users|home|tmp|opt|usr|etc|var|Volumes|mnt|media|srv|Applications|private)(?:\/[^\n<>"|?*]*)?)$/

/** True when all of `s` (for example an inline code span) is one path, spaces included. */
export function isWholePath(s: string): boolean {
  const t = s.trim()
  return t.length >= 3 && (WHOLE_WIN.test(t) || WHOLE_NIX.test(t))
}

/** Text split into plain pieces and paths (trailing full stops and quotes are not part of a path). */
export function splitPaths(text: string): { text: string; path?: string }[] {
  const hits: { start: number; end: number }[] = []
  QUOTED_PATH.lastIndex = 0
  for (let m = QUOTED_PATH.exec(text); m; m = QUOTED_PATH.exec(text)) {
    const end = m.index + m[0].replace(/[\s.]+$/, '').length
    if (end - m.index >= 3) hits.push({ start: m.index, end })
  }
  for (const rx of [WIN_PATH, NIX_PATH]) {
    rx.lastIndex = 0
    for (let m = rx.exec(text); m; m = rx.exec(text)) {
      let end = m.index + m[0].length
      while (end > m.index && /[.'"’”]/.test(text[end - 1]!)) end--
      if (end - m.index >= 3) hits.push({ start: m.index, end })
    }
  }
  if (!hits.length) return [{ text }]
  // At the same place, the longer match (a quoted path with spaces) wins.
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: { text: string; path?: string }[] = []
  let at = 0
  for (const h of hits) {
    if (h.start < at) continue
    if (h.start > at) out.push({ text: text.slice(at, h.start) })
    out.push({ text: text.slice(h.start, h.end), path: text.slice(h.start, h.end) })
    at = h.end
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

