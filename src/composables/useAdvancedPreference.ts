/**
 * @fileoverview Pure functions extracted from Advanced.vue for testability.
 *
 * Contains configuration transforms, secret generation, and port randomization
 * logic that was previously inline in the component's script setup.
 */
import { ENGINE_RPC_PORT, PROXY_SCOPES, PROXY_SCOPE_OPTIONS, DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { convertCommaToLine, convertLineToComma, generateRandomInt } from '@shared/utils'
import { isValidAria2ProxyUrl, UNSUPPORTED_PROXY_SCHEME_RE } from '@shared/utils/aria2Proxy'
import type { AppConfig } from '@shared/types'

export { isValidAria2ProxyUrl } from '@shared/utils/aria2Proxy'

// ── URL Validation ──────────────────────────────────────────────────

/**
 * Validates whether a string is a valid HTTP/HTTPS URL suitable for use as a
 * tracker source. Custom tracker sources are fetched via axios GET, so only
 * HTTP-based protocols are accepted.
 *
 * Exported for unit testing and use in Advanced.vue's tracker source validation.
 */
export function isValidTrackerSourceUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface AdvancedForm {
  [key: string]: unknown
  proxy: {
    enable: boolean
    server: string
    bypass: string
    scope: string[]
  }
  trackerSource: string[]
  customTrackerUrls: string[]
  btTracker: string
  autoSyncTracker: boolean
  lastSyncTrackerTime: number
  rpcListenPort: number
  rpcSecret: string
  extensionApiPort: number
  extensionApiSecret: string
  autoSubmitFromExtension: boolean
  enableUpnp: boolean
  listenPort: number
  dhtListenPort: number
  userAgent: string
  logLevel: string
  hardwareRendering: boolean
  // Clipboard detection (migrated from legacy Basic tab)
  clipboardEnable: boolean
  clipboardHttp: boolean
  clipboardFtp: boolean
  clipboardMagnet: boolean
  clipboardThunder: boolean
  clipboardBtHash: boolean
  // Protocol handlers (migrated from legacy Basic tab)
  protocolMagnet: boolean
  protocolThunder: boolean
  protocolMotrixnext: boolean
  // Timeout & disk (shared with Network tab but kept for backward compat)
  connectTimeout: number
  timeout: number
  fileAllocation: string
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Generates a cryptographically random secret string of 16 alphanumeric chars.
 * Used for aria2 RPC authentication.
 */
export function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

/**
 * Builds the advanced form state from the preference store config.
 * All fallback values reference DEFAULT_APP_CONFIG (single source of truth).
 * If no RPC secret exists, generates one.
 */
export function buildAdvancedForm(config: AppConfig): {
  form: AdvancedForm
  generatedSecret: string | null
  generatedApiSecret: string | null
} {
  const proxy = config.proxy ?? D.proxy
  // Distinguish "never set" (undefined/null → auto-generate) from
  // "intentionally cleared" ('' → respect user choice).
  const hasSecret = config.rpcSecret != null
  const rpcSecret = hasSecret ? config.rpcSecret : generateSecret()
  const generatedSecret = hasSecret ? null : rpcSecret

  // Extension API secret: auto-generate if never set
  const hasApiSecret = config.extensionApiSecret != null
  const extensionApiSecret = hasApiSecret ? config.extensionApiSecret! : generateSecret()
  const generatedApiSecret: string | null = hasApiSecret ? null : extensionApiSecret

  return {
    form: {
      proxy: {
        enable: proxy.enable ?? D.proxy.enable,
        server: proxy.server ?? D.proxy.server,
        bypass: proxy.bypass ?? D.proxy.bypass,
        scope: proxy.scope ?? [...PROXY_SCOPE_OPTIONS],
      },
      trackerSource: config.trackerSource ?? [...D.trackerSource],
      customTrackerUrls: config.customTrackerUrls ?? [...D.customTrackerUrls],
      btTracker: convertCommaToLine(config.btTracker ?? D.btTracker),
      autoSyncTracker: config.autoSyncTracker ?? D.autoSyncTracker,
      lastSyncTrackerTime: config.lastSyncTrackerTime ?? D.lastSyncTrackerTime,
      rpcListenPort: config.rpcListenPort ?? D.rpcListenPort,
      rpcSecret,
      extensionApiPort: config.extensionApiPort ?? D.extensionApiPort,
      extensionApiSecret,
      autoSubmitFromExtension: config.autoSubmitFromExtension ?? D.autoSubmitFromExtension,
      enableUpnp: config.enableUpnp ?? D.enableUpnp,
      listenPort: Number(config.listenPort ?? D.listenPort),
      dhtListenPort: Number(config.dhtListenPort ?? D.dhtListenPort),
      userAgent: config.userAgent ?? D.userAgent,
      logLevel: config.logLevel ?? D.logLevel,
      hardwareRendering: config.hardwareRendering ?? D.hardwareRendering,
      // Clipboard detection
      clipboardEnable: config.clipboard?.enable ?? D.clipboard.enable,
      clipboardHttp: config.clipboard?.http ?? D.clipboard.http,
      clipboardFtp: config.clipboard?.ftp ?? D.clipboard.ftp,
      clipboardMagnet: config.clipboard?.magnet ?? D.clipboard.magnet,
      clipboardThunder: config.clipboard?.thunder ?? D.clipboard.thunder,
      clipboardBtHash: config.clipboard?.btHash ?? D.clipboard.btHash,
      // Protocol handlers
      protocolMagnet: config.protocols?.magnet ?? D.protocols.magnet,
      protocolThunder: config.protocols?.thunder ?? D.protocols.thunder,
      protocolMotrixnext: config.protocols?.motrixnext ?? D.protocols.motrixnext,
      // Timeout & disk
      connectTimeout: config.connectTimeout ?? D.connectTimeout,
      timeout: config.timeout ?? D.timeout,
      fileAllocation: config.fileAllocation ?? D.fileAllocation,
    },
    generatedSecret,
    generatedApiSecret,
  }
}

/**
 * Converts the advanced form into aria2 system config key-value pairs.
 * Pure function — no side effects.
 */
export function buildAdvancedSystemConfig(f: AdvancedForm): Record<string, string> {
  const proxyForDownloads =
    f.proxy.enable && Array.isArray(f.proxy.scope) && f.proxy.scope.includes(PROXY_SCOPES.DOWNLOAD)
  return {
    'rpc-listen-port': String(f.rpcListenPort),
    'rpc-secret': f.rpcSecret,
    'enable-dht': 'true',
    'enable-peer-exchange': 'true',
    'listen-port': String(f.listenPort),
    'dht-listen-port': String(f.dhtListenPort),
    'user-agent': f.userAgent || '',
    'log-level': f.logLevel || 'debug',
    'bt-tracker': convertLineToComma(f.btTracker),
    'all-proxy': proxyForDownloads ? f.proxy.server : '',
    'no-proxy': proxyForDownloads ? f.proxy.bypass || '' : '',
  }
}

/**
 * Transforms the advanced form for store persistence.
 * Collapses flat clipboard/protocol fields into nested objects and
 * normalizes tracker format.
 */
export function transformAdvancedForStore(f: AdvancedForm): Record<string, unknown> {
  const {
    clipboardEnable,
    clipboardHttp,
    clipboardFtp,
    clipboardMagnet,
    clipboardThunder,
    clipboardBtHash,
    protocolMagnet,
    protocolThunder,
    protocolMotrixnext,
    ...rest
  } = f
  return {
    ...rest,
    btTracker: convertLineToComma(f.btTracker),
    clipboard: {
      enable: clipboardEnable,
      http: clipboardHttp,
      ftp: clipboardFtp,
      magnet: clipboardMagnet,
      thunder: clipboardThunder,
      btHash: clipboardBtHash,
    },
    protocols: {
      magnet: protocolMagnet,
      thunder: protocolThunder,
      motrixnext: protocolMotrixnext,
    },
  }
}

// ── Form validation ─────────────────────────────────────────────────

/**
 * Validates the advanced preference form before saving.
 * Returns null if valid, or an i18n error key if invalid.
 */
export function validateAdvancedForm(f: AdvancedForm): string | null {
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

export function randomRpcPort(): number {
  return generateRandomInt(ENGINE_RPC_PORT, 20000)
}

export function randomBtPort(): number {
  return generateRandomInt(20000, 24999)
}

export function randomDhtPort(): number {
  return generateRandomInt(25000, 29999)
}
