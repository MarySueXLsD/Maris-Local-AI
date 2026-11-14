// Which web addresses read_webpage may open without asking. Reading a page sends its address to the site,
// so an address can carry information out: text in a page or a file can try to talk the model into
// "reading" https://example.com/?d=<something private>. And an address on this computer or the home
// network reaches programs and devices (Ollama, ComfyUI, the router) that act on what they are sent.
// Both ask first; ordinary pages do not. No imports, so tests can load it directly.

/** An address on this computer, the home network or a VPN, by host name or literal IP address. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|lan|home|internal|intranet|corp|home\.arpa)$/.test(h)) return true
  // A name without a dot is a machine on the local network ("router", "nas").
  if (!h.includes('.') && !h.includes(':')) return true
  return isLocalAddress(h)
}

/** A literal IP address that is not on the public internet. */
export function isLocalAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])]
    return p === 0 || p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127) || p >= 224
  }
  if (!a.includes(':')) return false
  return a === '::' || a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
}

/** How much an address carries besides naming a page: its query, fragment and any very long path part. */
export function carriedData(url: URL): number {
  const longest = Math.max(0, ...url.pathname.split('/').map((s) => s.length))
  return url.search.length + url.hash.length + (longest > 80 ? longest : 0)
}

export type WebCheck = { ok: true } | { refuse: string } | { ask: string }

/**
 * Whether read_webpage may open `raw` straight away. `known` says whether the address came from the person
 * or from earlier results in this chat (a search result, a link on a page), which makes a long one fine.
 */
export function checkWebAddress(raw: string, known: (url: string) => boolean): WebCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { refuse: `"${raw}" is not a web address. Give a full address such as https://example.com/page.` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { refuse: `Only web pages (http and https) can be read this way${url.protocol === 'file:' ? '; for a file on this computer use read_file' : ''}.` }
  }
  if (isLocalHost(url.hostname)) {
    return { ask: `${url.host} is on this computer or the home network (a program, a router, a printer…). Opening it can make that program or device do something, so Maris asks first.` }
  }
  const data = carriedData(url)
  if (data > 160 && !known(url.href) && !known(url.href.replace(/#.*$/, ''))) {
    return {
      ask: `This address carries a lot of text to ${url.hostname} (${data} characters after the page name). It did not come from you or from an earlier result, so it could be sending information from this chat or your files to that site.`
    }
  }
  return { ok: true }
}
