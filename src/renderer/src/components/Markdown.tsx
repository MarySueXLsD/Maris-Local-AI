import { Check, Copy } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { isPageLink, pageNames, splitPages } from '@shared/pages'
import { SECTIONS } from '../views/settings/schema'
import { api } from '../lib/api'
import { DEVICE, PLATFORM } from '../lib/platform'
import { useApp } from '../store'
import { MediaImg } from './Media'

// ------------------------------------------------------------------ paths in answers
import { isWholePath, splitPaths } from '../lib/paths'

type MdNode = { type: string; value?: string; url?: string; title?: string | null; children?: MdNode[] }

/** A remark step that turns paths in plain text into "path:" links. */
function remarkPaths() {
  return (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      const kids = node.children
      if (!kids) return
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]!
        if (child.type === 'link' || child.type === 'linkReference' || child.type === 'code' || child.type === 'inlineCode' || child.type === 'html') continue
        if (child.type !== 'text') {
          walk(child)
          continue
        }
        const parts = splitPaths(child.value ?? '')
        if (!parts.some((p) => p.path)) continue
        const nodes: MdNode[] = parts.map((p) => (p.path ? { type: 'link', url: `path:${encodeURIComponent(p.path)}`, title: null, children: [{ type: 'text', value: p.text }] } : { type: 'text', value: p.text }))
        kids.splice(i, 1, ...nodes)
        i += nodes.length - 1
      }
    }
    walk(tree)
  }
}

const PAGE_NAMES = pageNames(SECTIONS)

/**
 * A remark step that turns the names of Maris's own pages ("Models → API", "Settings → Phone") into
 * "page:" links, wherever they are written: in an answer (also in bold), in a help article, in a post.
 */
function remarkPages() {
  return (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      const kids = node.children
      if (!kids) return
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]!
        if (child.type === 'link' || child.type === 'linkReference' || child.type === 'code' || child.type === 'inlineCode' || child.type === 'html') continue
        if (child.type !== 'text') {
          walk(child)
          continue
        }
        const parts = splitPages(child.value ?? '', PAGE_NAMES)
        if (!parts.some((p) => p.page)) continue
        const nodes: MdNode[] = parts.map((p) => (p.page ? { type: 'link', url: `page:${p.page}`, title: null, children: [{ type: 'text', value: p.text }] } : { type: 'text', value: p.text }))
        kids.splice(i, 1, ...nodes)
        i += nodes.length - 1
      }
    }
    walk(tree)
  }
}

const FILE_MANAGER = PLATFORM === 'win32' ? 'Explorer' : PLATFORM === 'darwin' ? 'Finder' : 'the file manager'

/** Open a path from an answer; say so when it does not exist. */
function reveal(p: string): void {
  void api.shell
    .reveal(p)
    .then((r) => {
      if (r === 'missing') useApp.setState({ error: `${p} does not exist on this ${DEVICE} (any more).` })
    })
    .catch(() => undefined)
}

function PathLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={`path:${encodeURIComponent(path)}`}
      className="path-link"
      title={`Open in ${FILE_MANAGER}`}
      onClick={(e) => {
        e.preventDefault()
        reveal(path)
      }}
    >
      {children}
    </a>
  )
}

const WHOLE_PATH = (s: string): boolean => {
  if (isWholePath(s)) return true
  const parts = splitPaths(s.trim())
  return parts.length === 1 && Boolean(parts[0]?.path)
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

const LANG_NAME: Record<string, string> = {
  py: 'Python',
  python: 'Python',
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  cs: 'C#',
  csharp: 'C#',
  cpp: 'C++',
  'c++': 'C++',
  rust: 'Rust',
  rs: 'Rust',
  haxe: 'Haxe',
  hx: 'Haxe',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  bash: 'Shell',
  sh: 'Shell'
}

function CodeBlock({ className, children, collapse }: { className?: string; children?: ReactNode; collapse?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(!collapse)
  const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1]
  const raw = textOf(children).replace(/\n$/, '')
  if (!open) {
    const lines = raw.split('\n').length
    return (
      <button
        onClick={() => setOpen(true)}
        className="my-2 flex w-full items-center gap-2 rounded-xl border border-line bg-code px-3 py-2 text-left text-[0.84rem] text-text-2 hover:border-line-strong hover:text-text"
        title="Code is folded away in Simple view. Click to show it."
      >
        <span className="font-mono text-text-3">{'</>'}</span>
        <span className="flex-1">
          {LANG_NAME[lang?.toLowerCase() ?? ''] ?? 'Code'}, {lines} line{lines === 1 ? '' : 's'}
        </span>
        <span className="text-[0.8rem] text-petal">Show code</span>
      </button>
    )
  }
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border border-line bg-code">
      <div className="flex h-8 items-center justify-between border-b border-line px-3 text-[0.78rem] text-text-3">
        <span>{lang ?? 'text'}</span>
        <button
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-text-2 hover:bg-sunken hover:text-text"
          onClick={() => {
            void navigator.clipboard.writeText(raw)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[0.86rem] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}

/** Links to help articles ("help:approvals"), Maris's own pages ("page:models/api") and paths ("path:…") are kept; everything else goes through the safe default. */
const keepHelpLinks = (url: string): string => (/^help:[a-z0-9-]+$/i.test(url) || isPageLink(url) || /^path:/.test(url) ? url : defaultUrlTransform(url))
/** Picture sources are checked by MarkdownImage, which only shows local or embedded pictures. */
const transformUrl = (url: string, key: string): string => (key === 'src' ? url : keepHelpLinks(url))

/**
 * Pictures in Markdown: Maris's own cached files (news posts), embedded data (the post editor's
 * preview) or names the caller resolves. Pictures on the internet are never loaded directly.
 */
function MarkdownImage({ src, alt, resolve }: { src: string; alt: string; resolve?: (src: string) => string | undefined }) {
  const s = resolve?.(src) ?? src
  const cls = 'my-3 block h-auto max-h-[520px] max-w-full rounded-xl border border-line'
  if (s.startsWith('maris-media://file/')) return <MediaImg path={decodeURIComponent(s.slice('maris-media://file/'.length))} alt={alt} className={cls} />
  if (/^data:image\//i.test(s)) return <img src={s} alt={alt} className={cls} />
  return alt ? <span className="text-text-3">[{alt}]</span> : null
}

export const Markdown = memo(function Markdown({
  text,
  streaming,
  collapseCode,
  resolveImage
}: {
  text: string
  streaming?: boolean
  collapseCode?: boolean
  /** Maps picture paths in the text to data URLs or maris-media URLs (the post editor's preview). */
  resolveImage?: (src: string) => string | undefined
}) {
  return (
    <div className={`prose-maris selectable ${streaming ? 'caret' : ''}`}>
      <ReactMarkdown
        urlTransform={transformUrl}
        remarkPlugins={[remarkGfm, remarkMath, remarkPaths, remarkPages]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }], rehypeKatex]}
        components={{
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children
            const props = (child as { props?: { className?: string; children?: ReactNode } })?.props ?? {}
            return (
              <CodeBlock className={props.className} collapse={collapseCode}>
                {props.children}
              </CodeBlock>
            )
          },
          a: ({ href, children }) =>
            href?.startsWith('path:') ? (
              <PathLink path={decodeURIComponent(href.slice(5))}>{children}</PathLink>
            ) : (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href?.startsWith('help:')) useApp.getState().openHelp(href.slice(5))
                  else if (href?.startsWith('page:')) useApp.getState().openPage(href)
                  else if (href && /^https?:/i.test(href)) void api.shell.openExternal(href)
                  else if (href) reveal(href)
                }}
                title={href?.startsWith('help:') ? 'Open this help article' : href?.startsWith('page:') ? 'Open this page in Maris' : href}
              >
                {children}
              </a>
            ),
          // A path written as code (`C:\Users\me\notes.txt`) opens too.
          code: ({ className, children }) => {
            const raw = textOf(children)
            if (!className && !raw.includes('\n') && WHOLE_PATH(raw)) {
              return (
                <code className={className}>
                  <PathLink path={raw.trim()}>{children}</PathLink>
                </code>
              )
            }
            return <code className={className}>{children}</code>
          },
          table: ({ children }) => <table>{children}</table>,
          img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} resolve={resolveImage} />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
