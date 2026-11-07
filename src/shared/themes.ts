// Colour themes. "maris" follows Settings → Theme (light/dark/system) using the palettes in styles.css;
// every other theme is a complete palette applied as CSS variables, and "custom" is built from five colours.

export type Scheme = 'light' | 'dark'

export interface ThemeTokens {
  scheme: Scheme
  ink: string
  text: string
  text2: string
  text3: string
  paper: string
  side: string
  surface: string
  raised: string
  sunken: string
  line: string
  lineStrong: string
  petal: string
  petalStrong: string
  petalSoft: string
  onPetal: string
  pollen: string
  pollenSoft: string
  danger: string
  dangerSoft: string
  ok: string
  okSoft: string
  codeBg: string
  shadow: string
  /** Neon themes light up primary buttons, focus rings and the logo. */
  glow: boolean
}

export interface ThemeDef {
  id: string
  name: string
  description: string
  tokens?: ThemeTokens
}

export interface CustomThemeColors {
  scheme: Scheme
  background: string
  surface: string
  text: string
  accent: string
  highlight: string
  glow: boolean
}

// ------------------------------------------------------------------ colour helpers

function rgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return [128, 128, 128]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const hex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
export const alpha = (c: string, a: number): string => {
  const [r, g, b] = rgb(c)
  return `rgb(${r} ${g} ${b} / ${a})`
}
/** Mix two colours; t = 0 gives a, t = 1 gives b. */
export const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a)
  const y = rgb(b)
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
export function luminance(c: string): number {
  const ch = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Derive a full palette from the five colours a person picks. */
export function tokensFromColors(c: CustomThemeColors): ThemeTokens {
  const dark = c.scheme === 'dark'
  const onAccent = contrast(c.accent, '#ffffff') >= contrast(c.accent, '#0d0b14') ? '#ffffff' : '#0d0b14'
  return {
    scheme: c.scheme,
    ink: dark ? c.background : c.text,
    text: c.text,
    text2: mix(c.text, c.background, 0.32),
    text3: mix(c.text, c.background, 0.52),
    paper: c.background,
    side: alpha(c.background, 0.9),
    surface: alpha(c.surface, 0.96),
    raised: dark ? mix(c.surface, c.text, 0.05) : mix(c.surface, '#ffffff', 0.6),
    sunken: dark ? 'rgb(0 0 0 / 0.2)' : alpha(c.text, 0.045),
    line: alpha(c.text, dark ? 0.13 : 0.1),
    lineStrong: alpha(c.text, dark ? 0.24 : 0.18),
    petal: c.accent,
    petalStrong: dark ? c.accent : mix(c.accent, '#000000', 0.1),
    petalSoft: alpha(c.accent, dark ? 0.16 : 0.11),
    onPetal: onAccent,
    pollen: c.highlight,
    pollenSoft: alpha(c.highlight, dark ? 0.15 : 0.18),
    danger: dark ? '#ff8597' : '#c62f45',
    dangerSoft: dark ? 'rgb(255 133 151 / 0.12)' : 'rgb(198 47 69 / 0.1)',
    ok: dark ? '#72d6a8' : '#1e8a5a',
    okSoft: dark ? 'rgb(114 214 168 / 0.12)' : 'rgb(30 138 90 / 0.1)',
    codeBg: mix(c.background, c.text, dark ? 0.05 : 0.025),
    shadow: dark ? '0 1px 2px rgb(0 0 0 / 0.3), 0 10px 32px rgb(0 0 0 / 0.32)' : `0 1px 2px ${alpha(c.text, 0.06)}, 0 8px 28px ${alpha(c.text, 0.08)}`,
    glow: c.glow
  }
}

// ------------------------------------------------------------------ presets

const def = (id: string, name: string, description: string, colors: CustomThemeColors, overrides: Partial<ThemeTokens> = {}): ThemeDef & { colors: CustomThemeColors } => ({
  id,
  name,
  description,
  colors,
  tokens: { ...tokensFromColors(colors), ...overrides }
})
const c = (scheme: Scheme, background: string, surface: string, text: string, accent: string, highlight: string, glow = false): CustomThemeColors => ({
  scheme,
  background,
  surface,
  text,
  accent,
  highlight,
  glow
})

export const THEMES: (ThemeDef & { colors?: CustomThemeColors })[] = [
  { id: 'maris', name: 'Maris', description: 'Violet and gold. Follows the light or dark setting below.' },
  def('neon-purple', 'Neon Purple', 'Electric violet on near-black, with cyan highlights and a soft glow.', c('dark', '#0b0614', '#120a22', '#f1e9ff', '#c06bff', '#39f0ff', true), {
    petalStrong: '#a944ff',
    raised: '#1b1031'
  }),
  def('neon-pink', 'Neon Pink', 'Hot pink on midnight plum, with electric cyan. Glows.', c('dark', '#12040d', '#1a0714', '#ffe9f5', '#ff3ea5', '#2ee6ff', true), {
    petalStrong: '#ff1f93',
    raised: '#260a1d'
  }),
  def('sakura', 'Sakura', 'Soft blossom pink on warm white. Light and calm.', c('light', '#fff5f8', '#ffffff', '#3b1f2b', '#e2457f', '#c77d12')),
  def('midnight', 'Midnight', 'Deep navy with sky blue and a warm yellow accent.', c('dark', '#0a1220', '#0f1a2e', '#e6eefc', '#5aa9ff', '#ffcf5a')),
  def('forest', 'Forest', 'Dark pine green with mint and honey.', c('dark', '#0c1512', '#111d19', '#e3f2ea', '#46d39a', '#f2c14e')),
  def('ember', 'Ember', 'Warm charcoal with glowing amber and a cool blue spark.', c('dark', '#16100c', '#1e1611', '#f7ebe0', '#ff9a3d', '#5ad1ff')),
  def('daylight', 'Daylight', 'Crisp white and ink with a clear blue accent, for bright rooms.', c('light', '#f7f8fa', '#ffffff', '#16202e', '#2f6fde', '#b26b00')),
  { id: 'custom', name: 'Custom', description: 'Your own colours: background, panels, text, accent and highlight.' }
]

/** Preview colours of the built-in Maris palettes (styles.css), for theme cards. */
export const MARIS_PREVIEW: Record<Scheme, { paper: string; side: string; raised: string; text: string; text3: string; petal: string; pollen: string }> = {
  light: { paper: '#f4f3f9', side: '#ecebf3', raised: '#ffffff', text: '#1b1830', text3: '#8a86a0', petal: '#6a4fe0', pollen: '#a86a08' },
  dark: { paper: '#15131f', side: '#1a1826', raised: '#232036', text: '#ecebf6', text3: '#77738f', petal: '#a493ff', pollen: '#f2b544' }
}

/** The palette a theme resolves to, or undefined for the built-in Maris light/dark palettes. */
export function themeTokens(id: string, custom: CustomThemeColors): ThemeTokens | undefined {
  if (id === 'custom') return tokensFromColors(custom)
  return THEMES.find((t) => t.id === id)?.tokens
}

/** Light or dark for Windows (title bar buttons, Mica tint); "system" lets Windows decide. */
export function themeScheme(id: string, custom: CustomThemeColors, maris: 'system' | 'light' | 'dark'): 'system' | Scheme {
  if (id === 'maris' || !id) return maris
  return themeTokens(id, custom)?.scheme ?? maris
}

/** CSS custom properties for a palette (names match styles.css). */
export function cssVars(t: ThemeTokens): Record<string, string> {
  return {
    '--ink': t.ink,
    '--text': t.text,
    '--text-2': t.text2,
    '--text-3': t.text3,
    '--paper': t.paper,
    '--side': t.side,
    '--surface': t.surface,
    '--raised': t.raised,
    '--sunken': t.sunken,
    '--line': t.line,
    '--line-strong': t.lineStrong,
    '--petal': t.petal,
    '--petal-strong': t.petalStrong,
    '--petal-soft': t.petalSoft,
    '--on-petal': t.onPetal,
    '--pollen': t.pollen,
    '--pollen-soft': t.pollenSoft,
    '--danger': t.danger,
    '--danger-soft': t.dangerSoft,
    '--ok': t.ok,
    '--ok-soft': t.okSoft,
    '--code-bg': t.codeBg,
    '--shadow': t.shadow
  }
}
