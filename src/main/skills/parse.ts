// Pure helpers for skills, without imports, so tests/skills.test.ts can check them directly.

export interface ParsedSkill {
  name: string
  description: string
  /** The instructions after the front matter. */
  body: string
}

/**
 * SKILL.md starts with front matter:
 *   ---
 *   name: pdf-tools
 *   description: Fill in and merge PDF files. Use when …
 *   ---
 * Values may be quoted or folded over several lines (">" or "|").
 */
export function parseSkillMd(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src)
  if (!m) {
    const heading = /^#\s+(.+)$/m.exec(src)?.[1]?.trim() ?? ''
    const para = src.replace(/^#.*$/gm, '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').slice(0, 300) ?? ''
    return { name: heading, description: para, body: src }
  }
  const fields: Record<string, string> = {}
  const lines = m[1]!.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim())
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim()
    } else if (/^["'].*["']$/.test(value)) {
      value = value.slice(1, -1)
    }
    fields[kv[1]!.toLowerCase()] = value
  }
  return { name: fields.name ?? '', description: fields.description ?? '', body: m[2]!.trim() }
}

export interface SkillSource {
  kind: 'git' | 'folder'
  /** What the person entered (normalised), kept for updates. */
  source: string
  cloneUrl: string
  /** GitHub serves a zip when git is not installed. */
  zipUrl?: string
  ref?: string
  /** A folder inside the repository. */
  subpath?: string
  /** Folder name under the skills directory. */
  slug: string
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skills'

/**
 * Accepts https://github.com/owner/repo, …/tree/<branch>/<folder>, owner/repo, git@host:owner/repo.git,
 * any other https git URL, or a folder on this computer.
 */
export function parseSkillSource(input: string): SkillSource {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) throw new Error('Enter a git address or a folder.')
  if (/^[A-Za-z]:[\\/]|^\/|^~[\\/]|^\\\\/.test(s)) {
    return { kind: 'folder', source: s, cloneUrl: s, slug: slugify(s.split(/[\\/]/).filter(Boolean).pop() ?? 'skills') }
  }
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/i.exec(s)
  if (!m && /^[\w.-]+\/[\w.-]+$/.test(s)) m = /^([\w.-]+)\/([\w.-]+)$/.exec(s) as RegExpExecArray
  if (m) {
    const [, owner, repo, ref, sub] = m
    let subpath: string | undefined = sub
    // A link to the SKILL.md file itself means its folder.
    if (subpath && /(^|\/)skill\.md$/i.test(subpath)) subpath = subpath.replace(/\/?skill\.md$/i, '') || undefined
    return {
      kind: 'git',
      source: `https://github.com/${owner}/${repo}${ref ? `/tree/${ref}${subpath ? `/${subpath}` : ''}` : ''}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      zipUrl: `https://github.com/${owner}/${repo}/archive/${ref ? encodeURIComponent(ref) : 'HEAD'}.zip`,
      ref,
      subpath,
      slug: slugify(`${owner}-${repo}${subpath ? `-${subpath.split('/').pop()}` : ''}`)
    }
  }
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(s)) {
    const name = s.replace(/\.git$/i, '').split(/[/:]/).filter(Boolean).slice(-2).join('-')
    return { kind: 'git', source: s, cloneUrl: s, slug: slugify(name) }
  }
  throw new Error('That does not look like a git address. Paste a link such as https://github.com/owner/repository.')
}
