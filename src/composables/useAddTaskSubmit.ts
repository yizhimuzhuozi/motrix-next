/**
 * @fileoverview Composable encapsulating AddTask submission logic.
 *
 * Extracted from AddTask.vue to make the complex branching testable:
 * - Options building (headers, proxy, user-agent, etc.)
 * - Batch submission routing (torrent vs metalink)
 * - Manual URI submission with multi-URI rename
 * - Error classification (engine-not-ready, duplicate, generic)
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { isEngineReady } from '@/api/aria2'
import { normalizeUriLines } from '@shared/utils/batchHelpers'
import { buildOuts } from '@shared/utils/rename'
import { logger } from '@shared/logger'
import type { Aria2EngineOptions, BatchItem, ProxyConfig } from '@shared/types'
import { isMagnetUri } from '@/composables/useMagnetFlow'

export interface AddTaskForm {
  uris: string
  out: string
  dir: string
  split: number
  userAgent: string
  authorization: string
  referer: string
  cookie: string
  /** Whether this task should use the global proxy server. */
  useProxy: boolean
  /** Injected from the preference store — not user-editable in the form. */
  globalProxyServer?: string
}

export interface UseAddTaskSubmitOptions {
  form: Ref<AddTaskForm>
  onClose: () => void
}

export interface MagnetSubmitFailure {
  uri: string
  error: string
}

export interface ManualUriSubmitResult {
  magnetGids: string[]
  magnetFailures: MagnetSubmitFailure[]
}

/**
 * Builds aria2 engine options from the add-task form.
 * Pure function — no side effects, fully testable.
 */
export function buildEngineOptions(form: AddTaskForm): Aria2EngineOptions {
  const options: Aria2EngineOptions = {
    dir: form.dir,
    split: String(form.split),
    // max-connection-per-server is intentionally NOT set per-task.
    // It uses the global value pushed by syncGlobalOptions(), allowing
    // split (segment count) and max-conn (server connection cap) to be
    // controlled independently. See: aria2 download_helper.cc:394-401.
  }
  if (form.out) options.out = form.out
  if (form.userAgent) options['user-agent'] = form.userAgent
  if (form.referer) options.referer = form.referer

  const headers: string[] = []
  if (form.cookie) headers.push(`Cookie: ${form.cookie}`)
  if (form.authorization) headers.push(`Authorization: ${form.authorization}`)
  if (headers.length > 0) options.header = headers

  if (form.useProxy && form.globalProxyServer) {
    options['all-proxy'] = form.globalProxyServer
  }
  return options
}

/**
 * Returns true if the global proxy is configured (enabled with a non-empty server).
 * Used by the AddTask UI to determine whether the proxy checkbox should be available.
 * Pure function — no side effects.
 */
export function isGlobalProxyConfigured(proxy: ProxyConfig): boolean {
  return proxy.enable && !!proxy.server.trim()
}

/**
 * Returns true if the global proxy is active AND its scope includes downloads.
 * When true, aria2 already routes all downloads through the proxy at the engine
 * level, so the per-task checkbox defaults to checked.
 * Pure function — no side effects.
 */
export function isGlobalDownloadProxyActive(proxy: ProxyConfig): boolean {
  return isGlobalProxyConfigured(proxy) && Array.isArray(proxy.scope) && proxy.scope.includes('download')
}

/**
 * Classifies an error from task submission into a user-friendly category.
 * Pure function — fully testable.
 */
export function classifySubmitError(err: unknown): 'engine-not-ready' | 'duplicate' | 'generic' {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('not initialized') || !isEngineReady()) return 'engine-not-ready'
  if (/duplicate|already/i.test(msg)) return 'duplicate'
  return 'generic'
}

/**
 * Submits file-based batch items (torrent/metalink) to the engine.
 * Mutates item.status in place; returns count of failures.
 */
export async function submitBatchItems(
  items: BatchItem[],
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
): Promise<number> {
  let failures = 0
  for (const item of items) {
    if (item.kind === 'uri') continue
    if (item.status !== 'pending' && item.status !== 'failed') continue
    try {
      if (item.kind === 'torrent') {
        const opts: Aria2EngineOptions = { ...options }
        delete opts.out
        if (
          item.selectedFileIndices &&
          item.torrentMeta &&
          item.selectedFileIndices.length > 0 &&
          item.selectedFileIndices.length < item.torrentMeta.files.length
        ) {
          opts['select-file'] = item.selectedFileIndices.join(',')
        }
        // Register source path by infoHash BEFORE addTorrent to avoid race:
        // fast downloads enter seeding before addTorrent promise resolves.
        if (item.source && item.torrentMeta?.infoHash) {
          taskStore.registerTorrentSource(item.torrentMeta.infoHash, item.source)
        }
        await taskStore.addTorrent({ torrent: item.payload, options: opts })
      } else if (item.kind === 'metalink') {
        const opts: Aria2EngineOptions = { ...options }
        delete opts.out
        await taskStore.addMetalink({ metalink: item.payload, options: opts })
      }
      item.status = 'submitted'
    } catch (e) {
      item.status = 'failed'
      item.error = e instanceof Error ? e.message : String(e)
      logger.error('submitBatchItems', e)
      failures++
    }
  }
  return failures
}

/**
 * Submits manually entered URIs from the textarea.
 * Handles multi-URI rename with buildOuts.
 *
 * Magnet URIs are separated and submitted via addMagnetUri (metadata-only mode).
 * Returns an array of magnet GIDs for the caller to monitor for file selection.
 */
export async function submitManualUris(
  form: AddTaskForm,
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
): Promise<ManualUriSubmitResult> {
  if (!form.uris.trim()) return { magnetGids: [], magnetFailures: [] }
  const allUris = normalizeUriLines(form.uris)

  // Partition into magnet and regular URIs
  const magnetUris = allUris.filter(isMagnetUri)
  const regularUris = allUris.filter((uri) => !isMagnetUri(uri))

  // Submit regular URIs using the existing path
  if (regularUris.length > 0) {
    if (regularUris.length > 1 && form.out) {
      const regularOptions = { ...options }
      delete regularOptions.out
      let outs = buildOuts(regularUris, form.out)
      if (outs.length === 0) {
        const dotIdx = form.out.lastIndexOf('.')
        const base = dotIdx > 0 ? form.out.substring(0, dotIdx) : form.out
        const ext = dotIdx > 0 ? form.out.substring(dotIdx) : ''
        outs = regularUris.map((_, i) => `${base}_${i + 1}${ext}`)
      }
      await taskStore.addUri({ uris: regularUris, outs, options: regularOptions })
    } else {
      // Let aria2 handle filename resolution natively:
      // 1. Content-Disposition header (highest priority)
      // 2. Redirected URL filename
      // 3. URL path segment with built-in percentDecode
      // See: aria2 HttpResponse.cc:determineFilename()
      await taskStore.addUri({ uris: regularUris, outs: [], options })
    }
  }

  // Submit magnet URIs (normal mode — global pause-metadata controls pausing)
  const result: ManualUriSubmitResult = {
    magnetGids: [],
    magnetFailures: [],
  }
  for (const uri of magnetUris) {
    try {
      const gid = await taskStore.addMagnetUri({ uri, options })
      result.magnetGids.push(gid)
    } catch (e) {
      logger.error('submitManualUris.magnet', e)
      result.magnetFailures.push({
        uri,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return result
}

export function useAddTaskSubmit({ form, onClose }: UseAddTaskSubmitOptions) {
  const { t } = useI18n()
  const router = useRouter()
  const appStore = useAppStore()
  const taskStore = useTaskStore()
  const preferenceStore = usePreferenceStore()
  const message = useAppMessage()
  const submitting = ref(false)

  async function handleSubmit() {
    if (submitting.value) return
    submitting.value = true

    try {
      const options = buildEngineOptions(form.value)
      const batch = appStore.pendingBatch
      let magnetFailureCount = 0

      if (batch.length > 0) {
        await submitBatchItems(batch, options, taskStore)
      }
      if (form.value.uris.trim()) {
        const manualResult = await submitManualUris(form.value, options, taskStore)
        magnetFailureCount = manualResult.magnetFailures.length
        // pendingMagnetGids is set directly inside addMagnetUri (task store)
      }

      const failedCount = batch.filter((i) => i.status === 'failed').length + magnetFailureCount
      if (failedCount > 0) {
        message.warning(`${failedCount} ${t('task.failed') || 'failed'}`, { duration: 5000, closable: true })
      } else {
        onClose()
        if (preferenceStore.config.newTaskShowDownloading !== false) {
          router.push({ path: '/task/all' }).catch(() => {})
        }
      }
    } catch (e: unknown) {
      const category = classifySubmitError(e)
      const errMsg = e instanceof Error ? e.message : String(e)
      logger.error('AddTask.submit', e)
      if (category === 'engine-not-ready') {
        message.error(t('app.engine-not-ready'), { duration: 5000, closable: true })
      } else if (category === 'duplicate') {
        message.warning(errMsg, { duration: 5000, closable: true })
      } else {
        message.error(errMsg, { duration: 5000, closable: true })
      }
    } finally {
      submitting.value = false
    }
  }

  return { submitting, handleSubmit }
}
