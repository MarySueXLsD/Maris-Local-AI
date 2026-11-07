import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import type { SkillInfo } from '@shared/extensions'
import { ollama } from '../engines/ollama'
import { settings } from '../settings'
import { schema, str, ToolError, type ToolDef } from '../tools/types'
import { cosine, Emitter, log, removeTree } from '../util'
import { parseSkillMd, parseSkillSource, type SkillSource } from './parse'
import { unzip } from './unzip'

interface Registry {
  repos: { slug: string; source: string; ref?: string; subpath?: string; installedAt: number; updatedAt?: number }[]
  /** Skills turned off by the person (all new ones are on). */
  disabled: string[]
}

const SKIP = new Set(['.git', 'node_modules', '.github', '__pycache__', '.venv'])

/** What Maris does without a skill. A request has to be closer to a skill than to all of these. */
const ANCHORS = [
  'General conversation: answer questions, explain things, give facts, opinions, jokes and advice.',
  'Work on this computer: find, read and organise files and folders, check hardware, memory, disk space and running programs, run commands.',
  'Look up current information on the web: news, weather forecasts, prices, opening hours, documentation.',
  'Write, debug, build and test code in a software project.',
  'Use a connected service or tool to fetch or save data.'
]
const MATCH_MARGIN = 0.09

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 180000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() })
    )
  })
}

/** Skills: instructions (SKILL.md plus helper files) the assistant can load when a task needs them. */
class Skills {
  readonly changed = new Emitter<SkillInfo[]>()
  private cache?: SkillInfo[]
  /** Embeddings of skill descriptions and anchors, keyed by model and text. */
  private vectors = new Map<string, Float32Array>()

  dir(): string {
    const d = path.join(app.getPath('userData'), 'skills')
    mkdirSync(d, { recursive: true })
    return d
  }

  private registry(): Registry {
    try {
      return JSON.parse(readFileSync(path.join(this.dir(), 'skills.json'), 'utf8')) as Registry
    } catch {
      return { repos: [], disabled: [] }
    }
  }

  private save(r: Registry): void {
    writeFileSync(path.join(this.dir(), 'skills.json'), JSON.stringify(r, null, 2))
    this.cache = undefined
    this.changed.emit(this.list())
  }

  /** Every SKILL.md under the installed sources. */
  list(): SkillInfo[] {
    if (this.cache) return this.cache
    const reg = this.registry()
    const out: SkillInfo[] = []
    for (const repo of reg.repos) {
      const base = path.join(this.dir(), repo.slug)
      const start = repo.subpath ? path.join(base, repo.subpath) : base
      for (const file of findSkillFiles(start, 4)) {
        const folder = path.dirname(file)
        const parsed = parseSkillMd(readFileSync(file, 'utf8'))
        const rel = path.relative(base, folder).replace(/\\/g, '/') || '.'
        const id = `${repo.slug}/${rel}`
        out.push({
          id,
          name: parsed.name || path.basename(folder),
          description: parsed.description,
          source: repo.source,
          dir: folder,
          enabled: !reg.disabled.includes(id),
          installedAt: repo.installedAt,
          updatedAt: repo.updatedAt,
          files: countFiles(folder) - 1
        })
      }
    }
    this.cache = out.sort((a, b) => a.name.localeCompare(b.name))
    return this.cache
  }

  enabled(): SkillInfo[] {
    return settings.get().extensions.skills ? this.list().filter((s) => s.enabled) : []
  }

  setEnabled(id: string, on: boolean): SkillInfo[] {
    const reg = this.registry()
    reg.disabled = reg.disabled.filter((x) => x !== id)
    if (!on) reg.disabled.push(id)
    this.save(reg)
    return this.list()
  }

  /** Install from a git URL (GitHub links to a folder work too) or a folder on this computer. */
  async install(input: string): Promise<SkillInfo[]> {
    const src = parseSkillSource(input)
    const reg = this.registry()
    const slug = uniqueSlug(src.slug, reg, src.source)
    const target = path.join(this.dir(), slug)
    await this.cleanLeftovers()
    const tmp = path.join(this.dir(), `.incoming-${Date.now()}`)
    try {
      await this.fetchSource(src, tmp)
      const start = src.subpath ? path.join(tmp, src.subpath) : tmp
      if (!existsSync(start)) throw new Error(`The folder "${src.subpath}" is not in that repository.`)
      if (!findSkillFiles(start, 4).length) throw new Error('No SKILL.md was found there. A skill is a folder with a SKILL.md file.')
      await removeTree(target)
      await cp(tmp, target, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) || p === tmp })
    } finally {
      await removeTree(tmp).catch((e) => log.warn('skills', `could not remove ${tmp}`, e))
    }
    const now = Date.now()
    const existing = reg.repos.find((r) => r.slug === slug)
    if (existing) existing.updatedAt = now
    else reg.repos.push({ slug, source: src.source, ref: src.ref, subpath: src.subpath, installedAt: now })
    this.save(reg)
    log.info('skills', `installed ${src.source} as ${slug}`)
    return this.list()
  }

  /** Get the newest version of a skill's source (all skills from that repository). */
  async update(id: string): Promise<SkillInfo[]> {
    const slug = id.split('/')[0]!
    const repo = this.registry().repos.find((r) => r.slug === slug)
    if (!repo) throw new Error('Unknown skill')
    return this.install(repo.source)
  }

  /** Remove a skill's whole source (a repository can hold several skills). */
  async remove(id: string): Promise<SkillInfo[]> {
    const slug = id.split('/')[0]!
    const reg = this.registry()
    reg.repos = reg.repos.filter((r) => r.slug !== slug)
    reg.disabled = reg.disabled.filter((x) => !x.startsWith(`${slug}/`))
    await removeTree(path.join(this.dir(), slug))
    this.save(reg)
    return this.list()
  }

  /** Download folders left behind by an install that was interrupted (or by an older Maris that could not delete them). */
  async cleanLeftovers(): Promise<void> {
    try {
      for (const name of readdirSync(this.dir())) {
        if (name.startsWith('.incoming-')) await removeTree(path.join(this.dir(), name)).catch(() => undefined)
      }
    } catch {
      /* nothing to clean */
    }
  }

  read(id: string): string {
    const s = this.list().find((x) => x.id === id)
    if (!s) throw new Error('Unknown skill')
    return readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')
  }

  private async fetchSource(src: SkillSource, dest: string): Promise<void> {
    if (src.kind === 'folder') {
      if (!existsSync(src.source)) throw new Error(`${src.source} does not exist.`)
      await cp(src.source, dest, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) || p === src.source })
      return
    }
    const git = await run('git', ['--version'])
    if (git.code === 0) {
      const args = ['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), src.cloneUrl, dest]
      const r = await run('git', args)
      if (r.code === 0) {
        await removeTree(path.join(dest, '.git'))
        return
      }
      // A half-finished clone would make the zip download fail.
      await removeTree(dest).catch(() => undefined)
      if (!src.zipUrl) throw new Error(`git could not get it: ${r.out.split('\n').slice(-2).join(' ')}`)
      log.warn('skills', `git clone failed, trying the zip download: ${r.out}`)
    }
    if (!src.zipUrl) throw new Error('Installing from this address needs git. Install git, or use a GitHub link.')
    const res = await fetch(src.zipUrl, { headers: { 'User-Agent': 'Maris' }, redirect: 'follow', signal: AbortSignal.timeout(120000) })
    if (!res.ok) throw new Error(res.status === 404 ? 'That repository was not found (or it is private).' : `Download failed (${res.status})`)
    mkdirSync(dest, { recursive: true })
    unzip(Buffer.from(await res.arrayBuffer()), dest, { stripFirst: true })
  }

  /** The skills section of the system prompt: names and one-line descriptions, plus the one that fits this request. */
  promptBlock(fits?: SkillInfo): string {
    const list = this.enabled().slice(0, 60)
    if (!list.length) return ''
    return [
      '## Skills',
      'Skills are instructions for particular kinds of tasks, installed by the user. Before you answer, check this list. If the request fits a skill, your first step is to call use_skill with its name; then follow what it says. Files the skill mentions are in its folder; read them with read_file.',
      ...list.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 280)}`),
      ...(fits ? ['', `This request fits the skill "${fits.name}". Call use_skill with "${fits.name}" before you answer.`] : [])
    ].join('\n')
  }

  /**
   * The skill that clearly fits a request, judged by meaning with the memory embedding model. Small models
   * often answer without checking the skills list; naming the skill in the prompt makes them load it.
   * A skill must be closer to the request than every one of Maris's built-in abilities (ANCHORS) by
   * MATCH_MARGIN. Measured with qwen3-embedding:0.6b: requests a skill was made for scored 0.11 to 0.32
   * above the anchors, other requests at most 0.06.
   */
  async match(request: string): Promise<SkillInfo | undefined> {
    const list = this.enabled()
    const model = settings.get().tiers.embed
    if (!list.length || !model || !request.trim()) return undefined
    try {
      const key = (text: string): string => `${model}\n${text}`
      const texts = [...ANCHORS, ...list.map((s) => `${s.name}: ${s.description}`.slice(0, 2000))]
      const missing = texts.filter((t) => !this.vectors.has(key(t)))
      if (missing.length) (await ollama.embed(model, missing)).forEach((v, i) => this.vectors.set(key(missing[i]), v))
      const query = /qwen3-embedding/i.test(model) ? `Instruct: Given a user request, retrieve the skill whose instructions help carry it out\nQuery: ${request}` : request
      const [q] = await ollama.embed(model, [query.slice(0, 2000)])
      const near = (t: string): number => cosine(q, this.vectors.get(key(t))!)
      const floor = Math.max(...ANCHORS.map(near))
      const best = list.map((s, i) => ({ s, score: near(texts[ANCHORS.length + i]) })).sort((a, b) => b.score - a.score)[0]
      log.info('skills', `closest skill: ${best.s.name} (${(best.score - floor).toFixed(3)} above the built-in abilities)`)
      return best.score - floor >= MATCH_MARGIN ? best.s : undefined
    } catch (e) {
      log.warn('skills', 'could not compare the request with the skills', e)
      return undefined
    }
  }

  tools(): ToolDef[] {
    if (!this.enabled().length) return []
    return [
      {
        name: 'use_skill',
        risk: 'read',
        description: 'Load the full instructions of one of the installed skills listed in the system prompt, by its name.',
        parameters: schema({ name: { type: 'string', description: 'The skill name, exactly as listed' } }, ['name']),
        async prepare(args) {
          return { risk: 'read', title: `Use the skill "${str(args.name, 'name')}"` }
        },
        run: async (args) => {
          const want = str(args.name, 'name').trim().toLowerCase()
          const skill = this.enabled().find((s) => s.name.toLowerCase() === want || s.id.toLowerCase() === want)
          if (!skill) throw new ToolError(`No enabled skill named "${args.name}". Installed: ${this.enabled().map((s) => s.name).join(', ')}`)
          const body = parseSkillMd(readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8')).body
          const others = listFiles(skill.dir, 3).filter((f) => f !== 'SKILL.md').slice(0, 40)
          return [
            `# Skill: ${skill.name}`,
            `Folder: ${skill.dir}`,
            others.length ? `Other files in the folder: ${others.join(', ')}` : '',
            '',
            body.slice(0, 30000)
          ]
            .filter((l) => l !== '')
            .join('\n')
        }
      }
    ]
  }
}

function findSkillFiles(dir: string, depth: number): string[] {
  const out: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  const own = entries.find((e) => e.toLowerCase() === 'skill.md')
  if (own) {
    out.push(path.join(dir, own))
    return out
  }
  if (depth <= 0) return out
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith('.')) continue
    const p = path.join(dir, e)
    try {
      if (statSync(p).isDirectory()) out.push(...findSkillFiles(p, depth - 1))
    } catch {
      /* unreadable */
    }
  }
  return out
}

function listFiles(dir: string, depth: number, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue
    const p = path.join(dir, e)
    const rel = prefix ? `${prefix}/${e}` : e
    if (statSync(p).isDirectory()) {
      if (depth > 0) out.push(...listFiles(p, depth - 1, rel))
    } else out.push(rel)
  }
  return out
}

function countFiles(dir: string): number {
  try {
    return listFiles(dir, 4).length
  } catch {
    return 0
  }
}

function uniqueSlug(base: string, reg: Registry, source: string): string {
  const same = reg.repos.find((r) => r.source === source)
  if (same) return same.slug
  let slug = base
  for (let i = 2; reg.repos.some((r) => r.slug === slug); i++) slug = `${base}-${i}`
  return slug
}

export const skills = new Skills()
