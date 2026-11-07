import { ShieldCheck, ShieldOff, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import type { ReactNode } from 'react'
import { anyAutoApprove, APPROVAL_KINDS, KIND_SHORT, kindLabel, type ApprovalKind } from '@shared/approval'
import type { Conversation, Project } from '@shared/types'
import { api } from '../lib/api'
import { TRASH } from '../lib/platform'
import { useApp } from '../store'
import { Button, cn, Switch } from './ui'

/** What skips the question in a chat: the person's own rules, newest choice first. */
export function useAutoApprove(conversationId?: string) {
  const rules = useApp((s) => s.settings?.agent.autoApprove)
  const sessions = useApp((s) => s.approvalSessions)
  const conversation = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  const project = useApp((s) => (conversation?.projectDir ? s.projects.find((p) => p.path === conversation.projectDir) : undefined))
  const inSession = Boolean(conversationId && sessions.includes(conversationId))
  const kinds = APPROVAL_KINDS.filter((k) => rules?.[k])
  const code = conversation?.mode === 'code'
  const projectEdits = Boolean(code && conversation?.autoEdits)
  const commands = code ? (project?.allowedCommands ?? []) : []
  const active = anyAutoApprove(rules, inSession) || projectEdits || commands.length > 0
  return { rules, sessions, inSession, kinds, everything: Boolean(rules?.everything), projectEdits, commands, conversation, project, active }
}

/** One line for the reminder: "everything", "everything in this session", "file edits and commands"… */
export function autoApproveSummary(a: ReturnType<typeof useAutoApprove>): string {
  if (a.everything) return 'everything, in every chat'
  if (a.inSession) return 'everything in this session'
  const parts = [...a.kinds.map((k) => KIND_SHORT[k]), ...(a.projectEdits ? ['edits in this project'] : []), ...(a.commands.length ? [`${a.commands.length} allowed command${a.commands.length === 1 ? '' : 's'}`] : [])]
  return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The panel for changing automatic approvals, from the reminder or the status bar. */
export function AutoApproveManager({ conversationId }: { conversationId?: string }) {
  const a = useAutoApprove(conversationId)
  const update = useApp((s) => s.updateSettings)
  const setAutoEdits = useApp((s) => s.setAutoEdits)
  const otherSessions = a.sessions.filter((id) => id !== conversationId)
  const setKind = (k: ApprovalKind, on: boolean): void => void update({ agent: { autoApprove: { [k]: on } } })
  const allOff = async (): Promise<void> => {
    await update({ agent: { autoApprove: { everything: false, files: false, delete: false, commands: false, programs: false, clipboard: false, memory: false, connectors: false } } })
    await api.approvals.clearSessions()
    if (a.projectEdits) setAutoEdits(false)
  }
  return (
    <div className="w-[min(92vw,380px)] space-y-3">
      <div>
        <h2 className="text-[0.98rem] font-semibold text-text">Approve without asking</h2>
        <p className="mt-0.5 text-[0.82rem] leading-snug text-text-2">Maris normally asks before it changes anything. These choices skip the question. Turn them off any time.</p>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface px-3">
        <Switch
          checked={a.everything}
          onChange={(v) => void update({ agent: { autoApprove: { everything: v } } })}
          label="Everything, everywhere"
          description="Every change in every chat, until you turn it off."
        />
        {conversationId && (
          <Switch
            checked={a.inSession}
            onChange={(v) => void api.approvals.setSession(conversationId, v)}
            label="Everything in this session"
            description="Every change in this chat, until you close Maris."
          />
        )}
      </div>
      <div>
        <h3 className="mb-1 text-[0.78rem] font-semibold text-text-2">These kinds, in every chat</h3>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface px-3">
          {APPROVAL_KINDS.map((k) => (
            <Switch key={k} checked={Boolean(a.rules?.[k])} onChange={(v) => setKind(k, v)} label={capitalize(kindLabel(k, TRASH))} />
          ))}
        </div>
        <p className="mt-1 text-[0.76rem] text-text-3">Changes in system folders still ask unless you approve everything.</p>
      </div>
      {(a.projectEdits || a.commands.length > 0) && (
        <ProjectRules project={a.project} conversation={a.conversation} edits={a.projectEdits} commands={a.commands} onEdits={setAutoEdits} />
      )}
      {otherSessions.length > 0 && (
        <p className="flex items-center justify-between gap-2 text-[0.8rem] text-text-2">
          Also on for everything in {otherSessions.length} other chat{otherSessions.length === 1 ? '' : 's'}.
          <Button size="sm" variant="ghost" onClick={() => void Promise.all(otherSessions.map((id) => api.approvals.setSession(id, false)))}>
            Turn off there
          </Button>
        </p>
      )}
      {a.active && (
        <Button size="sm" variant="outline" className="w-full justify-center" onClick={() => void allOff()}>
          <ShieldOff size={14} /> Ask before every change again
        </Button>
      )}
    </div>
  )
}

function ProjectRules({
  project,
  conversation,
  edits,
  commands,
  onEdits
}: {
  project?: Project
  conversation?: Conversation
  edits: boolean
  commands: string[]
  onEdits: (on: boolean) => void
}) {
  const forget = useApp((s) => s.loadProjects)
  return (
    <div>
      <h3 className="mb-1 text-[0.78rem] font-semibold text-text-2">In this project{project ? ` (${project.name})` : ''}</h3>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface px-3">
        {conversation && edits && <Switch checked={edits} onChange={onEdits} label="File edits inside this project" description="This chat only. Deleting files still asks." />}
        {commands.map((c) => (
          <div key={c} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 text-[0.9rem] text-text">
              Commands starting with <code className="rounded bg-code px-1 font-mono text-[0.8rem]">{c}</code>
            </span>
            <button
              aria-label={`Stop always allowing ${c}`}
              className="rounded-md p-1 text-text-3 hover:bg-sunken hover:text-text"
              onClick={() => project && void api.project.forgetCommand(project.path, c).then(() => forget())}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Opens the manager from any element. */
export function AutoApprovePopover({ conversationId, children, side = 'top' }: { conversationId?: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 max-h-[80vh] overflow-y-auto rounded-2xl border border-line-strong bg-raised p-4 shadow-float outline-none"
        >
          <AutoApproveManager conversationId={conversationId} />
          <Popover.Arrow className="fill-raised" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** The reminder above the message box while something is approved automatically in this chat. */
export function AutoApproveBar({ conversationId }: { conversationId?: string }) {
  const a = useAutoApprove(conversationId)
  if (!a.active) return null
  const strong = a.everything || a.inSession
  return (
    <div
      role="status"
      className={cn(
        'mb-2 flex items-center gap-2 rounded-xl border px-3.5 py-1.5 text-[0.84rem]',
        strong ? 'border-danger/40 bg-danger-soft text-text' : 'border-line bg-sunken text-text-2'
      )}
    >
      <ShieldCheck size={15} className={strong ? 'text-danger' : 'text-petal'} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Approving without asking: <b className="font-medium text-text">{autoApproveSummary(a)}</b>
      </span>
      <AutoApprovePopover conversationId={conversationId}>
        <button className="shrink-0 font-medium text-text underline underline-offset-2">Change</button>
      </AutoApprovePopover>
    </div>
  )
}
