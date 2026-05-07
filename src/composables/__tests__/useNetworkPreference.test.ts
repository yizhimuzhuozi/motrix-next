/**
 * @fileoverview Tests for useNetworkPreference pure functions.
 *
 * The Network tab manages proxy, port mapping, transfer parameters (timeouts,
 * file allocation), and User-Agent. All keys here map to aria2 engine options
 * via buildNetworkSystemConfig.
 *
 * Proxy validation logic (isValidAria2ProxyUrl, validateNetworkForm) and
 * port randomizers (randomBtPort, randomDhtPort) are also covered here.
 */
import { describe, it, expect } from 'vitest'
import {
  buildNetworkForm,
  buildNetworkSystemConfig,
  transformNetworkForStore,
  validateNetworkForm,
  isValidAria2ProxyUrl,
  randomBtPort,
  randomDhtPort,
  type NetworkForm,
} from '../useNetworkPreference'
import { PROXY_SCOPES, PROXY_SCOPE_OPTIONS, DEFAULT_APP_CONFIG } from '@shared/constants'
import type { AppConfig } from '@shared/types'

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

// ── buildNetworkForm ────────────────────────────────────────────────

describe('buildNetworkForm', () => {
  const emptyConfig = {} as AppConfig

  // ── Proxy ───────────────────────────────────────────────────────

  it('defaults proxy.enable to false', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.proxy.enable).toBe(false)
  })

  it('defaults proxy.server to empty string', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.proxy.server).toBe('')
  })

  it('default scope includes ALL scopes so proxy works on first enable', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.proxy.scope).toEqual(expect.arrayContaining([PROXY_SCOPES.DOWNLOAD]))
    expect(form.proxy.scope).toHaveLength(PROXY_SCOPE_OPTIONS.length)
  })

  it('preserves proxy configuration from config', () => {
    const config = {
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '*.local', scope: ['download'] },
    } as AppConfig
    const form = buildNetworkForm(config)
    expect(form.proxy.enable).toBe(true)
    expect(form.proxy.server).toBe('http://127.0.0.1:7890')
    expect(form.proxy.bypass).toBe('*.local')
    expect(form.proxy.scope).toEqual(['download'])
  })

  it('preserves user-selected subset of scopes', () => {
    const config = {
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    } as AppConfig
    const form = buildNetworkForm(config)
    expect(form.proxy.scope).toEqual([PROXY_SCOPES.DOWNLOAD])
  })

  // ── Ports ───────────────────────────────────────────────────────

  it('defaults enableUpnp to true', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.enableUpnp).toBe(true)
  })

  it('handles enableUpnp=false explicitly', () => {
    const config = { enableUpnp: false } as unknown as AppConfig
    const form = buildNetworkForm(config)
    expect(form.enableUpnp).toBe(false)
  })

  it('defaults listenPort to 21301', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.listenPort).toBe(21301)
  })

  it('defaults dhtListenPort to 26701', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.dhtListenPort).toBe(26701)
  })

  it('coerces string port values to numbers', () => {
    const config = { listenPort: '12345' as unknown, dhtListenPort: '54321' as unknown } as AppConfig
    const form = buildNetworkForm(config)
    expect(form.listenPort).toBe(12345)
    expect(form.dhtListenPort).toBe(54321)
  })

  // ── Transfer Parameters ─────────────────────────────────────────

  it('defaults connectTimeout to 10', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.connectTimeout).toBe(10)
  })

  it('reads connectTimeout from config', () => {
    const config = { connectTimeout: 30 } as unknown as AppConfig
    const form = buildNetworkForm(config)
    expect(form.connectTimeout).toBe(30)
  })

  it('defaults timeout to 10', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.timeout).toBe(10)
  })

  it('reads timeout from config', () => {
    const config = { timeout: 60 } as unknown as AppConfig
    const form = buildNetworkForm(config)
    expect(form.timeout).toBe(60)
  })

  it('defaults fileAllocation to none', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.fileAllocation).toBe('none')
  })

  it('reads fileAllocation from config', () => {
    const config = { fileAllocation: 'prealloc' } as unknown as AppConfig
    const form = buildNetworkForm(config)
    expect(form.fileAllocation).toBe('prealloc')
  })

  // ── User-Agent ──────────────────────────────────────────────────

  it('defaults userAgent from DEFAULT_APP_CONFIG', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form.userAgent).toBe(DEFAULT_APP_CONFIG.userAgent)
  })

  it('reads userAgent from config', () => {
    const config = { userAgent: 'Mozilla/5.0 Custom' } as AppConfig
    const form = buildNetworkForm(config)
    expect(form.userAgent).toBe('Mozilla/5.0 Custom')
  })

  // ── Completeness ────────────────────────────────────────────────

  it('returns all expected form fields', () => {
    const form = buildNetworkForm(emptyConfig)
    expect(form).toHaveProperty('proxy')
    expect(form).toHaveProperty('enableUpnp')
    expect(form).toHaveProperty('listenPort')
    expect(form).toHaveProperty('dhtListenPort')
    expect(form).toHaveProperty('connectTimeout')
    expect(form).toHaveProperty('timeout')
    expect(form).toHaveProperty('fileAllocation')
    expect(form).toHaveProperty('userAgent')
  })
})

// ── buildNetworkSystemConfig ────────────────────────────────────────

describe('buildNetworkSystemConfig', () => {
  const baseForm: NetworkForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    connectTimeout: 10,
    timeout: 10,
    fileAllocation: 'none',
    userAgent: '',
  }

  it('maps port and protocol keys to aria2 config', () => {
    const config = buildNetworkSystemConfig(baseForm)
    expect(config['listen-port']).toBe('21301')
    expect(config['dht-listen-port']).toBe('26701')
    expect(config['enable-dht']).toBe('true')
    expect(config['enable-peer-exchange']).toBe('true')
  })

  it('maps transfer parameter keys to aria2 config', () => {
    const config = buildNetworkSystemConfig(baseForm)
    expect(config['connect-timeout']).toBe('10')
    expect(config['timeout']).toBe('10')
    expect(config['file-allocation']).toBe('none')
  })

  it('emits custom connect-timeout and timeout values', () => {
    const config = buildNetworkSystemConfig({ ...baseForm, connectTimeout: 30, timeout: 60 })
    expect(config['connect-timeout']).toBe('30')
    expect(config['timeout']).toBe('60')
  })

  it('emits custom file-allocation value', () => {
    const config = buildNetworkSystemConfig({ ...baseForm, fileAllocation: 'prealloc' })
    expect(config['file-allocation']).toBe('prealloc')
  })

  it('maps user-agent to aria2 config', () => {
    const config = buildNetworkSystemConfig({ ...baseForm, userAgent: 'Custom/1.0' })
    expect(config['user-agent']).toBe('Custom/1.0')
  })

  // ── Proxy flow ──────────────────────────────────────────────────

  it('sets proxy when enabled for downloads', () => {
    const config = buildNetworkSystemConfig({
      ...baseForm,
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '*.local', scope: [PROXY_SCOPES.DOWNLOAD] },
    })
    expect(config['all-proxy']).toBe('http://proxy:8080')
    expect(config['no-proxy']).toBe('*.local')
  })

  it('clears proxy when not enabled for downloads', () => {
    const config = buildNetworkSystemConfig({
      ...baseForm,
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '*.local', scope: ['app'] },
    })
    expect(config['all-proxy']).toBe('')
    expect(config['no-proxy']).toBe('')
  })

  it('clears proxy when proxy is disabled', () => {
    const config = buildNetworkSystemConfig({
      ...baseForm,
      proxy: { enable: false, server: 'http://proxy:8080', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    })
    expect(config['all-proxy']).toBe('')
  })

  it('enabling proxy with default scope produces non-empty all-proxy', () => {
    const form = buildNetworkForm({} as AppConfig)
    form.proxy.enable = true
    form.proxy.server = 'http://127.0.0.1:7890'
    const config = buildNetworkSystemConfig(form)
    expect(config['all-proxy']).toBe('http://127.0.0.1:7890')
    expect(config['no-proxy']).toBe('')
  })

  it('proxy with download scope excluded produces empty all-proxy', () => {
    const config = buildNetworkSystemConfig({
      ...baseForm,
      proxy: {
        enable: true,
        server: 'http://127.0.0.1:7890',
        bypass: '',
        scope: [PROXY_SCOPES.UPDATE_APP, PROXY_SCOPES.UPDATE_TRACKERS],
      },
    })
    expect(config['all-proxy']).toBe('')
  })

  it('proxy bypass value is forwarded to no-proxy when download scope active', () => {
    const config = buildNetworkSystemConfig({
      ...baseForm,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '192.168.0.0/16,*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    })
    expect(config['all-proxy']).toBe('http://proxy:8080')
    expect(config['no-proxy']).toBe('192.168.0.0/16,*.local')
  })
})

// ── transformNetworkForStore ────────────────────────────────────────

describe('transformNetworkForStore', () => {
  const baseForm: NetworkForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    connectTimeout: 10,
    timeout: 10,
    fileAllocation: 'none',
    userAgent: '',
  }

  it('preserves port numbers as numbers (not strings)', () => {
    const result = transformNetworkForStore(baseForm)
    expect(result.listenPort).toBe(21301)
    expect(typeof result.listenPort).toBe('number')
    expect(result.dhtListenPort).toBe(26701)
    expect(typeof result.dhtListenPort).toBe('number')
  })

  it('preserves proxy config through transform', () => {
    const result = transformNetworkForStore({
      ...baseForm,
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '*.local', scope: ['download'] },
    })
    expect(result.proxy).toEqual({
      enable: true,
      server: 'http://127.0.0.1:7890',
      bypass: '*.local',
      scope: ['download'],
    })
  })

  it('preserves timeout values through transform', () => {
    const result = transformNetworkForStore({ ...baseForm, connectTimeout: 30, timeout: 60 })
    expect(result.connectTimeout).toBe(30)
    expect(result.timeout).toBe(60)
  })

  it('preserves fileAllocation through transform', () => {
    const result = transformNetworkForStore({ ...baseForm, fileAllocation: 'prealloc' })
    expect(result.fileAllocation).toBe('prealloc')
  })
})

// ── validateNetworkForm ─────────────────────────────────────────────

describe('validateNetworkForm', () => {
  const validForm: NetworkForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    connectTimeout: 10,
    timeout: 10,
    fileAllocation: 'none',
    userAgent: '',
  }

  it('returns null for valid form', () => {
    expect(validateNetworkForm(validForm)).toBeNull()
  })

  it('returns null for valid proxy URL when proxy enabled', () => {
    expect(
      validateNetworkForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'http://proxy.example.com:8080' },
      }),
    ).toBeNull()
  })

  it('returns invalid-proxy-url for malformed URL when proxy enabled', () => {
    expect(
      validateNetworkForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'http://:invalid:url:' },
      }),
    ).toBe('preferences.invalid-proxy-url')
  })

  it('returns proxy-unsupported-protocol for socks5 when proxy enabled', () => {
    expect(
      validateNetworkForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBe('preferences.proxy-unsupported-protocol')
  })

  it('returns null for invalid proxy URL when proxy disabled', () => {
    expect(
      validateNetworkForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: false, server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBeNull()
  })

  it('returns null for empty proxy server when proxy enabled', () => {
    expect(
      validateNetworkForm({
        ...validForm,
        proxy: { ...validForm.proxy, enable: true, server: '' },
      }),
    ).toBeNull()
  })
})

// ── Port Randomizers ────────────────────────────────────────────────

describe('port randomizers', () => {
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
