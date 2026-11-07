import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Project } from '@shared/types'
import { repo } from '../db'
import { runShell } from '../tools/shell'

export interface ProjectContext {
  name: string
  path: string
  stack: string[]
  topLevel: string
  git?: string
  instructions?: string
  /** The person's own description of the project. */
  about?: string
}

const MARKERS: [RegExp, string][] = [
  [/\.(sln|slnx|csproj)$/i, 'C# / .NET'],
  [/^cargo\.toml$/i, 'Rust (Cargo)'],
  [/^(pyproject\.toml|requirements\.txt|setup\.py|pipfile)$/i, 'Python'],
  [/^package\.json$/i, 'JavaScript / Node'],
  [/^tsconfig\.json$/i, 'TypeScript'],
  [/^project\.xml$/i, 'Haxe (HaxeFlixel / OpenFL / Lime)'],
  [/\.hxml$/i, 'Haxe'],
  [/^cmakelists\.txt$/i, 'C++ (CMake)'],
  [/\.(vcxproj)$/i, 'C++ (MSBuild)'],
  [/^makefile$/i, 'Make'],
  [/^index\.html?$/i, 'Web (HTML/CSS/JS)'],
  [/^go\.mod$/i, 'Go'],
  [/^(pom\.xml|build\.gradle(\.kts)?)$/i, 'Java / Kotlin']
]

const INSTRUCTION_FILES = ['AGENTS.md', 'MARIS.md', 'CLAUDE.md', '.cursorrules', path.join('.github', 'copilot-instructions.md')]

const cache = new Map<string, { at: number; ctx: ProjectContext }>()

export function detectStack(dir: string): string[] {
  const found = new Set<string>()
  const scan = (d: string, depth: number): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      for (const [rx, label] of MARKERS) if (rx.test(name)) found.add(label)
      if (depth < 1 && !/^(node_modules|\.git|bin|obj|target|export|dist|build)$/i.test(name)) {
        const full = path.join(d, name)
        try {
          if (readdirSync(full)) scan(full, depth + 1)
        } catch {
          /* not a folder */
        }
      }
    }
    if (entries.some((n) => n.toLowerCase() === 'source') && existsSync(path.join(d, 'project.xml'))) found.add('Haxe (HaxeFlixel / OpenFL / Lime)')
  }
  scan(dir, 0)
  return [...found]
}

export function touchProject(dir: string): Project {
  const existing = repo.getProject(dir)
  const p: Project = {
    path: existing?.path ?? dir,
    name: existing?.name ?? path.basename(dir),
    lastOpened: Date.now(),
    allowedCommands: existing?.allowedCommands ?? [],
    stack: detectStack(dir),
    description: existing?.description
  }
  repo.upsertProject(p)
  return p
}

/** Rename a project or change what it is about (its folder stays where it is). */
export function updateProject(dir: string, patch: { name?: string; description?: string }): Project {
  const p = repo.getProject(dir) ?? touchProject(dir)
  if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim().slice(0, 80)
  if (patch.description !== undefined) p.description = patch.description.trim().slice(0, 2000) || undefined
  repo.upsertProject(p)
  cache.delete(dir)
  return p
}

export function allowCommand(dir: string, prefix: string): void {
  const p = repo.getProject(dir) ?? touchProject(dir)
  if (!p.allowedCommands.some((c) => c.toLowerCase() === prefix.toLowerCase())) {
    p.allowedCommands.push(prefix)
    repo.upsertProject(p)
  }
}

export async function projectContext(dir: string): Promise<ProjectContext> {
  const hit = cache.get(dir)
  if (hit && Date.now() - hit.at < 30000) return hit.ctx
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') || e.name === '.github')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  } catch {
    /* unreadable */
  }
  let git: string | undefined
  if (existsSync(path.join(dir, '.git'))) {
    const r = await runShell('git -c core.quotepath=off status --short --branch', { cwd: dir, timeoutMs: 8000 }).catch(() => undefined)
    if (r?.stdout) {
      const lines = r.stdout.split('\n')
      git = lines.slice(0, 25).join('\n') + (lines.length > 25 ? `\n… ${lines.length - 25} more changed files` : '')
    }
  }
  let instructions = ''
  for (const f of INSTRUCTION_FILES) {
    const p = path.join(dir, f)
    if (existsSync(p) && instructions.length < 6000) {
      try {
        instructions += `\n### ${f}\n${readFileSync(p, 'utf8').slice(0, 6000 - instructions.length)}`
      } catch {
        /* ignore */
      }
    }
  }
  const saved = repo.getProject(dir)
  const ctx: ProjectContext = {
    name: saved?.name ?? path.basename(dir),
    about: saved?.description,
    path: dir,
    stack: detectStack(dir),
    topLevel: entries.join(', '),
    git,
    instructions: instructions.trim() || undefined
  }
  cache.set(dir, { at: Date.now(), ctx })
  return ctx
}
