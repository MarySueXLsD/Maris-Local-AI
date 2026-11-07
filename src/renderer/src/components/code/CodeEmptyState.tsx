import { Bug, FileText, FolderOpen, Gamepad2, Hammer, Map, Package, Terminal } from 'lucide-react'
import { useApp } from '../../store'
import { MarisMark } from '../MarisMark'
import { Button } from '../ui'

const EXISTING = [
  { icon: Map, text: 'Give me a quick tour of this project: structure, entry points and how to build and run it.' },
  { icon: Hammer, text: 'Build the project and run the tests, then fix anything that fails.' },
  { icon: Bug, text: 'Look for bugs, crashes and risky code, and suggest fixes with the reasons.' },
  { icon: FileText, text: 'Write a README with setup, build, run and test instructions.' }
]

const NEW = [
  { icon: Gamepad2, text: 'Create a HaxeFlixel game here: a player that runs and jumps on platforms, built for html5.' },
  { icon: Package, text: 'Create a C# .NET console app with a class library and xUnit tests, then build and test it.' },
  { icon: Terminal, text: 'Create a Rust command-line tool with clap that counts words in files, with unit tests.' },
  { icon: Map, text: 'Create a responsive landing page with HTML, CSS and vanilla JavaScript.' }
]

export function CodeEmptyState({ onPick }: { onPick: (text: string) => void }) {
  const project = useApp((s) => s.project)
  const projects = useApp((s) => s.projects)
  const openProject = useApp((s) => s.openProject)
  const openHelp = useApp((s) => s.openHelp)

  if (!project) {
    return (
      <div className="mx-auto flex h-full w-full max-w-[680px] flex-col justify-center px-6 pb-10">
        <MarisMark size={64} bloom />
        <h1 className="mt-6 font-display text-[2.1rem] leading-tight font-light text-text">Open a project</h1>
        <p className="mt-2 max-w-[54ch] text-[1rem] leading-relaxed text-text-2">
          Pick a folder with your code, or an empty folder for something new. Maris explores it, edits files, builds and runs your tests, and
          tells you in plain words what it did. It asks before it changes anything.{' '}
          <button className="text-petal underline-offset-2 hover:underline" onClick={() => openHelp('code-mode')}>
            How Code mode works
          </button>
        </p>
        <div className="mt-6">
          <Button variant="primary" onClick={() => void openProject()}>
            <FolderOpen size={16} /> Open folder
          </Button>
        </div>
        {projects.length > 0 && (
          <div className="mt-8">
            <h2 className="text-[0.84rem] font-medium text-text-2">Recent projects</h2>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {projects.slice(0, 6).map((p) => (
                <li key={p.path}>
                  <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunken" onClick={() => void openProject(p.path)}>
                    <FolderOpen size={15} className="shrink-0 text-petal" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.92rem] text-text">{p.name}</span>
                      <span className="block truncate text-[0.76rem] text-text-3">{p.path}</span>
                    </span>
                    {p.stack?.[0] && <span className="shrink-0 text-[0.76rem] text-text-3">{p.stack[0]}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  const fresh = !project.stack || project.stack.length === 0
  const ideas = fresh ? NEW : EXISTING
  return (
    <div className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-center px-6 pb-10">
      <MarisMark size={56} bloom />
      <h1 className="mt-5 font-display text-[2rem] leading-tight font-light text-text">
        {fresh ? `What should we build in ${project.name}?` : `Working in ${project.name}`}
      </h1>
      <p className="mt-2 text-[0.95rem] text-text-2">
        {fresh ? 'This folder looks empty, so Maris can start a project from scratch.' : `Detected: ${project.stack!.join(', ')}.`}
      </p>
      <div className="mt-7 grid gap-2 sm:grid-cols-2">
        {ideas.map(({ icon: Icon, text }) => (
          <button
            key={text}
            onClick={() => onPick(text)}
            className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left text-[0.9rem] leading-snug text-text-2 transition-colors hover:border-line-strong hover:text-text"
          >
            <Icon size={17} className="mt-0.5 shrink-0 text-petal" aria-hidden />
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}
