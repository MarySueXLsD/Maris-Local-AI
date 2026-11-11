import { Check, ChevronDown, Cloud, Gauge, KeyRound, Mountain, Server, Settings2, Sparkles, Zap } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { priceLabel } from '@shared/pricing'
import type { ModelInfo, Tier } from '@shared/types'
import { bytes, prettyModel } from '../../lib/format'
import { useApp } from '../../store'
import { DEVICE } from '../../lib/platform'

const TIERS: { tier: Tier; label: string; icon: typeof Zap; hint: string }[] = [
  { tier: 'fast', label: 'Fast', icon: Zap, hint: 'Quick replies' },
  { tier: 'balanced', label: 'Balanced', icon: Gauge, hint: 'Everyday depth' },
  { tier: 'max', label: 'Max', icon: Mountain, hint: 'Hardest problems' }
]

/** What to call a model: a service's own name for it, or the readable form of an Ollama tag. */
export const modelLabel = (name: string | undefined, models: ModelInfo[]): string => models.find((m) => m.name === name)?.label ?? prettyModel(name)

export function ModelPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const settings = useApp((s) => s.settings)
  const models = useApp((s) => s.models)
  const status = useApp((s) => s.status)
  const loaded = new Set(status?.ollama.loaded.map((m) => m.name) ?? [])
  const setView = useApp((s) => s.setView)
  const openModels = useApp((s) => s.openModels)
  const chatModels = models.filter((m) => !m.capabilities.includes('embedding'))
  const tierNames = new Set(TIERS.map((t) => settings?.tiers[t.tier]).filter(Boolean))
  const info = models.find((m) => m.name === value)
  const current = value === 'auto' ? 'Auto' : (TIERS.find((t) => settings?.tiers[t.tier] === value)?.label ?? modelLabel(value, models))
  // One model in every role (a slow computer): the roles would be three names for the same thing.
  const oneModel = tierNames.size <= 1
  const local = chatModels.filter((m) => !m.provider && !tierNames.has(m.name))
  const services = [...new Map(chatModels.filter((m) => m.provider).map((m) => [m.provider!, m.providerName ?? m.provider!])).entries()]
  const away = Boolean(info?.provider && info.remote !== false)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="no-drag inline-flex h-8 max-w-64 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.86rem] text-text hover:bg-sunken"
          aria-label={`Model: ${current}${away ? `, at ${info?.providerName}` : ''}`}
          title={
            value === 'auto'
              ? oneModel
                ? 'Which model answers. Click to choose another one.'
                : 'Which model answers. Auto picks Fast, Balanced or Max for every message. Click to choose one yourself.'
              : away
                ? `This chat always uses ${current} at ${info?.providerName}: its messages are sent there. Click to change, or pick Auto.`
                : `This chat always uses ${current}. Click to change, or pick Auto.`
          }
        >
          {value === 'auto' ? <Sparkles size={14} className="shrink-0 text-petal" /> : away ? <Cloud size={14} className="shrink-0 text-petal" /> : <Mountain size={14} className="shrink-0 text-petal" />}
          <span className="truncate">{current}</span>
          <ChevronDown size={14} className="shrink-0 text-text-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="end" className="z-50 max-h-[min(34rem,80vh)] w-80 overflow-y-auto rounded-xl border border-line bg-raised p-1.5 shadow-float">
          <DropdownMenu.Item className="menu-item items-start" onSelect={() => onChange('auto')}>
            <Sparkles size={15} className="mt-0.5 text-petal" />
            <span className="flex-1">
              <span className="block">Auto</span>
              <span className="block text-[0.78rem] leading-snug text-text-2">
                {oneModel ? `Answers with the model set up for this ${DEVICE}.` : `Picks Fast, Balanced or Max for each message from the task and how busy your ${DEVICE} is.`}
              </span>
            </span>
            {value === 'auto' && <Check size={15} className="mt-0.5" />}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {(oneModel ? TIERS.filter((t) => t.tier === 'max' || !settings?.tiers.max) : TIERS).map(({ tier, label, icon: Icon, hint }) => {
            const name = settings?.tiers[tier]
            const m = models.find((x) => x.name === name)
            if (!name || !m) return null
            return (
              <DropdownMenu.Item key={tier} className="menu-item" onSelect={() => onChange(name)}>
                <Icon size={15} className="text-text-2" />
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {oneModel ? modelLabel(name, models) : label} {!oneModel && <span className="text-text-3">{hint}</span>}
                  </span>
                  <span className="block truncate text-[0.78rem] text-text-2">
                    {oneModel ? 'Does everything here' : modelLabel(name, models)}
                    {m.provider ? `, ${m.remote === false ? 'in' : 'at'} ${m.providerName}` : `, ${bytes(m.sizeBytes)}`}
                    {loaded.has(name) ? ', loaded' : ''}
                  </span>
                </span>
                {value === name && <Check size={15} />}
              </DropdownMenu.Item>
            )
          })}
          {local.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
          {local.map((m) => (
            <DropdownMenu.Item key={m.name} className="menu-item" onSelect={() => onChange(m.name)}>
              <span className="min-w-0 flex-1 truncate">
                {prettyModel(m.name)} <span className="text-text-3">{bytes(m.sizeBytes)}</span>
              </span>
              {value === m.name && <Check size={15} />}
            </DropdownMenu.Item>
          ))}
          {services.map(([id, name]) => {
            const theirs = chatModels.filter((m) => m.provider === id && !tierNames.has(m.name))
            if (!theirs.length) return null
            const here = theirs[0]!.remote === false
            return (
              <div key={id}>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Label className="flex items-center gap-1.5 px-2 py-1 text-[0.75rem] text-text-3">
                  {here ? <Server size={12} aria-hidden /> : <Cloud size={12} aria-hidden />}
                  {name}
                  <span className="ml-auto">{here ? 'on this computer' : 'chats are sent there'}</span>
                </DropdownMenu.Label>
                {theirs.map((m) => (
                  <DropdownMenu.Item key={m.name} className="menu-item" onSelect={() => onChange(m.name)}>
                    <span className="min-w-0 flex-1 truncate">{m.label ?? prettyModel(m.name)}</span>
                    {m.price && (
                      <span className="tabular shrink-0 text-[0.74rem] text-text-3" title="Dollars per million tokens read / written">
                        {priceLabel(m.price)}
                      </span>
                    )}
                    {value === m.name && <Check size={15} />}
                  </DropdownMenu.Item>
                ))}
              </div>
            )
          })}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className="menu-item text-text-2" onSelect={() => setView('models')}>
            <Settings2 size={15} /> Manage models
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item text-text-2" onSelect={() => openModels('api')}>
            <KeyRound size={15} /> {services.length ? 'Manage API models' : 'Add Claude, GPT or another API model'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
