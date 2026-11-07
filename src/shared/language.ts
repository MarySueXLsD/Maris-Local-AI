// Which language a message is written in, judged from its letters and common words (no model needed),
// and whether an answer drifted into another writing system. Pure, so tests/language.test.ts checks it.

export type Script = 'latin' | 'cyrillic' | 'cjk' | 'kana' | 'hangul' | 'arabic' | 'hebrew' | 'greek' | 'devanagari' | 'thai'

export interface Language {
  /** ISO 639-1 code, e.g. "en". */
  code: string
  /** English name, e.g. "English", for the instruction to the model. */
  name: string
  script: Script
  /** False for one or two words that many languages share ("ok", "continue"). */
  confident: boolean
}

const SCRIPTS: [Script, RegExp][] = [
  ['latin', /[A-Za-zÀ-ɏ]/],
  ['cyrillic', /[Ѐ-ӿ]/],
  ['kana', /[぀-ヿㇰ-ㇿ]/],
  ['hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/],
  ['cjk', /[㐀-䶿一-鿿豈-﫿]/],
  ['arabic', /[؀-ۿݐ-ݿ]/],
  ['hebrew', /[֐-׿]/],
  ['greek', /[Ͱ-Ͽ]/],
  ['devanagari', /[ऀ-ॿ]/],
  ['thai', /[฀-๿]/]
]

/** Code, links and paths say nothing about the language a person writes in. */
export function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, ' ')
    .replace(/(^|\s)[~.]?\/[^\s"'<>|]+/g, ' ')
    .replace(/\S+\.[A-Za-z0-9]{1,5}\b/g, ' ')
}

export function scriptCounts(text: string): Record<Script, number> {
  const counts = Object.fromEntries(SCRIPTS.map(([s]) => [s, 0])) as Record<Script, number>
  for (const ch of text) {
    for (const [s, rx] of SCRIPTS) {
      if (rx.test(ch)) {
        counts[s]++
        break
      }
    }
  }
  return counts
}

// Frequent short words per language written in Latin letters. Words shared by several languages count for each.
const WORDS: Record<string, string[]> = {
  en: 'the and is are you your to of in it that what this for with how can do does my me there please make create write why where when which not be have i a an was will would should could all from at on or if so they we he she them about into just'.split(' '),
  es: 'el la los las que de y es en por para con una un como qué cómo dónde cuándo hola gracias pero muy más este esta estos tengo puedes quiero hacer del al se lo le no sí'.split(' '),
  de: 'der die das und ist ich nicht ein eine mit für wie was wo bitte danke auf zu es du sie wir ihr den dem des auch noch kann machen oder aber sind hast habe'.split(' '),
  fr: 'le la les et est je vous une des pour avec que qui comment quoi où merci pas ce dans du au sur mais très tu il elle nous faire peux veux est-ce'.split(' '),
  pt: 'o a os as que de e é em para com um uma como não você obrigado onde do da dos das mas muito isso esse essa fazer pode quero'.split(' '),
  it: 'il lo la gli le che di e è per con un una come non sono grazie dove del della ma molto questo questa fare puoi voglio cosa perché'.split(' '),
  pl: 'i w na z że jest nie się to co jak dla czy proszę dziękuję ale bardzo ten ta jestem możesz chcę zrobić gdzie dlaczego'.split(' '),
  nl: 'de het een en is van ik je niet dat wat hoe met voor op zijn maar ook kan maken waar waarom dit deze'.split(' '),
  tr: 've bir bu ne nasıl için ile mi var değil ben sen çok daha gibi ama neden nerede yap'.split(' '),
  id: 'dan yang di ini itu untuk dengan tidak apa bagaimana saya anda ada bisa dari ke juga'.split(' ')
}
const LATIN_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  pt: 'Portuguese',
  it: 'Italian',
  pl: 'Polish',
  nl: 'Dutch',
  tr: 'Turkish',
  id: 'Indonesian'
}
// Letters that only some languages use.
const MARKS: [string, RegExp][] = [
  ['es', /[ñ¿¡]/i],
  ['de', /[ßäöü]/i],
  ['fr', /[çêèàùâîôœë]/i],
  ['pt', /[ãõçâêô]/i],
  ['it', /[àèìòù]/i],
  ['pl', /[łąęśżźćń]/i],
  ['tr', /[ışğİ]/]
]

function latinLanguage(prose: string): { code: string; score: number; words: number } {
  const words = prose.toLowerCase().match(/[a-zÀ-ɏ'-]+/g) ?? []
  const score: Record<string, number> = Object.fromEntries(Object.keys(WORDS).map((k) => [k, 0]))
  for (const w of words) for (const [code, list] of Object.entries(WORDS)) if (list.includes(w)) score[code]++
  for (const [code, rx] of MARKS) if (rx.test(prose)) score[code] += 1.5
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1])
  const [best, second] = ranked
  // Plain ASCII without any telling word reads as English, the language most short tech messages are in.
  if (!best || best[1] === 0 || best[1] === second?.[1]) return { code: /[À-ɏ]/.test(prose) ? (best?.[0] ?? 'en') : 'en', score: 0, words: words.length }
  return { code: best[0], score: best[1], words: words.length }
}

/** The language of a message, or undefined when it has no letters to go by. */
export function detectLanguage(text: string): Language | undefined {
  const prose = proseOnly(text)
  const counts = scriptCounts(prose)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total < 2) return undefined
  // Japanese mixes kana and kanji; any kana means Japanese.
  if (counts.kana >= 2 && counts.kana + counts.cjk >= total * 0.3) return { code: 'ja', name: 'Japanese', script: 'kana', confident: total >= 4 }
  const [script, n] = (Object.entries(counts) as [Script, number][]).sort((a, b) => b[1] - a[1])[0]!
  const confident = n >= 12
  switch (script) {
    case 'cyrillic':
      if (/[іїєґ]/i.test(prose)) return { code: 'uk', name: 'Ukrainian', script, confident }
      if (/[ў]/i.test(prose)) return { code: 'be', name: 'Belarusian', script, confident }
      return { code: 'ru', name: 'Russian', script, confident }
    case 'cjk':
      return { code: 'zh', name: 'Chinese', script, confident: n >= 4 }
    case 'hangul':
      return { code: 'ko', name: 'Korean', script, confident: n >= 4 }
    case 'arabic':
      return /[پچژگ]/.test(prose) ? { code: 'fa', name: 'Persian', script, confident } : { code: 'ar', name: 'Arabic', script, confident }
    case 'hebrew':
      return { code: 'he', name: 'Hebrew', script, confident }
    case 'greek':
      return { code: 'el', name: 'Greek', script, confident }
    case 'devanagari':
      return { code: 'hi', name: 'Hindi', script, confident }
    case 'thai':
      return { code: 'th', name: 'Thai', script, confident }
    case 'kana':
      return { code: 'ja', name: 'Japanese', script, confident: n >= 4 }
    default: {
      const l = latinLanguage(prose)
      return { code: l.code, name: LATIN_NAMES[l.code] ?? 'English', script: 'latin', confident: l.words >= 3 && (l.score >= 2 || l.code === 'en') }
    }
  }
}

/** The person's language: the newest message that tells clearly, else the newest guess. */
export function conversationLanguage(userMessages: string[]): Language | undefined {
  let guess: Language | undefined
  for (let i = userMessages.length - 1; i >= 0 && i >= userMessages.length - 6; i--) {
    const l = detectLanguage(userMessages[i] ?? '')
    if (!l) continue
    if (l.confident) return l
    guess ??= l
  }
  return guess
}

/**
 * True when an answer is plainly in another writing system than the person's (a small model that
 * read Japanese file names and went on in Chinese). Only clear cases count: some Latin words in a
 * Russian answer, or kanji in an English one about a Japanese file, are normal.
 */
export function drifted(expected: Language, answer: string): boolean {
  const counts = scriptCounts(proseOnly(answer))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total < 24) return false
  const eastAsian = counts.cjk + counts.kana + counts.hangul
  const east = expected.script === 'cjk' || expected.script === 'kana' || expected.script === 'hangul'
  if (!east && eastAsian / total >= 0.3) return true
  if (expected.script === 'latin' && counts.cyrillic / total >= 0.5) return true
  if (expected.script === 'cyrillic' && total >= 80 && counts.latin / total >= 0.85) return true
  if (east && total >= 80 && counts.latin / total >= 0.9) return true
  return false
}

/** Short replies that ask to go on with the same task ("continue", "go on", "продолжай"). */
export function isContinuation(text: string): boolean {
  return /^\s*(please\s+)?(continue|go on|keep going|go ahead|carry on|proceed|resume|next|finish( it)?|do it|yes|yeah|yep|y|ok(ay)?|sure|right|продолжай|продолжи|дальше|давай|да|ок|го|weiter|continúa|sigue|continue[sz]?|vas-y)(\s+please)?[\s!.?…]*$/i.test(text)
}
