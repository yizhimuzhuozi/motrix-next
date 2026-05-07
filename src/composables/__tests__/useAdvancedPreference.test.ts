/**
 * @fileoverview Tests for useAdvancedPreference pure functions.
 *
 * HONESTY NOTE: These test REAL pure functions — no mocks of the module
 * under test. Only crypto.getRandomValues is validated via output properties.
 */
import { describe, it, expect } from 'vitest'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  isValidAria2ProxyUrl,
  isValidTrackerSourceUrl,
  randomRpcPort,
  randomBtPort,
  randomDhtPort,
  type AdvancedForm,
} from '../useAdvancedPreference'
import { ENGINE_RPC_PORT, PROXY_SCOPES, PROXY_SCOPE_OPTIONS, DEFAULT_APP_CONFIG } from '@shared/constants'
import { diffConfig } from '@shared/utils/config'
import type { AppConfig } from '@shared/types'

// ── isValidTrackerSourceUrl ─────────────────────────────────────────

describe('isValidTrackerSourceUrl', () => {
  // ── Valid URLs ────────────────────────────────────────────────────

  it('accepts HTTPS URL', () => {
    expect(isValidTrackerSourceUrl('https://trackers.run/s/wp_up_hp_hs_v4_v6.txt')).toBe(true)
  })

  it('accepts HTTP URL', () => {
    expect(isValidTrackerSourceUrl('http://example.com/trackers.txt')).toBe(true)
  })

  it('accepts HTTPS URL with path, query, and fragment', () => {
    expect(isValidTrackerSourceUrl('https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt?v=2#top')).toBe(
      true,
    )
  })

  it('accepts URL with port number', () => {
    expect(isValidTrackerSourceUrl('https://trackers.example.com:8443/list.txt')).toBe(true)
  })

  it('accepts URL with authentication', () => {
    expect(isValidTrackerSourceUrl('https://user:pass@trackers.example.com/list.txt')).toBe(true)
  })

  // ── Trimming ─────────────────────────────────────────────────────

  it('accepts URL with leading/trailing whitespace (trimmed)', () => {
    expect(isValidTrackerSourceUrl('  https://trackers.run/list.txt  ')).toBe(true)
  })

  // ── Invalid protocols ────────────────────────────────────────────

  it('rejects FTP URL', () => {
    expect(isValidTrackerSourceUrl('ftp://files.example.com/trackers.txt')).toBe(false)
  })

  it('rejects UDP URL', () => {
    expect(isValidTrackerSourceUrl('udp://tracker.example.com:6969/announce')).toBe(false)
  })

  it('rejects WSS URL', () => {
    expect(isValidTrackerSourceUrl('wss://tracker.example.com/announce')).toBe(false)
  })

  it('rejects magnet link', () => {
    expect(isValidTrackerSourceUrl('magnet:?xt=urn:btih:abc')).toBe(false)
  })

  it('rejects file URL', () => {
    expect(isValidTrackerSourceUrl('file:///etc/trackers.txt')).toBe(false)
  })

  // ── Malformed input ──────────────────────────────────────────────

  it('rejects plain text', () => {
    expect(isValidTrackerSourceUrl('not-a-url')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidTrackerSourceUrl('')).toBe(false)
  })

  it('rejects whitespace-only string', () => {
    expect(isValidTrackerSourceUrl('   ')).toBe(false)
  })

  it('rejects URL without scheme', () => {
    expect(isValidTrackerSourceUrl('trackers.run/list.txt')).toBe(false)
  })

  it('rejects string with only scheme', () => {
    expect(isValidTrackerSourceUrl('https://')).toBe(false)
  })
})

// ── buildAdvancedForm — custom tracker source URLs ──────────────────

describe('buildAdvancedForm — custom tracker source URLs', () => {
  it('preserves custom tracker source URLs alongside preset ones', () => {
    const customUrl = 'https://trackers.run/s/wp_up_hp_hs_v4_v6.txt'
    const presetUrl = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt'
    const config = {
      ...DEFAULT_APP_CONFIG,
      trackerSource: [presetUrl, customUrl],
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.trackerSource).toHaveLength(2)
    expect(form.trackerSource).toContain(presetUrl)
    expect(form.trackerSource).toContain(customUrl)
  })

  it('preserves only custom URLs when no presets selected', () => {
    const config = {
      ...DEFAULT_APP_CONFIG,
      trackerSource: ['https://my-tracker.example.com/list.txt'],
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.trackerSource).toEqual(['https://my-tracker.example.com/list.txt'])
  })

  it('preserves empty trackerSource array', () => {
    const config = { ...DEFAULT_APP_CONFIG, trackerSource: [] as string[] } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.trackerSource).toEqual([])
  })
})

// ── generateSecret ──────────────────────────────────────────────────

describe('generateSecret', () => {
  it('returns a 16-character string', () => {
    const secret = generateSecret()
    expect(secret).toHaveLength(16)
  })

  it('contains only alphanumeric characters', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('generates different values on successive calls', () => {
    const s1 = generateSecret()
    const s2 = generateSecret()
    // Cryptographic randomness: extremely unlikely to be equal
    expect(s1).not.toBe(s2)
  })
})

// ── buildAdvancedForm ───────────────────────────────────────────────

describe('buildAdvancedForm', () => {
  const emptyConfig = {} as AppConfig

  it('returns defaults for empty config', () => {
    const { form } = buildAdvancedForm(emptyConfig)
    expect(form.proxy.enable).toBe(false)
    expect(form.proxy.server).toBe('')
    // Default scope must include ALL scopes so proxy works on first enable
    // (legacy Motrix behavior — scope defaults to PROXY_SCOPE_OPTIONS)
    expect(form.proxy.scope).toEqual(expect.arrayContaining([PROXY_SCOPES.DOWNLOAD]))
    expect(form.proxy.scope).toHaveLength(PROXY_SCOPE_OPTIONS.length)
    expect(form.rpcListenPort).toBe(ENGINE_RPC_PORT)
    expect(form.listenPort).toBe(21301)
    expect(form.dhtListenPort).toBe(26701)
    expect(form.logLevel).toBe('debug')
    expect(form.enableUpnp).toBe(true)
  })

  it('generates a secret and flags it when none exists', () => {
    const { form, generatedSecret } = buildAdvancedForm(emptyConfig)
    expect(form.rpcSecret).toHaveLength(16)
    expect(generatedSecret).toBe(form.rpcSecret)
  })

  it('uses existing secret and does not flag it', () => {
    const config = { rpcSecret: 'myExistingSecret' } as AppConfig
    const { form, generatedSecret } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe('myExistingSecret')
    expect(generatedSecret).toBeNull()
  })

  it('preserves explicitly empty secret without regenerating', () => {
    const config = { rpcSecret: '' } as AppConfig
    const { form, generatedSecret } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe('')
    expect(generatedSecret).toBeNull()
  })

  it('preserves proxy configuration', () => {
    const config = {
      proxy: { enable: true, server: 'socks5://127.0.0.1:1080', bypass: '*.local', scope: ['download'] },
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.proxy.enable).toBe(true)
    expect(form.proxy.server).toBe('socks5://127.0.0.1:1080')
    expect(form.proxy.bypass).toBe('*.local')
    expect(form.proxy.scope).toEqual(['download'])
  })

  it('converts comma-separated trackers to newline format', () => {
    const config = { btTracker: 'udp://t1.org:6969,udp://t2.org:6969' } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.btTracker).toContain('\n')
    expect(form.btTracker).toContain('udp://t1.org:6969')
  })

  it('handles enableUpnp=false explicitly', () => {
    const config = { enableUpnp: false } as unknown as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.enableUpnp).toBe(false)
  })

  it('coerces string port values to numbers', () => {
    const config = { listenPort: '12345' as unknown, dhtListenPort: '54321' as unknown } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.listenPort).toBe(12345)
    expect(form.dhtListenPort).toBe(54321)
  })
})

// ── buildAdvancedSystemConfig ───────────────────────────────────────

describe('buildAdvancedSystemConfig', () => {
  const baseForm: AdvancedForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    trackerSource: [],
    customTrackerUrls: [],
    btTracker: 'udp://t1.org:6969\nudp://t2.org:6969',
    autoSyncTracker: false,
    lastSyncTrackerTime: 0,
    rpcListenPort: 16800,
    rpcSecret: 'testSecret',
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    userAgent: '',
    logLevel: 'warn',
    hardwareRendering: false,
    extensionApiPort: 16801,
    extensionApiSecret: 'test-api-secret',
    autoSubmitFromExtension: false,
    clipboardEnable: true,
    clipboardHttp: true,
    clipboardFtp: false,
    clipboardMagnet: true,
    clipboardThunder: false,
    clipboardBtHash: true,
    protocolMagnet: false,
    protocolThunder: false,
    protocolMotrixnext: true,
    connectTimeout: 60,
    timeout: 60,
    fileAllocation: 'prealloc',
  }

  it('maps all required aria2 config keys', () => {
    const config = buildAdvancedSystemConfig(baseForm)
    expect(config['rpc-listen-port']).toBe('16800')
    expect(config['rpc-secret']).toBe('testSecret')
    expect(config['enable-dht']).toBe('true')
    expect(config['enable-peer-exchange']).toBe('true')
    expect(config['listen-port']).toBe('21301')
    expect(config['dht-listen-port']).toBe('26701')
    expect(config['log-level']).toBe('warn')
  })

  it('converts newline trackers to comma-separated', () => {
    const config = buildAdvancedSystemConfig(baseForm)
    expect(config['bt-tracker']).toBe('udp://t1.org:6969,udp://t2.org:6969')
  })

  it('sets proxy when enabled for downloads', () => {
    const proxyForm: AdvancedForm = {
      ...baseForm,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    }
    const config = buildAdvancedSystemConfig(proxyForm)
    expect(config['all-proxy']).toBe('http://proxy:8080')
    expect(config['no-proxy']).toBe('*.local')
  })

  it('clears proxy when not enabled for downloads', () => {
    const noProxyForm: AdvancedForm = {
      ...baseForm,
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '*.local', scope: ['app'] },
    }
    const config = buildAdvancedSystemConfig(noProxyForm)
    expect(config['all-proxy']).toBe('')
    expect(config['no-proxy']).toBe('')
  })

  it('clears proxy when proxy is disabled', () => {
    const disabledForm: AdvancedForm = {
      ...baseForm,
      proxy: { enable: false, server: 'http://proxy:8080', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    }
    const config = buildAdvancedSystemConfig(disabledForm)
    expect(config['all-proxy']).toBe('')
  })
})

// ── transformAdvancedForStore ────────────────────────────────────────

describe('transformAdvancedForStore', () => {
  it('converts trackers back to comma format', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: 'udp://a\nudp://b',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'warn',
      hardwareRendering: false,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const result = transformAdvancedForStore(form)
    expect(result.btTracker).toBe('udp://a,udp://b')
  })

  it('preserves port numbers as numbers (not strings)', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'warn',
      hardwareRendering: false,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const result = transformAdvancedForStore(form)
    expect(result.listenPort).toBe(21301)
    expect(typeof result.listenPort).toBe('number')
    expect(result.dhtListenPort).toBe(26701)
    expect(typeof result.dhtListenPort).toBe('number')
  })

  it('round-trip: buildAdvancedForm → transformAdvancedForStore produces no phantom diff', () => {
    // This is the exact scenario that caused the bug: config → form → store → diffConfig
    // should report ZERO changes when the user didn't touch anything.
    const config = {
      listenPort: 21301,
      dhtListenPort: 26701,
      rpcListenPort: 16800,
      rpcSecret: 'existingSecret',
      enableUpnp: false,
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    const stored = transformAdvancedForStore(form)
    const diff = diffConfig(config as Record<string, unknown>, stored)
    // None of the restart-relevant keys should appear in the diff
    expect(diff).not.toHaveProperty('listenPort')
    expect(diff).not.toHaveProperty('dhtListenPort')
    expect(diff).not.toHaveProperty('rpcListenPort')
    expect(diff).not.toHaveProperty('rpcSecret')
  })
})

// ── isValidAria2ProxyUrl ────────────────────────────────────────────

describe('isValidAria2ProxyUrl', () => {
  // ── Valid inputs ──────────────────────────────────────────────────

  it('accepts empty string (clears proxy)', () => {
    expect(isValidAria2ProxyUrl('')).toBe(true)
  })

  it('accepts whitespace-only string', () => {
    expect(isValidAria2ProxyUrl('   ')).toBe(true)
  })

  it('accepts http:// proxy', () => {
    expect(isValidAria2ProxyUrl('http://127.0.0.1:8080')).toBe(true)
  })

  it('accepts https:// proxy', () => {
    expect(isValidAria2ProxyUrl('https://proxy.example.com:443')).toBe(true)
  })

  it('accepts ftp:// proxy', () => {
    expect(isValidAria2ProxyUrl('ftp://proxy.example.com:21')).toBe(true)
  })

  it('accepts http:// with user:password', () => {
    expect(isValidAria2ProxyUrl('http://user:pass@proxy.example.com:8080')).toBe(true)
  })

  it('accepts bare HOST:PORT (no scheme)', () => {
    expect(isValidAria2ProxyUrl('127.0.0.1:8080')).toBe(true)
  })

  it('accepts bare hostname (no port, no scheme)', () => {
    expect(isValidAria2ProxyUrl('proxy.example.com')).toBe(true)
  })

  it('accepts URL with leading/trailing whitespace', () => {
    expect(isValidAria2ProxyUrl('  http://proxy:8080  ')).toBe(true)
  })

  // ── Rejected inputs ───────────────────────────────────────────────

  it('rejects socks5:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks5://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks4:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks4://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks5h:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks5h://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks4a:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks4a://127.0.0.1:1080')).toBe(false)
  })

  it('rejects SOCKS5:// (case-insensitive)', () => {
    expect(isValidAria2ProxyUrl('SOCKS5://127.0.0.1:1080')).toBe(false)
  })

  it('rejects ws:// scheme', () => {
    expect(isValidAria2ProxyUrl('ws://proxy:8080')).toBe(false)
  })

  it('rejects custom:// scheme', () => {
    expect(isValidAria2ProxyUrl('custom://proxy:8080')).toBe(false)
  })
})

// ── validateAdvancedForm ────────────────────────────────────────────

describe('validateAdvancedForm', () => {
  const validForm: AdvancedForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    trackerSource: [],
    customTrackerUrls: [],
    btTracker: '',
    autoSyncTracker: false,
    lastSyncTrackerTime: 0,
    rpcListenPort: 16800,
    rpcSecret: 'validSecret',
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    userAgent: '',
    logLevel: 'warn',
    hardwareRendering: false,
    extensionApiPort: 16801,
    extensionApiSecret: 'test-api-secret',
    autoSubmitFromExtension: false,
    clipboardEnable: true,
    clipboardHttp: true,
    clipboardFtp: false,
    clipboardMagnet: true,
    clipboardThunder: false,
    clipboardBtHash: true,
    protocolMagnet: false,
    protocolThunder: false,
    protocolMotrixnext: true,
    connectTimeout: 60,
    timeout: 60,
    fileAllocation: 'prealloc',
  }

  it('returns null for valid form', () => {
    expect(validateAdvancedForm(validForm)).toBeNull()
  })

  it('returns null when rpcSecret is empty (security warning handled by UI dialog)', () => {
    expect(validateAdvancedForm({ ...validForm, rpcSecret: '' })).toBeNull()
  })

  it('returns null for valid proxy URL when proxy enabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'http://proxy.example.com:8080' },
      }),
    ).toBeNull()
  })

  it('returns invalid-proxy-url for malformed URL when proxy enabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'http://:invalid:url:' },
      }),
    ).toBe('preferences.invalid-proxy-url')
  })

  it('returns proxy-unsupported-protocol for socks5 when proxy enabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBe('preferences.proxy-unsupported-protocol')
  })

  it('returns proxy-unsupported-protocol for socks4 when proxy enabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'socks4://127.0.0.1:1080' },
      }),
    ).toBe('preferences.proxy-unsupported-protocol')
  })

  it('returns null for invalid proxy URL when proxy disabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: false, server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBeNull()
  })

  it('returns null for empty proxy server when proxy enabled', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: '' },
      }),
    ).toBeNull()
  })
})

// ── Port Randomizers ────────────────────────────────────────────────

describe('port randomizers', () => {
  it('randomRpcPort stays within [ENGINE_RPC_PORT, 20000)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomRpcPort()
      expect(port).toBeGreaterThanOrEqual(ENGINE_RPC_PORT)
      expect(port).toBeLessThan(20000)
    }
  })

  it('randomBtPort stays within [20000, 24999)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomBtPort()
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThan(24999)
    }
  })

  it('randomDhtPort stays within [25000, 29999)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomDhtPort()
      expect(port).toBeGreaterThanOrEqual(25000)
      expect(port).toBeLessThan(29999)
    }
  })
})

// ── Proxy Configuration Invariants ──────────────────────────────────

describe('proxy configuration invariants', () => {
  it('DEFAULT_APP_CONFIG.proxy.scope includes all PROXY_SCOPE_OPTIONS', () => {
    // Regression guard: the root cause of #81 was scope defaulting to []
    // instead of PROXY_SCOPE_OPTIONS, which silently disabled all proxy routing.
    const { form } = buildAdvancedForm({} as AppConfig)
    expect(form.proxy.scope).toEqual([...PROXY_SCOPE_OPTIONS])
  })

  it('buildAdvancedForm preserves user-selected subset of scopes', () => {
    const config = {
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.proxy.scope).toEqual([PROXY_SCOPES.DOWNLOAD])
  })

  it('enabling proxy with default scope produces non-empty all-proxy', () => {
    // End-to-end: the exact user flow from issue #81.
    // 1. Fresh install → buildAdvancedForm({}) → form with default scope
    // 2. User toggles enable=true and enters server
    // 3. buildAdvancedSystemConfig → all-proxy MUST be the server value
    const { form } = buildAdvancedForm({} as AppConfig)
    form.proxy.enable = true
    form.proxy.server = 'http://127.0.0.1:7890'
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['all-proxy']).toBe('http://127.0.0.1:7890')
    expect(systemConfig['no-proxy']).toBe('')
  })

  it('disabling proxy produces empty-string all-proxy (for clearing)', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: 'http://127.0.0.1:7890', bypass: '', scope: [...PROXY_SCOPE_OPTIONS] },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'debug',
      hardwareRendering: false,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    // Empty string is intentional — aria2 accepts '' to clear the proxy
    expect(systemConfig['all-proxy']).toBe('')
    expect(systemConfig['no-proxy']).toBe('')
  })

  it('proxy with download scope excluded produces empty all-proxy', () => {
    const form: AdvancedForm = {
      proxy: {
        enable: true,
        server: 'http://127.0.0.1:7890',
        bypass: '',
        scope: [PROXY_SCOPES.UPDATE_APP, PROXY_SCOPES.UPDATE_TRACKERS],
      },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'debug',
      hardwareRendering: false,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['all-proxy']).toBe('')
  })

  it('proxy bypass value is forwarded to no-proxy when download scope active', () => {
    const form: AdvancedForm = {
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '192.168.0.0/16,*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'debug',
      hardwareRendering: false,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['all-proxy']).toBe('http://proxy:8080')
    expect(systemConfig['no-proxy']).toBe('192.168.0.0/16,*.local')
  })
})

// ── hardwareRendering — Linux GPU toggle ────────────────────────────

describe('buildAdvancedForm — hardwareRendering', () => {
  it('defaults hardwareRendering to true (GPU acceleration ON)', () => {
    const { form } = buildAdvancedForm({} as AppConfig)
    expect(form.hardwareRendering).toBe(true)
  })

  it('preserves hardwareRendering=true from config', () => {
    const config = { hardwareRendering: true } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.hardwareRendering).toBe(true)
  })

  it('preserves hardwareRendering=false from config', () => {
    const config = { hardwareRendering: false } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.hardwareRendering).toBe(false)
  })
})

describe('transformAdvancedForStore — hardwareRendering', () => {
  it('preserves hardwareRendering in store output', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
      trackerSource: [],
      customTrackerUrls: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'warn',
      hardwareRendering: true,
      extensionApiPort: 16801,
      extensionApiSecret: 'test-api-secret',
      autoSubmitFromExtension: false,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      protocolMagnet: false,
      protocolThunder: false,
      protocolMotrixnext: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const result = transformAdvancedForStore(form)
    expect(result.hardwareRendering).toBe(true)
  })
})

describe('DEFAULT_APP_CONFIG — hardwareRendering', () => {
  it('defaults to true (GPU acceleration ON)', () => {
    expect(DEFAULT_APP_CONFIG.hardwareRendering).toBe(true)
  })
})
