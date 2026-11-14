import {
  Activity,
  ArrowRightLeft,
  Ban,
  BookmarkPlus,
  BookmarkX,
  Brain,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Clipboard,
  ClipboardPaste,
  Copy,
  Cpu,
  ExternalLink,
  FilePen,
  FilePlus2,
  FileSearch,
  FileText,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  ImagePlus,
  Info,
  LifeBuoy,
  MessageSquare,
  MessagesSquare,
  OctagonX,
  Search,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  ListTree,
  TextSearch,
  Image as ImageIcon,
  Play,
  ScrollText,
  CircleStop,
  Wrench,
  FileCode,
  type LucideIcon
} from 'lucide-react'
import { useState } from 'react'
import { kindLabel, type ApprovalRule } from '@shared/approval'
import type { ApprovalPreview, ApprovalRequest, ToolCallRecord } from '@shared/types'
import { api } from '../../lib/api'
import { duration } from '../../lib/format'
import { Button, cn, Spinner, Tip } from '../ui'
import { imperative, type Described } from './describe'
import { MediaProgressCard } from './MediaProgress'
import { DEVICE, TRASH } from '../../lib/platform'

const ICONS: Record<string, LucideIcon> = {
  list_dir: FolderOpen,
  read_file: FileText,
  search_files: FileSearch,
  file_info: Info,
  write_file: FilePlus2,
  write_files: FilePlus2,
  edit_file: FilePen,
  make_dir: FolderPlus,
  move_path: ArrowRightLeft,
  copy_path: Copy,
  delete_path: Trash2,
  run_command: SquareTerminal,
  system_info: Cpu,
  list_processes: Activity,
  kill_process: OctagonX,
  open_target: ExternalLink,
  get_clipboard: Clipboard,
  set_clipboard: ClipboardPaste,
  take_screenshot: Camera,
  web_search: Search,
  read_webpage: Globe,
  remember: BookmarkPlus,
  recall: Brain,
  forget: BookmarkX,
  search_chats: MessagesSquare,
  generate_image: ImagePlus,
  generate_video: Clapperboard,
  project_tree: ListTree,
  grep: TextSearch,
  multi_edit: FilePen,
  view_image: ImageIcon,
  start_process: Play,
  process_output: ScrollText,
  stop_process: CircleStop,
  dev_environment: Wrench,
  run_script: FileCode,
  maris_help: LifeBuoy,
  maris_status: Info
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l) => !/^(Index:|={3,}|--- |\+\+\+ )/.test(l))
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-line bg-code font-mono text-[0.8rem] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre px-3',
            l.startsWith('+') && 'bg-ok-soft text-ok',
            l.startsWith('-') && 'bg-danger-soft text-danger',
            l.startsWith('@@') && 'py-0.5 text-text-3'
          )}
        >
          {l || ' '}
        </div>
      ))}
    </div>
  )
}

function PreviewBlock({ preview }: { preview: ApprovalPreview }) {
  if (preview.kind === 'diff')
    return (
      <div className="space-y-1.5">
        <div className="text-[0.8rem] text-text-2">
          {preview.isNew ? 'New file' : 'Changes'}: <span className="text-ok">+{preview.additions}</span>{' '}
          <span className="text-danger">−{preview.deletions}</span>
        </div>
        <DiffView diff={preview.diff} />
      </div>
    )
  if (preview.kind === 'command')
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-code">
        <div className="border-b border-line px-3 py-1 text-[0.75rem] text-text-3">
          {preview.shell}
          {preview.cwd ? ` in ${preview.cwd}` : ''}
        </div>
        <pre className="selectable overflow-x-auto px-3 py-2 font-mono text-[0.84rem] text-text">{preview.command}</pre>
      </div>
    )
  if (preview.kind === 'list')
    return (
      <ul className="selectable space-y-0.5 rounded-lg border border-line bg-code px-3 py-2 font-mono text-[0.82rem]">
        {preview.items.map((it, i) => (
          <li key={i} className="break-all">
            {it}
          </li>
        ))}
      </ul>
    )
  return <pre className="selectable max-h-60 overflow-auto rounded-lg border border-line bg-code px-3 py-2 text-[0.84rem] whitespace-pre-wrap">{preview.text}</pre>
}

/** In Simple view: the change behind a "See the change" toggle, a short command line for everyday commands. */
function SimplePreview({ preview, described }: { preview: ApprovalPreview; described?: Described }) {
  const [open, setOpen] = useState(false)
  if (preview.kind === 'diff') {
    return (
      <div>
        {/* Where the change lands always matters for an approval, so the full path stays visible. */}
        <p className="mb-1.5 flex min-w-0 items-center gap-2 text-[0.8rem] text-text-2">
          <span className="shrink-0">File:</span>
          <code className="selectable truncate rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.76rem] text-text" title={preview.path}>
            {preview.path}
          </code>
        </p>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1.5 text-[0.84rem] text-text-2 hover:text-text">
          <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
          {open ? 'Hide the change' : preview.isNew ? 'See the new file' : 'See the change'}
          <span className="text-ok">+{preview.additions}</span>
          <span className="text-danger">−{preview.deletions}</span>
        </button>
        {open && (
          <div className="mt-2">
            <DiffView diff={preview.diff} />
          </div>
        )}
      </div>
    )
  }
  if (preview.kind === 'command' && !described?.important) {
    return (
      <p className="flex min-w-0 items-center gap-2 text-[0.8rem] text-text-2">
        <span className="shrink-0">Command:</span>
        <code className="selectable truncate rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.78rem] text-text">{preview.command}</code>
      </p>
    )
  }
  return <PreviewBlock preview={preview} />
}

/** What "Always approve …" can cover for this request, narrowest first. */
function ruleOptions(request: ApprovalRequest): { value: ApprovalRule; label: string; hint: string; warn?: string }[] {
  const out: { value: ApprovalRule; label: string; hint: string; warn?: string }[] = []
  if (request.allowPrefix) {
    out.push({ value: 'prefix', label: `"${request.allowPrefix}" in this project`, hint: 'Commands that start like this, in this project only.' })
  }
  if (request.kind) out.push({ value: 'kind', label: kindLabel(request.kind, TRASH), hint: 'In every chat, until you turn it off.' })
  out.push({
    value: 'session',
    label: 'everything in this session',
    hint: 'Every change in this chat, until you close Maris.',
    warn: 'Maris will make every change in this chat without asking, until you close Maris.'
  })
  out.push({
    value: 'everything',
    label: 'everything, everywhere',
    hint: 'Every change in every chat, until you turn it off.',
    warn: 'Maris will make every change in every chat without asking, including ones a web page or file talks it into. You can turn this off at the bottom of the window.'
  })
  return out
}

export function ApprovalPanel({ request, simple, described }: { request: ApprovalRequest; simple?: boolean; described?: Described }) {
  const [busy, setBusy] = useState(false)
  const options = ruleOptions(request)
  const [always, setAlways] = useState(false)
  const [rule, setRule] = useState<ApprovalRule>(options[0]!.value)
  const chosen = options.find((o) => o.value === rule) ?? options[0]!
  /** "Deny and say why": what Maris should do instead (undefined while the field is closed). */
  const [why, setWhy] = useState<string>()
  const answer = async (ok: boolean, note?: string): Promise<void> => {
    setBusy(true)
    await api.chat.approve(request.id, ok, ok && always && !request.alwaysAsk ? chosen.value : undefined, ok ? undefined : note?.trim() || undefined)
  }
  const system = request.risk === 'system'
  const friendly = simple && described && described.kind !== 'other'
  // "Write file" reads as "wants to write file"; names such as "GitHub" keep their capitals.
  const lowerFirst = (s: string): string => (/^[A-Z][a-z]*(?![A-Za-z0-9])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)
  const title = friendly
    ? `Maris wants to ${imperative(described.running)}`
    : request.tool.startsWith('mcp_')
      ? `Maris wants to use ${request.title}`
      : `Maris wants to ${lowerFirst(request.title)}`
  // Warnings from the tool itself (for example "this is a system file") always stay.
  const toolWarning = request.tool !== 'run_command' && request.detail ? request.detail : ''
  const detail = friendly
    ? described.important && described.why
      ? `Important: this ${described.why}.`
      : toolWarning || 'Have a look, then decide.'
    : request.detail || (system ? 'This is a system-level change.' : `This changes something on your ${DEVICE}.`)
  return (
    <div
      role="group"
      aria-label={`Approval needed: ${request.title}`}
      className="mt-2 space-y-3 rounded-xl border border-pollen/60 bg-pollen-soft p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-pollen" aria-hidden />
        <div className="min-w-0">
          <p className="text-[0.95rem] font-medium text-text">{title}</p>
          <p className="mt-0.5 text-[0.84rem] text-text-2">{detail} Nothing happens until you approve.</p>
        </div>
      </div>
      {request.install && (
        <p className="flex items-start gap-2 rounded-lg bg-raised/70 px-3 py-2 text-[0.86rem] text-text" aria-label="Install size">
          <HardDrive size={15} className="mt-0.5 shrink-0 text-text-2" aria-hidden />
          <span>{request.install.summary}</span>
        </p>
      )}
      {request.preview && (simple ? <SimplePreview preview={request.preview} described={described} /> : <PreviewBlock preview={request.preview} />)}
      <div className="flex flex-wrap items-center gap-2">
        <Tip label={always ? `Let Maris do this, and from now on approve ${chosen.label} without asking` : 'Let Maris do this, just this once'}>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void answer(true)}>
            <Check size={15} /> Approve
          </Button>
        </Tip>
        <Tip label="Do not do it. Maris stops and asks what you would prefer.">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void answer(false, why)}>
            <Ban size={15} /> Deny
          </Button>
        </Tip>
        {why === undefined && (
          <Tip label="Do not do it, and tell Maris what to do instead.">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setWhy('')}>
              <MessageSquare size={15} /> Deny and say why
            </Button>
          </Tip>
        )}
        {system && <span className="ml-auto text-[0.8rem] text-danger">System-level change</span>}
      </div>
      {why !== undefined && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void answer(false, why)
          }}
        >
          <input
            autoFocus
            aria-label="What Maris should do instead"
            placeholder="For example: use the Documents folder instead, or ask me first"
            value={why}
            disabled={busy}
            maxLength={1000}
            onChange={(e) => setWhy(e.target.value)}
            className="h-8 min-w-[12rem] flex-1 rounded-lg border border-line-strong bg-raised px-2.5 text-[0.86rem] text-text outline-none focus-visible:border-petal"
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            <Ban size={15} /> Deny and tell Maris
          </Button>
        </form>
      )}
      {/* "Always approve …": the dropdown widens it from this kind of request to the whole session or everything. */}
      {request.alwaysAsk ? (
        <p className="text-[0.8rem] text-text-3">Maris asks every time before it changes its own settings, even when other changes are approved automatically.</p>
      ) : (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.84rem] text-text-2">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="size-4 accent-petal" checked={always} disabled={busy} onChange={(e) => setAlways(e.target.checked)} />
          Always approve
        </label>
        <select
          aria-label="What to always approve"
          value={chosen.value}
          disabled={busy}
          onChange={(e) => {
            setRule(e.target.value as ApprovalRule)
            setAlways(true)
          }}
          className="h-8 max-w-full min-w-0 rounded-lg border border-line-strong bg-raised px-2 text-[0.84rem] text-text outline-none focus-visible:border-petal"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-[0.78rem] text-text-3">{chosen.hint}</span>
      </div>
      )}
      {always && !request.alwaysAsk && chosen.warn && (
        <p className="flex items-start gap-1.5 text-[0.8rem] text-danger" role="note">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> {chosen.warn}
        </p>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolCallRecord['status'] }) {
  switch (status) {
    case 'pending':
    case 'running':
      return <Spinner className="size-3.5" />
    case 'awaiting-approval':
      return <ShieldAlert size={15} className="text-pollen" aria-label="Waiting for your approval" />
    case 'done':
      return <Check size={15} className="text-ok" aria-label="Done" />
    case 'denied':
      return <Ban size={14} className="text-text-3" aria-label="Denied" />
    case 'error':
      return <CircleAlert size={15} className="text-danger" aria-label="Failed" />
  }
}

const STATUS_WORD: Record<ToolCallRecord['status'], string> = {
  pending: 'Starting',
  'awaiting-approval': 'Waiting for your approval',
  running: 'Running',
  done: '',
  denied: 'You denied this',
  error: 'Failed'
}

function PlanCard({ call }: { call: ToolCallRecord }) {
  const steps = Array.isArray(call.args.steps) ? (call.args.steps as { text: string; status: string }[]) : []
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <div className="my-2 rounded-xl border border-line bg-sunken px-4 py-3" aria-label="Plan">
      <p className="text-[0.84rem] font-medium text-text">
        Plan <span className="font-normal text-text-3">{done} of {steps.length} done</span>
      </p>
      <ol className="mt-2 space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[0.88rem]">
            <span
              aria-label={s.status}
              className={cn(
                'mt-[5px] size-2.5 shrink-0 rounded-full border',
                s.status === 'done' ? 'border-ok bg-ok' : s.status === 'in_progress' ? 'border-pollen bg-pollen-soft' : 'border-line-strong'
              )}
            />
            <span className={cn(s.status === 'done' ? 'text-text-3 line-through decoration-text-3/50' : s.status === 'in_progress' ? 'text-text' : 'text-text-2')}>
              {s.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function ToolCard({ call, approval }: { call: ToolCallRecord; approval?: ApprovalRequest }) {
  if (call.name === 'update_plan') return <PlanCard call={call} />
  return <ToolRow call={call} approval={approval} />
}

function ToolRow({ call, approval }: { call: ToolCallRecord; approval?: ApprovalRequest }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.name] ?? SquareTerminal
  const title = call.title ?? call.name
  const took = call.endedAt && call.startedAt ? duration(call.endedAt - call.startedAt) : ''
  const hasDetails = Boolean(call.result || call.error || call.preview || Object.keys(call.args).length)
  return (
    <div className="my-1.5">
      <button
        className={cn(
          'group flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left transition-colors hover:border-line hover:bg-sunken',
          open && 'border-line bg-sunken'
        )}
        aria-expanded={open}
        onClick={() => hasDetails && setOpen(!open)}
      >
        <Icon size={15} className="shrink-0 text-text-2" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate text-[0.88rem]', call.status === 'running' ? 'live' : 'text-text-2')}>{title}</span>
        {call.progress && call.status === 'running' && <span className="tabular shrink-0 text-[0.78rem] text-text-3">{call.progress}</span>}
        {STATUS_WORD[call.status] && call.status !== 'running' && (
          <span className={cn('shrink-0 text-[0.78rem]', call.status === 'error' ? 'text-danger' : call.status === 'awaiting-approval' ? 'text-pollen' : 'text-text-3')}>
            {STATUS_WORD[call.status]}
          </span>
        )}
        {took && call.status === 'done' && <span className="tabular shrink-0 text-[0.75rem] text-text-3">{took}</span>}
        <StatusIcon status={call.status} />
        {hasDetails && <ChevronRight size={14} className={cn('shrink-0 text-text-3 transition-transform', open && 'rotate-90')} aria-hidden />}
      </button>
      {call.autoApproved && <p className="ml-7 text-[0.74rem] text-text-3">{call.autoApproved}</p>}
      {call.note && call.status === 'denied' && <p className="selectable ml-7 text-[0.78rem] text-text-2">{call.note}</p>}
      {call.media && (call.status === 'running' || call.status === 'pending') && (
        <div className="ml-7">
          <MediaProgressCard m={call.media} />
        </div>
      )}
      {approval && call.status === 'awaiting-approval' && <ApprovalPanel request={approval} />}
      {open && (
        <div className="mt-1 ml-7 space-y-2 border-l border-line pl-3">
          {call.preview && <img src={call.preview} alt="Preview of what Maris saw" className="max-w-sm rounded-lg border border-line" />}
          {Object.keys(call.args).length > 0 && (
            <pre className="selectable overflow-x-auto rounded-lg bg-code px-3 py-2 font-mono text-[0.78rem] text-text-2">{JSON.stringify(call.args, null, 2)}</pre>
          )}
          {call.error && <p className="selectable text-[0.85rem] text-danger">{call.error}</p>}
          {call.result && (
            <pre className="selectable max-h-72 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[0.78rem] leading-relaxed whitespace-pre-wrap text-text">{call.result}</pre>
          )}
        </div>
      )}
    </div>
  )
}
