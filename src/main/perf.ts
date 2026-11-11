// Low-power mode: what Maris does differently on a slow computer (an old processor, little memory,
// no graphics card that can run language models). Settings → Engine → Low-power mode turns it on, off,
// or leaves it to Maris ("Auto": on where the hardware scan says it helps).
//
// What it changes:
//   - instructions are a short version, and only the tools a request needs are described
//   - no extra model calls: chat titles come from the message, routing does not ask a helper model
//   - the window follows the small context windows setup chose, instead of growing to fit everything
//   - the interface drops blur, glow and animations, and the status bar samples less often
// Models that run at an API service are not held back by any of this: they get the full instructions.
import os from 'node:os'
import type { Settings } from '@shared/types'
import { repo } from './db'
import { settings } from './settings'

let scanned: boolean | undefined
let read = false

/** Remember what the hardware scan found (kept across restarts, so start-up needs no scan). */
export function rememberLitePc(lite: boolean): void {
  scanned = lite
  read = true
  try {
    repo.setKv('pc-lite', lite)
  } catch {
    /* the database is not open in unit tests */
  }
}

function scannedLite(): boolean | undefined {
  if (!read) {
    read = true
    try {
      scanned = repo.getKv<boolean>('pc-lite')
    } catch {
      scanned = undefined
    }
  }
  return scanned
}

/** True when low-power mode is in effect. */
export function isLite(cfg: Settings = settings.get()): boolean {
  if (cfg.engine.profile === 'lite') return true
  if (cfg.engine.profile === 'standard') return false
  const known = scannedLite()
  if (known !== undefined) return known
  // Never scanned (setup was skipped): judge from what Node can see.
  return cfg.engine.processing === 'cpu' && (os.totalmem() < 12 * 2 ** 30 || os.cpus().length <= 4)
}
