/** @fileoverview aria2 proxy URL validation helpers. */

/** Regex matching URI schemes that aria2 cannot handle as proxy. */
export const UNSUPPORTED_PROXY_SCHEME_RE = /^socks[45a-z]*:\/\//i

/**
 * Validates a proxy URL against aria2's `HttpProxyOptionHandler` whitelist.
 *
 * aria2 accepts `http://`, `https://`, `ftp://`, and bare `HOST:PORT`
 * values. SOCKS/custom schemes are rejected before they can crash the engine.
 */
export function isValidAria2ProxyUrl(url: string): boolean {
  if (!url || !url.trim()) return true
  const trimmed = url.trim()

  if (UNSUPPORTED_PROXY_SCHEME_RE.test(trimmed)) return false

  if (/^(https?|ftp):\/\//i.test(trimmed)) {
    try {
      new URL(trimmed)
      return true
    } catch {
      return false
    }
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      new URL(`http://${trimmed}`)
      return true
    } catch {
      return false
    }
  }

  return false
}
