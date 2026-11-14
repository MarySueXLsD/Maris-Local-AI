// What an Ollama server started by Maris is started with. No imports, so tests can load it directly.

/**
 * Settings for an `ollama serve` that Maris starts: one request at a time (Ollama would otherwise keep
 * memory for several conversations in each model), flash attention and a compact context window when
 * chosen in Settings → Engine. What the person set in their own environment is left as it is.
 */
export function serverEnv(e: { flashAttention: boolean; kvCache: 'f16' | 'q8_0' | 'q4_0' }, current: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  if (!current.OLLAMA_NUM_PARALLEL) env.OLLAMA_NUM_PARALLEL = '1'
  if (e.flashAttention && !current.OLLAMA_FLASH_ATTENTION) env.OLLAMA_FLASH_ATTENTION = '1'
  // A smaller context window needs flash attention; without it Ollama keeps the full one.
  if (e.flashAttention && e.kvCache !== 'f16' && !current.OLLAMA_KV_CACHE_TYPE) env.OLLAMA_KV_CACHE_TYPE = e.kvCache
  return env
}
