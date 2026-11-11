// One chat between the terminal and Maris: sends messages, streams answers, shows steps in plain words
// and asks for approvals with a single key.
import { randomUUID } from 'node:crypto'
import type { Attachment, ApprovalRequest, ChatEvent, ChatMessage, MediaJob, Part, RouteDecision, ThinkMode, ToolCallRecord } from '@shared/types'
import { approvalKind, kindLabel } from '@shared/approval'
import { usd } from '@shared/pricing'
import { describeCall, imperative } from '../renderer/src/components/chat/describe'
import { duration, prettyModel } from '../renderer/src/lib/format'
import type { Rpc } from './connect'
import { Prose } from './prose'
import { fit, type Paint, readKey, StatusLine } from './term'

export interface Io {
  /** Where the answer goes (stdout). */
  out: NodeJS.WriteStream
  outPaint: Paint
  /** Where steps, status and questions go: the terminal (stdout, or stderr when stdout is piped). */
  ui: NodeJS.WriteStream
  paint: Paint
  /** The keyboard is available for approvals and Ctrl+C. */
  interactive: boolean
  showThinking: boolean
  /** Left margin for everything Maris prints in a terminal. */
  margin: string
}

export type AskResult = 'done' | 'stopped' | 'error'

const TRASH = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'

export class Session {
  conversationId?: string
  mode: 'chat' | 'code' = 'chat'
  projectDir?: string
  model = 'auto'
  think: ThinkMode = 'auto'
  web = true
  lastAnswer = ''
  lastModel = ''
  private subscribed = false

  constructor(
    private rpc: Rpc,
    private io: Io
  ) {}

  /** Send one message and show the answer until it is finished. */
  async ask(text: string, attachments: Attachment[] = []): Promise<AskResult> {
    const { io, rpc } = this
    const p = io.paint
    const s = p.sym
    const m = io.margin
    if (!this.subscribed) {
      rpc.subscribe(['chat:event', 'media:job'])
      this.subscribed = true
    }
    const status = new StatusLine(io.ui, p, m)
    const sameStream = io.ui === io.out
    const prose = new Prose((x) => io.out.write(x), io.outPaint.prose(), () => (io.out.isTTY ? io.out.columns || 100 : Infinity), io.out.isTTY ? m : '')
    let thinking: Prose | undefined
    let assistantId: string | undefined
    let route: RouteDecision | undefined
    let textChars = 0
    let textPart: number | undefined
    let lastPrinted: 'none' | 'text' | 'steps' = 'none'
    let answer = ''
    const tools = new Map<string, ToolCallRecord>()
    const finished = new Set<string>()
    const explore: ToolCallRecord[] = []
    const approvalQueue: ApprovalRequest[] = []
    /** Approvals answered in this terminal (their "resolved" event is not news here). */
    const answered = new Set<string>()
    /** Approvals this terminal showed but could not ask about (not interactive): answered in the window. */
    const waitingElsewhere = new Set<string>()
    let approving: { id: string; cancel: () => void } | undefined
    let stopRequested = false

    // ---- printing helpers
    const endText = (): void => {
      if (lastPrinted === 'text') prose.end()
    }
    const line = (str: string): void => {
      if (lastPrinted === 'text') {
        prose.end()
        if (sameStream) io.ui.write('\n')
      }
      status.print(str)
      lastPrinted = 'steps'
    }
    const flushExplore = (): void => {
      if (!explore.length) return
      const calls = explore.splice(0)
      const reads = calls.filter((c) => c.name === 'read_file').length
      const searches = calls.filter((c) => /grep|search/.test(c.name)).length
      const bits = [reads && `read ${reads} file${reads > 1 ? 's' : ''}`, searches && `searched ${searches} time${searches > 1 ? 's' : ''}`].filter(Boolean).join(', ')
      if (calls.length === 1) {
        const d = describeCall(calls[0])
        line(`${m}${p.ok(s.ok)} ${d.done}${d.outcome ? p.dim(` — ${d.outcome}`) : ''}`)
      } else {
        line(`${m}${p.ok(s.ok)} ${this.mode === 'code' ? 'Looked through the project' : 'Looked around'}${bits ? p.dim(` (${bits})`) : ''}`)
      }
    }
    const showStatus = (t: string, reset = true): void => {
      if (lastPrinted === 'text' && sameStream) return
      status.set(t, reset)
    }

    const toolFinished = (c: ToolCallRecord): void => {
      const d = describeCall(c)
      if (c.status === 'done' && d.kind === 'explore') {
        explore.push(c)
        showStatus(this.mode === 'code' ? 'Looking through the project…' : 'Looking around…')
        return
      }
      flushExplore()
      if (c.status === 'denied') return line(`${m}${p.dim(`${s.no} You said no: ${imperative(d.running)}`)}`)
      if (c.status === 'error' || d.ok === false) {
        const why = (c.error ?? '').split('\n')[0]
        return line(`${m}${p.bad(s.bad)} ${c.status === 'error' ? `Could not ${imperative(d.running)}` : d.done}${why ? p.dim(` — ${fit(why, 90)}`) : d.outcome ? p.dim(` — ${d.outcome}`) : ''}`)
      }
      if (c.name === 'update_plan') return printPlan(c)
      line(`${m}${p.ok(s.ok)} ${d.done}${d.outcome ? p.dim(` — ${d.outcome}`) : ''}${c.autoApproved ? p.dim(` (${c.autoApproved.replace(/\.$/, '').toLowerCase()})`) : ''}`)
    }

    const printPlan = (c: ToolCallRecord): void => {
      const steps = Array.isArray(c.args.steps) ? (c.args.steps as { step?: string; text?: string; status?: string }[]) : []
      if (!steps.length) return
      const done = steps.filter((x) => x.status === 'done' || x.status === 'completed').length
      line(`${m}${p.accent(s.mark)} ${p.bold('Plan')} ${p.dim(`${done} of ${steps.length} done`)}`)
      for (const st of steps) {
        const label = st.step ?? st.text ?? ''
        const mark = st.status === 'done' || st.status === 'completed' ? p.ok(s.ok) : st.status === 'in_progress' ? p.accent(s.arrow) : p.dim(s.dot)
        line(`${m}  ${mark} ${st.status === 'done' || st.status === 'completed' ? p.dim(label) : label}`)
      }
    }

    // ---- approvals
    const askApproval = async (req: ApprovalRequest): Promise<void> => {
      status.stop()
      flushExplore()
      endText()
      const call = tools.get(req.toolCallId)
      const d = call ? describeCall(call) : undefined
      const friendly = d && d.kind !== 'other' ? imperative(d.running) : req.title.charAt(0).toLowerCase() + req.title.slice(1)
      const out = (x: string): void => {
        io.ui.write(`${x}\n`)
      }
      if (lastPrinted !== 'none') out('')
      out(`${m}${p.gold(p.bold(`${s.warn} Maris wants to ${req.tool.startsWith('mcp_') ? `use ${req.title}` : friendly}`))}`)
      const pv = req.preview
      if (pv?.kind === 'command') {
        out(`${m}  ${p.code(fit(pv.command, (io.ui.columns || 100) - m.length - 4))}`)
        if (pv.cwd) out(`${m}  ${p.dim(`in ${pv.cwd}`)}`)
      } else if (pv?.kind === 'diff') {
        out(`${m}  ${pv.isNew ? 'Create' : 'Change'} ${pv.path} ${p.ok(`+${pv.additions}`)} ${p.bad(`-${pv.deletions}`)}`)
      } else if (pv?.kind === 'list') {
        for (const it of pv.items.slice(0, 6)) out(`${m}  ${p.dim(s.dot)} ${it}`)
        if (pv.items.length > 6) out(`${m}  ${p.dim(`and ${pv.items.length - 6} more`)}`)
      } else if (pv?.kind === 'text') {
        for (const l of pv.text.split('\n').slice(0, 4)) out(`${m}  ${p.dim(fit(l, 100))}`)
      }
      if (req.detail && req.tool !== 'run_command') out(`${m}  ${p.dim(req.detail)}`)
      if (req.install?.summary) out(`${m}  ${p.gold(req.install.summary)}`)
      if (!io.interactive) {
        out(`${m}  ${p.dim('Approve or deny it in the Maris window (this terminal is not interactive).')}`)
        lastPrinted = 'steps'
        waitingElsewhere.add(req.id)
        return
      }
      const kind = approvalKind(req.tool, req.risk)
      const keys = [
        `${p.bold('y')} allow`,
        `${p.bold('n')} deny`,
        ...(kind ? [`${p.bold('a')} always allow ${kindLabel(kind, TRASH)}`] : []),
        `${p.bold('s')} allow all in this chat`,
        ...(pv?.kind === 'diff' || (pv?.kind === 'list' && pv.items.length > 6) || req.detail ? [`${p.bold('d')} details`] : [])
      ]
      out(`${m}  ${keys.join(p.dim('   '))}`)
      lastPrinted = 'steps'
      for (;;) {
        const ctrl = new AbortController()
        approving = { id: req.id, cancel: () => ctrl.abort() }
        const key = await readKey(['y', 'n', 'a', 's', 'd', 'enter', 'escape', 'ctrl-c'], ctrl.signal)
        // Answered in the Maris window meanwhile.
        if (key === 'aborted') return
        if (key === 'd') {
          if (pv?.kind === 'diff') {
            for (const l of pv.diff.split('\n').slice(0, 120)) out(`${m}  ${l.startsWith('+') ? p.ok(l) : l.startsWith('-') ? p.bad(l) : l.startsWith('@@') ? p.accent(l) : p.dim(l)}`)
          } else if (pv?.kind === 'list') {
            for (const it of pv.items) out(`${m}  ${p.dim(s.dot)} ${it}`)
          } else if (req.detail) out(`${m}  ${req.detail}`)
          continue
        }
        if (key === 'a' && !kind) continue
        const approved = key === 'y' || key === 'a' || key === 's'
        const rule = key === 'a' ? 'kind' : key === 's' ? 'session' : undefined
        finished.add(req.id)
        answered.add(req.id)
        if (key === 'ctrl-c') {
          stopRequested = true
          await rpc.call('chat:stop', this.conversationId).catch(() => undefined)
        } else await rpc.call('chat:approve', req.id, approved, rule).catch((e: Error) => out(`${m}${p.bad(e.message)}`))
        // The step may already show its spinner: print above it.
        status.print(`${m}  ${approved ? p.ok(`${s.ok} Allowed`) : p.dim(`${s.no} Denied`)}${rule === 'kind' && kind ? p.dim(` — from now on Maris won't ask about ${kindLabel(kind, TRASH)}`) : rule === 'session' ? p.dim(' — for the rest of this chat') : ''}`)
        return
      }
    }
    const pumpApprovals = async (): Promise<void> => {
      if (approving) return
      const next = approvalQueue.shift()
      if (!next) return
      approving = { id: next.id, cancel: () => undefined }
      await askApproval(next)
      approving = undefined
      void pumpApprovals()
    }

    // ---- events
    let resolveDone: (r: AskResult) => void = () => undefined
    const done = new Promise<AskResult>((r) => (resolveDone = r))
    const mine = (id?: string): boolean => Boolean(id) && id === this.conversationId

    const onChat = (e: ChatEvent): void => {
      switch (e.type) {
        case 'message': {
          const msg: ChatMessage = e.message
          if (!mine(msg.conversationId) || msg.role !== 'assistant') return
          assistantId ??= msg.id
          if (msg.route) route = msg.route
          return
        }
        case 'route':
          if (!mine(e.conversationId)) return
          assistantId ??= e.messageId
          route = e.route
          showStatus(waitingText(route))
          return
        case 'delta': {
          if (!mine(e.conversationId) || e.messageId !== assistantId) return
          if (e.kind === 'thinking') {
            if (io.showThinking) {
              status.stop()
              if (!thinking) {
                if (lastPrinted !== 'none') io.ui.write('\n')
                thinking = new Prose((x) => io.ui.write(p.dim(x)), { ...p.prose(), bold: (x) => x, accent: (x) => x, code: (x) => x }, () => io.ui.columns || 100, `${m}${s.bar} `)
              }
              thinking.push(e.text)
            } else showStatus('Thinking…', false)
            return
          }
          if (thinking) {
            thinking.end()
            thinking = undefined
            io.ui.write('\n')
          }
          status.stop()
          flushExplore()
          if (lastPrinted === 'steps' && io.out.isTTY) io.out.write('\n')
          // A new text part (after thinking, say) starts a new paragraph.
          if (lastPrinted === 'text' && textPart !== undefined && textPart !== e.partIndex) {
            prose.end()
            io.out.write('\n')
          }
          textPart = e.partIndex
          lastPrinted = 'text'
          textChars += e.text.length
          answer += e.text
          prose.push(e.text)
          return
        }
        case 'part': {
          if (!mine(e.conversationId) || e.messageId !== assistantId) return
          const part: Part = e.part
          if (part.type === 'tool') {
            const c = part.call
            tools.set(c.id, c)
            if (c.status === 'running' || c.status === 'pending') {
              const d = describeCall(c)
              const media = c.media
              const progress = media
                ? `${d.running.replace(/…$/, '')} with ${media.model}${media.progress ? ` · ${Math.round(media.progress * 100)}%` : ''}${media.etaSec ? ` · about ${fmtSecs(media.etaSec)} left` : ''}`
                : c.progress
                  ? `${d.running.replace(/…$/, '')} · ${c.progress}`
                  : d.running
              if (d.kind !== 'explore') flushExplore()
              showStatus(progress, !media)
            } else if ((c.status === 'done' || c.status === 'error' || c.status === 'denied') && !finished.has(c.id)) {
              finished.add(c.id)
              status.stop()
              toolFinished(c)
            }
          } else if (part.type === 'media') {
            flushExplore()
            line(`${m}${p.accent(s.mark)} ${part.media.kind === 'video' ? 'Video' : 'Picture'} saved: ${p.file(part.media.path)}`)
          } else if (part.type === 'notice') {
            flushExplore()
            line(`${m}${part.tone === 'warn' ? p.gold(`${s.warn} ${part.text}`) : p.dim(part.text)}`)
          } else if (part.type === 'text' && part.text === '' && textChars > 0) {
            // The model's process restarted this step: what was printed so far is being written again.
            textChars = 0
            answer = ''
          }
          return
        }
        case 'approval':
          if (!mine(e.request.conversationId) || finished.has(e.request.id)) return
          approvalQueue.push(e.request)
          void pumpApprovals()
          return
        case 'approval-resolved': {
          finished.add(e.id)
          const queued = approvalQueue.findIndex((a) => a.id === e.id)
          if (queued >= 0) approvalQueue.splice(queued, 1)
          if ((approving?.id === e.id || waitingElsewhere.has(e.id)) && !answered.has(e.id)) {
            if (approving?.id === e.id) approving.cancel()
            waitingElsewhere.delete(e.id)
            status.print(`${m}  ${e.approved ? p.ok(`${s.ok} Allowed in the Maris window`) : p.dim(`${s.no} Denied in the Maris window`)}`)
          }
          return
        }
        case 'status': {
          if (!mine(e.conversationId) || e.messageId !== assistantId) return
          if (e.status !== 'done' && e.status !== 'error' && e.status !== 'stopped') return
          status.stop()
          flushExplore()
          if (thinking) {
            thinking.end()
            thinking = undefined
          }
          if (lastPrinted === 'text') prose.end()
          this.lastAnswer = answer
          this.lastModel = e.model ?? route?.model ?? ''
          if (e.status === 'error') {
            io.ui.write(`${m}${p.bad(`${s.bad} ${e.error ?? 'The answer stopped with an error.'}`)}\n`)
            return resolveDone('error')
          }
          if (e.status === 'stopped') {
            io.ui.write(`${m}${p.dim('Stopped.')}\n`)
            return resolveDone('stopped')
          }
          if (io.ui.isTTY) {
            const bits = [prettyModel(this.lastModel), e.stats?.durationMs ? duration(e.stats.durationMs) : '', e.stats?.tokensPerSec ? `${e.stats.tokensPerSec} tok/s` : '', e.stats?.costUsd !== undefined ? `${e.stats.costPartial ? 'over ' : ''}${usd(e.stats.costUsd)}` : '']
            io.ui.write(`${p.dim(`${m}${bits.filter(Boolean).join(` ${s.dot} `)}`)}\n`)
          }
          return resolveDone('done')
        }
      }
    }
    const onJob = (j: MediaJob): void => {
      // Media progress also arrives on the tool card; this keeps the status line moving between updates.
      void j
    }
    const onClosed = (): void => {
      status.stop()
      io.ui.write(`${m}${p.bad('Maris closed.')}\n`)
      resolveDone('error')
    }
    rpc.on('chat:event', onChat)
    rpc.on('media:job', onJob)
    rpc.once('closed', onClosed)

    // ---- keyboard: Ctrl+C or Esc stops the answer
    const stdin = process.stdin
    const onKey = (buf: Buffer): void => {
      if (approving) return
      const k = buf.toString()
      if ((k === '\x03' || k === '\x1b') && !stopRequested) {
        stopRequested = true
        status.set('Stopping…')
        void rpc.call('chat:stop', this.conversationId).catch(() => undefined)
      }
    }
    if (io.interactive) {
      stdin.setRawMode?.(true)
      stdin.resume()
      stdin.on('data', onKey)
    }

    try {
      showStatus(this.model === 'auto' ? 'Choosing a model…' : `Waiting for ${prettyModel(this.model)}…`)
      // Name a new chat here: its first events can arrive before chat:send returns.
      this.conversationId ??= randomUUID()
      const sent = await rpc.call<{ conversationId: string; messageId: string }>('chat:send', {
        conversationId: this.conversationId,
        text,
        attachments,
        model: this.model,
        think: this.think,
        webAccess: this.web,
        mode: this.mode,
        projectDir: this.mode === 'code' ? this.projectDir : undefined,
        origin: 'terminal'
      })
      this.conversationId = sent.conversationId
      return await done
    } catch (e) {
      status.stop()
      io.ui.write(`${m}${p.bad(`${s.bad} ${(e as Error).message}`)}\n`)
      return 'error'
    } finally {
      rpc.off('chat:event', onChat)
      rpc.off('media:job', onJob)
      rpc.off('closed', onClosed)
      if (io.interactive) {
        stdin.off('data', onKey)
        stdin.setRawMode?.(false)
        stdin.pause()
      }
    }
  }
}

function waitingText(r: RouteDecision): string {
  const name = prettyModel(r.model)
  if (r.cpuOnly && /media|picture|video/i.test(r.reason)) return `Waiting for ${name} (on the processor while a picture is drawn)…`
  return `Waiting for ${name}…`
}

function fmtSecs(s: number): string {
  return s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}
