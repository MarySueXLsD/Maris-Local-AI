import { ArrowLeft, BookOpen, ChevronRight, LifeBuoy, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { cn, inputCls } from '../components/ui'
import { ARTICLES, articleById, CATEGORIES } from '../help/articles'
import { useApp } from '../store'

export function HelpView() {
  const articleId = useApp((s) => s.helpArticle) ?? 'welcome'
  const openHelp = useApp((s) => s.openHelp)
  const [query, setQuery] = useState('')
  const reader = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const article = articleById(articleId) ?? ARTICLES[0]

  useEffect(() => {
    reader.current?.scrollTo({ top: 0 })
    heading.current?.focus()
  }, [articleId])

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    const words = q.split(/\s+/)
    return ARTICLES.map((a) => {
      const title = a.title.toLowerCase()
      const hay = `${title} ${a.summary} ${a.keywords} ${a.body}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) return undefined
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (a.keywords.includes(w) ? 2 : 0) + 1, 0)
      return { a, score }
    })
      .filter((x): x is { a: (typeof ARTICLES)[number]; score: number } => Boolean(x))
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a)
  }, [q])

  const related = ARTICLES.filter((a) => a.category === article.category && a.id !== article.id)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <div className="drag h-11 shrink-0" />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Help articles" className="hidden w-64 shrink-0 flex-col overflow-y-auto px-3 pb-6 md:flex">
          <div className="flex items-center gap-2 px-2 pb-3">
            <LifeBuoy size={18} className="text-petal" aria-hidden />
            <h1 className="font-display text-[1.5rem] font-light text-text">Help</h1>
          </div>
          <label className="relative mb-3 block">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-3" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search help" aria-label="Search help" className={cn(inputCls, 'h-9 py-1 pl-8 text-[0.88rem]')} />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-text-3 hover:text-text">
                <X size={13} />
              </button>
            )}
          </label>
          {q ? (
            <div className="space-y-px" aria-live="polite">
              <p className="px-2.5 pb-1 text-[0.76rem] text-text-3">{results.length ? `${results.length} article${results.length > 1 ? 's' : ''}` : 'No articles match. Try other words.'}</p>
              {results.map((a) => (
                <ArticleLink key={a.id} id={a.id} title={a.title} active={a.id === article.id} onOpen={openHelp} />
              ))}
            </div>
          ) : (
            CATEGORIES.map((cat) => (
              <div key={cat} className="mb-3">
                <h2 className="px-2.5 pb-1 text-[0.76rem] font-medium text-text-3">{cat}</h2>
                <div className="space-y-px">
                  {ARTICLES.filter((a) => a.category === cat).map((a) => (
                    <ArticleLink key={a.id} id={a.id} title={a.title} active={a.id === article.id} onOpen={openHelp} />
                  ))}
                </div>
              </div>
            ))
          )}
        </nav>

        <div ref={reader} className="min-w-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-[720px] px-8 pb-20" aria-labelledby="help-article-title">
            {/* narrow windows: article picker */}
            <div className="mb-4 md:hidden">
              <select aria-label="Choose an article" value={article.id} onChange={(e) => openHelp(e.target.value)} className={cn(inputCls, 'py-1.5')}>
                {ARTICLES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.category}: {a.title}
                  </option>
                ))}
              </select>
            </div>
            <p className="flex items-center gap-1.5 text-[0.8rem] text-text-3">
              <BookOpen size={13} aria-hidden /> {article.category}
            </p>
            <h1 id="help-article-title" ref={heading} tabIndex={-1} className="mt-1 font-display text-[2rem] leading-tight font-light text-text">
              {article.title}
            </h1>
            <p className="mt-2 text-[1.02rem] leading-relaxed text-text-2">{article.summary}</p>
            <div className="mt-6 border-t border-line pt-6">
              <Markdown text={article.body} />
            </div>
            {related.length > 0 && (
              <section className="mt-10 border-t border-line pt-6" aria-label="Related articles">
                <h2 className="text-[0.86rem] font-semibold text-text-2">More in {article.category}</h2>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {related.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => openHelp(a.id)}
                      className="flex items-start gap-2 rounded-xl border border-line bg-raised/60 px-3.5 py-2.5 text-left transition-colors hover:border-line-strong"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[0.92rem] text-text">{a.title}</span>
                        <span className="block text-[0.8rem] leading-snug text-text-3">{a.summary}</span>
                      </span>
                      <ChevronRight size={15} className="mt-1 shrink-0 text-text-3" aria-hidden />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {article.id !== 'welcome' && (
              <button onClick={() => openHelp('welcome')} className="mt-8 inline-flex items-center gap-1.5 text-[0.86rem] text-text-2 hover:text-text">
                <ArrowLeft size={14} /> Back to Welcome
              </button>
            )}
          </article>
        </div>
      </div>
    </div>
  )
}

function ArticleLink({ id, title, active, onOpen }: { id: string; title: string; active: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(id)}
      aria-current={active ? 'page' : undefined}
      className={cn('block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[0.88rem] transition-colors', active ? 'bg-petal-soft text-text' : 'text-text-2 hover:bg-sunken hover:text-text')}
    >
      {title}
    </button>
  )
}
