import { Check, Clapperboard, Download, ExternalLink, FolderOpen, Image as ImageIcon, Minus, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import type { ComfyState, DownloadProgress, MediaResult } from '@shared/types'
import { api, type PackInfo } from '../lib/api'
import { MediaImg, MediaVideo } from '../components/Media'
import { PreviewSlider } from '../components/ModelPreviews'
import { bytes, timeAgo } from '../lib/format'
import { DEVICE, REMOTE, TRASH } from '../lib/platform'
import { useApp } from '../store'
import { Button, cn, IconButton, inputCls, Progress, Section, Spinner } from '../components/ui'

type Kind = 'image' | 'video'

function seconds(n: number): string {
  return n < 90 ? `${Math.max(1, Math.round(n))} s` : `${Math.round(n / 60)} min`
}

function timeHere(p: PackInfo): string {
  const unit = p.unit === 'image' ? 'picture' : p.unit
  if (!p.estimateSec) return `${p.speed} on a fast graphics card`
  return `About ${seconds(p.estimateSec)} per ${unit} on your ${DEVICE}${p.estimateMeasured ? ', measured here' : ' (estimated from your hardware)'}`
}

/** One picture or video model: examples, what it is, what it is good and less good at, how it runs here. */
function PackCard({ p, progress, onRemove }: { p: PackInfo; progress?: DownloadProgress; onRemove: (p: PackInfo) => void }) {
  const active = (progress && !progress.done) || p.installing
  const d = p.details
  const onDisk = p.files.filter((f) => f.present).reduce((s, f) => s + (f.sizeBytes ?? 0), 0)
  return (
    <article className="grid gap-5 px-4 py-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]" aria-label={p.name}>
      <PreviewSlider packId={p.id} kind={p.kind} modelName={p.name} startImage={p.startImage} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-start gap-3">
          <span className="mt-0.5 text-petal">{p.kind === 'image' ? <ImageIcon size={18} /> : <Clapperboard size={18} />}</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[1.02rem] font-semibold text-text">
              {p.name}{' '}
              <span className="text-[0.8rem] font-normal text-text-3">
                {p.kind === 'image' ? 'Pictures' : p.startImage === 'needed' ? 'Animates a picture' : 'Video'}, {p.tier === 'fast' ? 'fast' : 'best quality'}
              </span>
            </h3>
            <p className="mt-0.5 text-[0.88rem] leading-snug text-text-2">{p.description}</p>
          </div>
          {p.installed ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[0.8rem] text-ok">
                <Check size={13} /> Installed
              </span>
              {!REMOTE && (
                <IconButton label={`Remove ${p.name} from this ${DEVICE}`} onClick={() => onRemove(p)}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </span>
          ) : active ? (
            <span className="flex items-center gap-2">
              <Spinner />
              <span className="text-[0.8rem] text-text-2">{progress && !progress.done ? 'Downloading' : 'Setting up the engine'}</span>
              <Button size="sm" variant="ghost" onClick={() => void api.media.cancelDownload(progress && !progress.done ? p.id : 'comfyui')}>
                <X size={14} /> Cancel
              </Button>
            </span>
          ) : (
            !REMOTE && (
              <Button size="sm" variant="outline" title={`Download ${p.name} (${p.missingGB || p.sizeGB} GB) into your data folder`} onClick={() => void api.media.installPack(p.id).catch(() => undefined)}>
                <Download size={14} /> Install
              </Button>
            )
          )}
        </div>

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.84rem]">
          <dt className="text-text-3">Time</dt>
          <dd className="text-text">{timeHere(p)}</dd>
          {d && (
            <>
              <dt className="text-text-3">Makes</dt>
              <dd className="text-text">{d.output}</dd>
              <dt className="text-text-3">Made by</dt>
              <dd className="text-text">{d.maker}</dd>
              <dt className="text-text-3">Size</dt>
              <dd className="text-text">{d.size}</dd>
            </>
          )}
          <dt className="text-text-3">Graphics card</dt>
          <dd className="text-text">
            {p.vramGB} GB of video memory for full speed{p.vramMinGB < p.vramGB ? `; works from ${p.vramMinGB} GB, slower` : ''}
            {p.cpuOk ? '; also runs on the processor' : ''}
          </dd>
          <dt className="text-text-3">{p.installed ? 'On disk' : 'Download'}</dt>
          <dd className="text-text">
            {p.installed ? `${bytes(onDisk)} in ${p.files.length} files (files shared with other models count once)` : `${p.sizeGB} GB${p.missingGB && p.missingGB < p.sizeGB ? `, ${p.missingGB} GB of it still needed (the rest is shared with models you have)` : ''}`}
          </dd>
          <dt className="text-text-3">Licence</dt>
          <dd className="text-text">{d?.licenseNote ?? p.license}</dd>
        </dl>

        {d && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[0.8rem] font-medium text-text-2">Good at</p>
              <ul className="mt-1 space-y-1">
                {d.goodAt.map((t) => (
                  <li key={t} className="flex gap-1.5 text-[0.84rem] leading-snug text-text">
                    <Check size={13} className="mt-[3px] shrink-0 text-ok" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[0.8rem] font-medium text-text-2">Less good at</p>
              <ul className="mt-1 space-y-1">
                {d.weakAt.map((t) => (
                  <li key={t} className="flex gap-1.5 text-[0.84rem] leading-snug text-text">
                    <Minus size={13} className="mt-[3px] shrink-0 text-text-3" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {d && (
          <details className="group mt-3 rounded-lg border border-line px-3 py-2">
            <summary className="flex items-center gap-1.5 text-[0.84rem] font-medium text-text">
              <Sparkles size={13} className="text-petal" aria-hidden /> How it works and how to write prompts for it
            </summary>
            <p className="mt-2 text-[0.84rem] leading-snug text-text-2">{d.how}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.84rem] leading-snug text-text">
              {d.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </details>
        )}
        <details className="mt-2 rounded-lg border border-line px-3 py-2">
          <summary className="text-[0.84rem] font-medium text-text">Files ({p.files.length})</summary>
          <ul className="mt-2 space-y-1">
            {p.files.map((f) => (
              <li key={f.name} className="flex items-center gap-2 text-[0.8rem]">
                <span className={cn('size-1.5 shrink-0 rounded-full', f.present ? 'bg-ok' : 'bg-line-strong')} aria-label={f.present ? 'Downloaded' : 'Not downloaded'} />
                <span className="min-w-0 flex-1 truncate font-mono text-text-2" title={`${f.dir}/${f.name}`}>
                  {f.dir}/{f.name}
                </span>
                <span className="tabular shrink-0 text-text-3">{bytes(f.sizeBytes ?? 0)}</span>
              </li>
            ))}
          </ul>
        </details>
        {d && (
          <button className="mt-2 inline-flex items-center gap-1 text-[0.82rem] text-petal hover:underline" onClick={() => void api.shell.openExternal(d.link)}>
            <ExternalLink size={12} /> The model's page
          </button>
        )}

        {progress && !progress.done && (
          <div className="mt-3 space-y-1">
            <Progress value={progress.totalBytes ? progress.receivedBytes / progress.totalBytes : 0} label={`Downloading ${p.name}`} />
            <p className="tabular text-[0.76rem] text-text-3">
              {progress.file} {bytes(progress.receivedBytes)} of {bytes(progress.totalBytes)}
            </p>
          </div>
        )}
        {progress?.error && <p className="mt-1 text-[0.82rem] text-danger">{progress.error}</p>}
      </div>
    </article>
  )
}

/** The picture engine runs by itself: it starts when something is made and stops after a quiet spell. */
function EngineInfo({ comfy, kind }: { comfy?: ComfyState; kind: Kind }) {
  const idle = useApp((s) => s.settings?.media.stopAfterIdleMin ?? 20)
  const setView = useApp((s) => s.setView)
  const [log, setLog] = useState(false)
  if (!comfy?.installed) return null
  return (
    <div className="mt-6 rounded-xl border border-line px-4 py-3 text-[0.84rem] text-text-2">
      <p>
        <span className="text-text">The {kind === 'image' ? 'picture' : 'video'} engine (ComfyUI)</span>{' '}
        {comfy.starting ? 'is starting…' : comfy.up ? 'is ready.' : 'starts by itself when you make something.'} It stops on its own{' '}
        {idle > 0 ? `after ${idle} minutes without work` : 'only when Maris closes'}, so your graphics card is free for games and chats.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!REMOTE && (
          <Button size="sm" variant="ghost" onClick={() => comfy.dir && void api.shell.openPath(comfy.dir)}>
            <FolderOpen size={13} /> Open its folder
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setLog(!log)}>
          {log ? 'Hide its log' : 'Show its log'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setView('settings')}>
          <Settings2 size={13} /> Engine settings
        </Button>
      </div>
      {log && <pre className="selectable mt-2 max-h-64 overflow-auto rounded-lg bg-code p-3 font-mono text-[0.74rem] text-text-2">{comfy.log.join('\n') || 'No output yet.'}</pre>}
    </div>
  )
}

/** Models → Pictures or Videos: which model does what, the models, what you made, and the engine. */
export function MediaTab({ kind }: { kind: Kind }) {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const [packs, setPacks] = useState<PackInfo[]>([])
  const [comfy, setComfy] = useState<ComfyState>()
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const [gallery, setGallery] = useState<MediaResult[]>([])
  const [removing, setRemoving] = useState<PackInfo>()

  useEffect(() => {
    void api.media.packs().then(setPacks)
    void api.media.comfyState().then(setComfy)
    void api.media.gallery().then(setGallery)
    const offs = [
      api.media.onDownload((d) => {
        setDownloads((s) => ({ ...s, [d.id]: d }))
        if (d.done) void api.media.packs().then(setPacks)
      }),
      api.media.onComfy(setComfy),
      api.media.onJob((j) => {
        if (j.status === 'done') void api.media.gallery().then(setGallery)
      })
    ]
    return () => offs.forEach((o) => o())
  }, [])

  // The engine setup sends few events; look again while anything installs.
  const anyInstalling = packs.some((p) => p.installing) || Boolean(comfy?.installing)
  useEffect(() => {
    if (!anyInstalling) return
    const t = setInterval(() => void api.media.packs().then(setPacks), 3000)
    return () => clearInterval(t)
  }, [anyInstalling])

  const mine = useMemo(() => packs.filter((p) => p.kind === kind), [packs, kind])
  const installed = mine.filter((p) => p.installed)
  const more = mine.filter((p) => !p.installed)
  const made = gallery.filter((g) => g.kind === kind)
  const word = kind === 'image' ? 'pictures' : 'videos'
  const roles = kind === 'image' ? ([['imageFast', 'Quick pictures', 'Drafts and ideas, and when you ask for something fast'], ['imageQuality', 'Best pictures', 'When you ask for detail or quality']] as const) : ([['videoFast', 'Quick clips', 'Most clips'], ['videoQuality', 'Best clips', 'When you ask for the best quality']] as const)
  const comfyDl = downloads['comfyui']
  const animator = packs.find((p) => p.installed && p.kind === 'video' && p.startImage)

  return (
    <>
      <Section title="Roles" description={`Which model Maris uses for ${word}. Automatic picks the best installed model that fits your graphics card at that moment.`}>
        <div className="divide-y divide-line rounded-xl border border-line">
          {roles.map(([key, label, hint]) => {
            const value = settings?.media.roles?.[key] ?? ''
            return (
              <div key={key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-48 flex-1">
                  <p className="text-[0.95rem] text-text">{label}</p>
                  <p className="text-[0.82rem] text-text-2">{hint}</p>
                </div>
                <select aria-label={`${label} model`} value={value} onChange={(e) => void update({ media: { roles: { [key]: e.target.value } } })} className={cn(inputCls, 'w-64')}>
                  <option value="">Automatic</option>
                  {installed.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-48 flex-1">
              <p className="text-[0.95rem] text-text">{kind === 'image' ? 'Picture size' : 'Clip length'}</p>
              <p className="text-[0.82rem] text-text-2">{kind === 'image' ? 'When you do not pick a shape. Bigger takes longer.' : 'When you do not say how long. Longer clips take longer to make.'}</p>
            </div>
            {kind === 'image' ? (
              <select
                aria-label="Picture size"
                className={cn(inputCls, 'w-64')}
                value={`${settings?.media.imageWidth ?? 1024}x${settings?.media.imageHeight ?? 1024}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x').map(Number)
                  void update({ media: { imageWidth: w, imageHeight: h } })
                }}
              >
                {[
                  ['1024x1024', 'Square, 1024×1024'],
                  ['832x1216', 'Portrait, 832×1216'],
                  ['1216x832', 'Landscape, 1216×832'],
                  ['1344x768', 'Wide, 1344×768'],
                  ['768x768', 'Small square, 768×768 (faster)']
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                {!['1024x1024', '832x1216', '1216x832', '1344x768', '768x768'].includes(`${settings?.media.imageWidth}x${settings?.media.imageHeight}`) && (
                  <option value={`${settings?.media.imageWidth}x${settings?.media.imageHeight}`}>
                    {settings?.media.imageWidth}×{settings?.media.imageHeight} (from Settings)
                  </option>
                )}
              </select>
            ) : (
              <select aria-label="Clip length" className={cn(inputCls, 'w-64')} value={settings?.media.videoSeconds ?? 3} onChange={(e) => void update({ media: { videoSeconds: Number(e.target.value) } })}>
                {[2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} seconds
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </Section>

      {comfyDl && !comfyDl.done && (
        <div className="mt-6 space-y-1 rounded-xl border border-line px-4 py-3">
          <p className="text-[0.9rem] text-text">{comfyDl.label}</p>
          <div className={comfyDl.totalBytes === 100 && comfyDl.receivedBytes === 0 ? 'animate-pulse' : ''}>
            <Progress value={comfyDl.totalBytes ? Math.max(comfyDl.totalBytes === 100 ? 0.15 : 0, comfyDl.receivedBytes / comfyDl.totalBytes) : 0} label="Installing the engine" />
          </div>
          {comfyDl.totalBytes > 100 && (
            <p className="tabular text-[0.76rem] text-text-3">
              {bytes(comfyDl.receivedBytes)} of {bytes(comfyDl.totalBytes)}
            </p>
          )}
        </div>
      )}

      {installed.length > 0 && (
        <Section title="Installed" description={`Make ${word} from any chat: pick ${kind === 'image' ? 'Image' : 'Video'} next to the web button in the message box.`}>
          <div className="divide-y divide-line rounded-xl border border-line">
            {installed.map((p) => (
              <PackCard key={p.id} p={p} progress={downloads[p.id]} onRemove={setRemoving} />
            ))}
          </div>
        </Section>
      )}

      {more.length > 0 && (
        <Section
          title={installed.length ? 'Get more' : `Set up ${word}`}
          description={comfy?.installed ? 'Fast models suit drafts and ideas; quality models suit finished work. Files models share download once.' : 'Maris uses ComfyUI, the standard engine for local picture and video models. Installing a model also sets up the engine (about 2 GB) in your data folder.'}
        >
          <div className="divide-y divide-line rounded-xl border border-line">
            {more.map((p) => (
              <PackCard key={p.id} p={p} progress={downloads[p.id]} onRemove={setRemoving} />
            ))}
          </div>
        </Section>
      )}

      {made.length > 0 && (
        <Section title={kind === 'image' ? 'Your pictures' : 'Your videos'} description="Everything you made, newest first.">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {made.map((g) => (
              <figure key={g.id} className="group relative overflow-hidden rounded-xl border border-line bg-sunken">
                {g.kind === 'image' ? (
                  <MediaImg path={g.path} alt={g.prompt} loading="lazy" className="aspect-square w-full cursor-zoom-in object-cover" onClick={() => void api.shell.openPath(g.path)} />
                ) : (
                  <MediaVideo path={g.path} muted loop playsInline className="aspect-square w-full object-cover" onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} aria-label={g.prompt} />
                )}
                <figcaption className="absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/80 to-transparent p-2.5 pt-8 text-[0.76rem] text-white transition-transform group-focus-within:translate-y-0 group-hover:translate-y-0">
                  <p className="line-clamp-2">{g.prompt}</p>
                  <p className="mt-1 opacity-70">
                    {g.model}, {timeAgo(g.createdAt)}
                  </p>
                  <div className="mt-1.5 flex gap-1">
                    {!REMOTE && (
                      <button className="rounded-md bg-white/15 px-2 py-1 hover:bg-white/25" onClick={() => void api.shell.openPath(g.path)}>
                        Open
                      </button>
                    )}
                    {!REMOTE && (
                      <button className="rounded-md bg-white/15 px-2 py-1 hover:bg-white/25" aria-label="Show in folder" onClick={() => void api.shell.showInFolder(g.path)}>
                        <FolderOpen size={12} />
                      </button>
                    )}
                    {g.kind === 'image' && animator && !REMOTE && (
                      <button
                        className="rounded-md bg-white/15 px-2 py-1 hover:bg-white/25"
                        title={`Make a clip that starts from this picture with ${animator.name}`}
                        onClick={() => {
                          void api.files.attach([g.path]).then((atts) => {
                            const s = useApp.getState()
                            if (s.mode !== 'chat') s.setMode('chat')
                            s.newChat()
                            s.setComposerMedia('video', animator.id)
                            s.insertIntoComposer(g.prompt, true)
                            s.attachToComposer(atts)
                          })
                        }}
                      >
                        Animate
                      </button>
                    )}
                    <button
                      className="ml-auto rounded-md bg-white/15 px-2 py-1 hover:bg-white/25"
                      aria-label={`Move to ${TRASH}`}
                      onClick={() => void api.media.remove(g.id, true).then(() => setGallery((l) => l.filter((x) => x.id !== g.id)))}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>
      )}

      <EngineInfo comfy={comfy} kind={kind} />

      <Dialog.Root open={Boolean(removing)} onOpenChange={(o) => !o && setRemoving(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(460px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-6 shadow-float">
            <Dialog.Title className="text-[1.1rem] font-semibold text-text">Remove {removing?.name}?</Dialog.Title>
            <Dialog.Description className="mt-2 text-[0.9rem] text-text-2">
              Its files are deleted from your data folder (files other installed models use stay). Everything you made with it stays. You can install it again later.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemoving(undefined)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (removing) await api.media.removePack(removing.id).catch(() => undefined)
                  setRemoving(undefined)
                  setPacks(await api.media.packs())
                }}
              >
                <Trash2 size={14} /> Remove
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
