import { Check, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MARIS_PREVIEW, THEMES, tokensFromColors } from '@shared/themes'
import type { Settings } from '@shared/types'
import { cn, Tip } from '../../components/ui'

interface PreviewColors {
  paper: string
  side: string
  raised: string
  text: string
  text3: string
  petal: string
  pollen: string
}

/** A tiny drawing of the app in a theme's colours: sidebar, two lines of text, a message and a button. */
function Mini({ c, glow }: { c: PreviewColors; glow?: boolean }) {
  return (
    <div className="flex h-[74px] w-full" style={{ background: c.paper }} aria-hidden>
      <div className="w-[26%] space-y-1 border-r p-1.5" style={{ background: c.side, borderColor: `${c.text3}33` }}>
        <div className="h-1.5 w-full rounded-full" style={{ background: c.petal, boxShadow: glow ? `0 0 6px ${c.petal}` : undefined }} />
        <div className="h-1 w-3/4 rounded-full" style={{ background: c.text3, opacity: 0.6 }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: c.text3, opacity: 0.4 }} />
      </div>
      <div className="flex flex-1 flex-col justify-between p-2">
        <div className="space-y-1">
          <div className="h-1 w-4/5 rounded-full" style={{ background: c.text, opacity: 0.75 }} />
          <div className="h-1 w-3/5 rounded-full" style={{ background: c.text3 }} />
        </div>
        <div className="flex items-center justify-end gap-1">
          <span className="size-1.5 rounded-full" style={{ background: c.pollen }} />
          <span className="h-3 w-9 rounded-full" style={{ background: c.petal, boxShadow: glow ? `0 0 8px ${c.petal}` : undefined }} />
        </div>
      </div>
    </div>
  )
}

export function ThemePicker({ s, update }: { s: Settings; update: (path: string, value: unknown) => void }) {
  const current = s.ui.palette || 'maris'
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const marisScheme = s.ui.theme === 'system' ? (systemDark ? 'dark' : 'light') : s.ui.theme
  const custom = tokensFromColors(s.ui.customTheme)

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5">
        {THEMES.map((t) => {
          const active = current === t.id
          const colors: PreviewColors =
            t.id === 'maris'
              ? MARIS_PREVIEW[marisScheme]
              : t.id === 'custom'
                ? { paper: custom.paper, side: custom.paper, raised: custom.raised, text: custom.text, text3: custom.text3, petal: custom.petal, pollen: custom.pollen }
                : { paper: t.tokens!.paper, side: t.tokens!.paper, raised: t.tokens!.raised, text: t.tokens!.text, text3: t.tokens!.text3, petal: t.tokens!.petal, pollen: t.tokens!.pollen }
          const glow = t.id === 'custom' ? s.ui.customTheme.glow : Boolean(t.tokens?.glow)
          return (
            <Tip key={t.id} label={t.description}>
              <button
                role="radio"
                aria-checked={active}
                aria-label={t.name}
                onClick={() => update('ui.palette', t.id)}
                className={cn(
                  'group overflow-hidden rounded-xl border text-left transition-all',
                  active ? 'border-petal ring-2 ring-petal/50' : 'border-line hover:-translate-y-px hover:border-line-strong'
                )}
              >
                <Mini c={colors} glow={glow} />
                <span className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ background: colors.raised, color: colors.text }}>
                  <span className="min-w-0 flex-1 truncate text-[0.84rem] font-medium">{t.name}</span>
                  {glow && <Sparkles size={12} style={{ color: colors.petal }} aria-label="Glows" />}
                  {active && <Check size={14} style={{ color: colors.petal }} aria-hidden />}
                </span>
              </button>
            </Tip>
          )
        })}
      </div>
      {current === 'custom' && (
        <div className="flex flex-wrap items-center gap-1.5 text-[0.82rem] text-text-2">
          <span>Start from:</span>
          {THEMES.filter((t) => t.colors).map((t) => (
            <button
              key={t.id}
              onClick={() => update('ui.customTheme', { ...t.colors })}
              className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 hover:border-line-strong hover:text-text"
            >
              <span className="size-2.5 rounded-full" style={{ background: t.colors!.accent }} aria-hidden />
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A colour swatch plus its hex code, both editable. */
export function HexColorControl({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(value)
  }, [value])
  const commit = (v: string): void => {
    const t = v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`
    if (/^#[0-9a-f]{6}$/i.test(t)) {
      if (t.toLowerCase() !== value.toLowerCase()) onCommit(t.toLowerCase())
    } else setText(value)
  }
  return (
    <span className="inline-flex items-center gap-2">
      <label className="relative size-8 cursor-pointer overflow-hidden rounded-lg border border-line-strong" style={{ background: value }} title="Pick a colour">
        <input type="color" aria-label={`${label} colour picker`} value={value} onChange={(e) => onCommit(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <input
        aria-label={`${label} colour code`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="tabular w-24 rounded-lg border border-line-strong bg-raised px-2 py-1.5 font-mono text-[0.84rem] text-text focus:border-petal focus:outline-none"
      />
    </span>
  )
}
