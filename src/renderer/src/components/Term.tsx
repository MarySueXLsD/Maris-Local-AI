import { Tooltip as RTooltip } from 'radix-ui'
import type { ReactNode } from 'react'
import { GLOSSARY } from '../help/glossary'
import { useApp } from '../store'

/**
 * A technical word with a dotted underline: pointing at it explains it in plain words, clicking opens
 * the help article. Plain text when "Explain technical words" is off.
 */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const on = useApp((s) => s.settings?.ui.helpTips ?? true)
  const openHelp = useApp((s) => s.openHelp)
  const g = GLOSSARY[id]
  if (!g || !on) return <>{children ?? g?.term}</>
  return (
    <RTooltip.Root delayDuration={200}>
      <RTooltip.Trigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-describedby={undefined}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            if (g.article) openHelp(g.article)
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && g.article) {
              e.preventDefault()
              openHelp(g.article)
            }
          }}
          className="cursor-help underline decoration-text-3/70 decoration-dotted underline-offset-[3px] hover:decoration-petal"
        >
          {children ?? g.term}
        </span>
      </RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side="top" sideOffset={6} className="z-[60] max-w-72 rounded-lg border border-line bg-raised px-3 py-2 text-[0.82rem] leading-snug text-text shadow-float">
          <span className="block font-medium">{g.term}</span>
          <span className="mt-0.5 block text-text-2">{g.short}</span>
          {g.article && <span className="mt-1 block text-[0.76rem] text-text-3">Click to read more in Help.</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

/** Which words get an explanation. Order matters: longer phrases first. */
const TERMS: [RegExp, string][] = [
  [/tokens\/s|tokens per second/i, 'tps'],
  [/\bVRAM\b|video memory/i, 'vram'],
  [/\bGPU\b|graphics card/i, 'gpu'],
  [/\bRAM\b|system memory/i, 'ram'],
  [/\bCPU\b/, 'cpu'],
  [/context windows?/i, 'context'],
  [/mixture[- ]of[- ]experts/i, 'moe'],
  [/negative prompts?/i, 'negative'],
  [/\bLoRAs?\b/, 'lora'],
  [/\bOllama\b/, 'ollama'],
  [/\bComfyUI\b/, 'comfyui'],
  [/\btemperature\b/i, 'temperature'],
  [/\bembeddings?\b/i, 'embedding'],
  [/\bQ[3-8]_K(_[A-Z]+)?\b|quantis(ed|ation)/i, 'quant'],
  [/\bcompact(ing|ion|ed)?\b/i, 'compaction'],
  [/\btokens\b/i, 'tokens']
]

/** Text with the first few technical words turned into <Term> explanations. */
export function withTerms(text: string | undefined, limit = 2): ReactNode {
  if (!text) return text
  const nodes: ReactNode[] = []
  let rest = text
  const used = new Set<string>()
  let key = 0
  while (used.size < limit) {
    let best: { index: number; length: number; id: string } | undefined
    for (const [rx, id] of TERMS) {
      if (used.has(id)) continue
      const m = rx.exec(rest)
      if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, id }
    }
    if (!best) break
    used.add(best.id)
    if (best.index > 0) nodes.push(rest.slice(0, best.index))
    nodes.push(
      <Term key={key++} id={best.id}>
        {rest.slice(best.index, best.index + best.length)}
      </Term>
    )
    rest = rest.slice(best.index + best.length)
  }
  nodes.push(rest)
  return <>{nodes}</>
}
