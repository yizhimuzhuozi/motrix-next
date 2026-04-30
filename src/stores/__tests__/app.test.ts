import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STAT_BASE_INTERVAL, STAT_MAX_INTERVAL, STAT_MIN_INTERVAL } from '@shared/timing'

// ── Mocks ───────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'macos'),
}))

import { useAppStore } from '../app'
import { createBatchItem, resetBatchIdCounter } from '@shared/utils/batchHelpers'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

  // ── enqueueBatch ────────────────────────────────────────────────

  it('enqueueBatch deduplicates against items already in pendingBatch', () => {
    const store = useAppStore()

    store.pendingBatch = [createBatchItem('uri', 'magnet:?xt=urn:btih:existing')]

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:existing'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:new'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:existing', 'magnet:?xt=urn:btih:new'])
  })

  it('enqueueBatch deduplicates duplicates within the same incoming batch', () => {
    const store = useAppStore()

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:other'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:dup', 'magnet:?xt=urn:btih:other'])
  })

  it('enqueueBatch returns 0 and opens dialog when given empty array', () => {
    const store = useAppStore()
    const skipped = store.enqueueBatch([])
    expect(skipped).toBe(0)
    expect(store.pendingBatch).toEqual([])
  })

  it('enqueueBatch opens addTaskDialog on non-empty input', () => {
    const store = useAppStore()
    expect(store.addTaskVisible).toBe(false)
    store.enqueueBatch([createBatchItem('uri', 'https://example.com/file')])
    expect(store.addTaskVisible).toBe(true)
  })

  // ── Interval Management ─────────────────────────────────────────

  describe('interval management', () => {
    it('updateInterval sets interval within bounds', () => {
      const store = useAppStore()
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('updateInterval clamps to STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(99999)
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })

    it('updateInterval clamps to STAT_MIN_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(1)
      expect(store.interval).toBe(STAT_MIN_INTERVAL)
    })

    it('updateInterval no-ops when value equals current', () => {
      const store = useAppStore()
      store.interval = 2000
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('increaseInterval increments by 100ms by default', () => {
      const store = useAppStore()
      const before = store.interval
      store.increaseInterval()
      expect(store.interval).toBe(before + 100)
    })

    it('increaseInterval does not exceed STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.interval = STAT_MAX_INTERVAL
      store.increaseInterval()
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })

    it('decreaseInterval decrements by 100ms by default', () => {
      const store = useAppStore()
      store.interval = 2000
      store.decreaseInterval()
      expect(store.interval).toBe(1900)
    })

    it('decreaseInterval does not go below STAT_MIN_INTERVAL', () => {
      const store = useAppStore()
      store.interval = STAT_MIN_INTERVAL
      store.decreaseInterval()
      expect(store.interval).toBe(STAT_MIN_INTERVAL)
    })

    it('resetInterval restores to STAT_BASE_INTERVAL', () => {
      const store = useAppStore()
      store.interval = 9999
      store.resetInterval()
      expect(store.interval).toBe(STAT_BASE_INTERVAL)
    })
  })

  // ── Dialog State ────────────────────────────────────────────────

  describe('dialog state', () => {
    it('showAddTaskDialog sets addTaskVisible to true', () => {
      const store = useAppStore()
      expect(store.addTaskVisible).toBe(false)
      store.showAddTaskDialog()
      expect(store.addTaskVisible).toBe(true)
    })

    it('hideAddTaskDialog sets addTaskVisible to false and clears pendingBatch', () => {
      const store = useAppStore()
      store.addTaskVisible = true
      store.pendingBatch = [createBatchItem('uri', 'https://example.com')]
      store.hideAddTaskDialog()
      expect(store.addTaskVisible).toBe(false)
      expect(store.pendingBatch).toEqual([])
    })
  })

  // ── updateAddTaskOptions ────────────────────────────────────────

  describe('updateAddTaskOptions', () => {
    it('replaces addTaskOptions with provided options', () => {
      const store = useAppStore()
      store.updateAddTaskOptions({ dir: '/tmp/downloads', split: '4' } as never)
      expect(store.addTaskOptions).toEqual({ dir: '/tmp/downloads', split: '4' })
    })

    it('defaults to empty object when called with no arguments', () => {
      const store = useAppStore()
      store.addTaskOptions = { dir: '/old' } as never
      store.updateAddTaskOptions()
      expect(store.addTaskOptions).toEqual({})
    })
  })

  // ── fetchGlobalStat (one-shot initializer) ───────────────────────

  describe('fetchGlobalStat', () => {
    it('parses numeric stat values from string response', async () => {
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '102400',
          uploadSpeed: '51200',
          numActive: '2',
          numWaiting: '1',
          numStopped: '5',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.stat.downloadSpeed).toBe(102400)
      expect(store.stat.uploadSpeed).toBe(51200)
      expect(store.stat.numActive).toBe(2)
    })

    it('decreases interval when active tasks exist', async () => {
      const store = useAppStore()
      store.interval = STAT_BASE_INTERVAL
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '1000',
          uploadSpeed: '0',
          numActive: '3',
          numWaiting: '0',
          numStopped: '0',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.interval).toBeLessThanOrEqual(STAT_BASE_INTERVAL)
    })

    it('increases interval when no active tasks', async () => {
      const store = useAppStore()
      const before = store.interval
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '0',
          uploadSpeed: '0',
          numActive: '0',
          numWaiting: '0',
          numStopped: '3',
        }),
      }
      await store.fetchGlobalStat(api)
      expect(store.interval).toBeGreaterThanOrEqual(before)
      expect(store.stat.downloadSpeed).toBe(0)
    })

    it('survives API error without crashing', async () => {
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockRejectedValue(new Error('network')),
      }
      await expect(store.fetchGlobalStat(api)).resolves.toBeUndefined()
    })

    it('does NOT invoke tray/dock/progress commands (Rust handles those)', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const store = useAppStore()
      const api = {
        getGlobalStat: vi.fn().mockResolvedValue({
          downloadSpeed: '1048576',
          uploadSpeed: '0',
          numActive: '1',
          numWaiting: '0',
          numStopped: '0',
        }),
      }
      await store.fetchGlobalStat(api)
      // After the architectural migration, fetchGlobalStat is a pure data
      // initializer — it must not invoke any tray/dock/progress commands.
      const uiCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
        ['update_tray_title', 'update_dock_badge', 'update_progress_bar'].includes(c[0] as string),
      )
      expect(uiCalls).toHaveLength(0)
    })
  })

  // ── handleStatEvent (Rust event → reactive state) ───────────────

  describe('handleStatEvent', () => {
    it('updates stat values from event payload', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 204800,
        uploadSpeed: 10240,
        numActive: 2,
        numWaiting: 1,
        numStopped: 5,
        numStoppedTotal: 10,
      })
      expect(store.stat.downloadSpeed).toBe(204800)
      expect(store.stat.uploadSpeed).toBe(10240)
      expect(store.stat.numActive).toBe(2)
      expect(store.stat.numWaiting).toBe(1)
      expect(store.stat.numStopped).toBe(5)
    })

    it('decreases interval when active tasks are present', () => {
      const store = useAppStore()
      store.interval = STAT_BASE_INTERVAL
      store.handleStatEvent({
        downloadSpeed: 1000,
        uploadSpeed: 0,
        numActive: 3,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.interval).toBeLessThanOrEqual(STAT_BASE_INTERVAL)
    })

    it('increases interval when idle (numActive = 0)', () => {
      const store = useAppStore()
      const before = store.interval
      store.handleStatEvent({
        downloadSpeed: 0,
        uploadSpeed: 0,
        numActive: 0,
        numWaiting: 0,
        numStopped: 3,
        numStoppedTotal: 5,
      })
      expect(store.interval).toBeGreaterThanOrEqual(before)
    })

    it('zeros downloadSpeed when no active tasks', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 999,
        uploadSpeed: 100,
        numActive: 0,
        numWaiting: 0,
        numStopped: 1,
        numStoppedTotal: 1,
      })
      // downloadSpeed is forced to 0 when numActive === 0
      // (matches fetchGlobalStat behavior and Rust's expectation)
      expect(store.stat.downloadSpeed).toBe(0)
      expect(store.stat.uploadSpeed).toBe(100)
    })

    it('preserves downloadSpeed when tasks are active', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 512000,
        uploadSpeed: 0,
        numActive: 1,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.stat.downloadSpeed).toBe(512000)
    })
  })

  // ── fetchEngineInfo ─────────────────────────────────────────────

  describe('fetchEngineInfo', () => {
    it('stores engine version and features', async () => {
      const store = useAppStore()
      const api = {
        getVersion: vi.fn().mockResolvedValue({ version: '1.37.0', enabledFeatures: ['BitTorrent', 'GZip'] }),
      }
      await store.fetchEngineInfo(api)
      expect(store.engineInfo.version).toBe('1.37.0')
      expect(store.engineInfo.enabledFeatures).toContain('BitTorrent')
    })
  })

  // ── fetchEngineOptions ──────────────────────────────────────────

  describe('fetchEngineOptions', () => {
    it('stores global engine options and returns data', async () => {
      const store = useAppStore()
      const api = {
        getGlobalOption: vi.fn().mockResolvedValue({ dir: '/downloads', split: '5' }),
      }
      const result = await store.fetchEngineOptions(api)
      expect(store.engineOptions).toMatchObject({ dir: '/downloads', split: '5' })
      expect(result).toEqual({ dir: '/downloads', split: '5' })
    })
  })

  // ── handleDeepLinkUrls ──────────────────────────────────────────

  describe('handleDeepLinkUrls', () => {
    it('detects remote .torrent and .metalink URLs with correct kind', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([
        'https://example.com/linux.torrent',
        'https://example.com/bundle.meta4',
        'ftp://example.com/archive.metalink',
      ])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'https://example.com/linux.torrent' },
        { kind: 'metalink', source: 'https://example.com/bundle.meta4' },
        { kind: 'metalink', source: 'ftp://example.com/archive.metalink' },
      ])
    })

    it('keeps local file:// torrent and metalink references as file items', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///Users/test/Downloads/a.torrent', 'file:///Users/test/Downloads/b.meta4'])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: '/Users/test/Downloads/a.torrent' },
        { kind: 'metalink', source: '/Users/test/Downloads/b.meta4' },
      ])
    })

    it('normalizes Windows file URIs without leaving a leading slash before the drive letter', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///C:/Users/test/Downloads/Space%20Name.torrent'])

      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'C:/Users/test/Downloads/Space Name.torrent' },
      ])
    })

    it('handles magnet links', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['magnet:?xt=urn:btih:abc123'])
      expect(store.pendingBatch[0].kind).toBe('uri')
      expect(store.pendingBatch[0].source).toBe('magnet:?xt=urn:btih:abc123')
    })

    it('no-ops for empty or null-ish input', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([])
      expect(store.pendingBatch).toEqual([])
    })

    it('handles mixed protocol URLs', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([
        'https://example.com/file.zip',
        'magnet:?xt=urn:btih:hash',
        'file:///local/path.torrent',
      ])
      expect(store.pendingBatch).toHaveLength(3)
    })

    it('extracts referer from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.example.com/file.zip')
      const referer = encodeURIComponent('https://example.com/downloads')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.example.com/file.zip')
      expect(store.pendingReferer).toBe('https://example.com/downloads')
    })

    it('sets pendingReferer to empty when deep link has no referer param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('')
    })

    it('uses last referer when multiple deep links arrive', () => {
      const store = useAppStore()
      const url1 = encodeURIComponent('https://cdn.example.com/a.zip')
      const ref1 = encodeURIComponent('https://site-a.com')
      const url2 = encodeURIComponent('https://cdn.example.com/b.zip')
      const ref2 = encodeURIComponent('https://site-b.com')
      store.handleDeepLinkUrls([
        `motrixnext://new?url=${url1}&referer=${ref1}`,
        `motrixnext://new?url=${url2}&referer=${ref2}`,
      ])

      expect(store.pendingBatch).toHaveLength(2)
      expect(store.pendingReferer).toBe('https://site-b.com')
    })

    it('clears pendingReferer when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      const referer = encodeURIComponent('https://example.com')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}`])
      expect(store.pendingReferer).toBe('https://example.com')

      store.hideAddTaskDialog()
      expect(store.pendingReferer).toBe('')
    })

    // ── Cookie extraction (mirrors referer tests above) ────────────

    it('extracts cookie from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/file.zip')
      const cookie = encodeURIComponent('session=abc123; token=xyz')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&cookie=${cookie}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.quark.cn/file.zip')
      expect(store.pendingCookie).toBe('session=abc123; token=xyz')
    })

    it('sets pendingCookie to empty when deep link has no cookie param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingCookie).toBe('')
    })

    it('uses last cookie when multiple deep links arrive', () => {
      const store = useAppStore()
      const url1 = encodeURIComponent('https://cdn.a.com/file.zip')
      const c1 = encodeURIComponent('sid=aaa')
      const url2 = encodeURIComponent('https://cdn.b.com/file.zip')
      const c2 = encodeURIComponent('sid=bbb')
      store.handleDeepLinkUrls([
        `motrixnext://new?url=${url1}&cookie=${c1}`,
        `motrixnext://new?url=${url2}&cookie=${c2}`,
      ])

      expect(store.pendingBatch).toHaveLength(2)
      expect(store.pendingCookie).toBe('sid=bbb')
    })

    it('clears pendingCookie when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      const cookie = encodeURIComponent('auth=secret')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&cookie=${cookie}`])
      expect(store.pendingCookie).toBe('auth=secret')

      store.hideAddTaskDialog()
      expect(store.pendingCookie).toBe('')
    })

    it('extracts both referer and cookie from same deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/file.zip')
      const referer = encodeURIComponent('https://pan.quark.cn')
      const cookie = encodeURIComponent('__puus=abc; __pus=def')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}&cookie=${cookie}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('https://pan.quark.cn')
      expect(store.pendingCookie).toBe('__puus=abc; __pus=def')
    })

    // ── Filename extraction (mirrors referer/cookie tests above) ────

    it('extracts filename from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const filename = encodeURIComponent('无常幽鬼V0.1.xmgic')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=${filename}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.quark.cn/hash123')
      expect(store.pendingFilename).toBe('无常幽鬼V0.1.xmgic')
    })

    it('sets pendingFilename to empty when deep link has no filename param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingFilename).toBe('')
    })

    it('clears pendingFilename when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const filename = encodeURIComponent('test.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=${filename}`])
      expect(store.pendingFilename).toBe('test.zip')

      store.hideAddTaskDialog()
      expect(store.pendingFilename).toBe('')
    })

    it('extracts filename together with referer and cookie', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const referer = encodeURIComponent('https://pan.quark.cn')
      const cookie = encodeURIComponent('__puus=abc')
      const filename = encodeURIComponent('无常幽鬼V0.1.xmgic')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}&cookie=${cookie}&filename=${filename}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('https://pan.quark.cn')
      expect(store.pendingCookie).toBe('__puus=abc')
      expect(store.pendingFilename).toBe('无常幽鬼V0.1.xmgic')
    })

    it('ignores generic browser fallback filename from extension deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://mail-attachment.googleusercontent.com/attachment/u/0/')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=download`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingFilename).toBe('')
      expect(store.pendingBatch[0].displayName).not.toBe('download')
    })
  })

  // ── autoSubmitFromExtension ───────────────────────────────────────

  describe('autoSubmitFromExtension', () => {
    // Helper: build a motrixnext://new deep link
    function buildDeepLink(downloadUrl: string, referer = '', cookie = '', filename = ''): string {
      const u = encodeURIComponent(downloadUrl)
      const r = referer ? `&referer=${encodeURIComponent(referer)}` : ''
      const c = cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''
      const f = filename ? `&filename=${encodeURIComponent(filename)}` : ''
      return `motrixnext://new?url=${u}${r}${c}${f}`
    }

    it('auto-submits HTTP URI when enabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip')])

      // Auto-submitted: pendingBatch should be empty, dialog should NOT open
      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('auto-submits magnet URI when enabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('magnet:?xt=urn:btih:abc123')])

      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('falls back to AddTask dialog when disabled', () => {
      const store = useAppStore()
      // Default config has autoSubmitFromExtension = false

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip')])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.addTaskVisible).toBe(true)
    })

    it('always shows dialog for .torrent URLs (requires fetch→parse→file-select)', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/linux.torrent')])

      // Torrent URLs must go through dialog regardless of auto-submit setting
      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].kind).toBe('torrent')
      expect(store.addTaskVisible).toBe(true)
    })

    it('always shows dialog for .metalink URLs (requires fetch→parse pipeline)', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/bundle.meta4')])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].kind).toBe('metalink')
      expect(store.addTaskVisible).toBe(true)
    })

    it('handles mixed batch: auto-submits URIs, dialogs torrent', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([
        buildDeepLink('https://example.com/file.zip'),
        buildDeepLink('https://example.com/linux.torrent'),
      ])

      // file.zip auto-submitted, linux.torrent goes to dialog
      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://example.com/linux.torrent')
      expect(store.addTaskVisible).toBe(true)
    })

    it('does not open dialog when all items are auto-submitted', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/a.zip'), buildDeepLink('https://example.com/b.mp4')])

      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('still sets pendingReferer even when auto-submitting', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip', 'https://example.com')])

      // referer should still be extracted (used in auto-submit form)
      expect(store.pendingReferer).toBe('https://example.com')
    })

    it('forwards cookie to aria2 header when auto-submitting', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://cdn.quark.cn/file.zip', 'https://pan.quark.cn', 'auth=secret')])

      // Cookie should be extracted even during auto-submit
      expect(store.pendingCookie).toBe('auth=secret')
    })

    it('non-extension deep links (file://, http://) are unaffected by auto-submit', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      // Regular deep links (not motrixnext://) should always go to dialog
      store.handleDeepLinkUrls(['https://example.com/file.zip'])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.addTaskVisible).toBe(true)
    })
  })
})
