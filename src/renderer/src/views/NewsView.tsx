import { ArrowLeft, CheckCheck, Download, ExternalLink, Pin, RefreshCw, Rocket, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { NewsPostContent, NewsState, UpdateState } from '@shared/extensions'
import { MediaImg } from '../components/Media'
import { Markdown } from '../components/Markdown'
import { Button, cn, PageHeader, Progress, Section, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { REMOTE } from '../lib/platform'
import { useApp } from '../store'

const KIND_WORD = { news: 'News', update: 'Update notes', tip: 'Tip' } as const

const longDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Updates & news: new versions of Maris, and posts its maker publishes. */
export function NewsView() {
  const update = useApp((s) => s.updateState)
  const news = useApp((s) => s.newsState)
  const [openId, setOpenId] = useState<string>()

  useEffect(() => {
    // Opening the page counts as a look: refresh quietly if the last check is older than ten minutes.
    if (!news?.fetchedAt || Date.now() - news.fetchedAt > 600000) void api.news.refresh().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (openId) return <PostReader id={openId} onBack={() => setOpenId(undefined)} />

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <div className="mx-auto max-w-[860px] px-5 pb-16 sm:px-8">
        <PageHeader title="Updates & news" description="New versions of Maris and posts from the people who make it. Checked automatically while you are online.">
          <Button
            size="sm"
            variant="outline"
            disabled={news?.loading || update?.checking}
            onClick={() => void Promise.all([api.updates.check(), api.news.refresh()]).catch(() => undefined)}
          >
            {news?.loading || update?.checking ? <Spinner className="size-3.5" /> : <RefreshCw size={14} />} Check now
          </Button>
        </PageHeader>

        {update && <UpdateCard u={update} />}

        <Section
          title="News"
          description={news?.offline ? 'You are offline. Posts you opened before are still here.' : news?.fetchedAt ? `Last checked ${timeAgo(news.fetchedAt)}.` : undefined}
        >
          {news?.error && <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[0.88rem] text-danger">{news.error}</p>}
          {news && news.unread > 1 && (
            <div className="mb-3 flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => void api.news.markRead('all')}>
                <CheckCheck size={14} /> Mark all as read
              </Button>
            </div>
          )}
          <PostList news={news} onOpen={setOpenId} />
        </Section>
      </div>
    </div>
  )
}

function UpdateCard({ u }: { u: UpdateState }) {
  const [showNotes, setShowNotes] = useState(false)
  const [busy, setBusy] = useState(false)
  const a = u.available
  if (!a) {
    return (
      <p className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-raised/60 px-4 py-3 text-[0.9rem] text-text-2">
        <Sparkles size={16} className="text-petal" aria-hidden />
        <span>
          Maris {u.current} is the newest version
          {u.checkedAt ? ` (checked ${timeAgo(u.checkedAt)})` : ''}.
        </span>
        {u.offline && <span className="text-text-3">Offline right now.</span>}
        {u.error && <span className="text-danger">{u.error}</span>}
      </p>
    )
  }
  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-petal/50 bg-petal-soft" aria-label="Update available">
      <div className="flex flex-wrap items-start gap-4 p-4">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-petal-strong text-on-petal">
          <Rocket size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[1.1rem] font-semibold text-text">{a.name || `Maris ${a.version}`} is available</h2>
          <p className="text-[0.88rem] text-text-2">
            You have {u.current}. Published {longDate(a.publishedAt)}.
          </p>
          {u.downloading !== undefined && (
            <div className="mt-3 max-w-sm">
              <Progress value={u.downloading} label="Downloading the update" />
            </div>
          )}
          {u.error && <p className="mt-2 text-[0.86rem] text-danger">{u.error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {REMOTE ? (
              <span className="text-[0.86rem] text-text-2">Install it on the computer.</span>
            ) : u.downloaded ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void api.updates.install().finally(() => setBusy(false))
                }}
              >
                <Rocket size={14} /> Install now
              </Button>
            ) : a.asset ? (
              <Button variant="primary" size="sm" disabled={u.downloading !== undefined} onClick={() => void api.updates.download()}>
                <Download size={14} /> Download ({Math.max(1, Math.round(a.asset.size / 2 ** 20))} MB)
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void api.updates.openRelease()}>
              <ExternalLink size={14} /> Release page
            </Button>
            {a.notes.trim() && (
              <Button variant="ghost" size="sm" aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
                {showNotes ? 'Hide what is new' : 'What is new'}
              </Button>
            )}
          </div>
          {u.downloaded && !REMOTE && (
            <p className="mt-2 text-[0.8rem] text-text-3">
              {navigator.userAgent.includes('Windows')
                ? 'Maris closes and the installer opens. Your chats, memories and models stay.'
                : 'The new version opens next to this one; replace Maris with it.'}
            </p>
          )}
        </div>
      </div>
      {showNotes && (
        <div className="border-t border-petal/30 bg-raised/70 px-5 py-4">
          <Markdown text={a.notes} />
        </div>
      )}
    </section>
  )
}

function PostList({ news, onOpen }: { news?: NewsState; onOpen: (id: string) => void }) {
  if (!news || (news.loading && !news.posts.length)) {
    return (
      <p className="flex items-center gap-2 text-[0.9rem] text-text-2">
        <Spinner className="size-3.5" /> Looking for posts…
      </p>
    )
  }
  if (!news.posts.length) return <p className="text-[0.9rem] text-text-2">No posts yet. New ones show up here when they are published.</p>
  return (
    <ul className="space-y-3">
      {news.posts.map((p) => (
        <li key={p.id}>
          <button
            onClick={() => onOpen(p.id)}
            className={cn(
              'group flex w-full gap-4 overflow-hidden rounded-xl border bg-raised/60 p-3 text-left transition-colors hover:border-line-strong hover:bg-raised',
              p.unread ? 'border-petal/50' : 'border-line'
            )}
          >
            {p.coverPath && <MediaImg path={p.coverPath} alt="" className="size-20 shrink-0 rounded-lg object-cover sm:h-24 sm:w-36" />}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-[0.76rem] text-text-3">
                <span className="rounded-full bg-sunken px-2 py-0.5 text-text-2">{KIND_WORD[p.kind] ?? 'News'}</span>
                {p.version && <span>Maris {p.version}</span>}
                <span>{longDate(p.date)}</span>
                {p.pinned && <Pin size={12} aria-label="Pinned" />}
                {p.unread && <span className="rounded-full bg-petal-strong px-1.5 text-[0.7rem] font-medium text-on-petal">New</span>}
              </span>
              <span className="mt-1 block text-[1rem] font-medium text-text group-hover:underline">{p.title}</span>
              {p.summary && <span className="mt-0.5 line-clamp-2 block text-[0.88rem] text-text-2">{p.summary}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function PostReader({ id, onBack }: { id: string; onBack: () => void }) {
  const [post, setPost] = useState<NewsPostContent>()
  const [error, setError] = useState('')
  useEffect(() => {
    void api.news
      .post(id)
      .then(setPost)
      .catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')))
  }, [id])
  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="drag h-11" />
      <article className="mx-auto max-w-[760px] px-5 pb-16 sm:px-8">
        <Button size="sm" variant="ghost" className="-ml-2 mb-3" onClick={onBack}>
          <ArrowLeft size={14} /> All posts
        </Button>
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[0.9rem] text-danger">{error}</p>}
        {!post && !error && (
          <p className="flex items-center gap-2 text-text-2">
            <Spinner className="size-3.5" /> Loading…
          </p>
        )}
        {post && (
          <>
            <p className="text-[0.82rem] text-text-3">
              {KIND_WORD[post.entry.kind] ?? 'News'}
              {post.entry.version ? ` · Maris ${post.entry.version}` : ''} · {longDate(post.entry.date)}
              {post.entry.author ? ` · ${post.entry.author}` : ''}
            </p>
            <h1 className="mt-1 font-display text-[2rem] font-light leading-tight text-text">{post.entry.title}</h1>
            <div className="mt-5">
              <Markdown text={post.body} />
            </div>
          </>
        )}
      </article>
    </div>
  )
}
