import type { DeepPartial, Settings } from '@shared/types'
import { DEFAULT_SETTINGS, deepMerge } from '@shared/defaults'
import { repo } from './db'
import { suggestDataDir } from './paths'
import { Emitter } from './util'

export { DEFAULT_SETTINGS, deepMerge }

/** Keys that describe this PC rather than preferences; kept when settings are reset or imported. */
const MACHINE_KEYS = ['dataDir', 'tiers', 'onboarded'] as const

class SettingsService {
  private current: Settings = DEFAULT_SETTINGS
  readonly changed = new Emitter<Settings>()

  load(): Settings {
    const stored = repo.getKv<Partial<Settings>>('settings')
    this.current = deepMerge(DEFAULT_SETTINGS, stored ?? {})
    // One-time changes to saved settings whose default changed (a value nobody chose stays in step).
    const done = new Set(repo.getKv<string[]>('settings-migrations') ?? [])
    if (!done.has('steps-unlimited')) {
      // The old default of 20 steps cut long tasks short; no limit is the default now.
      if (stored && this.current.agent.maxSteps === 20) this.current.agent.maxSteps = 0
      done.add('steps-unlimited')
      repo.setKv('settings-migrations', [...done])
      if (stored) repo.setKv('settings', this.current)
    }
    if (!done.has('context-32k')) {
      // 16K windows were the old default and filled up before a coding task got going; 32K is the default now.
      const t = this.current.routing.contextByTier
      if (stored) for (const k of ['fast', 'balanced', 'max'] as const) if (t[k] === 16384) t[k] = 32768
      if (stored && this.current.routing.codeContext < 32768) this.current.routing.codeContext = 32768
      done.add('context-32k')
      repo.setKv('settings-migrations', [...done])
      if (stored) repo.setKv('settings', this.current)
    }
    if (!this.current.dataDir) {
      this.current.dataDir = suggestDataDir()
      repo.setKv('settings', this.current)
    }
    return this.current
  }

  get(): Settings {
    return this.current
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.current = deepMerge(this.current, patch)
    repo.setKv('settings', this.current)
    this.changed.emit(this.current)
    return this.current
  }

  /** Replace whole sub-objects (used where merging would keep stale keys, e.g. media roles). */
  replace(next: Settings): Settings {
    this.current = next
    repo.setKv('settings', this.current)
    this.changed.emit(this.current)
    return this.current
  }

  /** Back to factory settings, keeping what was set up for this PC (models, data folder). */
  reset(section?: keyof Settings): Settings {
    if (section) {
      return this.replace({ ...this.current, [section]: structuredClone(DEFAULT_SETTINGS[section]) })
    }
    const keep = Object.fromEntries(MACHINE_KEYS.map((k) => [k, this.current[k]]))
    return this.replace(deepMerge(structuredClone(DEFAULT_SETTINGS), keep))
  }

  /** Settings as JSON for a backup file (secrets such as API keys are left out). */
  exportJson(): string {
    const copy = structuredClone(this.current)
    delete copy.web.braveKey
    return JSON.stringify({ app: 'Maris', version: 1, settings: copy }, null, 2)
  }

  importJson(text: string): Settings {
    const parsed = JSON.parse(text) as { app?: string; settings?: Partial<Settings> }
    if (parsed.app !== 'Maris' || !parsed.settings || typeof parsed.settings !== 'object') {
      throw new Error('This file is not a Maris settings backup.')
    }
    const keep = Object.fromEntries(MACHINE_KEYS.map((k) => [k, this.current[k]]))
    return this.replace(deepMerge(deepMerge(structuredClone(DEFAULT_SETTINGS), parsed.settings), keep))
  }
}

export const settings = new SettingsService()
