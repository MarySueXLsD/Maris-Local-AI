import { Bold, Eye, Heading2, ImagePlus, Italic, KeyRound, Link2, List, Pencil, Pin, Send, Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdminStatus, NewsKind, PostDraft } from '@shared/extensions'
import { Markdown } from '../components/Markdown'
import { Button, cn, inputCls, PageHeader, Section, Segmented, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../store'

const DRAFT_KEY = 'maris.admin.draft'
const EMPTY: PostDraft = { title: '', kind: 'news', summary: '', body: '', images: [] }
const clean = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

function loadDraft(): PostDraft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as PostDraft | null
    return d && typeof d.body === 'string' ? d : EMPTY
  } catch {
    return EMPTY
  }
}

/** Admin: write posts with pictures and publish them to every copy of Maris. */
export function AdminView() {
  const [status, setStatus] = useState<AdminStatus>()
  const [error, setError] = useState('')
  useEffect(() => {
    void api.admin.status(true).then(setStatus).catch((e) => setError(clean(e)))
  }, [])
  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[920px] px-5 pb-16 sm:px-8">
        <PageHeader
          title="Admin"
          description={
            <>
              Posts you publish here appear in <b className="text-text">Updates & news</b> for everyone who uses Maris, the next time their copy is online. They are
              stored as Markdown files with pictures in the GitHub repository {status?.repo ? <code className="rounded bg-code px-1">{status.repo}</code> : ''}.
            </>
          }
        />
        {error && <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-[0.88rem] text-danger">{error}</p>}
        {!status ? (
          <p className="flex items-center gap-2 text-text-2">
            <Spinner className="size-3.5" /> Checking access…
          </p>
        ) : status.canPublish ? (
          <Publisher status={status} onSignOut={() => void api.admin.clearToken().then(setStatus)} />
        ) : (
          <TokenSetup status={status} onDone={setStatus} />
        )}
      </div>
    </div>
  )
}

function TokenSetup({ status, onDone }: { status: AdminStatus; onDone: (s: AdminStatus) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(status.error ?? '')
  return (
    <Section title="Connect to GitHub" description="Publishing needs a GitHub token that may write to the repository. Only people with such a token can publish; everyone else only reads.">
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-[0.9rem] text-text-2">
        <li>
          Open{' '}
          <button className="text-petal underline" onClick={() => void api.shell.openExternal('https://github.com/settings/personal-access-tokens/new')}>
            GitHub → Fine-grained tokens → Generate new token
          </button>
          .
        </li>
        <li>
          Under Repository access choose only <code className="rounded bg-code px-1">{status.repo}</code>, and under Permissions set <b>Contents</b> to <b>Read and write</b>.
        </li>
        <li>Generate it and paste it here. It stays on this computer, encrypted.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <input
          type="password"
          autoComplete="off"
          className={cn(inputCls, 'max-w-md flex-1 font-mono')}
          placeholder="github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="GitHub token"
        />
        <Button
          variant="primary"
          disabled={busy || !token.trim()}
          onClick={() => {
            setBusy(true)
            setError('')
            void api.admin
              .setToken(token)
              .then((s) => {
                onDone(s)
                if (s.error) setError(s.error)
              })
              .catch((e) => setError(clean(e)))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? <Spinner className="size-3.5" /> : <KeyRound size={15} />} Save token
        </Button>
      </div>
      {error && <p className="mt-2 text-[0.86rem] text-danger">{error}</p>}
      <p className="mt-3 text-[0.8rem] text-text-3">The repository can be changed in Settings → Updates and news.</p>
    </Section>
  )
}

function Publisher({ status, onSignOut }: { status: AdminStatus; onSignOut: () => void }) {
  const posts = useApp((s) => s.newsState?.posts ?? [])
  const [draft, setDraftState] = useState<PostDraft>(loadDraft)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<'publish' | string>()
  const [message, setMessage] = useState<{ text: string; bad?: boolean }>()
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const setDraft = (d: PostDraft): void => {
    setDraftState(d)
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
    } catch {
      /* storage full: pictures can be large */
    }
  }
  const images = useMemo(() => new Map(draft.images.map((i) => [`images/${i.name}`, i.dataUrl])), [draft.images])

  const insert = (before: string, after = '', placeholder = ''): void => {
    const el = area.current
    const start = el?.selectionStart ?? draft.body.length
    const end = el?.selectionEnd ?? draft.body.length
    const chosen = draft.body.slice(start, end) || placeholder
    const body = draft.body.slice(0, start) + before + chosen + after + draft.body.slice(end)
    setDraft({ ...draft, body })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + before.length, start + before.length + chosen.length)
    })
  }

  const addPictures = async (files: FileList | File[] | null): Promise<void> => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith('image/'))
    const added: PostDraft['images'] = []
    for (const f of list) {
      if (f.size > 8 * 2 ** 20) {
        setMessage({ text: `${f.name} is larger than 8 MB.`, bad: true })
        continue
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(f)
      })
      let name = f.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'picture.png'
      while ([...draft.images, ...added].some((i) => i.name === name)) name = name.replace(/(\.\w+)?$/, (ext) => `-2${ext}`)
      added.push({ name, dataUrl })
    }
    if (!added.length) return
    const refs = added.map((a) => `![${a.name.replace(/\.\w+$/, '')}](images/${a.name})`).join('\n\n')
    const el = area.current
    const at = el?.selectionStart ?? draft.body.length
    const body = `${draft.body.slice(0, at)}${at > 0 ? '\n\n' : ''}${refs}\n\n${draft.body.slice(at)}`
    setDraft({ ...draft, images: [...draft.images, ...added], body, cover: draft.cover ?? added[0]?.name })
  }

  const publish = async (): Promise<void> => {
    setBusy('publish')
    setMessage(undefined)
    try {
      await api.admin.publish(draft)
      setMessage({ text: `Published "${draft.title}". Everyone sees it within a few minutes of going online.` })
      setDraft(EMPTY)
      setTab('write')
    } catch (e) {
      setMessage({ text: clean(e), bad: true })
    } finally {
      setBusy('')
      setConfirm(undefined)
    }
  }

  const edit = async (id: string): Promise<void> => {
    setBusy(`edit:${id}`)
    try {
      setDraft(await api.admin.loadDraft(id))
      setTab('write')
      setMessage({ text: 'Editing a published post. Publishing replaces it.' })
      window.scrollTo({ top: 0 })
    } catch (e) {
      setMessage({ text: clean(e), bad: true })
    } finally {
      setBusy('')
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(`remove:${id}`)
    try {
      await api.admin.remove(id)
      setMessage({ text: 'Post removed. It disappears for everyone within a few minutes.' })
      if (draft.id === id) setDraft(EMPTY)
    } catch (e) {
      setMessage({ text: clean(e), bad: true })
    } finally {
      setBusy('')
      setConfirm(undefined)
    }
  }

  const ready = draft.title.trim() && draft.body.trim()
  return (
    <>
      <p className="mb-5 flex flex-wrap items-center gap-2 text-[0.86rem] text-text-2">
        <KeyRound size={14} className="text-ok" aria-hidden /> Signed in to GitHub as <b className="text-text">{status.login}</b>, publishing to{' '}
        <code className="rounded bg-code px-1">{status.repo}</code>.
        <button className="ml-auto text-text-3 underline hover:text-text" onClick={onSignOut}>
          Remove token
        </button>
      </p>

      {message && (
        <p role="status" className={cn('mb-4 rounded-lg px-3 py-2 text-[0.9rem]', message.bad ? 'bg-danger-soft text-danger' : 'bg-petal-soft text-text')}>
          {message.text}
        </p>
      )}

      <section className="rounded-2xl border border-line bg-raised/60 p-4" aria-label="Post editor">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-[1.15rem] font-semibold text-text">{draft.id ? 'Edit post' : 'New post'}</h2>
          <div className="flex gap-2">
            {(draft.id || draft.title || draft.body) && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(EMPTY)}>
                <X size={14} /> Start over
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <input className={inputCls} placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
          <Segmented<NewsKind>
            label="Kind of post"
            value={draft.kind}
            onChange={(kind) => setDraft({ ...draft, kind })}
            options={[
              { value: 'news', label: 'News' },
              { value: 'update', label: 'Update notes' },
              { value: 'tip', label: 'Tip' }
            ]}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem]">
          <input
            className={inputCls}
            placeholder="One-line summary for the list (optional)"
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            aria-label="Summary"
          />
          <input
            className={inputCls}
            placeholder={draft.kind === 'update' ? 'Version, e.g. 0.2.0' : 'Version (optional)'}
            value={draft.version ?? ''}
            onChange={(e) => setDraft({ ...draft, version: e.target.value })}
            aria-label="Version"
          />
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-line-strong bg-surface">
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
            {tab === 'write' && (
              <>
                <ToolBtn label="Bold" onClick={() => insert('**', '**', 'bold text')}>
                  <Bold size={15} />
                </ToolBtn>
                <ToolBtn label="Italic" onClick={() => insert('_', '_', 'text')}>
                  <Italic size={15} />
                </ToolBtn>
                <ToolBtn label="Heading" onClick={() => insert('\n## ', '\n', 'Heading')}>
                  <Heading2 size={15} />
                </ToolBtn>
                <ToolBtn label="List" onClick={() => insert('\n- ', '', 'item')}>
                  <List size={15} />
                </ToolBtn>
                <ToolBtn label="Link" onClick={() => insert('[', '](https://)', 'link text')}>
                  <Link2 size={15} />
                </ToolBtn>
                <ToolBtn label="Add pictures" onClick={() => fileInput.current?.click()}>
                  <ImagePlus size={15} />
                </ToolBtn>
              </>
            )}
            <div className="ml-auto">
              <Segmented<'write' | 'preview'>
                label="Write or preview"
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'write', label: 'Write' },
                  { value: 'preview', label: 'Preview' }
                ]}
              />
            </div>
          </div>
          {tab === 'write' ? (
            <textarea
              ref={area}
              className="block min-h-[320px] w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[0.9rem] leading-relaxed text-text outline-none placeholder:text-text-3"
              placeholder="Write in Markdown. Add pictures with the picture button, or paste or drop them here."
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              onPaste={(e) => {
                // Screenshots arrive as "image.png"; give each pasted picture its own name.
                const stamp = Date.now().toString(36)
                const pics = [...e.clipboardData.files]
                  .filter((f) => f.type.startsWith('image/'))
                  .map((f, i) => new File([f], `picture-${stamp}${i ? `-${i + 1}` : ''}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, { type: f.type }))
                if (pics.length) {
                  e.preventDefault()
                  void addPictures(pics)
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                if (e.dataTransfer.files.length) {
                  e.preventDefault()
                  void addPictures(e.dataTransfer.files)
                }
              }}
              aria-label="Post text (Markdown)"
            />
          ) : (
            <div className="min-h-[320px] px-5 py-4">
              {draft.title && <h1 className="mb-3 font-display text-[1.8rem] font-light leading-tight text-text">{draft.title}</h1>}
              {draft.body.trim() ? <Markdown text={draft.body} resolveImage={(src) => images.get(src)} /> : <p className="text-text-3">Nothing to preview yet.</p>}
            </div>
          )}
        </div>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addPictures(e.target.files).then(() => (e.target.value = ''))} />

        {draft.images.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-[0.8rem] font-semibold text-text-2">Pictures (the starred one is shown in the list)</p>
            <div className="flex flex-wrap gap-2">
              {draft.images.map((img) => (
                <figure key={img.name} className="group relative">
                  <img src={img.dataUrl} alt={img.name} className={cn('size-20 rounded-lg border object-cover', draft.cover === img.name ? 'border-petal' : 'border-line')} />
                  <div className="absolute inset-x-0 bottom-0 flex justify-between p-1">
                    <button
                      className="rounded bg-black/55 p-1 text-white"
                      aria-label={`Use ${img.name} as the cover picture`}
                      onClick={() => setDraft({ ...draft, cover: img.name })}
                    >
                      <Star size={12} fill={draft.cover === img.name ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      className="rounded bg-black/55 p-1 text-white"
                      aria-label={`Remove ${img.name}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          images: draft.images.filter((i) => i.name !== img.name),
                          cover: draft.cover === img.name ? undefined : draft.cover,
                          body: draft.body.split(`(images/${img.name})`).join('()')
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                </figure>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-[0.88rem] text-text-2">
            <input type="checkbox" className="size-4 accent-petal" checked={Boolean(draft.pinned)} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
            <Pin size={13} aria-hidden /> Pin to the top
          </label>
          <div className="ml-auto flex gap-2">
            {confirm === 'publish' ? (
              <>
                <span className="self-center text-[0.86rem] text-text-2">Publish to everyone?</span>
                <Button variant="primary" disabled={busy === 'publish'} onClick={() => void publish()}>
                  {busy === 'publish' ? <Spinner className="size-3.5" /> : <Send size={15} />} Publish
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(undefined)}>
                  Not yet
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={!ready} onClick={() => setConfirm('publish')}>
                <Send size={15} /> {draft.id ? 'Publish changes' : 'Publish'}
              </Button>
            )}
          </div>
        </div>
      </section>

      <Section title="Published posts" description="What everyone sees in Updates & news.">
        {posts.length === 0 && <p className="text-[0.9rem] text-text-2">Nothing published yet.</p>}
        <ul className="divide-y divide-line rounded-xl border border-line">
          {posts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.95rem] text-text">
                  {p.pinned && <Pin size={12} className="mr-1 inline" aria-label="Pinned" />}
                  {p.title}
                </span>
                <span className="text-[0.8rem] text-text-3">
                  {new Date(p.date).toLocaleDateString()} · {p.kind === 'update' ? 'Update notes' : p.kind === 'tip' ? 'Tip' : 'News'}
                </span>
              </span>
              {confirm === p.id ? (
                <span className="flex gap-2">
                  <Button size="sm" variant="danger" disabled={busy === `remove:${p.id}`} onClick={() => void remove(p.id)}>
                    {busy === `remove:${p.id}` ? <Spinner className="size-3.5" /> : <Trash2 size={14} />} Remove for everyone
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(undefined)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  {p.source === 'file' ? (
                    <span className="px-2 text-[0.8rem] text-text-3" title={`news/${p.file} in the repository: change it there`}>
                      Markdown file in git
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy === `edit:${p.id}`} onClick={() => void edit(p.id)}>
                      {busy === `edit:${p.id}` ? <Spinner className="size-3.5" /> : <Pencil size={14} />} Edit
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(p.id)} aria-label={`Remove ${p.title}`}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-1.5 text-[0.8rem] text-text-3">
          <Eye size={13} aria-hidden /> Tip: write update notes for a new version as an "Update notes" post with its version number.
        </p>
      </Section>
    </>
  )
}

function ToolBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded-md p-1.5 text-text-2 hover:bg-sunken hover:text-text">
      {children}
    </button>
  )
}
