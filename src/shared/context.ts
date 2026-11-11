// Context window sizes: how much of a conversation a model sees at once. The sizes Settings and the
// context ring offer, and how a size is written. Pure, shared by the main process and the interface.

/** For models on this computer, in Ollama's units of 1024: from 4K up to 2M. */
export const LOCAL_CONTEXT_SIZES = [4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144, 393216, 524288, 1048576, 2097152]

/** For models at an API service, in the round numbers the services use: from 16K up to 2M. */
export const API_CONTEXT_SIZES = [16384, 32768, 65536, 131072, 200000, 400000, 1000000, 2000000]

/** What the context ring offers for a model on this computer (fewer steps than Settings). */
export const RING_CONTEXT_SIZES = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152]

/** A size as people say it: 32768 is "32K", 200000 "200K", 1048576 "1M", 1500000 "1.5M". */
export function contextLabel(n: number): string {
  const unit = n % 1024 === 0 ? 1024 : 1000
  const round = (x: number): string => String(Math.round(x * 10) / 10)
  const k = n / unit
  return k >= unit ? `${round(k / unit)}M` : `${round(k)}K`
}

/**
 * The sizes to offer for one model: the standard ones it can take, its own limit as the largest, and
 * the size in use now, so the current choice is always among them.
 */
export function sizesFor(standard: readonly number[], current: number, max?: number): number[] {
  const list = standard.filter((n) => !max || n <= max)
  if (max) list.push(max)
  if (!max || current <= max) list.push(current)
  return [...new Set(list)].sort((a, b) => a - b)
}

/**
 * How much of a model's window Maris fills with the conversation at an API service: four fifths. The
 * rest is for the answer, which shares the window, and for the difference between Maris's token
 * estimates and the service's own count (newer models count more tokens for the same text).
 */
export function usableWindow(takes: number): number {
  return Math.max(4096, Math.floor(takes * 0.8) - 2048)
}
