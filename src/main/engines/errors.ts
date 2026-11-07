// Recognising Ollama failures. No imports, so tests/errors.test.ts can check it.

/**
 * Ollama's model process (llama-server) died or dropped the connection mid-request, e.g. "read tcp
 * …: wsarecv: An existing connection was forcibly closed by the remote host". Ollama starts the
 * process again on the next request, so these are worth one retry.
 */
export function isRunnerCrash(text: string): boolean {
  return /forcibly closed|wsarecv|wsasend|connection (was )?reset|ECONNRESET|socket hang up|broken pipe|unexpected EOF|: EOF\b|runner process (has )?(terminated|exited|crashed)|unexpectedly stopped|llama-server.*(exit|terminat)|exit status 0x/i.test(text)
}
