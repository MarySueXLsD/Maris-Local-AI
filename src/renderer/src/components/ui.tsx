import { clsx, type ClassValue } from 'clsx'
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Switch as RSwitch, Tooltip as RTooltip } from 'radix-ui'
import { twMerge } from 'tailwind-merge'

export const cn = (...v: ClassValue[]): string => twMerge(clsx(v))

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'
  size?: 'sm' | 'md'
}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'outline', size = 'md', className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[0.85rem]' : 'h-9 px-4 text-[0.92rem]',
        variant === 'primary' && 'bg-petal-strong text-on-petal hover:bg-petal',
        variant === 'outline' && 'border border-line-strong text-text hover:bg-sunken',
        variant === 'ghost' && 'text-text-2 hover:bg-sunken hover:text-text',
        variant === 'subtle' && 'bg-sunken text-text hover:bg-petal-soft',
        variant === 'danger' && 'bg-danger-soft text-danger hover:bg-danger hover:text-white',
        className
      )}
    />
  )
})

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root delayDuration={350}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-80 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[0.8rem] leading-snug text-text shadow-float"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tip?: boolean }

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton(
  { label, active, className, children, tip = true, ...rest },
  ref
) {
  const btn = (
    <button
      ref={ref}
      aria-label={label}
      aria-pressed={active}
      {...rest}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-text-2 transition-colors hover:bg-sunken hover:text-text disabled:opacity-40',
        active && 'bg-petal-soft text-petal hover:bg-petal-soft hover:text-petal',
        className
      )}
    >
      {children}
    </button>
  )
  return tip ? <Tip label={label}>{btn}</Tip> : btn
})

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cn('flex items-start justify-between gap-6 py-2.5', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block text-[0.95rem] text-text">{label}</span>
        {description && <span className="mt-0.5 block text-[0.84rem] leading-snug text-text-2">{description}</span>}
      </span>
      <RSwitch.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={label}
        className="relative mt-0.5 h-[22px] w-[40px] shrink-0 rounded-full border border-line-strong bg-sunken transition-colors data-[state=checked]:border-petal-strong data-[state=checked]:bg-petal-strong"
      >
        <RSwitch.Thumb className="block size-[14px] translate-x-[3px] rounded-full bg-text-2 transition-transform data-[state=checked]:translate-x-[21px] data-[state=checked]:bg-on-petal" />
      </RSwitch.Root>
    </label>
  )
}

/** A small On/Off checkbox for list rows. It flips at once and goes back if saving fails. */
export function RowToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => Promise<unknown>; label: string }) {
  const [on, setOn] = useState(checked)
  useEffect(() => setOn(checked), [checked])
  return (
    <label className="flex shrink-0 items-center gap-2 text-[0.82rem] text-text-2">
      <input
        type="checkbox"
        className="size-4 accent-petal"
        checked={on}
        aria-label={label}
        onChange={(e) => {
          const v = e.target.checked
          setOn(v)
          onChange(v).catch(() => setOn(!v))
        }}
      />
      {on ? 'On' : 'Off'}
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md'
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 font-medium transition-colors',
            size === 'sm' ? 'h-7 text-[0.8rem]' : 'h-8 text-[0.88rem]',
            value === o.value ? 'bg-raised text-text shadow-sm' : 'text-text-2 hover:text-text'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-spin text-pollen', className)} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Progress({ value, label, tone = 'petal' }: { value: number; label: string; tone?: 'petal' | 'pollen' }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
      <div className={cn('h-full rounded-full transition-[width] duration-500', tone === 'petal' ? 'bg-petal' : 'bg-pollen')} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-sunken px-1.5 py-px font-sans text-[0.75rem] text-text-2">{children}</kbd>
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block py-2.5">
      <span className="block text-[0.95rem] text-text">{label}</span>
      {hint && <span className="mt-0.5 block text-[0.84rem] leading-snug text-text-2">{hint}</span>}
      <span className="mt-2 block">{children}</span>
    </label>
  )
}

export const inputCls =
  'w-full rounded-lg border border-line-strong bg-raised px-3 py-2 text-[0.95rem] text-text placeholder:text-text-3 focus:border-petal focus:outline-none'

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line py-6 first:border-t-0 first:pt-0">
      <h2 className="font-display text-[1.15rem] font-semibold text-text">{title}</h2>
      {description && <p className="mt-1 max-w-[62ch] text-[0.88rem] leading-relaxed text-text-2">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function PageHeader({ title, children, description }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div>
        <h1 className="font-display text-[1.9rem] font-light leading-tight text-text">{title}</h1>
        {description && <p className="mt-1.5 max-w-[64ch] text-[0.92rem] leading-relaxed text-text-2">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  )
}
