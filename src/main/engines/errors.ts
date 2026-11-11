// Recognising Ollama failures. No imports, so tests/errors.test.ts can check it.

/**
 * Ollama's model process (llama-server) died or dropped the connection mid-request, e.g. "read tcp
 * …: wsarecv: An existing connection was forcibly closed by the remote host". Ollama starts the
 * process again on the next request, so these are worth one retry.
 */
/**
 * A service's way of saying "this conversation is longer than the model takes": "prompt is too long:
 * 215000 tokens > 200000 maximum", "This model's maximum context length is 128000 tokens…". Returns
 * the model's real limit when the message names it.
 */
export function contextOverflow(text: string): { limit?: number } | undefined {
  if (!/(prompt|input|conversation|request|context) (is )?too (long|large)|context[ _](length|window|limit)|maximum context|too many tokens|token limit|reduce the length/i.test(text)) return undefined
  // "…: 215000 tokens > 200000 maximum", "…exceed context limit: 180000 + 64000 > 200000, decrease…"
  const m =
    />\s*(\d{4,9})\b/.exec(text) ??
    /maximum context length (?:is|of) (\d{4,9})/i.exec(text) ??
    /context (?:window|length)(?: of| is|:)? (\d{4,9})/i.exec(text) ??
    /(?:limit|maximum)(?: of| is|:)? (\d{4,9}) tokens/i.exec(text)
  return { limit: m ? Number(m[1]) : undefined }
}

export function isRunnerCrash(text: string): boolean {
  return /forcibly closed|wsarecv|wsasend|connection (was )?reset|ECONNRESET|socket hang up|broken pipe|unexpected EOF|: EOF\b|runner process (has )?(terminated|exited|crashed)|unexpectedly stopped|llama-server.*(exit|terminat)|exit status 0x/i.test(text)
}
