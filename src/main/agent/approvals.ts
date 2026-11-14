import type { ApprovalRule } from '@shared/approval'
import type { ApprovalRequest } from '@shared/types'
import { Emitter, uid } from '../util'

export interface ApprovalAnswer {
  approved: boolean
  /** The person also chose "Always approve …" with this scope. */
  rule?: ApprovalRule
  /** With a denial: what the person wants instead ("use the other folder"). */
  note?: string
}

type Pending = { req: ApprovalRequest; resolve: (a: ApprovalAnswer) => void }

/**
 * The approval gate: every action that changes the PC waits here until the person clicks Approve or
 * Deny in the app, unless a rule they turned on themselves covers it ("Always approve …").
 */
class Approvals {
  private pending = new Map<string, Pending>()
  /** Chats where the person chose "Approve everything in this session". Not saved: ends when Maris closes. */
  private sessionAll = new Set<string>()
  readonly requested = new Emitter<ApprovalRequest>()
  readonly resolved = new Emitter<{ id: string; approved: boolean }>()
  readonly sessionsChanged = new Emitter<string[]>()

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>, signal: AbortSignal): Promise<ApprovalAnswer> {
    const req: ApprovalRequest = { ...input, id: uid(), createdAt: Date.now() }
    return new Promise<ApprovalAnswer>((resolve) => {
      const done = (a: ApprovalAnswer): void => {
        if (!this.pending.has(req.id)) return
        this.pending.delete(req.id)
        signal.removeEventListener('abort', onAbort)
        this.resolved.emit({ id: req.id, approved: a.approved })
        resolve(a)
      }
      const onAbort = (): void => done({ approved: false })
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(req.id, { req, resolve: done })
      this.requested.emit(req)
    })
  }

  /**
   * `rule` (or `true`, the old "always allow this command" answer) only counts with an approval; `note`,
   * what the person wants instead, only with a denial.
   */
  respond(id: string, approved: boolean, rule?: ApprovalRule | boolean, note?: unknown): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    const r: ApprovalRule | undefined = rule === true ? 'prefix' : rule === false || rule === null ? undefined : rule
    const said = !approved && typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : undefined
    p.resolve({ approved, rule: approved ? r : undefined, note: said })
    return true
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req)
  }

  denyAll(conversationId?: string): void {
    for (const p of [...this.pending.values()]) {
      if (!conversationId || p.req.conversationId === conversationId) p.resolve({ approved: false })
    }
  }

  inSession(conversationId: string): boolean {
    return this.sessionAll.has(conversationId)
  }

  sessions(): string[] {
    return [...this.sessionAll]
  }

  setSession(conversationId: string, on: boolean): string[] {
    const had = this.sessionAll.has(conversationId)
    if (on) this.sessionAll.add(conversationId)
    else this.sessionAll.delete(conversationId)
    if (had !== on) this.sessionsChanged.emit(this.sessions())
    return this.sessions()
  }

  clearSessions(): string[] {
    if (this.sessionAll.size) {
      this.sessionAll.clear()
      this.sessionsChanged.emit([])
    }
    return []
  }
}

export const approvals = new Approvals()
