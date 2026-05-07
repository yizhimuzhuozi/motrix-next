/**
 * @fileoverview Pinia store for global application state: engine, tasks, stats, and polling.
 *
 * Global stat (speed / task counts) follows a Backend-as-Source-of-Truth architecture:
 *   Rust stat_service  ──500ms──▶  aria2 getGlobalStat
 *                      ├──▶  tray / dock / progress (direct native API)
 *                      └──▶  emit("stat:update")  ──▶  this store
 *
 * The frontend does NOT poll aria2 for global stats — it passively listens
 * to the Rust event stream. This eliminates double RPC and redundant IPC.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { decodeThunderLink } from '@shared/utils'
import { formatLogFields, logger } from '@shared/logger'
import { STAT_BASE_INTERVAL, STAT_PER_TASK_INTERVAL, STAT_MIN_INTERVAL, STAT_MAX_INTERVAL } from '@shared/timing'
import { detectKind, createBatchItem, resolveExternalFilenameHint } from '@shared/utils/batchHelpers'
import { summarizeExternalInput } from '@shared/utils/externalInputDiagnostics'
import { parseMotrixDeepLink } from '@shared/utils/motrixDeepLink'
import { buildEngineOptions, submitManualUris } from '@/composables/useAddTaskSubmit'
import { isGlobalDownloadProxyActive, getDownloadProxy } from '@/composables/useAddTaskSubmit'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import type { Aria2RawGlobalStat, Aria2EngineOptions, TauriUpdate, AppConfig, BatchItem } from '@shared/types'
import type { AddTaskForm } from '@/composables/useAddTaskSubmit'

/** Payload shape emitted by Rust stat_service via `stat:update`. */
interface StatPayload {
  downloadSpeed: number
  uploadSpeed: number
  numActive: number
  numWaiting: number
  numStopped: number
  numStoppedTotal: number
}

export interface DeepLinkHandlingResult {
  received: number
  queued: number
  autoSubmitted: number
  ignored: number
}

function normalizeFileUriPath(url: string): string {
  const decodedPath = decodeURIComponent(url.replace(/^file:\/\//i, ''))
  return /^\/[A-Za-z]:[\\/]/.test(decodedPath) ? decodedPath.slice(1) : decodedPath
}

export const useAppStore = defineStore('app', () => {
  const systemTheme = ref('light')
  const trayFocused = ref(false)
  const aboutPanelVisible = ref(false)
  const engineInfo = ref<{ version: string; enabledFeatures: string[] }>({
    version: '',
    enabledFeatures: [],
  })
  const engineOptions = ref<Partial<AppConfig>>({})
  const interval = ref(STAT_BASE_INTERVAL)
  const stat = ref({
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0,
  })
  const addTaskVisible = ref(false)
  const pendingBatch = ref<BatchItem[]>([])
  const addTaskOptions = ref<Aria2EngineOptions>({})
  /** Referer from the most recent deep-link, pre-filled into AddTask form. */
  const pendingReferer = ref('')
  /** Cookie from the most recent deep-link, forwarded to aria2 as a Cookie header. */
  const pendingCookie = ref('')
  /** Output filename from extension's Content-Disposition extraction. */
  const pendingFilename = ref('')
  const progress = ref(0)
  const pendingUpdate = ref<TauriUpdate | null>(null)
  const engineRestarting = ref(true)
  let engineRestartingSince = Date.now()
  const MIN_BANNER_MS = 1000

  /** Set engine restarting state with minimum display time to prevent flicker. */
  function setEngineRestarting(value: boolean) {
    if (value) {
      engineRestarting.value = true
      engineRestartingSince = Date.now()
    } else {
      const elapsed = Date.now() - engineRestartingSince
      const remaining = MIN_BANNER_MS - elapsed
      if (remaining > 0) {
        setTimeout(() => {
          engineRestarting.value = false
        }, remaining)
      } else {
        engineRestarting.value = false
      }
    }
  }
  const engineReady = ref(false)
  const pendingMagnetGids = ref<string[]>([])
  /** Protocols detected as hijacked at startup (set by syncProtocolHandlers). */
  const pendingProtocolHijack = ref<string[]>([])

  function updateInterval(millisecond: number) {
    let val = millisecond
    if (val > STAT_MAX_INTERVAL) val = STAT_MAX_INTERVAL
    if (val < STAT_MIN_INTERVAL) val = STAT_MIN_INTERVAL
    if (interval.value === val) return
    interval.value = val
  }

  function increaseInterval(millisecond = 100) {
    if (interval.value < STAT_MAX_INTERVAL) interval.value += millisecond
  }

  function decreaseInterval(millisecond = 100) {
    if (interval.value > STAT_MIN_INTERVAL) interval.value -= millisecond
  }

  function resetInterval() {
    interval.value = STAT_BASE_INTERVAL
  }

  /**
   * Unified entry point for all external inputs.
   * Accepts pre-built BatchItems (already resolved) and appends them to
   * the pending batch, then opens the add-task dialog.
   * @returns Number of duplicate items skipped.
   */
  function enqueueBatch(items: BatchItem[]): number {
    if (items.length === 0) return 0
    // Deduplicate against existing batch AND within incoming items
    const seen = new Set(pendingBatch.value.map((i) => i.source))
    const unique: BatchItem[] = []
    for (const item of items) {
      if (!seen.has(item.source)) {
        seen.add(item.source)
        unique.push(item)
      }
    }
    const skipped = items.length - unique.length
    if (unique.length > 0) {
      pendingBatch.value = [...pendingBatch.value, ...unique]
    }
    addTaskVisible.value = true
    return skipped
  }

  /** Opens an empty add-task dialog for manual URI entry. */
  function showAddTaskDialog() {
    addTaskVisible.value = true
  }

  function hideAddTaskDialog() {
    addTaskVisible.value = false
    pendingBatch.value = []
    pendingReferer.value = ''
    pendingCookie.value = ''
    pendingFilename.value = ''
  }

  function updateAddTaskOptions(options: Aria2EngineOptions = {}) {
    addTaskOptions.value = { ...options }
  }

  /**
   * One-shot initializer — called once when the engine becomes ready.
   * Pulls initial stat values so the UI has data before the first Rust
   * event arrives. Does NOT set tray/dock/progress — Rust handles those.
   */
  async function fetchGlobalStat(api: { getGlobalStat: () => Promise<Aria2RawGlobalStat> }) {
    try {
      const data = await api.getGlobalStat()
      const parsed: Record<string, number> = {}
      Object.keys(data).forEach((key) => {
        parsed[key] = Number(data[key])
      })

      const { numActive } = parsed
      if (numActive > 0) {
        updateInterval(STAT_BASE_INTERVAL - STAT_PER_TASK_INTERVAL * numActive)
      } else {
        parsed.downloadSpeed = 0
        increaseInterval()
      }
      stat.value = parsed as typeof stat.value
    } catch (e) {
      logger.warn('AppStore.fetchGlobalStat', (e as Error).message)
    }
  }

  /**
   * Processes a single stat:update event payload from the Rust backend.
   * Updates reactive stat values AND the adaptive polling interval that
   * TaskView and lifecycleService depend on.
   */
  function handleStatEvent(payload: StatPayload) {
    const { numActive } = payload
    stat.value = {
      downloadSpeed: numActive > 0 ? payload.downloadSpeed : 0,
      uploadSpeed: payload.uploadSpeed,
      numActive,
      numWaiting: payload.numWaiting,
      numStopped: payload.numStopped,
    }
    if (numActive > 0) {
      updateInterval(STAT_BASE_INTERVAL - STAT_PER_TASK_INTERVAL * numActive)
    } else {
      increaseInterval()
    }
  }

  /**
   * Subscribes to the Rust stat_service's `stat:update` event stream.
   * Returns an unlisten function for cleanup.
   */
  function setupStatListener(): Promise<() => void> {
    return listen<StatPayload>('stat:update', (event) => {
      handleStatEvent(event.payload)
    })
  }

  async function fetchEngineInfo(api: { getVersion: () => Promise<{ version: string; enabledFeatures: string[] }> }) {
    const data = await api.getVersion()
    engineInfo.value = { ...engineInfo.value, ...data }
  }

  async function fetchEngineOptions(api: { getGlobalOption: () => Promise<Record<string, string>> }) {
    const data = await api.getGlobalOption()
    engineOptions.value = { ...engineOptions.value, ...data }
    return data
  }

  /**
   * Normalizes deep-link / argv URLs into BatchItems and enqueues them.
   * All items land in the same batch for user review before submission.
   */
  function handleDeepLinkUrls(urls: string[]): DeepLinkHandlingResult {
    const result: DeepLinkHandlingResult = {
      received: urls?.length ?? 0,
      queued: 0,
      autoSubmitted: 0,
      ignored: 0,
    }
    if (!urls || urls.length === 0) return result

    const items: BatchItem[] = []
    const FILE_EXTS = ['.torrent', '.metalink', '.meta4']

    for (const url of urls) {
      const lower = url.toLowerCase()
      const motrixDeepLink = parseMotrixDeepLink(url)

      // ── motrixnext:// — extension-to-app communication protocol ───
      // Bare `motrixnext://` is a wake-up signal (window focus handled
      // by the deep-link-open listener in useAppEvents).
      // `motrixnext://new?url=X` creates a download task from the URL.
      if (motrixDeepLink.valid) {
        if (motrixDeepLink.isNewTask) {
          const downloadUrl = motrixDeepLink.downloadUrl
          const kind = detectKind(downloadUrl)
          const resolvedHint = resolveExternalFilenameHint(downloadUrl, motrixDeepLink.filename)
          if (motrixDeepLink.referer) {
            pendingReferer.value = motrixDeepLink.referer
          }
          if (motrixDeepLink.cookie) {
            pendingCookie.value = motrixDeepLink.cookie
          }
          if (resolvedHint) {
            pendingFilename.value = resolvedHint
          }

          const autoSubmit = usePreferenceStore().config.autoSubmitFromExtension
          logger.info(
            'DeepLink.new',
            formatLogFields({
              url: summarizeExternalInput(downloadUrl),
              kind,
              referer: motrixDeepLink.referer ? 'present' : 'none',
              cookie: motrixDeepLink.cookie ? 'present' : 'none',
              filename: motrixDeepLink.filename ? 'present' : 'none',
              resolvedFilename: resolvedHint ? 'present' : 'none',
              autoSubmit,
            }),
          )
          if (autoSubmit && kind === 'uri') {
            result.autoSubmitted += 1
            void autoSubmitExtensionUrl(downloadUrl, motrixDeepLink.referer, motrixDeepLink.cookie, resolvedHint)
          } else {
            const item = createBatchItem(kind, downloadUrl)
            if (resolvedHint) {
              item.displayName = resolvedHint
            }
            items.push(item)
          }
        } else {
          result.ignored += 1
          const fields = formatLogFields({
            action: motrixDeepLink.action,
            hasUrl: motrixDeepLink.downloadUrl ? 'true' : 'false',
            reason: motrixDeepLink.downloadUrl ? 'unhandled-action' : 'wake-only',
          })
          if (motrixDeepLink.downloadUrl) {
            logger.warn('DeepLink.ignored', fields)
          } else {
            logger.debug('DeepLink.ignored', fields)
          }
        }
        continue
      }
      if (motrixDeepLink.reason === 'malformed') {
        result.ignored += 1
        logger.warn('DeepLink.ignored', formatLogFields({ action: 'unknown', hasUrl: 'false', reason: 'malformed' }))
        continue
      }

      // Determine if this is a local file reference (file:// protocol or raw path)
      const isFileUri = lower.startsWith('file://')
      const isRemoteUri =
        lower.startsWith('http://') ||
        lower.startsWith('https://') ||
        lower.startsWith('ftp://') ||
        lower.startsWith('magnet:') ||
        lower.startsWith('thunder://')
      const isLocalPath = !isRemoteUri && !isFileUri

      // Only treat as a file-based batch item if it's a LOCAL path or file:// URI
      const hasFileExt = FILE_EXTS.some((ext) => lower.endsWith(ext))
      if ((isLocalPath || isFileUri) && hasFileExt) {
        const filePath = isFileUri ? normalizeFileUriPath(url) : url
        const kind = detectKind(filePath)
        items.push(createBatchItem(kind, filePath))
      } else if (lower.startsWith('magnet:')) {
        items.push(createBatchItem('uri', url))
      } else if (lower.startsWith('thunder://')) {
        items.push(createBatchItem('uri', decodeThunderLink(url)))
      } else if (isRemoteUri && hasFileExt) {
        // Remote .torrent/.metalink URLs — detect kind for proper handling
        items.push(createBatchItem(detectKind(url), url))
      } else if (isRemoteUri) {
        items.push(createBatchItem('uri', url))
      }
    }

    if (items.length > 0) {
      const skipped = enqueueBatch(items)
      result.queued += items.length - skipped
    }

    return result
  }

  /**
   * Auto-submits a single extension URL using the user's default settings.
   * Equivalent to opening AddTask and clicking Submit without any changes.
   */
  async function autoSubmitExtensionUrl(
    url: string,
    referer: string,
    cookie: string,
    filenameHint: string,
  ): Promise<void> {
    const preferenceStore = usePreferenceStore()
    const taskStore = useTaskStore()

    const form: AddTaskForm = {
      uris: url,
      out: filenameHint,
      dir: preferenceStore.config.dir,
      split: preferenceStore.config.split ?? 16,
      userAgent: '',
      authorization: '',
      referer,
      cookie,
      proxyMode: isGlobalDownloadProxyActive(preferenceStore.config.proxy) ? 'global' : 'none',
      customProxy: '',
      globalProxyServer: preferenceStore.config.proxy?.server ?? '',
    }

    const options = buildEngineOptions(form)
    try {
      await submitManualUris(
        form,
        options,
        taskStore,
        {
          enabled: preferenceStore.config.fileCategoryEnabled,
          categories: preferenceStore.config.fileCategories,
        },
        getDownloadProxy(preferenceStore.config.proxy),
      )
      preferenceStore.recordHistoryDirectory(form.dir || preferenceStore.config.dir)
      logger.info('autoSubmit', `auto-submitted: ${url}`)
    } catch (e) {
      logger.error('autoSubmit', e)
    }
  }

  return {
    systemTheme,
    trayFocused,
    aboutPanelVisible,
    engineInfo,
    engineOptions,
    interval,
    stat,
    addTaskVisible,
    pendingBatch,
    addTaskOptions,
    pendingReferer,
    pendingCookie,
    progress,
    pendingUpdate,
    engineRestarting,
    setEngineRestarting,
    engineReady,
    pendingMagnetGids,
    updateInterval,
    increaseInterval,
    decreaseInterval,
    resetInterval,
    enqueueBatch,
    showAddTaskDialog,
    hideAddTaskDialog,
    updateAddTaskOptions,
    fetchGlobalStat,
    handleStatEvent,
    setupStatListener,
    fetchEngineInfo,
    fetchEngineOptions,
    handleDeepLinkUrls,
    pendingProtocolHijack,
    pendingFilename,
  }
})
