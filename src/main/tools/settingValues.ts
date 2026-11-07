// Checks and display for Maris's own settings as the assistant changes them (see ./settings.ts).
// No runtime imports, so tests/assistant.test.ts can check them.
import type { SettingDef } from '../../renderer/src/views/settings/schema'
/** A value the setting does not take; the message goes back to the model. */
export class ToolError extends Error {}

/** Why the assistant may not change this setting, or undefined when it may (with approval). */
export function lockedReason(d: Pick<SettingDef, 'path' | 'type' | 'section'>): string | undefined {
  if (d.type === 'secret') return 'keys and tokens are only entered on the Settings page'
  if (d.path.startsWith('agent.autoApprove') || d.path === 'agent.autoRunReadOnlyCommands') return 'what Maris may do without asking is only changed by you, on the Settings page'
  if (d.path === 'agent.fullControl') return 'full control is only turned on by you: on the Settings page, or with the button Maris shows in the chat (request_full_control)'
  if (d.section === 'phone') return 'the phone link is only changed on the Settings page'
  if (d.path === 'updates.repo' || d.path === 'updates.admin') return 'where updates come from is only changed on the Settings page'
  return undefined
}

const TRUE = /^(true|on|yes|1|enable|enabled)$/i
const FALSE = /^(false|off|no|0|disable|disabled)$/i

/** The value to store for `raw`, checked against the setting's type, choices and range. Throws ToolError. */
export function coerceSetting(d: SettingDef, raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw.trim() : raw
  switch (d.type) {
    case 'switch':
      if (typeof text === 'boolean') return text
      if (TRUE.test(String(text))) return true
      if (FALSE.test(String(text))) return false
      throw new ToolError(`${d.label} is on or off; got "${String(raw)}"`)
    case 'select':
    case 'segmented': {
      const opts = d.options ?? []
      const hit = opts.find((o) => String(o.value).toLowerCase() === String(text).toLowerCase()) ?? opts.find((o) => o.label.toLowerCase() === String(text).toLowerCase())
      if (hit) return hit.value
      if (!opts.length && typeof text === 'string' && text) return text
      throw new ToolError(`${d.label} must be one of: ${opts.map((o) => `${String(o.value)} (${o.label})`).join(', ')}`)
    }
    case 'slider':
    case 'number': {
      let n = typeof text === 'number' ? text : Number(String(text).replace(/[%\s]|GB|MB|s$|h$/gi, ''))
      if (!Number.isFinite(n)) throw new ToolError(`${d.label} is a number; got "${String(raw)}"`)
      // "70%" for a setting stored as 0.7.
      if (d.format === 'percent' && d.max !== undefined && d.max <= 1 && n > 1) n = n / 100
      if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) throw new ToolError(`${d.label} goes from ${d.min ?? '…'} to ${d.max ?? '…'}${d.unit ? ` ${d.unit}` : ''}; got ${n}`)
      return n
    }
    case 'hexcolor':
      if (/^#[0-9a-f]{6}$/i.test(String(text))) return String(text).toLowerCase()
      throw new ToolError(`${d.label} is a colour like #7c5cff; got "${String(raw)}"`)
    default:
      if (typeof text !== 'string') throw new ToolError(`${d.label} is text; got ${JSON.stringify(raw)}`)
      return text
  }
}

/** How a stored value reads to a person: an option's label, on/off, or the number with its unit. */
export function showSetting(d: SettingDef, v: unknown): string {
  if (v === undefined || v === null || v === '') return d.emptyLabel ?? '(not set)'
  if (d.type === 'switch') return v ? 'on' : 'off'
  const opt = d.options?.find((o) => o.value === v)
  if (opt) return opt.label
  if (typeof v === 'number' && d.format === 'percent') return `${Math.round(v * 100)}%`
  return `${typeof v === 'object' ? JSON.stringify(v) : String(v)}${d.unit ? ` ${d.unit}` : ''}`
}

