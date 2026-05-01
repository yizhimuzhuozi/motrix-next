/**
 * @fileoverview Composable for managing per-task options in the Task Detail drawer.
 *
 * Reads the current task's options via `getTaskOption`, exposes a reactive form
 * for UA, referer, cookie, authorization, and proxy (tri-state: none/global/custom),
 * and applies changes via `changeTaskOption`.
 *
 * ## aria2 source code verification
 *
 * All target options are confirmed mutable via `changeOption` in
 * `OptionHandlerFactory.cc` — each has `setChangeOptionForReserved(true)`:
 * - `all-proxy` (L1390) — HttpProxyOptionHandler, accepts any proxy URL
 * - `user-agent` (L1223) — DefaultOptionHandler
 * - `referer` (L1185) — DefaultOptionHandler
 * - `header` (L1094) — CumulativeOptionHandler, accepts array input
 *
 * For **active** tasks, these go through the `pendingOption` path
 * (RpcMethodImpl.cc L1120-1131): pause → apply → restart.
 *
 * Pure dependency-injection design — no direct store/API imports — fully testable.
 */
import { ref, reactive, computed, watch, type Ref } from 'vue'
import { isEngineReady } from '@/api/aria2'
import { isGlobalProxyConfigured } from '@/composables/useAddTaskSubmit'
import { isValidAria2ProxyUrl } from '@shared/utils/aria2Proxy'
import { sanitizeHeaderValue, sanitizeHttpHeaderOptions } from '@shared/utils/headerSanitize'
import { TASK_STATUS } from '@shared/constants'
import type { Aria2Task, Aria2EngineOptions, ProxyConfig } from '@shared/types'
import { logger } from '@shared/logger'

// ── Constants ─────────────────────────────────────────────────────

/** Task statuses where aria2 allows option modification. */
const MODIFIABLE_STATUSES = new Set([TASK_STATUS.ACTIVE, TASK_STATUS.WAITING, TASK_STATUS.PAUSED])

// ── Public types ──────────────────────────────────────────────────

/** Proxy configuration mode for a specific task. */
export type ProxyMode = 'none' | 'global' | 'custom'

export interface TaskDetailOptionsForm {
  userAgent: string
  referer: string
  cookie: string
  authorization: string
  proxyMode: ProxyMode
  customProxy: string
}

export interface UseTaskDetailOptionsConfig {
  task: Ref<Aria2Task | null>
  getTaskOption: (gid: string) => Promise<Record<string, string>>
  changeTaskOption: (payload: { gid: string; options: Aria2EngineOptions }) => Promise<void>
  proxyConfig: () => ProxyConfig
  message: {
    success: (content: string) => void
    error: (content: string) => void
  }
  t: (key: string) => string
}

// ── Pure header utilities ─────────────────────────────────────────

/**
 * Extracts Cookie and Authorization values from aria2's `header` option.
 *
 * aria2 may return `header` as a single newline-separated string, an array
 * of strings, or undefined. This function handles all forms gracefully.
 */
export function parseHeaders(raw: string | string[] | undefined): {
  cookie: string
  authorization: string
} {
  const result = { cookie: '', authorization: '' }
  if (!raw) return result

  const lines = Array.isArray(raw) ? raw : raw.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^Cookie:\s*/i.test(trimmed)) {
      result.cookie = trimmed.replace(/^Cookie:\s*/i, '').trim()
    } else if (/^Authorization:\s*/i.test(trimmed)) {
      result.authorization = trimmed.replace(/^Authorization:\s*/i, '').trim()
    }
  }
  return result
}

/**
 * Builds an aria2 `header` array from cookie and authorization values.
 * Returns an empty array when both are empty.
 */
export function buildHeaders(cookie: string, authorization: string): string[] {
  const headers: string[] = []
  const cleanCookie = sanitizeHeaderValue(cookie)
  const cleanAuthorization = sanitizeHeaderValue(authorization)
  if (cleanCookie) headers.push(`Cookie: ${cleanCookie}`)
  if (cleanAuthorization) headers.push(`Authorization: ${cleanAuthorization}`)
  return headers
}

// ── Form snapshot helpers ─────────────────────────────────────────

function createEmptyForm(): TaskDetailOptionsForm {
  return {
    userAgent: '',
    referer: '',
    cookie: '',
    authorization: '',
    proxyMode: 'none',
    customProxy: '',
  }
}

function snapshotForm(source: TaskDetailOptionsForm, target: TaskDetailOptionsForm) {
  Object.assign(target, { ...source })
}

// ── Proxy detection ───────────────────────────────────────────────

/** Strips trailing slashes for URL comparison (aria2 normalizes proxy URLs). */
function normalizeProxyUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Detects the proxy mode from the loaded all-proxy value.
 * - Empty → none
 * - Matches global proxy server → global
 * - Anything else → custom (with the URL preserved)
 *
 * Uses normalized comparison because aria2's HttpProxyOptionHandler
 * reconstructs URLs via uri::construct(), which appends a trailing
 * slash (e.g. "http://host:port" → "http://host:port/").
 */
function detectProxyMode(allProxy: string, globalServer: string): { mode: ProxyMode; custom: string } {
  if (!allProxy) return { mode: 'none', custom: '' }
  if (globalServer && normalizeProxyUrl(allProxy) === normalizeProxyUrl(globalServer)) {
    return { mode: 'global', custom: '' }
  }
  return { mode: 'custom', custom: allProxy }
}

// ── Options loader ────────────────────────────────────────────────

function populateFormFromResponse(opts: Record<string, string>, form: TaskDetailOptionsForm, globalServer: string) {
  form.userAgent = (opts.userAgent as string) ?? ''
  form.referer = (opts.referer as string) ?? ''

  const headerRaw = opts.header as unknown as string | string[] | undefined
  const parsed = parseHeaders(headerRaw)
  form.cookie = parsed.cookie
  form.authorization = parsed.authorization

  const allProxy = (opts.allProxy as string) ?? ''
  const detected = detectProxyMode(allProxy, globalServer)
  form.proxyMode = detected.mode
  form.customProxy = detected.custom
}

// ── Changed-options diff builder ──────────────────────────────────

function buildChangedOptions(
  form: TaskDetailOptionsForm,
  loaded: TaskDetailOptionsForm,
  resolvedProxy: string,
): Aria2EngineOptions {
  const options: Aria2EngineOptions = {}
  const sanitizedHeaders = sanitizeHttpHeaderOptions({
    userAgent: form.userAgent,
    referer: form.referer,
    cookie: form.cookie,
    authorization: form.authorization,
  })

  if (form.userAgent !== loaded.userAgent) {
    options['user-agent'] = sanitizedHeaders.userAgent ?? ''
  }
  if (form.referer !== loaded.referer) {
    options.referer = sanitizedHeaders.referer ?? ''
  }
  if (form.cookie !== loaded.cookie || form.authorization !== loaded.authorization) {
    options.header = buildHeaders(form.cookie, form.authorization)
  }
  if (form.proxyMode !== loaded.proxyMode || form.customProxy !== loaded.customProxy) {
    options['all-proxy'] = resolvedProxy
  }

  return options
}

// ── Proxy resolution ──────────────────────────────────────────────

function resolveProxy(mode: ProxyMode, customProxy: string, globalServer: string): string {
  if (mode === 'global') return globalServer
  if (mode === 'custom') return customProxy
  return ''
}

// ── Composable ────────────────────────────────────────────────────

export function useTaskDetailOptions(config: UseTaskDetailOptionsConfig) {
  const { task, getTaskOption, changeTaskOption, proxyConfig, message, t } = config

  const form = reactive<TaskDetailOptionsForm>(createEmptyForm())
  const loaded = reactive<TaskDetailOptionsForm>(createEmptyForm())
  const applying = ref(false)

  const canModify = computed(() => {
    if (!task.value || !isEngineReady()) return false
    return MODIFIABLE_STATUSES.has(task.value.status)
  })

  const globalProxyAvailable = computed(() => isGlobalProxyConfigured(proxyConfig()))
  const proxyAddress = computed(() => proxyConfig()?.server ?? '')

  const dirty = computed(
    () =>
      form.userAgent !== loaded.userAgent ||
      form.referer !== loaded.referer ||
      form.cookie !== loaded.cookie ||
      form.authorization !== loaded.authorization ||
      form.proxyMode !== loaded.proxyMode ||
      form.customProxy !== loaded.customProxy,
  )

  function resetForm() {
    Object.assign(form, createEmptyForm())
    snapshotForm(form, loaded)
  }

  async function loadOptions(gid: string) {
    try {
      const opts = await getTaskOption(gid)
      populateFormFromResponse(opts, form, proxyAddress.value)

      // If the global proxy has been disabled since this task was created,
      // the detected 'global' mode is stale — downgrade to 'custom' so the
      // UI truthfully shows the actual per-task proxy address from aria2.
      // The user can then manually clear it or switch to 'none'.
      if (form.proxyMode === 'global' && !globalProxyAvailable.value) {
        const actualProxy = (opts.allProxy as string) ?? ''
        form.proxyMode = actualProxy ? 'custom' : 'none'
        form.customProxy = actualProxy
      }

      snapshotForm(form, loaded)
    } catch (err) {
      logger.debug('[useTaskDetailOptions] getTaskOption failed', err)
      resetForm()
    }
  }

  watch(
    () => task.value?.gid,
    (gid) => (gid && canModify.value ? void loadOptions(gid) : resetForm()),
    { immediate: true },
  )

  // Sync proxyMode in real-time when global proxy config changes.
  // Covers the timing gap where loadOptions ran before the preference
  // store finished loading, leaving a stale 'global' mode.
  watch(globalProxyAvailable, (available) => {
    if (!available && form.proxyMode === 'global') {
      form.proxyMode = form.customProxy ? 'custom' : 'none'
    }
  })

  async function applyOptions(): Promise<void> {
    if (applying.value || !task.value || !dirty.value) return
    applying.value = true
    try {
      const proxy = resolveProxy(form.proxyMode, form.customProxy, proxyAddress.value)

      // Validate proxy format before sending to aria2 — prevents errorCode=28 crash
      if (proxy && !isValidAria2ProxyUrl(proxy)) {
        message.error(t('task.proxy-unsupported-protocol'))
        return
      }

      const options = buildChangedOptions(form, loaded, proxy)
      await changeTaskOption({ gid: task.value.gid, options })
      snapshotForm(form, loaded)
      const key = task.value.status === TASK_STATUS.ACTIVE ? 'task.options-applied-restart' : 'task.options-applied'
      message.success(t(key))
    } catch (err) {
      logger.debug('[useTaskDetailOptions] changeTaskOption failed', err)
      message.error(t('task.options-apply-failed'))
    } finally {
      applying.value = false
    }
  }

  return { form, canModify, globalProxyAvailable, proxyAddress, dirty, applying, applyOptions }
}
