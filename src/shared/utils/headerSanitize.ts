/**
 * @fileoverview HTTP header value sanitization utilities.
 *
 * RFC 7230 §3.2.6: HTTP header field-values MUST NOT contain CR (\r)
 * or LF (\n).  Textarea inputs naturally introduce trailing newlines
 * which, when passed as User-Agent or Referer, produce malformed HTTP
 * requests — some CDNs (e.g. BaiduPCS) respond with HTTP 400.
 *
 * These pure functions detect and strip such characters.
 */

/**
 * Returns `true` if `value` contains any CR (`\r`) or LF (`\n`) characters
 * that are illegal in HTTP header field-values.
 */
export function hasUnsafeHeaderChars(value: string): boolean {
  return /[\r\n]/.test(value)
}

/**
 * Strips all CR/LF characters and trims leading/trailing whitespace.
 * Preserves all other characters including tabs (legal per HTTP obs-fold).
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, '').trim()
}

export interface HttpHeaderOptions {
  userAgent?: string
  referer?: string
  cookie?: string
  authorization?: string
}

export function sanitizeHttpHeaderOptions(options: HttpHeaderOptions): HttpHeaderOptions {
  const sanitized: HttpHeaderOptions = {}

  if (options.userAgent !== undefined) sanitized.userAgent = sanitizeHeaderValue(options.userAgent)
  if (options.referer !== undefined) sanitized.referer = sanitizeHeaderValue(options.referer)
  if (options.cookie !== undefined) sanitized.cookie = sanitizeHeaderValue(options.cookie)
  if (options.authorization !== undefined) sanitized.authorization = sanitizeHeaderValue(options.authorization)

  return sanitized
}
