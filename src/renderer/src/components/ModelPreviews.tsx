import { ChevronLeft, ChevronRight, Copy, Maximize2, MessageSquarePlus, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { ANIMATE_SAMPLES, IMAGE_SAMPLES, LITE_SAMPLES, VIDEO_SAMPLES, type PreviewEntry, type PreviewManifest } from '@shared/mediaSamples'
import manifestJson from '../lib/previews.json'
import { useApp } from '../store'
import { cn, Tip } from './ui'

const MANIFEST = manifestJson as PreviewManifest

export interface Preview extends PreviewEntry {
  prompt: string
  url: string
  posterUrl?: string
  /** Image-to-video: the picture the clip starts from. */
  startUrl?: string
}

/** Rendered examples for a picture or video model (made with that very model), with their prompts. */
export function previewsFor(packId: string): Preview[] {
  const samples = [...IMAGE_SAMPLES, ...LITE_SAMPLES, ...VIDEO_SAMPLES, ...ANIMATE_SAMPLES]
  return (MANIFEST.packs[packId] ?? []).map((e) => ({
    ...e,
    prompt: samples.find((s) => s.id === e.sample)?.prompt ?? '',
    url: `./previews/${packId}/${e.file}`,
    posterUrl: e.poster ? `./previews/${packId}/${e.poster}` : undefined,
    startUrl: e.start ? `./previews/${packId}/${e.start}` : undefined
  }))
}

/**
 * "Use this prompt": a new chat with the message box in Image or Video mode, this model picked and the
 * prompt filled in. Nothing is made until the person presses Enter.
 */
export function startChatWithPrompt(kind: 'image' | 'video', prompt: string, packId?: string): void {
  const s = useApp.getState()
  if (s.mode !== 'chat') s.setMode('chat')
  s.newChat()
  s.setComposerMedia(kind, packId)
  s.insertIntoComposer(prompt, true)
}

/** A picture or clip at full size, with its prompt; arrows move between the examples. */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  kind,
  packId,
  modelName
}: {
  items: Preview[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  kind: 'image' | 'video'
  packId: string
  modelName: string
}) {
  const n = items.length
  const cur = items[((index % n) + n) % n]
  const go = (d: number): void => onIndex((index + d + n) % n)
  if (!cur) return null
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/85" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-6 outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') go(1)
            if (e.key === 'ArrowLeft') go(-1)
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <Dialog.Title className="sr-only">Example made with {modelName}</Dialog.Title>
          <Dialog.Description className="sr-only">{cur.prompt}</Dialog.Description>
          <div className="relative flex max-h-[80vh] max-w-[94vw] items-center justify-center">
            {cur.file.endsWith('.mp4') ? (
              <video key={cur.url} src={cur.url} poster={cur.posterUrl} autoPlay loop muted playsInline controls className="max-h-[80vh] max-w-[94vw] rounded-lg" aria-label={cur.prompt} />
            ) : (
              <img key={cur.url} src={cur.url} alt={cur.prompt} className="max-h-[80vh] max-w-[94vw] rounded-lg object-contain" />
            )}
            {cur.startUrl && (
              <figure className="absolute bottom-3 left-3 w-40 overflow-hidden rounded-md border border-white/40 bg-black/60 shadow-float">
                <img src={cur.startUrl} alt="The picture this clip starts from" className="w-full" />
                <figcaption className="px-2 py-1 text-[0.72rem] text-white/85">Starts from this picture</figcaption>
              </figure>
            )}
          </div>
          <div className="flex w-full max-w-[760px] items-start gap-3 text-white">
            <p className="selectable min-w-0 flex-1 text-[0.9rem] leading-snug text-white/90">{cur.prompt}</p>
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1.5 text-[0.84rem] font-medium hover:bg-white/25"
              onClick={() => {
                onClose()
                startChatWithPrompt(kind, cur.prompt, packId)
              }}
            >
              <MessageSquarePlus size={14} /> Use this prompt
            </button>
            <button className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-white/15 hover:bg-white/25" aria-label="Copy the prompt" onClick={() => void navigator.clipboard.writeText(cur.prompt)}>
              <Copy size={14} />
            </button>
          </div>
          {n > 1 && (
            <>
              <button className="fixed top-1/2 left-4 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30" aria-label="Previous example" onClick={() => go(-1)}>
                <ChevronLeft size={22} />
              </button>
              <button className="fixed top-1/2 right-4 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30" aria-label="Next example" onClick={() => go(1)}>
                <ChevronRight size={22} />
              </button>
              <p className="tabular text-[0.78rem] text-white/60">
                {(((index % n) + n) % n) + 1} of {n}
              </p>
            </>
          )}
          <Dialog.Close className="fixed top-4 right-4 inline-flex size-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30" aria-label="Close">
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * A slider of examples: one picture or clip at a time, arrows and dots to move, the prompt under it, and
 * "Use this prompt". Clicking an example opens it full size. Clips play only while they are on screen.
 */
export function PreviewSlider({
  packId,
  kind,
  modelName,
  startImage,
  className
}: {
  packId: string
  kind: 'image' | 'video'
  modelName: string
  /** The model animates a picture (its examples start from one). */
  startImage?: 'needed' | 'optional'
  className?: string
}) {
  const items = previewsFor(packId)
  const [i, setI] = useState(0)
  const [broken, setBroken] = useState(false)
  const [full, setFull] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const v = video.current
    if (!v) return
    if (visible && !full) void v.play().catch(() => undefined)
    else v.pause()
  }, [visible, i, full])
  const samples = kind === 'image' ? (packId === 'image-lite' ? LITE_SAMPLES : IMAGE_SAMPLES) : startImage === 'needed' ? ANIMATE_SAMPLES : VIDEO_SAMPLES
  if (!items.length || broken) {
    return (
      <div className={cn('flex flex-col justify-between rounded-xl border border-dashed border-line bg-sunken/40 p-3.5', className)}>
        <p className="text-[0.82rem] text-text-3">No examples for this model yet. Try one of these prompts:</p>
        <ul className="mt-2 space-y-1.5">
          {samples.slice(0, 2).map((s) => (
            <li key={s.id} className="flex items-start gap-2 text-[0.82rem] text-text-2">
              <span className="line-clamp-2 min-w-0 flex-1">{s.prompt}</span>
              <button className="shrink-0 rounded-md px-1.5 py-0.5 text-petal hover:bg-petal-soft" onClick={() => startChatWithPrompt(kind, s.prompt, packId)}>
                Use
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const n = items.length
  const at = ((i % n) + n) % n
  const cur = items[at]
  const go = (d: number): void => setI((x) => (x + d + n) % n)
  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={box}
        className={cn('group relative overflow-hidden rounded-xl border border-line bg-sunken', kind === 'image' ? 'aspect-square' : 'aspect-video')}
        tabIndex={0}
        role="region"
        aria-roledescription="slider"
        aria-label={`Examples made with ${modelName}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(1)
          if (e.key === 'ArrowLeft') go(-1)
          if (e.key === 'Enter') setFull(true)
        }}
      >
        <button className="block size-full cursor-zoom-in" onClick={() => setFull(true)} aria-label="Open this example full size">
          {cur.file.endsWith('.mp4') ? (
            <video
              key={cur.url}
              ref={video}
              src={cur.url}
              poster={cur.posterUrl}
              muted
              loop
              playsInline
              preload="metadata"
              className="pointer-events-none size-full object-cover"
              aria-label={cur.prompt}
              onError={() => setBroken(true)}
            />
          ) : (
            <img key={cur.url} src={cur.url} alt={cur.prompt} loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
          )}
        </button>
        {cur.startUrl && (
          <img src={cur.startUrl} alt="The picture this clip starts from" title="The clip starts from this picture" className="pointer-events-none absolute top-1.5 left-1.5 w-[30%] rounded-md border border-white/60 shadow-float" />
        )}
        <span className="pointer-events-none absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
          <Maximize2 size={13} />
        </span>
        {n > 1 && (
          <>
            <button
              className="absolute top-1/2 left-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Previous example"
              onClick={() => go(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Next example"
              onClick={() => go(1)}
            >
              <ChevronRight size={18} />
            </button>
            <div className="absolute inset-x-0 bottom-1.5 flex justify-center gap-1.5" role="tablist" aria-label="Examples">
              {items.map((it, k) => (
                <button
                  key={it.url}
                  role="tab"
                  aria-selected={k === at}
                  aria-label={`Example ${k + 1}`}
                  onClick={() => setI(k)}
                  className={cn('size-1.5 rounded-full transition-all', k === at ? 'w-4 bg-white' : 'bg-white/55 hover:bg-white/80')}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-[0.82rem] leading-snug text-text-2" title={cur.prompt}>
        {cur.prompt}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-petal-soft px-2 py-1 text-[0.8rem] font-medium text-text hover:bg-petal/20"
          onClick={() => startChatWithPrompt(kind, cur.prompt, packId)}
          title={startImage === 'needed' ? 'Opens a new chat in Video mode with this prompt. Attach the picture to animate, then press Enter.' : 'Opens a new chat with this model and prompt. Nothing is made until you press Enter.'}
        >
          <MessageSquarePlus size={13} /> Use this prompt
        </button>
        <Tip label="Copy the prompt">
          <button className="inline-flex size-7 items-center justify-center rounded-md text-text-3 hover:bg-sunken hover:text-text" aria-label="Copy the prompt" onClick={() => void navigator.clipboard.writeText(cur.prompt)}>
            <Copy size={13} />
          </button>
        </Tip>
      </div>
      {full && <Lightbox items={items} index={at} onIndex={setI} onClose={() => setFull(false)} kind={kind} packId={packId} modelName={modelName} />}
    </div>
  )
}
