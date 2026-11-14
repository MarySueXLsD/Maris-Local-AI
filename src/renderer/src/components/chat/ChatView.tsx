import { ArrowDown, PanelLeft, PanelRight, Upload } from 'lucide-react'
import { Switch as RSwitch } from 'radix-ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ChatMessage } from '@shared/types'
import { useApp } from '../../store'
import { CodeEmptyState } from '../code/CodeEmptyState'
import { ProjectPanel } from '../code/ProjectPanel'
import { cn, IconButton, Tip } from '../ui'

// The column grows with the window (between a minimum and a maximum), so wide and ultrawide screens
// are not left with a narrow strip in the middle. The composer (Composer.tsx) is 60px narrower.
const CHAT_WIDTH = {
  narrow: 'max-w-[clamp(740px,48vw,1000px)]',
  normal: 'max-w-[clamp(860px,64vw,1800px)]',
  wide: 'max-w-[clamp(1140px,82vw,2600px)]',
  full: 'max-w-none'
} as const
import { Composer, filesToAttachments } from './Composer'
import { EmptyState } from './EmptyState'
import { MessageView } from './Message'
import { ModelPicker } from './ModelPicker'

const EMPTY: ChatMessage[] = []

function AutoEditsSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <Tip label="When on, Maris edits files inside this project without asking. Deleting files, changes outside the project and commands still ask.">
      <label className="no-drag inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[0.82rem] text-text-2 hover:bg-sunken max-md:hidden">
        <RSwitch.Root
          checked={on}
          onCheckedChange={onChange}
          aria-label="Auto-approve file edits in this project"
          className="relative h-[18px] w-[32px] shrink-0 rounded-full border border-line-strong bg-sunken transition-colors data-[state=checked]:border-pollen data-[state=checked]:bg-pollen"
        >
          <RSwitch.Thumb className="block size-[12px] translate-x-[2px] rounded-full bg-text-2 transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-ink" />
        </RSwitch.Root>
        Auto-approve edits
      </label>
    </Tip>
  )
}

/** Code mode: switch between plain-language steps and every technical detail. */
function ViewToggle() {
  const view = useApp((s) => s.settings?.ui.activityView ?? 'simple')
  const update = useApp((s) => s.updateSettings)
  return (
    <Tip label="Simple: Maris describes each step in plain words and folds commands and code away (important ones stay visible). Detailed: every command, file and change.">
      <div role="radiogroup" aria-label="How Maris shows its work" className="no-drag inline-flex rounded-lg border border-line bg-sunken p-0.5 max-md:hidden">
        {(['simple', 'detailed'] as const).map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={view === v}
            onClick={() => void update({ ui: { activityView: v } })}
            className={cn('h-7 rounded-md px-2.5 text-[0.8rem] font-medium transition-colors', view === v ? 'bg-raised text-text shadow-sm' : 'text-text-2 hover:text-text')}
          >
            {v === 'simple' ? 'Simple' : 'Detailed'}
          </button>
        ))}
      </div>
    </Tip>
  )
}

export function ChatView() {
  const currentId = useApp((s) => s.currentId)
  const messages = useApp((s) => (s.currentId ? (s.messages[s.currentId] ?? EMPTY) : EMPTY))
  const conversation = useApp((s) => s.conversations.find((c) => c.id === s.currentId))
  const approvalsMap = useApp((s) => s.approvals)
  const draftModel = useApp((s) => s.draftModel)
  const setChatModel = useApp((s) => s.setChatModel)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const send = useApp((s) => s.send)
  const settings = useApp((s) => s.settings)
  const chatWidth = settings?.ui.chatWidth ?? 'normal'
  const compact = settings?.ui.density === 'compact'
  const mode = useApp((s) => s.mode)
  const project = useApp((s) => s.project)
  const panelOpen = useApp((s) => s.panelOpen)
  const togglePanel = useApp((s) => s.togglePanel)
  const draftAutoEdits = useApp((s) => s.draftAutoEdits)
  const setAutoEdits = useApp((s) => s.setAutoEdits)
  const scroller = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [dropped, setDropped] = useState<Attachment[]>([])
  // The same array while the approvals do not change: a new one on every render (every streamed word) made
  // each message of the chat draw itself again.
  const approvals = useMemo(() => Object.values(approvalsMap), [approvalsMap])
  const code = mode === 'code'

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [messages, stick])

  useEffect(() => {
    setStick(true)
  }, [currentId])

  const consumed = useCallback(() => setDropped([]), [])

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (files.length) setDropped(await filesToAttachments(files))
  }

  const pick = (t: string): void => void send(t, [], settings?.agent.defaultThink ?? 'auto', settings?.web.enabled ?? true)

  return (
    <div className="flex h-full min-w-0 flex-1">
      <main
        className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={(e) => void onDrop(e)}
      >
        <div
          className="drag flex h-11 shrink-0 items-center gap-2"
          style={{
            paddingLeft: sidebarOpen ? '0.75rem' : 'calc(0.75rem + var(--chrome-left))',
            paddingRight: code && panelOpen ? '0.75rem' : 'calc(0.75rem + var(--chrome-right))'
          }}
        >
          {!sidebarOpen && (
            <IconButton label="Show sidebar" className="no-drag" onClick={toggleSidebar}>
              <PanelLeft size={16} />
            </IconButton>
          )}
          <h1 className="min-w-0 flex-1 truncate text-[0.92rem] text-text-2">
            {code && project ? <span className="text-text">{project.name}</span> : null}
            {code && project ? <span className="text-text-3"> / </span> : null}
            {conversation && !(code && conversation.title === 'New chat') ? conversation.title : code ? 'New task' : 'New chat'}
          </h1>
          {code && project && (
            <>
              <ViewToggle />
              <AutoEditsSwitch on={conversation ? Boolean(conversation.autoEdits) : draftAutoEdits} onChange={setAutoEdits} />
            </>
          )}
          <ModelPicker value={conversation?.model ?? draftModel} onChange={setChatModel} />
          {code && project && (
            <IconButton label={panelOpen ? 'Hide project panel' : 'Show project panel'} className="no-drag" active={panelOpen} onClick={togglePanel}>
              <PanelRight size={16} />
            </IconButton>
          )}
        </div>

        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversation">
          {messages.length === 0 ? (
            code ? (
              <CodeEmptyState onPick={pick} />
            ) : (
              <EmptyState onPick={pick} />
            )
          ) : (
            <div className={cn('mx-auto flex w-full flex-col px-3.5 pt-4 pb-10 sm:px-6', CHAT_WIDTH[chatWidth], compact ? 'gap-3' : 'gap-6')}>
              {conversation?.summary && (
                <details className="rounded-xl border border-line bg-sunken px-4 py-2.5 text-[0.86rem] text-text-2">
                  <summary className="cursor-pointer text-text">Earlier messages are summarised to save context</summary>
                  <div className="selectable mt-2 whitespace-pre-wrap">{conversation.summary}</div>
                </details>
              )}
              {messages.map((m, i) => (
                // Older messages out of view are not laid out or painted until they scroll into view (a long
                // Code-mode chat holds hundreds of steps); the last ones, which change, always are.
                <div key={m.id} className={i < messages.length - 2 ? 'offscreen-lazy' : undefined}>
                  <MessageView m={m} approvals={approvals} />
                </div>
              ))}
            </div>
          )}
        </div>

        {!stick && messages.length > 0 && (
          <button
            onClick={() => setStick(true)}
            className="absolute bottom-36 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-[0.82rem] text-text shadow-float"
          >
            <ArrowDown size={14} /> Jump to latest
          </button>
        )}

        <Composer conversationId={currentId} extraAttachments={dropped} onConsumed={consumed} />

        {dragging && (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-petal bg-petal-soft">
            <span className="inline-flex items-center gap-2 text-[1rem] text-text">
              <Upload size={18} /> Drop files or images to attach them
            </span>
          </div>
        )}
      </main>
      {code && project && panelOpen && (
        <div
          className="flex h-full flex-col max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:max-w-[88vw] max-md:shadow-float"
          style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
        >
          <div className="drag h-0" />
          <ProjectPanel conversationId={currentId} messages={messages} />
        </div>
      )}
    </div>
  )
}
