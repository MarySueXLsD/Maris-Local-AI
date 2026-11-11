// Where list prices are looked up, and under which maker's name each kind of service finds its
// models there. One line per service, none per model. Pure (no imports).

/** OpenRouter's public model list: no key, nothing sent but the request itself. */
export const PRICE_LIST_URL = 'https://openrouter.ai/api/v1/models'

/**
 * The maker a service's models are listed under, by the service's preset id. Services that resell
 * other makers' models at their own prices (Groq), run on this computer, or give their prices
 * themselves (OpenRouter) are not here.
 */
export const PRICE_VENDOR: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  mistral: 'mistralai',
  deepseek: 'deepseek',
  xai: 'x-ai'
}

export const PRICE_VENDORS = [...new Set(Object.values(PRICE_VENDOR))]
