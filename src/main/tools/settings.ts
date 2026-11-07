// Maris's own settings, for the assistant: read them freely, change them only after the person approves.
// A change is never covered by "Always approve" (see ALWAYS_ASK in @shared/approval), and the settings
// that decide what Maris may do on its own, the phone link, where updates come from and keys stay on the
// Settings page. Labels, choices and ranges come from the same schema the Settings page renders.
import '../hostPlatform'
import { getPath, patchFor } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { SECTIONS, SETTINGS_SCHEMA, type SettingDef } from '../../renderer/src/views/settings/schema'
import { settings } from '../settings'
import { coerceSetting, lockedReason, showSetting } from './settingValues'
import { schema, str, ToolError, type Args, type ToolDef } from './types'

const sectionTitle = (id: string): string => SECTIONS.find((s) => s.id === id)?.title ?? id

function findSetting(key: string): SettingDef {
  const k = key.trim()
  const d =
    SETTINGS_SCHEMA.find((x) => x.path === k) ??
    SETTINGS_SCHEMA.find((x) => x.path.toLowerCase() === k.toLowerCase()) ??
    SETTINGS_SCHEMA.find((x) => x.label.toLowerCase() === k.toLowerCase())
  if (!d) throw new ToolError(`There is no setting "${key}". Look it up with maris_settings first and pass its path (like ui.theme).`)
  return d
}

interface Change {
  def: SettingDef
  value: unknown
  before: unknown
}

/** The requested changes, checked. Accepts {changes:[{path,value}]} or a single {path,value}. */
function readChanges(args: Args, current: Settings): Change[] {
  const list = Array.isArray(args.changes) ? args.changes : args.path !== undefined ? [{ path: args.path, value: args.value }] : []
  if (!list.length) throw new ToolError('Say which setting to change: changes: [{ path, value }]')
  return list.map((c) => {
    const item = (c ?? {}) as { path?: unknown; value?: unknown }
    const def = findSetting(str(item.path, 'path'))
    const locked = lockedReason(def)
    if (locked) throw new ToolError(`"${def.label}" cannot be changed from the chat: ${locked}.`)
    return { def, value: coerceSetting(def, item.value), before: getPath(current, def.path) }
  })
}

const line = (d: SettingDef, v: unknown): string => {
  const choices = d.options?.length ? `; choices: ${d.options.map((o) => `${String(o.value)}${String(o.value) !== o.label ? ` (${o.label})` : ''}`).join(', ')}` : ''
  const range = d.type === 'number' || d.type === 'slider' ? `; ${d.min ?? '…'} to ${d.max ?? '…'}${d.unit ? ` ${d.unit}` : ''}` : ''
  const locked = lockedReason(d) ? '; only on the Settings page' : ''
  return `- ${d.path} — ${d.label}: ${d.type === 'secret' ? (v ? '(set)' : '(not set)') : showSetting(d, v)} [${d.type}${choices}${range}${locked}]${d.hint ? ` ${d.hint}` : ''}`
}

export const settingsTools: ToolDef[] = [
  {
    name: 'maris_settings',
    risk: 'read',
    description:
      "Read Maris's own settings (appearance and theme, answer style, models, context windows, engine, memory, web, pictures and video, status bar, window and startup, updates). Returns each setting's path, current value and allowed values. Pass search to narrow it down.",
    parameters: schema({ search: { type: 'string', description: 'Words to look for, e.g. "theme", "text size", "context"' } }),
    async prepare(args) {
      return { risk: 'read', title: args.search ? `Look up Maris settings: ${String(args.search)}` : 'Look up Maris settings' }
    },
    async run(args) {
      const current = settings.get()
      const words = String(args.search ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      const hits = SETTINGS_SCHEMA.filter((d) => {
        if (!words.length) return true
        const hay = `${d.path} ${d.label} ${d.hint ?? ''} ${d.keywords ?? ''} ${d.group ?? ''} ${sectionTitle(d.section)}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      if (!hits.length) return `No setting matches "${String(args.search)}". Try fewer or other words, or call maris_settings without search for the full list.`
      const out: string[] = []
      for (const s of SECTIONS) {
        const inSection = hits.filter((d) => d.section === s.id)
        if (inSection.length) out.push(`## ${s.title}`, ...inSection.map((d) => line(d, getPath(current, d.path))))
      }
      return `${out.join('\n')}\n\nChange one with change_maris_settings (the user approves every change).`
    }
  },
  {
    name: 'change_maris_settings',
    risk: 'change',
    description:
      "Change Maris's own settings, for example the theme, text size, answer style or a context window. Look the setting up with maris_settings first and pass its path and the new value. The user always approves the change first, even when they approve other things automatically.",
    parameters: schema(
      {
        changes: {
          type: 'array',
          description: 'The settings to change',
          items: { type: 'object', properties: { path: { type: 'string', description: 'Setting path, e.g. ui.theme' }, value: { type: 'string', description: 'New value' } }, required: ['path', 'value'] }
        }
      },
      ['changes']
    ),
    async prepare(args) {
      const changes = readChanges(args, settings.get())
      const items = changes.map((c) => `${c.def.label} (${sectionTitle(c.def.section)}): ${showSetting(c.def, c.before)} → ${showSetting(c.def, c.value)}`)
      return {
        risk: 'change',
        title: changes.length === 1 ? `Change Maris setting: ${items[0]}` : `Change ${changes.length} Maris settings`,
        detail: 'Maris asks every time before it changes its own settings.',
        preview: { kind: 'list', items }
      }
    },
    async run(args) {
      const changes = readChanges(args, settings.get())
      let patch: Record<string, unknown> = {}
      for (const c of changes) patch = mergePatch(patch, patchFor(c.def.path, c.value))
      settings.update(patch as Parameters<typeof settings.update>[0])
      return `Changed: ${changes.map((c) => `${c.def.label} is now ${showSetting(c.def, c.value)}`).join('; ')}.`
    }
  }
]

function mergePatch(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] = prev && typeof prev === 'object' && v && typeof v === 'object' && !Array.isArray(v) ? mergePatch(prev as Record<string, unknown>, v as Record<string, unknown>) : v
  }
  return out
}
