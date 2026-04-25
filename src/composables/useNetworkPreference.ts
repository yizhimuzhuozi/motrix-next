/**
 * @fileoverview Pure functions for the Network preference tab.
 *
 * Manages: proxy, port mapping (UPnP, BT/DHT ports), transfer parameters
 * (connect-timeout, timeout, file-allocation), and User-Agent. All keys
 * here map to aria2 engine options via buildNetworkSystemConfig.
 *
 * Proxy validation logic is co-located here since it is only used in
 * this tab's save flow.
 */
import type { AppConfig } from '@shared/types'
import { PROXY_SCOPES, PROXY_SCOPE_OPTIONS, DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { generateRandomInt } from '@shared/utils'

// ── Proxy Validation ────────────────────────────────────────────────

/** Regex matching URI schemes that aria2 cannot handle as proxy. */
const UNSUPPORTED_PROXY_SCHEME_RE = /^socks[45a-z]*:\/\//i

/**
 * Validates a proxy URL against aria2's `HttpProxyOptionHandler` whitelist.
 *
 * aria2 source (OptionHandlerImpl.cc L509-511) only accepts three scheme
 * prefixes: `http://`, `https://`, `ftp://`.  Any other scheme (e.g.
 * `socks5://`) is prepended with `http://` and then fails `uri::parse()`,
 * crashing the engine with errorCode=28.
 *
 * This function mirrors that whitelist:
 * - Empty string → valid (clears proxy)
 * - `http://…`, `https://…`, `ftp://…` → valid
 * - Bare `HOST:PORT` (no scheme) → valid (aria2 auto-prepends `http://`)
 * - `socks4://`, `socks5://`, etc. → **invalid**
 */
export function isValidAria2ProxyUrl(url: string): boolean {
  if (!url || !url.trim()) return true
  const trimmed = url.trim()

  // Explicitly reject SOCKS and other unsupported schemes
  if (UNSUPPORTED_PROXY_SCHEME_RE.test(trimmed)) return false

  // aria2-accepted schemes
  if (/^(https?|ftp):\/\//i.test(trimmed)) {
    try {
      new URL(trimmed)
      return true
    } catch {
      return false
    }
  }

  // No scheme at all → aria2 prepends http:// automatically
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      new URL('http://' + trimmed)
      return true
    } catch {
      return false
    }
  }

  // Any other scheme (e.g. ws://, custom://) → reject
  return false
}

// ── Types ───────────────────────────────────────────────────────────

export interface NetworkForm {
  [key: string]: unknown
  proxy: {
    enable: boolean
    server: string
    bypass: string
    scope: string[]
  }
  enableUpnp: boolean
  listenPort: number
  dhtListenPort: number
  connectTimeout: number
  timeout: number
  fileAllocation: string
  userAgent: string
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the network form state from the preference store config.
 * All fallback values reference DEFAULT_APP_CONFIG (single source of truth).
 */
export function buildNetworkForm(config: AppConfig): NetworkForm {
  const proxy = config.proxy ?? D.proxy
  return {
    proxy: {
      enable: proxy.enable ?? D.proxy.enable,
      server: proxy.server ?? D.proxy.server,
      bypass: proxy.bypass ?? D.proxy.bypass,
      scope: proxy.scope ?? [...PROXY_SCOPE_OPTIONS],
    },
    enableUpnp: config.enableUpnp ?? D.enableUpnp,
    listenPort: Number(config.listenPort ?? D.listenPort),
    dhtListenPort: Number(config.dhtListenPort ?? D.dhtListenPort),
    connectTimeout: config.connectTimeout ?? D.connectTimeout,
    timeout: config.timeout ?? D.timeout,
    fileAllocation: config.fileAllocation ?? D.fileAllocation,
    userAgent: config.userAgent ?? D.userAgent,
  }
}

/**
 * Converts the network form into aria2 system config key-value pairs.
 * Handles proxy scope filtering: only sets all-proxy if download scope is active.
 */
export function buildNetworkSystemConfig(f: NetworkForm): Record<string, string> {
  const proxyForDownloads =
    f.proxy.enable && Array.isArray(f.proxy.scope) && f.proxy.scope.includes(PROXY_SCOPES.DOWNLOAD)
  return {
    'listen-port': String(f.listenPort),
    'dht-listen-port': String(f.dhtListenPort),
    'enable-dht': 'true',
    'enable-peer-exchange': 'true',
    'user-agent': f.userAgent || '',
    'connect-timeout': String(f.connectTimeout),
    timeout: String(f.timeout),
    'file-allocation': f.fileAllocation || 'none',
    'all-proxy': proxyForDownloads ? f.proxy.server : '',
    'no-proxy': proxyForDownloads ? f.proxy.bypass || '' : '',
  }
}

/**
 * Transforms the network form for store persistence.
 * Preserves port values as numbers and proxy as nested object.
 */
export function transformNetworkForStore(f: NetworkForm): Partial<AppConfig> {
  return { ...f }
}

// ── Form Validation ─────────────────────────────────────────────────

/**
 * Validates the network preference form before saving.
 * Returns null if valid, or an i18n error key if invalid.
 */
export function validateNetworkForm(f: NetworkForm): string | null {
  if (f.proxy.enable && f.proxy.server) {
    if (!isValidAria2ProxyUrl(f.proxy.server)) {
      return UNSUPPORTED_PROXY_SCHEME_RE.test(f.proxy.server.trim())
        ? 'preferences.proxy-unsupported-protocol'
        : 'preferences.invalid-proxy-url'
    }
  }
  return null
}

// ── Port Randomization ──────────────────────────────────────────────

export function randomBtPort(): number {
  return generateRandomInt(20000, 24999)
}

export function randomDhtPort(): number {
  return generateRandomInt(25000, 29999)
}
