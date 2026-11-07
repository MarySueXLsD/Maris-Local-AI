import { ArrowUp, Clapperboard, FileCode2, FileText, Globe, Image as ImageIcon, MessageSquareText, Paperclip, ShieldAlert, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { Attachment, MediaRequest, RouteDecision, ThinkMode } from '@shared/types'
import { api, type PackInfo } from '../../lib/api'
import { prettyModel } from '../../lib/format'
import { useApp, type ComposerKind } from '../../store'
import { cn, IconButton, Tip } from '../ui'
import { DEVICE, keys, modKey, REMOTE } from '../../lib/platform'
import { AutoApproveBar, useAutoApprove } from '../AutoApprove'
import { ContextMeter } from './ContextMeter'

const COMPOSER_WIDTH = { narrow: 'max-w-[680px]', normal: 'max-w-[800px]', wide: 'max-w-[1080px]' } as const

async function imageFileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = reject
    r.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise((res) => {
    img.onload = res
    img.src = dataUrl
  })
  const scale = Math.min(1, 1568 / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    name: file.name || 'pasted image',
    mime: 'image/jpeg',
    size: file.size,
    dataUrl: canvas.toDataURL('image/jpeg', 0.88)
  }
}

export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  const paths: string[] = []
  for (const f of files) {
    const p = api.files.pathFor(f)
    if (p) paths.push(p)
    else if (f.type.startsWith('image/')) out.push(await imageFileToAttachment(f))
  }
  if (paths.length) out.push(...(await api.files.attach(paths)))
  return out
}

const THINK_LABEL: Record<ThinkMode, string> = { auto: 'Think: auto', on: 'Think: on', off: 'Think: off' }

// Commands for the message box (insert text, attach, switch to Image/Video) are applied once each, even
// when the box appears again later (after visiting another page) and finds the last command in the store.
const applied = { insert: 0, attach: 0, media: 0 }
const NEXT_THINK: Record<ThinkMode, ThinkMode> = { auto: 'on', on: 'off', off: 'auto' }

const KINDS: { value: ComposerKind; label: string; icon: typeof ImageIcon; tip: string }[] = [
  { value: 'text', label: 'Text', icon: MessageSquareText, tip: 'Maris answers in words and can use its tools' },
  { value: 'image', label: 'Image', icon: ImageIcon, tip: 'Make a picture from your description' },
  { value: 'video', label: 'Video', icon: Clapperboard, tip: 'Make a short clip from your description, or animate an attached picture' }
]
const SHAPES = {
  image: [
    ['square', 'Square'],
    ['portrait', 'Portrait'],
    ['landscape', 'Landscape'],
    ['wide', 'Wide']
  ],
  video: [
    ['wide', 'Wide'],
    ['square', 'Square'],
    ['portrait', 'Portrait']
  ]
} as const

function secondsText(n: number): string {
  return n < 90 ? `${Math.max(1, Math.round(n))} s` : `${Math.round(n / 60)} min`
}

/** A small labelled choice inside the composer's Image and Video controls. */
function Chips<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center rounded-lg border border-line bg-sunken p-0.5">
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn('h-6 rounded-md px-2 text-[0.78rem] transition-colors', value === v ? 'bg-raised font-medium text-text shadow-sm' : 'text-text-2 hover:text-text')}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

export function Composer({ conversationId, extraAttachments, onConsumed }: { conversationId?: string; extraAttachments: Attachment[]; onConsumed: () => void }) {
  const settings = useApp((s) => s.settings)
  const running = useApp((s) => (conversationId ? Boolean(s.running[conversationId]) : false))
  const send = useApp((s) => s.send)
  const sendMedia = useApp((s) => s.sendMedia)
  const stop = useApp((s) => s.stop)
  const focusTick = useApp((s) => s.focusTick)
  const draftModel = useApp((s) => s.draftModel)
  const convModel = useApp((s) => s.conversations.find((c) => c.id === conversationId)?.model)
  const approvals = useApp((s) => s.approvals)
  const pending = Object.values(approvals).filter((a) => a.conversationId === conversationId)
  const autoApprove = useAutoApprove(conversationId)
  const hasModels = useApp((s) => s.models.some((m) => !m.capabilities.includes('embedding')))
  const status = useApp((s) => s.status)
  const mode = useApp((s) => s.mode)
  const project = useApp((s) => s.project)
  const insert = useApp((s) => s.composerInsert)
  const attach = useApp((s) => s.composerAttach)
  const mediaCmd = useApp((s) => s.composerMedia)
  const openChat = useApp((s) => s.open)
  const openModels = useApp((s) => s.openModels)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [think, setThink] = useState<ThinkMode>(settings?.agent.defaultThink ?? 'auto')
  const [web, setWeb] = useState(settings?.web.enabled ?? true)
  const [preview, setPreview] = useState<RouteDecision>()
  const [kind, setKind] = useState<ComposerKind>('text')
  const [packs, setPacks] = useState<PackInfo[]>([])
  const [packId, setPackId] = useState('')
  const [shape, setShape] = useState<string>('square')
  const [quality, setQuality] = useState<'auto' | 'fast' | 'quality'>('auto')
  const [count, setCount] = useState(1)
  const [seconds, setSeconds] = useState(settings?.media.videoSeconds ?? 3)
  const ref = useRef<HTMLTextAreaElement>(null)
  const model = conversationId ? (convModel ?? 'auto') : draftModel
  const media = kind !== 'text'

  useEffect(() => {
    ref.current?.focus()
  }, [focusTick, conversationId])

  // Opening another chat starts in Text again (a chat made from Image mode keeps it while it is being made).
  const prevConv = useRef(conversationId)
  useEffect(() => {
    const prev = prevConv.current
    prevConv.current = conversationId
    if (prev !== undefined && prev !== conversationId) setKind('text')
  }, [conversationId])

  useEffect(() => {
    if (!insert || insert.tick <= applied.insert) return
    applied.insert = insert.tick
    setText((t) => (insert.replace ? insert.text : `${t}${t && !t.endsWith(' ') ? ' ' : ''}${insert.text} `))
    ref.current?.focus()
  }, [insert])

  useEffect(() => {
    if (!attach || attach.tick <= applied.attach) return
    applied.attach = attach.tick
    if (attach.list.length) setAttachments((a) => [...a, ...attach.list.filter((x) => !a.some((y) => y.id === x.id))].slice(0, 10))
  }, [attach])

  useEffect(() => {
    if (!mediaCmd || mediaCmd.tick <= applied.media) return
    applied.media = mediaCmd.tick
    choose(mediaCmd.kind, mediaCmd.packId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaCmd])

  useEffect(() => {
    if (extraAttachments.length) {
      setAttachments((a) => [...a, ...extraAttachments].slice(0, 10))
      onConsumed()
    }
  }, [extraAttachments, onConsumed])

  // Auto-size the text box.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  // Live preview of the router's choice while typing (answers in words only).
  useEffect(() => {
    if (running || media || text.trim().length < 3) {
      setPreview(undefined)
      return
    }
    const t = setTimeout(() => {
      void api.chat.previewRoute(text, attachments, model === 'auto' ? undefined : model, think, mode).then(setPreview)
    }, 350)
    return () => clearTimeout(t)
  }, [text, attachments, model, think, running, mode, media])

  /** Switch between words, a picture and a video; the picture engine warms up while the prompt is written. */
  function choose(k: ComposerKind, pick?: string): void {
    setKind(k)
    if (k === 'text') return
    setShape(k === 'image' ? 'square' : 'wide')
    setPackId(pick ?? '')
    void api.media
      .packs()
      .then(setPacks)
      .catch(() => undefined)
    const c = useApp.getState().status?.comfy
    if (c?.installed && !c.up && !c.starting && !REMOTE) void api.media.startComfy().catch(() => undefined)
  }

  const kindPacks = useMemo(() => packs.filter((p) => p.kind === kind && p.installed), [packs, kind])
  const pack = kindPacks.find((p) => p.id === packId)
  const startPicture = attachments.find((a) => a.kind === 'image')
  const needsPicture = kind === 'video' && pack?.startImage === 'needed' && !startPicture
  const noModel = media && packs.length > 0 && kindPacks.length === 0
  const estimate = (() => {
    if (!media) return undefined
    const list = pack ? [pack] : kindPacks
    const secs = list.map((p) => p.estimateSec).filter((n): n is number => Boolean(n))
    if (!secs.length) return undefined
    const one = pack ? secs[0]! : Math.min(...secs)
    const total = kind === 'image' ? one * count : one * Math.max(1, seconds / Math.max(1, settings?.media.videoSeconds ?? 3))
    return `${pack ? 'About' : 'From about'} ${secondsText(total)}${kind === 'image' && count > 1 ? ` for ${count}` : ''}`
  })()

  const canSend =
    (media ? kindPacks.length > 0 || packs.length === 0 : hasModels) &&
    !needsPicture &&
    (mode !== 'code' || Boolean(project) || Boolean(conversationId)) &&
    (text.trim().length > 0 || (!media && attachments.length > 0))

  const submit = async (): Promise<void> => {
    if (running) {
      stop()
      return
    }
    if (!canSend) return
    const prompt = text.trim()
    const atts = attachments
    setText('')
    setAttachments([])
    setPreview(undefined)
    if (!media) {
      void send(prompt, atts, think, web)
      return
    }
    // A picture pasted into the box has no file yet; the video engine needs one to start from.
    let start = startPicture?.path
    if (kind === 'video' && startPicture && !start && startPicture.dataUrl) start = await api.files.saveImage(startPicture.dataUrl).catch(() => undefined)
    const req: MediaRequest = {
      kind,
      prompt,
      packId: packId || undefined,
      quality: packId ? undefined : quality,
      aspect: shape as MediaRequest['aspect'],
      ...(kind === 'image' ? { count } : { seconds, startImage: start })
    }
    void sendMedia(req, atts)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const enterSends = settings?.ui.sendWithEnter !== false
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (enterSends || modKey(e))) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && running) {
      e.preventDefault()
      stop()
    }
  }

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    const atts = await filesToAttachments(files)
    setAttachments((a) => [...a, ...atts].slice(0, 10))
  }

  const job = status?.comfy.job
  const left = job?.etaSec ? ` · about ${job.etaSec < 90 ? `${Math.max(1, job.etaSec)} s` : `${Math.round(job.etaSec / 60)} min`} left` : ''
  const busyWord = job
    ? `${job.kind === 'video' ? 'Rendering a video' : 'Drawing a picture'}${job.model ? ` with ${job.model}` : ''}${left}; chats run on the processor meanwhile`
    : status?.busy === 'heavy'
      ? 'Another program is using the graphics card heavily'
      : status?.busy === 'busy'
        ? `Your ${DEVICE} is busy`
        : ''
  const jobElsewhere = job?.conversationId && job.conversationId !== conversationId ? job.conversationId : undefined

  const placeholder = !hasModels && !media
    ? 'Install a model in Models to start chatting'
    : kind === 'image'
      ? 'Describe the picture: subject, setting, style, light, camera…'
      : kind === 'video'
        ? startPicture
          ? 'Describe how the picture should move: what moves, the camera, the mood…'
          : 'Describe the scene and how it moves: action, camera, mood…'
        : mode === 'code'
          ? project
            ? `Ask Maris to build, fix or explain something in ${project.name}`
            : 'Open a project folder first'
          : 'Message Maris'

  return (
    <div className={cn('mx-auto w-full px-6 pb-4', COMPOSER_WIDTH[settings?.ui.chatWidth ?? 'normal'])}>
      {pending.length > 0 && (
        <div role="status" className="mb-2 flex items-center gap-2 rounded-xl border border-pollen/50 bg-pollen-soft px-3.5 py-2 text-[0.88rem]">
          <ShieldAlert size={16} className="text-pollen" aria-hidden />
          <span className="flex-1">Maris is waiting for your OK on {pending.length === 1 ? 'one action' : `${pending.length} actions`}.</span>
          <button
            className="font-medium text-text underline underline-offset-2"
            onClick={() => document.querySelector('[role="group"][aria-label^="Approval needed"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            Review
          </button>
        </div>
      )}
      <AutoApproveBar conversationId={conversationId} />
      <div className={cn('rounded-2xl border bg-raised shadow-float focus-within:border-petal/60', media ? 'border-petal/45' : 'border-line-strong')}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <span
                key={a.id}
                title={a.kind === 'snippet' ? `${a.path ?? a.name}${a.lines ? `, lines ${a.lines[0]}–${a.lines[1]}` : ''}\n\n${(a.text ?? '').slice(0, 600)}` : (a.path ?? a.name)}
                className="group relative inline-flex items-center gap-2 rounded-lg border border-line bg-sunken py-1 pr-1 pl-1 text-[0.82rem] text-text-2"
              >
                {a.kind === 'image' && a.dataUrl ? (
                  <img src={a.dataUrl} alt="" className="size-9 rounded-md object-cover" />
                ) : a.kind === 'snippet' ? (
                  <FileCode2 size={15} className="ml-1.5 text-petal" />
                ) : (
                  <FileText size={15} className="ml-1.5" />
                )}
                <span className="max-w-48 truncate">
                  {a.name}
                  {a.kind === 'snippet' && a.lines ? <span className="text-text-3"> · lines {a.lines[0] === a.lines[1] ? a.lines[0] : `${a.lines[0]}–${a.lines[1]}`}</span> : null}
                  {kind === 'video' && a === startPicture ? <span className="text-petal"> · start picture</span> : null}
                </span>
                <button aria-label={`Remove ${a.name}`} className="rounded p-1 text-text-3 hover:bg-raised hover:text-text" onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => void onPaste(e)}
          placeholder={placeholder}
          aria-label="Message Maris"
          className="selectable block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[1rem] leading-relaxed text-text placeholder:text-text-3 focus:outline-none"
        />
        {media && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2" aria-label={kind === 'image' ? 'Picture options' : 'Video options'}>
            {noModel ? (
              <p className="text-[0.84rem] text-text-2">
                No {kind === 'image' ? 'picture' : 'video'} model is installed yet.{' '}
                <button className="font-medium text-petal underline underline-offset-2" onClick={() => openModels(kind)}>
                  Get one in Models
                </button>
              </p>
            ) : (
              <>
                <select
                  aria-label="Model"
                  value={packId}
                  onChange={(e) => setPackId(e.target.value)}
                  className="h-7 max-w-52 rounded-lg border border-line bg-sunken px-2 text-[0.8rem] text-text focus:border-petal focus:outline-none"
                >
                  <option value="">Model: let Maris pick</option>
                  {kindPacks.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.startImage === 'needed' ? ' (needs a picture)' : ''}
                    </option>
                  ))}
                </select>
                {!packId && (
                  <Chips
                    label="Quality"
                    value={quality}
                    onChange={setQuality}
                    options={[
                      ['auto', 'Auto'],
                      ['fast', 'Fast'],
                      ['quality', 'Best']
                    ]}
                  />
                )}
                <Chips label="Shape" value={shape} onChange={setShape} options={SHAPES[kind]} />
                {kind === 'image' ? (
                  <Chips
                    label="How many"
                    value={count}
                    onChange={setCount}
                    options={[
                      [1, '1'],
                      [2, '2'],
                      [4, '4']
                    ]}
                  />
                ) : (
                  <Chips
                    label="Length"
                    value={seconds}
                    onChange={setSeconds}
                    options={[
                      [2, '2 s'],
                      [3, '3 s'],
                      [5, '5 s'],
                      [8, '8 s']
                    ]}
                  />
                )}
                {estimate && <span className="tabular text-[0.78rem] text-text-3">{estimate}</span>}
                {needsPicture && <span className="text-[0.78rem] text-pollen">Attach the picture to animate</span>}
              </>
            )}
          </div>
        )}
        <div className="flex items-center gap-1 px-2 pb-2">
          <IconButton
            label={kind === 'video' ? 'Attach a picture to animate' : 'Attach files or images'}
            onClick={async () => {
              const atts = await api.files.pick()
              setAttachments((a) => [...a, ...atts].slice(0, 10))
            }}
          >
            <Paperclip size={16} />
          </IconButton>
          {!media && (
            <Tip label="Auto thinks step by step only when a task needs it. Click to switch between auto, on and off.">
              <button
                onClick={() => setThink(NEXT_THINK[think])}
                aria-label={THINK_LABEL[think]}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[0.84rem] transition-colors hover:bg-sunken',
                  think === 'on' ? 'text-petal' : think === 'off' ? 'text-text-3' : 'text-text-2'
                )}
              >
                <Sparkles size={15} /> {THINK_LABEL[think]}
              </button>
            </Tip>
          )}
          {!media && (
            <IconButton
              label={web ? 'Web access on: Maris may search the internet for this chat. Click to stay offline.' : `Web access off: answers come only from this ${DEVICE}. Click to allow web search.`}
              active={web}
              onClick={() => setWeb(!web)}
            >
              <Globe size={16} />
            </IconButton>
          )}
          <div role="radiogroup" aria-label="What to make" className="ml-0.5 inline-flex items-center rounded-lg border border-line bg-sunken p-0.5">
            {KINDS.map(({ value, label, icon: Icon, tip }) => (
              <Tip key={value} label={tip}>
                <button
                  role="radio"
                  aria-checked={kind === value}
                  aria-label={label}
                  onClick={() => choose(value)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.8rem] transition-colors',
                    kind === value ? 'bg-raised font-medium text-text shadow-sm' : 'text-text-3 hover:text-text'
                  )}
                >
                  <Icon size={14} />
                  {kind === value && <span>{label}</span>}
                </button>
              </Tip>
            ))}
          </div>
          <div className="flex-1" />
          <ContextMeter conversationId={conversationId} />
          <Tip label={running ? 'Stop (Esc)' : media ? `Make it (${settings?.ui.sendWithEnter === false ? keys('Enter') : 'Enter'})` : settings?.ui.sendWithEnter === false ? `Send (${keys('Enter')})` : 'Send (Enter)'}>
            <button
              onClick={() => void submit()}
              disabled={!running && !canSend}
              aria-label={running ? 'Stop' : media ? `Make the ${kind === 'image' ? 'picture' : 'video'}` : 'Send'}
              className={cn(
                'inline-flex size-9 items-center justify-center rounded-xl transition-colors disabled:opacity-35',
                running ? 'bg-text text-paper hover:opacity-90' : 'bg-petal-strong text-on-petal hover:bg-petal'
              )}
            >
              {running ? <Square size={14} fill="currentColor" /> : kind === 'image' ? <ImageIcon size={17} /> : kind === 'video' ? <Clapperboard size={17} /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          </Tip>
        </div>
      </div>
      <div className="flex min-h-7 items-center gap-2 px-2 pt-1.5 text-[0.78rem] text-text-3" aria-live="polite">
        {media ? (
          <span>
            {kind === 'image' ? 'Makes the picture right away on your graphics card' : 'Makes the clip right away on your graphics card'}
            {pack ? ` with ${pack.name}` : ''}. Chats keep working meanwhile.
          </span>
        ) : preview && !running ? (
          <Tip label={preview.reason}>
            <span tabIndex={0}>
              {preview.auto ? 'Auto will answer with' : 'Answering with'} <span className="text-text-2">{prettyModel(preview.model)}</span>
              {preview.think ? ', thinking first' : ''}
              {preview.cpuOnly ? ', on the CPU' : ''}
            </span>
          </Tip>
        ) : (
          <span>
            {autoApprove.everything || autoApprove.inSession
              ? `Maris can read your ${DEVICE} and the web freely, and makes changes without asking (see above).`
              : mode === 'code'
                ? 'Maris reads your project freely and asks before it changes files or runs commands, unless you allowed it.'
                : autoApprove.active
                  ? `Maris can read your ${DEVICE} and the web freely. It asks before other changes.`
                  : `Maris can read your ${DEVICE} and the web freely. It asks before changing anything.`}
          </span>
        )}
        {busyWord &&
          (jobElsewhere ? (
            <button className="ml-auto min-w-0 truncate text-pollen underline-offset-2 hover:underline" title={`${busyWord}. Click to open that chat.`} onClick={() => void openChat(jobElsewhere)}>
              {busyWord}
            </button>
          ) : (
            <span className="ml-auto min-w-0 truncate text-pollen" title={busyWord}>
              {busyWord}
            </span>
          ))}
      </div>
    </div>
  )
}
