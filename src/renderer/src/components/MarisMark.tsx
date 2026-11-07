import { cn } from './ui'

// Geometry in a 64×64 box, shared with scripts/maris-mark.cjs (which draws the app and tray icons).
const FACE = 'M16 5H23.8A8.5 8.5 0 0 0 36.8 5H44.6A6 6 0 0 1 50.6 11V37.2A6 6 0 0 1 44.6 43.2H16A6 6 0 0 1 10 37.2V11A6 6 0 0 1 16 5Z'
const CONNECTOR = 'M15.8 45.6H44.8V54.6A3 3 0 0 1 41.8 57.6H18.8A3 3 0 0 1 15.8 54.6Z'
const PINS = [17.5, 23.1, 28.7, 34.3, 39.9]
const RIDGES = 'M15.4 10.6H21.7M15.4 13.6H21.7M38.9 10.6H45.2M38.9 13.6H45.2'
const HIGHLIGHT = 'M11.6 37V11A4.4 4.4 0 0 1 16 6.6H21.9M38.7 6.6H44.6'
const PIXEL_M = 'M22.8 21.5h3v15h-3zM34.8 21.5h3v15h-3zM25.8 24.5h3v3h-3zM31.8 24.5h3v3h-3zM28.8 27.5h3v3h-3z'
const SEAL =
  '45.3 12.7 46.18 15.38 48.69 14.11 47.42 16.62 50.1 17.5 47.42 18.38 48.69 20.89 46.18 19.62 45.3 22.3 44.42 19.62 41.91 20.89 43.18 18.38 40.5 17.5 43.18 16.62 41.91 14.11 44.42 15.38'

/**
 * The Maris mark: a game cartridge in the accent colour, with a pixel M on its label, a gold star seal and
 * gold contacts. Colours come from the theme, so it follows every theme and custom accent.
 * `bloom` plays the entrance: the cartridge slots in and the seal pops on.
 */
export function MarisMark({ size = 24, bloom = false, className }: { size?: number; bloom?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={cn('maris-mark', bloom && 'bloom', className)}>
      <g className="cart">
        <path d={FACE} transform="translate(3.4 3.4)" fill="var(--mark-shade)" />
        <path d={CONNECTOR} fill="var(--mark-deep)" />
        <g fill="var(--pollen)">
          {PINS.map((x) => (
            <rect key={x} x={x} y={49.2} width={3.2} height={6.4} rx={0.8} />
          ))}
        </g>
        <path className="petal" d={FACE} fill="var(--petal)" />
        <path d={RIDGES} stroke="var(--mark-ridge)" strokeWidth={1.3} strokeLinecap="round" />
        <path d={HIGHLIGHT} fill="none" stroke="#fff" strokeOpacity={0.3} strokeWidth={1.4} strokeLinecap="round" />
        <rect x={15.3} y={17.5} width={30} height={23} rx={3} fill="var(--raised)" />
        <path d={PIXEL_M} fill="var(--petal)" />
        <polygon className="seal" points={SEAL} fill="var(--pollen)" stroke="var(--mark-deep)" strokeWidth={0.9} strokeLinejoin="round" />
      </g>
    </svg>
  )
}
