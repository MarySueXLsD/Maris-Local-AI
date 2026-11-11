// Whether a processor has AVX2 and AVX-512, which decide how fast language models run on it (a
// processor without AVX2 is roughly a third as fast per core). The system is asked first (scan.ts,
// scanPosix.ts); this is the fallback from the processor's name and its family and model numbers,
// for systems that do not say. No imports, so tests/cpu-flags.test.ts can check it.

export interface CpuFlags {
  avx2: boolean
  avx512: boolean
}

// Intel family 6 models without AVX2: Core 2, Nehalem, Westmere, Sandy Bridge, Ivy Bridge …
const INTEL_OLD = new Set([15, 22, 23, 29, 26, 30, 31, 46, 37, 44, 47, 42, 45, 58, 62])
// … and the Atom line up to Tremont (Gracemont, as in the N100, has AVX2).
const INTEL_ATOM = new Set([28, 38, 39, 53, 54, 55, 74, 76, 77, 90, 92, 93, 95, 122, 134, 138, 150, 156])
// Intel models with AVX-512: Skylake-X, Cannon Lake, Ice Lake, Tiger Lake, Rocket Lake, Sapphire and Emerald Rapids.
const INTEL_512 = new Set([85, 102, 106, 108, 125, 126, 140, 141, 143, 167, 207])

/**
 * `name`: the processor's marketing name ("Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz").
 * `identifier`: Windows' PROCESSOR_IDENTIFIER ("Intel64 Family 6 Model 58 Stepping 9, GenuineIntel"), if known.
 */
export function guessCpuFlags(name: string, identifier = ''): CpuFlags {
  const n = name
    .toLowerCase()
    .replace(/\((r|tm)\)/g, '')
    .replace(/\s+/g, ' ')
  // Not x86 (Apple chips, Snapdragon): they have their own vector instructions and count as modern.
  if (/\b(apple|arm|aarch64|snapdragon|qualcomm|cortex|neoverse|ampere)\b/.test(n) || /arm/i.test(identifier)) return { avx2: true, avx512: false }
  const family = Number(/family (\d+)/i.exec(identifier)?.[1])
  const model = Number(/model (\d+)/i.exec(identifier)?.[1])
  const amd = /authenticamd/i.test(identifier) || /\b(amd|ryzen|athlon|phenom|sempron|epyc|threadripper|opteron)\b|\bfx[- ]?\d{4}/.test(n)
  const lowEnd = /celeron|pentium/.test(n)
  if (Number.isFinite(family) && Number.isFinite(model) && family > 0) {
    if (amd) {
      // Excavator (family 21, model 96 and up) and every Zen have AVX2; Zen 4 and Zen 5 add AVX-512.
      const zen4 = family === 25 && ((model >= 16 && model <= 31) || (model >= 96 && model <= 127) || model >= 160)
      return { avx2: family >= 23 || (family === 21 && model >= 96), avx512: family >= 26 || zen4 }
    }
    if (family === 6) {
      if (INTEL_OLD.has(model) || INTEL_ATOM.has(model)) return { avx2: false, avx512: false }
      // Pentium and Celeron versions of the big cores had AVX2 switched off until Alder Lake and Raptor Lake
      // (model numbers do not rise with the years, so those are listed).
      if (lowEnd && ![151, 154, 183, 186, 190, 191].includes(model)) return { avx2: false, avx512: false }
      return { avx2: model >= 60, avx512: INTEL_512.has(model) }
    }
    // Pentium 4 and older.
    if (family < 6 || family === 15) return { avx2: false, avx512: false }
  }
  // Only the name to go by. Each line is a family of processors from before AVX2.
  const OLD_NAMES = [
    /\batom\b|core ?2\b|\bphenom\b|\bsempron\b|\bopteron\b/,
    // Athlon before Zen ("Athlon II X4", "Athlon X4 860K"); the Zen ones are Athlon Gold, Silver and 3000G.
    /\bathlon (ii|x[234]|64|neo)\b/,
    /\bfx[- ]?\d{4}/,
    // AMD A-series and E-series (most of them; the last A-series generation had AVX2 and is undersold here).
    /\b(a(4|6|8|10|12)|e[12])[- ]\d{4}/,
    // Core i of the first three generations: "i7 CPU 920", "i5-750", "i5-2500K", "i7-3770".
    /\bi[357] cpu\b|\bi[357][- ]\d{3}\b|\bi[357][- ][23]\d{3}(?!\d)/,
    // Xeons up to Ivy Bridge: X5650 and friends, and E3/E5/E7 without a "v3" or later.
    /\bxeon cpu [xewl]\d{4}\b/,
    /\be[357][- ]\d{4}\b(?!.* v[3-9])/
  ]
  const old = OLD_NAMES.some((rx) => rx.test(n)) || (lowEnd && !/gold g[78]\d{3}/.test(n))
  const avx512 = /\bryzen (ai|[3579] (pro )?[789]\d{3})|\bepyc (9|8)\d{3}|threadripper (pro )?(7|9)\d{3}|xeon.*(gold|platinum|silver|bronze|w-\d)|\bi[3579]-1[01]\d{2}g\d|\bi[579]-11\d{3}/.test(n)
  return { avx2: !old, avx512: !old && avx512 }
}
