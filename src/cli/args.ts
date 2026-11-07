// Command-line arguments of the maris command (kept apart from main.ts so tests can check them).
import type { ThinkMode } from '@shared/types'

export const SUBCOMMANDS = ['code', 'image', 'video', 'chats', 'open', 'status', 'models', 'help'] as const
export type Sub = (typeof SUBCOMMANDS)[number]

export interface Args {
  sub?: Sub
  words: string[]
  model?: string
  think?: ThinkMode
  web?: boolean
  plain: boolean
  showThinking: boolean
  cont: boolean
  chat?: string
  files: string[]
  quality?: 'fast' | 'quality'
  count?: number
  seconds?: number
  open: boolean
  help: boolean
  version: boolean
}

export class Usage extends Error {}

export function parse(argv: string[]): Args {
  const a: Args = { words: [], plain: false, showThinking: false, cont: false, files: [], open: false, help: false, version: false }
  const value = (i: number, name: string): string => {
    const v = argv[i + 1]
    if (v === undefined || (v.startsWith('-') && v.length > 1)) throw new Usage(`${name} needs a value.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--') {
      a.words.push(...argv.slice(i + 1))
      break
    }
    if (!t.startsWith('-') || t === '-') {
      if (!a.sub && !a.words.length && (SUBCOMMANDS as readonly string[]).includes(t)) a.sub = t as Sub
      else a.words.push(t)
      continue
    }
    const [flag, inline] = t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined]
    const take = (name: string): string => {
      if (inline !== undefined) return inline
      const v = value(i, name)
      i++
      return v
    }
    switch (flag) {
      case '-h':
      case '--help':
        a.help = true
        break
      case '-v':
      case '--version':
        a.version = true
        break
      case '-m':
      case '--model':
        a.model = take('--model')
        break
      case '--think':
        a.think = 'on'
        break
      case '--no-think':
        a.think = 'off'
        break
      case '--web':
        a.web = true
        break
      case '--no-web':
        a.web = false
        break
      case '--plain':
        a.plain = true
        break
      case '--show-thinking':
        a.showThinking = true
        break
      case '-c':
      case '--continue':
        a.cont = true
        break
      case '--chat':
        a.chat = take('--chat')
        break
      case '-f':
      case '--file':
        a.files.push(take('--file'))
        break
      case '--quality': {
        const q = take('--quality')
        if (q !== 'fast' && q !== 'quality') throw new Usage('--quality is fast or quality.')
        a.quality = q
        break
      }
      case '-n':
      case '--count':
        a.count = Number(take('--count'))
        break
      case '--seconds':
        a.seconds = Number(take('--seconds'))
        break
      case '-o':
      case '--open':
        a.open = true
        break
      default:
        throw new Usage(`Unknown option ${flag}.`)
    }
  }
  return a
}
