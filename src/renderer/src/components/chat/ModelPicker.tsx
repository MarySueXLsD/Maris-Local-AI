import { Check, ChevronDown, Gauge, Mountain, Settings2, Sparkles, Zap } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { Tier } from '@shared/types'
import { bytes, prettyModel } from '../../lib/format'
import { useApp } from '../../store'
import { DEVICE } from '../../lib/platform'

const TIERS: { tier: Tier; label: string; icon: typeof Zap; hint: string }[] = [
  { tier: 'fast', label: 'Fast', icon: Zap, hint: 'Quick replies' },
  { tier: 'balanced', label: 'Balanced', icon: Gauge, hint: 'Everyday depth' },
  { tier: 'max', label: 'Max', icon: Mountain, hint: 'Hardest problems' }
]

export function ModelPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const settings = useApp((s) => s.settings)
  const models = useApp((s) => s.models)
  const status = useApp((s) => s.status)
  const loaded = new Set(status?.ollama.loaded.map((m) => m.name) ?? [])
  const setView = useApp((s) => s.setView)
  const chatModels = models.filter((m) => !m.capabilities.includes('embedding'))
  const tierNames = new Set(TIERS.map((t) => settings?.tiers[t.tier]).filter(Boolean))
  const current = value === 'auto' ? 'Auto' : (TIERS.find((t) => settings?.tiers[t.tier] === value)?.label ?? prettyModel(value))
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="no-drag inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.86rem] text-text hover:bg-sunken"
          aria-label={`Model: ${current}`}
          title={value === 'auto' ? 'Which model answers. Auto picks Fast, Balanced or Max for every message. Click to choose one yourself.' : `This chat always uses ${current}. Click to change, or pick Auto.`}
        >
          {value === 'auto' ? <Sparkles size={14} className="text-petal" /> : <Mountain size={14} className="text-petal" />}
          <span>{current}</span>
          <ChevronDown size={14} className="text-text-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="end" className="z-50 w-80 rounded-xl border border-line bg-raised p-1.5 shadow-float">
          <DropdownMenu.Item className="menu-item items-start" onSelect={() => onChange('auto')}>
            <Sparkles size={15} className="mt-0.5 text-petal" />
            <span className="flex-1">
              <span className="block">Auto</span>
              <span className="block text-[0.78rem] leading-snug text-text-2">
                Picks Fast, Balanced or Max for each message from the task and how busy your {DEVICE} is.
              </span>
            </span>
            {value === 'auto' && <Check size={15} className="mt-0.5" />}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {TIERS.map(({ tier, label, icon: Icon, hint }) => {
            const name = settings?.tiers[tier]
            const info = models.find((m) => m.name === name)
            if (!name) return null
            return (
              <DropdownMenu.Item key={tier} className="menu-item" onSelect={() => onChange(name)}>
                <Icon size={15} className="text-text-2" />
                <span className="flex-1">
                  <span className="block">
                    {label} <span className="text-text-3">{hint}</span>
                  </span>
                  <span className="block text-[0.78rem] text-text-2">
                    {prettyModel(name)}
                    {info ? `, ${bytes(info.sizeBytes)}` : ''}
                    {loaded.has(name) ? ', loaded' : ''}
                  </span>
                </span>
                {value === name && <Check size={15} />}
              </DropdownMenu.Item>
            )
          })}
          {chatModels.some((m) => !tierNames.has(m.name)) && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
          {chatModels
            .filter((m) => !tierNames.has(m.name))
            .map((m) => (
              <DropdownMenu.Item key={m.name} className="menu-item" onSelect={() => onChange(m.name)}>
                <span className="flex-1">
                  {prettyModel(m.name)} <span className="text-text-3">{bytes(m.sizeBytes)}</span>
                </span>
                {value === m.name && <Check size={15} />}
              </DropdownMenu.Item>
            ))}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className="menu-item text-text-2" onSelect={() => setView('models')}>
            <Settings2 size={15} /> Manage models
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
