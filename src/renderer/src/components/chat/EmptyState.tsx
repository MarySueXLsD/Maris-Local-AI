import { Activity, FolderSearch, Globe, ImagePlus } from 'lucide-react'
import { greeting } from '../../lib/format'
import { useApp } from '../../store'
import { MarisMark } from '../MarisMark'
import { DEVICE } from '../../lib/platform'

const IDEAS = [
  { icon: FolderSearch, text: 'Find the 10 largest files in my Downloads folder' },
  { icon: Activity, text: 'What is using my GPU and RAM right now?' },
  { icon: ImagePlus, text: 'Draw a cozy wooden cabin in a snowy forest at dusk, warm light in the windows' },
  { icon: Globe, text: 'What are the most important tech news stories today?' }
]

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const name = useApp((s) => s.settings?.persona.userName)
  const hasModels = useApp((s) => s.models.some((m) => !m.capabilities.includes('embedding')))
  const setView = useApp((s) => s.setView)
  const openHelp = useApp((s) => s.openHelp)
  return (
    <div className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-center px-6 pb-10">
      <MarisMark size={76} bloom />
      <h1 className="mt-6 font-display text-[2.3rem] leading-tight font-light text-text">
        {greeting()}
        {name ? `, ${name}` : ''}
      </h1>
      <p className="mt-2 max-w-[52ch] text-[1rem] leading-relaxed text-text-2">
        Everything here runs on your own {DEVICE}. Maris can look around your files, the system and the web, and it asks before it changes anything.{' '}
        <button className="text-petal underline-offset-2 hover:underline" onClick={() => openHelp('welcome')}>
          New here? A two-minute guide
        </button>
      </p>
      {hasModels ? (
        <div className="mt-8 grid gap-2 sm:grid-cols-2">
          {IDEAS.map(({ icon: Icon, text }) => (
            <button
              key={text}
              onClick={() => onPick(text)}
              className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left text-[0.92rem] leading-snug text-text-2 transition-colors hover:border-line-strong hover:text-text"
            >
              <Icon size={17} className="mt-0.5 shrink-0 text-petal" aria-hidden />
              {text}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-line bg-surface p-4 text-[0.92rem] text-text-2">
          No language model is installed yet.{' '}
          <button className="font-medium text-petal underline underline-offset-2" onClick={() => setView('models')}>
            Open Models
          </button>{' '}
          to download one.
        </div>
      )}
    </div>
  )
}
