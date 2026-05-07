/**
 * @fileoverview Tests for the extracted AddTask submission logic.
 *
 * Tests REAL pure functions without mocking them:
 * - buildEngineOptions: form → aria2 options conversion
 * - classifySubmitError: error categorization
 * - submitBatchItems: batch routing to torrent/metalink stores
 * - submitManualUris: multi-URI handling with rename
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

// ── Mock external dependencies ──────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params?.taskName ? `${key}:${params.taskName}` : key),
  }),
}))

const mockRouterPush = vi.fn().mockResolvedValue(undefined)
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: vi.fn(() => ({ destroy: vi.fn() })),
    error: vi.fn(() => ({ destroy: vi.fn() })),
    warning: vi.fn(() => ({ destroy: vi.fn() })),
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

// Mock isEngineReady for classifySubmitError tests
const mockIsEngineReady = vi.fn().mockReturnValue(true)
vi.mock('@/api/aria2', () => ({
  isEngineReady: () => mockIsEngineReady(),
}))

const mockAppStore = {
  pendingBatch: [] as BatchItem[],
}

const mockTaskStoreForHook = {
  addUri: vi.fn().mockResolvedValue(['gid1']),
  addMagnetUri: vi.fn().mockResolvedValue('magnet-gid'),
  addTorrent: vi.fn(),
  addMetalink: vi.fn(),
  registerTorrentSource: vi.fn(),
}

const mockPreferenceStore = {
  config: {
    newTaskShowDownloading: true,
    proxy: { enable: false, server: '', scope: [], bypass: '' },
    fileCategoryEnabled: false,
    fileCategories: [],
    taskNotification: false,
    notifyOnStart: false,
  },
}

const mockMessage = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}

vi.mock('@/stores/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/stores/task', () => ({
  useTaskStore: () => mockTaskStoreForHook,
}))

vi.mock('@/stores/preference', () => ({
  usePreferenceStore: () => mockPreferenceStore,
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => mockMessage,
}))

import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  useAddTaskSubmit,
  isGlobalProxyConfigured,
  isGlobalDownloadProxyActive,
  type AddTaskForm,
} from '../useAddTaskSubmit'
import type { BatchItem, Aria2EngineOptions, ProxyConfig } from '@shared/types'

// ── buildEngineOptions ──────────────────────────────────────────────

describe('buildEngineOptions', () => {
  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/downloads',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    proxyMode: 'none',
    customProxy: '',
  }

  it('always includes dir and split', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.dir).toBe('/downloads')
    expect(opts.split).toBe('16')
  })

  it('does NOT include max-connection-per-server (uses global value since v2)', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts['max-connection-per-server']).toBeUndefined()
  })

  it('includes split without coupling to max-connection-per-server', () => {
    const opts = buildEngineOptions({ ...baseForm, split: 128 })
    expect(opts.split).toBe('128')
    expect(opts['max-connection-per-server']).toBeUndefined()
  })

  it('includes out when non-empty', () => {
    const opts = buildEngineOptions({ ...baseForm, out: 'file.zip' })
    expect(opts.out).toBe('file.zip')
  })

  it('omits out when empty', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.out).toBeUndefined()
  })

  it('includes user-agent when set', () => {
    const opts = buildEngineOptions({ ...baseForm, userAgent: 'MyUA/1.0' })
    expect(opts['user-agent']).toBe('MyUA/1.0')
  })

  it('includes referer when set', () => {
    const opts = buildEngineOptions({ ...baseForm, referer: 'https://r.com' })
    expect(opts.referer).toBe('https://r.com')
  })

  it('builds header array from cookie and authorization', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      cookie: 'session=abc',
      authorization: 'Bearer token',
    })
    expect(opts.header).toEqual(['Cookie: session=abc', 'Authorization: Bearer token'])
  })

  it('sanitizes every HTTP header value before building aria2 options', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      userAgent: 'MyUA\r\nInjected: bad',
      referer: 'https://r.com\n',
      cookie: 'session=abc\r\nX-Evil: 1',
      authorization: 'Bearer token\nAnother: bad',
    })

    expect(opts['user-agent']).toBe('MyUAInjected: bad')
    expect(opts.referer).toBe('https://r.com')
    expect(opts.header).toEqual(['Cookie: session=abcX-Evil: 1', 'Authorization: Bearer tokenAnother: bad'])
  })

  it('omits header when no cookie or auth', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.header).toBeUndefined()
  })

  // ── Proxy tri-state tests ──

  it('sets all-proxy when proxyMode is global and globalProxyServer is provided', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'global',
      globalProxyServer: 'http://127.0.0.1:7890',
    })
    expect(opts['all-proxy']).toBe('http://127.0.0.1:7890')
  })

  it('sets all-proxy to empty string when proxyMode is none (clears global)', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'none',
      globalProxyServer: 'http://127.0.0.1:7890',
    })
    expect(opts['all-proxy']).toBe('')
  })

  it('sets all-proxy to empty string when proxyMode is global but server is empty', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'global',
      globalProxyServer: '',
    })
    expect(opts['all-proxy']).toBe('')
  })

  it('sets all-proxy to empty string when proxyMode is global but server is undefined', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'global',
    })
    expect(opts['all-proxy']).toBe('')
  })

  it('sets all-proxy when proxyMode is custom with valid address', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'custom',
      customProxy: 'http://10.0.0.1:8080',
    })
    expect(opts['all-proxy']).toBe('http://10.0.0.1:8080')
  })

  it('sets all-proxy to empty string when proxyMode is custom but customProxy is empty', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'custom',
      customProxy: '',
    })
    expect(opts['all-proxy']).toBe('')
  })

  it('clears all-proxy when proxyMode is none even with customProxy set', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'none',
      customProxy: 'http://10.0.0.1:8080',
    })
    expect(opts['all-proxy']).toBe('')
  })

  it('handles proxy server with authentication credentials', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'global',
      globalProxyServer: 'http://user:pass@proxy.example.com:8080',
    })
    expect(opts['all-proxy']).toBe('http://user:pass@proxy.example.com:8080')
  })
})

// ── classifySubmitError ─────────────────────────────────────────────

describe('classifySubmitError', () => {
  beforeEach(() => {
    mockIsEngineReady.mockReturnValue(true)
  })

  it('returns engine-not-ready when message contains "not initialized"', () => {
    expect(classifySubmitError(new Error('Aria2 client not initialized'))).toBe('engine-not-ready')
  })

  it('returns engine-not-ready when engine is not ready', () => {
    mockIsEngineReady.mockReturnValue(false)
    expect(classifySubmitError(new Error('some error'))).toBe('engine-not-ready')
  })

  it('returns duplicate for "already exists" errors', () => {
    expect(classifySubmitError(new Error('GID already exists'))).toBe('duplicate')
  })

  it('returns duplicate for "duplicate download" errors', () => {
    expect(classifySubmitError(new Error('duplicate download detected'))).toBe('duplicate')
  })

  it('returns generic for unknown errors', () => {
    expect(classifySubmitError(new Error('network timeout'))).toBe('generic')
  })

  it('handles non-Error values', () => {
    expect(classifySubmitError('some string error')).toBe('generic')
  })
})

// ── submitBatchItems ────────────────────────────────────────────────

describe('submitBatchItems', () => {
  const mockTaskStore = {
    addTorrent: vi.fn().mockResolvedValue('gid1'),
    addMetalink: vi.fn().mockResolvedValue(['gid2']),
    registerTorrentSource: vi.fn(),
  } as unknown as ReturnType<typeof import('@/stores/task').useTaskStore>

  const baseOptions: Aria2EngineOptions = { dir: '/dl', split: '16' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits torrent items via addTorrent', async () => {
    const items: BatchItem[] = [
      { id: 1, kind: 'torrent', source: 'a.torrent', payload: 'base64', status: 'pending' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addTorrent).toHaveBeenCalledWith({
      torrent: 'base64',
      options: expect.objectContaining({ dir: '/dl' }),
    })
    expect(items[0].status).toBe('submitted')
  })

  it('submits metalink items via addMetalink', async () => {
    const items: BatchItem[] = [
      { id: 2, kind: 'metalink', source: 'b.meta4', payload: 'mlData', status: 'pending' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addMetalink).toHaveBeenCalledWith({
      metalink: 'mlData',
      options: expect.objectContaining({ dir: '/dl' }),
    })
    expect(items[0].status).toBe('submitted')
  })

  it('skips URI items (handled separately)', async () => {
    const items: BatchItem[] = [
      {
        id: 3,
        kind: 'uri',
        source: 'http://e.com',
        payload: 'http://e.com',
        status: 'pending',
      } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
    expect(mockTaskStore.addMetalink).not.toHaveBeenCalled()
  })

  it('removes out option for torrent/metalink items', async () => {
    const items: BatchItem[] = [
      { id: 4, kind: 'torrent', source: 'c.torrent', payload: 'b64', status: 'pending' } as unknown as BatchItem,
    ]
    const opts = { ...baseOptions, out: 'custom.zip' }

    await submitBatchItems(items, opts, mockTaskStore)

    const passedOpts = (mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mock.calls[0][0].options
    expect(passedOpts.out).toBeUndefined()
  })

  it('includes select-file when partial selection', async () => {
    const items: BatchItem[] = [
      {
        id: 5,
        kind: 'torrent',
        source: 'd.torrent',
        payload: 'b64',
        status: 'pending',
        selectedFileIndices: [1, 3],
        torrentMeta: { files: [{ idx: 1 }, { idx: 2 }, { idx: 3 }] },
      } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    const passedOpts = (mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mock.calls[0][0].options
    expect(passedOpts['select-file']).toBe('1,3')
  })

  it('marks items as failed on error and returns failure count', async () => {
    ;(mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('engine down'))

    const items: BatchItem[] = [
      { id: 6, kind: 'torrent', source: 'e.torrent', payload: 'b64', status: 'pending' } as unknown as BatchItem,
    ]

    const failures = await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(failures).toBe(1)
    expect(items[0].status).toBe('failed')
    expect(items[0].error).toBe('engine down')
  })

  it('skips already submitted items', async () => {
    const items: BatchItem[] = [
      { id: 7, kind: 'torrent', source: 'f.torrent', payload: 'b64', status: 'submitted' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)
    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
  })
})

// ── submitManualUris ────────────────────────────────────────────────

describe('submitManualUris', () => {
  const mockTaskStore = {
    addUri: vi.fn().mockResolvedValue(['gid1']),
    addMagnetUri: vi.fn().mockResolvedValue('magnet-gid'),
  } as unknown as ReturnType<typeof import('@/stores/task').useTaskStore>

  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/dl',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    proxyMode: 'none',
    customProxy: '',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when uris is empty/whitespace', async () => {
    await submitManualUris({ ...baseForm, uris: '  ' }, {}, mockTaskStore)
    expect(mockTaskStore.addUri).not.toHaveBeenCalled()
  })

  it('submits single URI with extension — outs contains empty string (no HEAD needed)', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/file.zip' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toEqual(['http://example.com/file.zip'])
    // Each URI produces an empty string (= let aria2 decide), not a flat []
    expect(call.outs).toEqual([''])
    expect(call.options).toEqual({ dir: '/dl' })
  })

  it('generates numbered outs for multi-URI with out specified', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://a.com/1\nhttp://b.com/2', out: 'file.zip' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toHaveLength(2)
    // Should have generated numbered filenames (fallback since buildOuts may return empty)
    expect(call.outs.length).toBeGreaterThan(0)
  })

  it('does not invoke HEAD for percent-encoded URIs with extension — aria2 handles decode natively', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // .mp3 has an extension → hasExtension returns true → no HEAD request
    expect(call.outs).toEqual([''])
  })

  it('invokes resolve_filename for extensionless URL paths', async () => {
    // This URL has no extension in the path — resolve_filename is invoked
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('215.zip')

    await submitManualUris(
      { ...baseForm, uris: 'https://datashop.cboe.com/download/sample/215' },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://datashop.cboe.com/download/sample/215',
      proxy: null,
    })
    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['215.zip'])
  })

  it('passes referer and cookie to resolve_filename for authenticated extensionless URLs', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Итоги_2026.docx')

    const result = await submitManualUris(
      {
        ...baseForm,
        uris: 'https://mail-attachment.googleusercontent.com/attachment/u/0/',
        referer: 'https://mail.google.com/mail/u/0/#inbox',
        cookie: 'COMPASS=gmail=abc',
      },
      { dir: '/dl', referer: 'https://mail.google.com/mail/u/0/#inbox', header: ['Cookie: COMPASS=gmail=abc'] },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://mail-attachment.googleusercontent.com/attachment/u/0/',
      proxy: null,
      referer: 'https://mail.google.com/mail/u/0/#inbox',
      cookie: 'COMPASS=gmail=abc',
    })
    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['Итоги_2026.docx'])
    expect(result.submittedTaskNames).toEqual(['Итоги_2026.docx'])
  })

  it('sanitizes referer and cookie before passing them to resolve_filename', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('safe.zip')

    await submitManualUris(
      {
        ...baseForm,
        uris: 'https://example.com/download',
        referer: 'https://example.com/\r\nInjected: bad',
        cookie: 'session=abc\nX-Evil: 1',
      },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://example.com/download',
      proxy: null,
      referer: 'https://example.com/Injected: bad',
      cookie: 'session=abcX-Evil: 1',
    })
  })

  it('does not include magnet URIs in regular addUri call (they use separate addMagnetUri path)', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/file%20name.zip\nmagnet:?xt=urn:btih:abc123' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Only the regular URI should be in the addUri call
    expect(call.uris).toEqual(['http://example.com/file%20name.zip'])
    expect(call.outs).toEqual(['']) // .zip has extension → empty string (no HEAD)
  })

  it('does not invoke resolve_filename when user has specified out', async () => {
    const { invoke } = await import('@tauri-apps/api/core')

    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3', out: 'custom.mp3' },
      { dir: '/dl', out: 'custom.mp3' },
      mockTaskStore,
    )

    // User provided explicit out → buildOuts handles naming, resolve_filename not called
    expect(invoke).not.toHaveBeenCalledWith('resolve_filename', expect.anything())
  })

  it('returns structured magnet failures without throwing away successful submissions', async () => {
    ;(mockTaskStore.addMagnetUri as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('magnet-gid-1')
      .mockRejectedValueOnce(new Error('invalid magnet'))

    const result = await submitManualUris(
      {
        ...baseForm,
        uris: 'magnet:?xt=urn:btih:good\nmagnet:?xt=urn:btih:bad',
      },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(result).toEqual({
      submittedTaskNames: [],
      magnetGids: ['magnet-gid-1'],
      magnetFailures: [{ uri: 'magnet:?xt=urn:btih:bad', error: 'invalid magnet' }],
    })
  })
})

describe('useAddTaskSubmit', () => {
  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/dl',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    proxyMode: 'none',
    customProxy: '',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAppStore.pendingBatch = []
    mockPreferenceStore.config.newTaskShowDownloading = true
    mockPreferenceStore.config.fileCategoryEnabled = false
    mockPreferenceStore.config.fileCategories = []
    mockPreferenceStore.config.taskNotification = false
    mockPreferenceStore.config.notifyOnStart = false
  })

  it('keeps AddTask open when a magnet submission fails', async () => {
    mockTaskStoreForHook.addMagnetUri.mockRejectedValueOnce(new Error('invalid magnet'))
    const onClose = vi.fn()

    const { handleSubmit } = useAddTaskSubmit({
      form: ref({ ...baseForm, uris: 'magnet:?xt=urn:btih:bad' }),
      onClose,
    })

    await handleSubmit()

    expect(onClose).not.toHaveBeenCalled()
    expect(mockMessage.warning).toHaveBeenCalledWith('1 task.failed', { closable: true })
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it('uses the resolved output filename in the start toast for extensionless URLs', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('ИТОГИ ЛДУ 2026.xlsx')
    const onClose = vi.fn()

    const { handleSubmit } = useAddTaskSubmit({
      form: ref({
        ...baseForm,
        uris: 'http://127.0.0.1:18080/attachment/u/0/?ui=2&disp=safe',
      }),
      onClose,
    })

    await handleSubmit()

    expect(mockMessage.info).toHaveBeenCalledWith('task.download-start-message:ИТОГИ ЛДУ 2026.xlsx')
  })
})

// ── isGlobalProxyConfigured ─────────────────────────────────────────

describe('isGlobalProxyConfigured', () => {
  it('returns true when proxy is enabled and server is non-empty', () => {
    const proxy: ProxyConfig = { enable: true, server: 'http://127.0.0.1:7890' }
    expect(isGlobalProxyConfigured(proxy)).toBe(true)
  })

  it('returns false when proxy is disabled', () => {
    const proxy: ProxyConfig = { enable: false, server: 'http://127.0.0.1:7890' }
    expect(isGlobalProxyConfigured(proxy)).toBe(false)
  })

  it('returns false when server is empty', () => {
    const proxy: ProxyConfig = { enable: true, server: '' }
    expect(isGlobalProxyConfigured(proxy)).toBe(false)
  })

  it('returns false when server is whitespace-only', () => {
    const proxy: ProxyConfig = { enable: true, server: '   ' }
    expect(isGlobalProxyConfigured(proxy)).toBe(false)
  })

  it('returns false when both disabled and empty server', () => {
    const proxy: ProxyConfig = { enable: false, server: '' }
    expect(isGlobalProxyConfigured(proxy)).toBe(false)
  })
})

// ── isGlobalDownloadProxyActive ─────────────────────────────────────

describe('isGlobalDownloadProxyActive', () => {
  it('returns true when proxy enabled, server set, and scope includes download', () => {
    const proxy: ProxyConfig = {
      enable: true,
      server: 'http://proxy:8080',
      scope: ['download', 'update-app'],
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(true)
  })

  it('returns false when scope does not include download', () => {
    const proxy: ProxyConfig = {
      enable: true,
      server: 'http://proxy:8080',
      scope: ['update-app', 'update-trackers'],
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(false)
  })

  it('returns false when proxy is disabled', () => {
    const proxy: ProxyConfig = {
      enable: false,
      server: 'http://proxy:8080',
      scope: ['download'],
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(false)
  })

  it('returns false when server is empty', () => {
    const proxy: ProxyConfig = {
      enable: true,
      server: '',
      scope: ['download'],
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(false)
  })

  it('returns false when scope is undefined', () => {
    const proxy: ProxyConfig = {
      enable: true,
      server: 'http://proxy:8080',
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(false)
  })

  it('returns false when scope is empty array', () => {
    const proxy: ProxyConfig = {
      enable: true,
      server: 'http://proxy:8080',
      scope: [],
    }
    expect(isGlobalDownloadProxyActive(proxy)).toBe(false)
  })
})
