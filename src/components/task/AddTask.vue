<script setup lang="ts">
/** @fileoverview Add task dialog: dual-tab layout (URI / Torrent) with AutoAnimate list transitions. */
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE, ENGINE_MAX_CONNECTION_PER_SERVER } from '@shared/constants'
import { detectResource, bytesToSize } from '@shared/utils'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { mergeUriLines, normalizeUriLines, extractMagnetDisplayName } from '@shared/utils/batchHelpers'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  isGlobalProxyConfigured,
  isGlobalDownloadProxyActive,
  getDownloadProxy,
} from '@/composables/useAddTaskSubmit'
import type { ManualUriSubmitResult } from '@/composables/useAddTaskSubmit'
import { isValidAria2ProxyUrl } from '@shared/utils/aria2Proxy'
import { handleTaskStart } from '@/composables/useTaskNotifyHandlers'
import { isMagnetUri } from '@/composables/useMagnetFlow'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { logger } from '@shared/logger'

import { resolveUnresolvedItems, chooseTorrentFile as chooseTorrentFileImpl } from '@/composables/useAddTaskFileOps'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NIcon,
  NInputGroup,
  NDataTable,
  NTag,
  NEllipsis,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import type { DataTableColumns } from 'naive-ui'
import type { BatchItem } from '@shared/types'
import { FolderOpenOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { vAutoAnimate } from '@formkit/auto-animate'
import AdvancedOptions from './addtask/AdvancedOptions.vue'
import DirectoryPopover from '@/components/common/DirectoryPopover.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
/** Tracks whether the user manually edited the download directory in this session. */
const dirUserModified = ref(false)

const activeTab = ref(ADD_TASK_TYPE.URI)
const tabsRef = ref<InstanceType<typeof import('naive-ui').NTabs> | null>(null)

/**
 * Switch tab programmatically with correct animation direction.
 *
 * NTabs only computes `animationDirection` inside its internal `activateTab()`
 * handler (user clicks).  Programmatic `:value` changes skip that and always
 * default to `'next'`.  This helper mirrors the direction logic from the NTabs
 * source and sets it on the component instance before updating `activeTab`.
 */
const TAB_ORDER = [ADD_TASK_TYPE.URI, ADD_TASK_TYPE.TORRENT] as const
function switchTab(target: string): void {
  if (activeTab.value === target) return
  const inst = tabsRef.value as Record<string, unknown> | null
  if (inst && 'animationDirection' in inst) {
    const curIdx = TAB_ORDER.indexOf(activeTab.value as (typeof TAB_ORDER)[number])
    const tgtIdx = TAB_ORDER.indexOf(target as (typeof TAB_ORDER)[number])
    ;(inst as { animationDirection: string }).animationDirection = tgtIdx > curIdx ? 'next' : 'prev'
  }
  activeTab.value = target
}
const showAdvanced = ref(false)
const submitting = ref(false)
const selectedBatchIndex = ref(0)

const form = ref({
  uris: '',
  out: '',
  dir: preferenceStore.config.dir || '',
  split: preferenceStore.config.split || 16,
  userAgent: '',
  authorization: '',
  referer: '',
  cookie: '',
  proxyMode: (isGlobalDownloadProxyActive(preferenceStore.config.proxy) ? 'global' : 'none') as
    | 'none'
    | 'global'
    | 'custom',
  customProxy: '',
})

/**
 * Whether a usable global proxy is configured in Settings → Advanced.
 * Must read through preferenceStore.config (not a cached local) because
 * the store replaces the entire config ref on save, which would break
 * reactivity for any local alias.
 */
const globalProxyAvailable = computed(() => isGlobalProxyConfigured(preferenceStore.config.proxy))

/** The global proxy server address for display in the radio hint. */
const globalProxyServer = computed(() => preferenceStore.config.proxy?.server ?? '')

// Sync proxyMode when the global proxy config changes (e.g. disabled in
// settings, or config loads after component mount).  Without this, a stale
// 'global' mode would leave the proxy-hint visible with no matching radio.
watch(globalProxyAvailable, (available) => {
  if (!available && form.value.proxyMode === 'global') {
    form.value.proxyMode = 'none'
  }
})

const maxSplit = ENGINE_MAX_CONNECTION_PER_SERVER

// Real-time tracking: NInputNumber only commits v-model on blur,
// so we capture the native `input` event via bubbling from the inner
// <input> element. The watch covers +/− button clicks (immediate update).
const splitAtLimit = ref(form.value.split > maxSplit)

function onSplitRawInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const val = Number(raw)
  splitAtLimit.value = raw !== '' && !isNaN(val) && val > maxSplit
}

watch(
  () => form.value.split,
  (v) => {
    splitAtLimit.value = v > maxSplit
  },
)

const fileColumns = computed<DataTableColumns>(() => {
  const data = (selectedItem.value?.torrentMeta?.files ?? []) as Array<{ idx: number; length: number; path: string }>
  return [
    { type: 'selection' },
    {
      title: t('task.file-index'),
      key: 'idx',
      width: calcColumnWidth({
        title: t('task.file-index'),
        values: data.map((r) => String(r.idx)),
      }),
    },
    { title: t('task.file-name'), key: 'path', ellipsis: { tooltip: true } },
    {
      title: t('task.file-size'),
      key: 'length',
      width: calcColumnWidth({
        title: t('task.file-size'),
        values: data.map((r) => bytesToSize(r.length)),
        sortable: true,
      }),
      sorter: (a: Record<string, unknown>, b: Record<string, unknown>) => (a.length as number) - (b.length as number),
      render(row: Record<string, unknown>) {
        return bytesToSize(row.length as number)
      },
    },
  ]
})

// ── Computed batch accessors ────────────────────────────────────────

const batch = computed(() => appStore.pendingBatch)
const hasBatch = computed(() => batch.value.length > 0)
const fileItems = computed(() => batch.value.filter((i) => i.kind !== 'uri'))
const selectedItem = computed(() => fileItems.value[selectedBatchIndex.value] || null)

// Sync download dir and split with latest preference every time the dialog
// opens. AddTask is kept mounted (`:show` not `v-if`), so form values would
// otherwise be stale if the user changes defaults in preferences.
watch(
  () => props.show,
  (visible) => {
    if (visible) {
      // When classification is enabled, clear the dir so user sees it's optional;
      // otherwise sync from preferences as usual.
      if (preferenceStore.config.fileCategoryEnabled) {
        form.value.dir = ''
      } else {
        form.value.dir = preferenceStore.config.dir || form.value.dir
      }
      // Sync split from the user's Basic preference value
      form.value.split = preferenceStore.config.split ?? form.value.split
      // Reset the manual-override flag each time the dialog opens
      dirUserModified.value = false

      // Pre-fill referer and cookie from browser extension deep-link.
      // These are extracted by handleDeepLinkUrls() and stored as pending
      // values. Without this, the manual-submit path silently discards
      // them — causing cookie-gated CDNs (Quark, Baidu) to return 412.
      if (appStore.pendingReferer) {
        form.value.referer = appStore.pendingReferer
      }
      if (appStore.pendingCookie) {
        form.value.cookie = appStore.pendingCookie
      }
      if (appStore.pendingFilename) {
        form.value.out = appStore.pendingFilename
      }
    }
  },
)

const checkedRowKeys = computed({
  get: () => selectedItem.value?.selectedFileIndices || [],
  set: (keys: number[]) => {
    const item = selectedItem.value
    if (item) item.selectedFileIndices = keys
  },
})

const submitLabel = computed(() => t('app.submit'))

/** Whether file classification is currently enabled in preferences. */
const categoryEnabled = computed(() => preferenceStore.config.fileCategoryEnabled)

/** Dynamic label: switches between original 'Save to' and 'Custom Path' based on classification state. */
const dirLabel = computed(() => (categoryEnabled.value ? t('task.task-custom-dir') : t('task.task-dir')))

/** The resolved hint text key: changes based on whether user manually overrode the path. */
const categoryHintKey = computed(() =>
  dirUserModified.value ? 'task.category-hint-overridden' : 'task.category-hint-active',
)

/** Handles user manually editing the dir field. */
function onDirInput(value: string) {
  form.value.dir = value
  // Empty = user hasn't specified a custom path (auto-classification will handle it).
  // Non-empty = explicit user override, classification rules will be skipped.
  dirUserModified.value = value.trim().length > 0
}

// ── Lifecycle ───────────────────────────────────────────────────────

onMounted(async () => {
  if (!form.value.dir) {
    try {
      form.value.dir = await downloadDir()
    } catch (e) {
      logger.debug('AddTask.dir', e)
      form.value.dir = '~/Downloads'
    }
  }
})

// When dialog opens: resolve file items, flush URIs into textarea, auto-select tab
//
// Race-condition guard: the batch.length watcher may fire and drain pendingBatch
// BEFORE this async watcher finishes its clipboard read.  A simple `hasBatch`
// re-check fails because the batch is already empty by that point.  Instead we
// use a flag that the batch.length watcher sets synchronously whenever it writes
// to form.uris — the flag survives the drain and is visible after the await.
let batchDidWrite = false

watch(
  () => props.show,
  async (visible) => {
    if (!visible) {
      batchDidWrite = false
      return
    }
    selectedBatchIndex.value = 0

    if (hasBatch.value) {
      // Resolve file-based items
      await localResolveUnresolvedItems()
      // Flush URI batch items into the editable textarea via normalized merge
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        form.value.uris = mergeUriLines(
          form.value.uris,
          uriItems.map((i) => i.payload),
        )
        appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
      }
      // Auto-switch to Torrent tab when file items are present
      if (fileItems.value.length > 0) {
        switchTab(ADD_TASK_TYPE.TORRENT)
      } else {
        switchTab(ADD_TASK_TYPE.URI)
      }
    } else {
      // Only reset tab if batchWatcher hasn't already handled a programmatic
      // switch — otherwise we'd cause a rapid URI→TORRENT bounce that
      // confuses NTabs' animation direction.
      if (!batchDidWrite) switchTab(ADD_TASK_TYPE.URI)
      // No batch — check clipboard for URIs
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = await readText()
        // Re-check: a deep-link/extension batch may have arrived and been
        // processed (and drained) during the async readText() gap.
        // `hasBatch` is unreliable here because batchWatcher drains
        // pendingBatch after writing — use the flag instead.
        if (batchDidWrite) return
        if (text && detectResource(text, preferenceStore.config.clipboard)) {
          form.value.uris = text.trim()
        }
      } catch (e) {
        logger.debug('AddTask.readClipboard', e)
      }
    }
  },
)

// Watch for new batch items added while dialog is already open (drag-drop, deep link).
// Replace (not merge) the textarea — batch content takes priority over any clipboard
// auto-fill that the show watcher may have already written.
watch(
  () => batch.value.length,
  async (newLen, oldLen) => {
    if (!props.show || newLen <= oldLen) return
    // Snapshot newly arrived items before any drain/resolve mutates the batch.
    const newlyArrived = batch.value.slice(oldLen)
    const uriItems = batch.value.filter((i) => i.kind === 'uri')
    if (uriItems.length > 0) {
      batchDidWrite = true
      form.value.uris = mergeUriLines(
        '',
        uriItems.map((i) => i.payload),
      )
      appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
    }
    // Auto-switch tab SYNCHRONOUSLY (before any await) so NTabs computes
    // the correct slide direction in the same render tick.
    const hasNewFiles = newlyArrived.some((i) => i.kind !== 'uri')
    const hasNewUris = newlyArrived.some((i) => i.kind === 'uri')
    if (hasNewFiles) {
      switchTab(ADD_TASK_TYPE.TORRENT)
    } else if (hasNewUris) {
      switchTab(ADD_TASK_TYPE.URI)
    }
    // Resolve file metadata asynchronously (doesn't affect tab choice).
    await localResolveUnresolvedItems()
  },
)

// ── File resolution (delegated to useAddTaskFileOps) ────────────────

async function localResolveUnresolvedItems() {
  await resolveUnresolvedItems(batch.value, t, getDownloadProxy(preferenceStore.config.proxy))
}

async function chooseTorrentFile() {
  await chooseTorrentFileImpl({
    t,
    batch,
    fileItems,
    selectedBatchIndex,
    setPendingBatch: (items) => {
      appStore.pendingBatch = items
    },
    showWarning: (msg) => message.warning(msg),
  })
}

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true })
    if (typeof selected === 'string') {
      form.value.dir = selected
      // Only mark as user-override when classification is active
      dirUserModified.value = categoryEnabled.value && selected.trim().length > 0
    }
  } catch (e) {
    logger.debug('AddTask.chooseDirectory', e)
  }
}

function onDirectorySelect(dir: string) {
  form.value.dir = dir
  dirUserModified.value = categoryEnabled.value && dir.trim().length > 0
}

function removeBatchItem(item: BatchItem) {
  appStore.pendingBatch = batch.value.filter((i) => i !== item)
  selectedBatchIndex.value = Math.min(selectedBatchIndex.value, Math.max(0, fileItems.value.length - 1))
}

// ── Submit ───────────────────────────────────────────────────────────

function handleClose() {
  emit('close')
  Object.assign(form.value, {
    uris: '',
    out: '',
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    proxyMode: isGlobalDownloadProxyActive(preferenceStore.config.proxy) ? 'global' : 'none',
    customProxy: '',
  })
  submitting.value = false
  selectedBatchIndex.value = 0
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true

  try {
    // Validate custom proxy before building options
    if (form.value.proxyMode === 'custom' && form.value.customProxy) {
      if (!isValidAria2ProxyUrl(form.value.customProxy)) {
        message.error(t('task.proxy-unsupported-protocol'), { closable: true })
        submitting.value = false
        return
      }
    }

    // When dir field is empty (user left it blank for auto-classification),
    // fall back to the global default dir so aria2 always has a valid path.
    const effectiveForm = {
      ...form.value,
      dir: form.value.dir.trim() || preferenceStore.config.dir,
      globalProxyServer: globalProxyServer.value,
    }
    const options = buildEngineOptions(effectiveForm)
    let manualResult: ManualUriSubmitResult = { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }

    if (hasBatch.value) {
      await submitBatchItems(batch.value, options, taskStore)
    }
    if (form.value.uris.trim()) {
      // User's custom path takes highest priority — skip classification when overridden
      const shouldClassify = preferenceStore.config.fileCategoryEnabled && !dirUserModified.value
      manualResult = await submitManualUris(
        effectiveForm,
        options,
        taskStore,
        {
          enabled: shouldClassify,
          categories: preferenceStore.config.fileCategories,
        },
        getDownloadProxy(preferenceStore.config.proxy),
      )
    }

    const failedCount = batch.value.filter((i) => i.status === 'failed').length + manualResult.magnetFailures.length
    if (failedCount > 0) {
      message.warning(`${failedCount} ${t('task.failed') || 'failed'}`, { closable: true })
    } else {
      // ── Collect task names BEFORE handleClose clears form state ──
      const taskNames: string[] = []
      for (const item of batch.value) {
        if (item.status === 'submitted') {
          taskNames.push(item.displayName)
        }
      }
      taskNames.push(...manualResult.submittedTaskNames)
      const allUris = normalizeUriLines(form.value.uris)
      const magnetUris = allUris.filter(isMagnetUri)
      for (let i = 0; i < manualResult.magnetGids.length; i++) {
        const dn = magnetUris[i] ? extractMagnetDisplayName(magnetUris[i]) : ''
        taskNames.push(dn || t('task.magnet-task'))
      }

      handleClose()

      // ── Record directory for the recent-folders popover ────────
      const effectiveDir = form.value.dir.trim() || preferenceStore.config.dir
      if (effectiveDir) {
        preferenceStore.recordHistoryDirectory(effectiveDir)
      }

      // ── Start notification (aggregated) ────────────────────────
      handleTaskStart(taskNames, {
        messageInfo: message.info,
        t,
        taskNotification: preferenceStore.config.taskNotification !== false,
        notifyOnStart: preferenceStore.config.notifyOnStart === true,
      })

      if (preferenceStore.config.newTaskShowDownloading !== false) {
        router.push({ path: '/task/all' }).catch(() => {})
      }
    }
  } catch (e: unknown) {
    const category = classifySubmitError(e)
    const errMsg = e instanceof Error ? e.message : String(e)
    logger.error('AddTask.submit', e)
    if (category === 'engine-not-ready') {
      message.error(t('app.engine-not-ready'), { closable: true })
    } else if (category === 'duplicate') {
      message.warning(errMsg, { closable: true })
    } else {
      message.error(errMsg, { closable: true })
    }
  } finally {
    submitting.value = false
  }
}

function kindTagType(kind: string): 'info' | 'success' | 'warning' {
  switch (kind) {
    case 'torrent':
      return 'info'
    case 'metalink':
      return 'success'
    default:
      return 'warning'
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="false"
    :close-on-esc="true"
    :auto-focus="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NCard
      :title="t('task.new-task')"
      closable
      class="add-task-card"
      :style="{
        maxWidth: '680px',
        minWidth: '380px',
        width: '70vw',
        margin: 'auto',
        height: '82vh',
        display: 'flex',
        flexDirection: 'column',
      }"
      :content-style="{ flex: '1', minHeight: '0', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
      @close="handleClose"
    >
      <NForm label-placement="left" label-width="110px">
        <NTabs ref="tabsRef" :value="activeTab" type="line" animated @update:value="(v: string) => (activeTab = v)">
          <!-- ── URI Tab ──────────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.URI" :tab="t('task.uri-task') || 'URL'">
            <div class="tab-pane-content">
              <NFormItem :show-label="false" style="margin-bottom: 0">
                <NInput
                  v-model:value="form.uris"
                  type="textarea"
                  :rows="5"
                  :placeholder="t('task.uri-task-tips') || 'One URL per line'"
                />
              </NFormItem>
            </div>
          </NTabPane>

          <!-- ── Torrent Tab ─────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.TORRENT" :tab="t('task.torrent-task') || 'Torrent'">
            <div v-auto-animate="{ duration: 200, easing: 'ease-out' }" class="tab-pane-content">
              <!-- Torrent panel: animated batch list + file detail -->
              <div v-if="fileItems.length > 0" class="torrent-panel">
                <!-- Batch list with AutoAnimate transitions -->
                <div v-auto-animate="{ duration: 200, easing: 'ease-out' }" class="batch-list">
                  <div
                    v-for="(item, idx) in fileItems"
                    :key="item.id"
                    class="batch-item"
                    :class="{ 'batch-item-selected': idx === selectedBatchIndex }"
                    @click="selectedBatchIndex = idx"
                  >
                    <div class="batch-item-main">
                      <NEllipsis :style="{ maxWidth: '400px', flex: 1 }">{{ item.displayName }}</NEllipsis>
                      <NSpace :size="4" align="center" :wrap="false">
                        <NTag :type="kindTagType(item.kind)" size="small" :bordered="false">
                          {{ item.kind === 'metalink' ? 'Metalink' : 'Torrent' }}
                        </NTag>
                        <NButton quaternary size="tiny" @click.stop="removeBatchItem(item)">✕</NButton>
                      </NSpace>
                    </div>
                  </div>
                </div>

                <!-- Add more files button -->
                <NButton size="small" dashed block style="margin-top: 6px" @click="chooseTorrentFile">
                  <template #icon>
                    <NIcon><CloudUploadOutline /></NIcon>
                  </template>
                  {{ t('task.select-torrent') || 'Select torrent files' }}
                </NButton>

                <!-- File detail for selected torrent -->
                <Transition name="content-fade" mode="out-in">
                  <div
                    v-if="selectedItem?.torrentMeta && selectedItem.torrentMeta.files.length > 0"
                    :key="selectedItem?.id"
                    class="torrent-file-list"
                  >
                    <NDataTable
                      v-model:checked-row-keys="checkedRowKeys"
                      :columns="fileColumns"
                      :data="selectedItem.torrentMeta.files"
                      :row-key="(row: any) => row.idx as number"
                      size="small"
                      :max-height="200"
                      :scroll-x="400"
                    />
                  </div>
                </Transition>
              </div>

              <!-- Upload zone: shown when no torrents loaded -->
              <div v-if="fileItems.length === 0" class="torrent-upload-zone" @click="chooseTorrentFile">
                <NIcon :size="36" :depth="3"><CloudUploadOutline /></NIcon>
                <span class="torrent-upload-text">
                  {{ t('task.select-torrent') || 'Drag torrent here or click to select' }}
                </span>
              </div>
            </div>
          </NTabPane>
        </NTabs>

        <!-- ── Download settings: always visible ──────────────── -->
        <div class="download-settings">
          <NFormItem :label="t('task.task-out') + ':'">
            <NInput v-model:value="form.out" :placeholder="t('task.task-out-tips')" :autofocus="false" />
          </NFormItem>
          <NFormItem :label="t('preferences.split-count') + ':'">
            <div class="split-field-wrapper" @input="onSplitRawInput">
              <NInputNumber v-model:value="form.split" :min="1" :max="maxSplit" style="width: 120px" />
              <!-- Limit hint — CSS Grid 0fr→1fr slide-in, mirrors ua-warn pattern -->
              <div class="split-limit-collapse" :class="{ 'split-limit-collapse--open': splitAtLimit }">
                <div class="split-limit-collapse__inner">
                  <div class="split-limit-bar">
                    <span class="split-limit-text">⚠ {{ t('task.split-limit-hint') }}</span>
                  </div>
                </div>
              </div>
            </div>
          </NFormItem>
          <NFormItem :label="dirLabel + ':'">
            <div style="width: 100%">
              <NInputGroup>
                <NInput
                  :value="form.dir"
                  style="flex: 1"
                  :placeholder="categoryEnabled ? t('task.category-dir-placeholder') : ''"
                  @update:value="onDirInput"
                />
                <NButton @click="chooseDirectory">
                  <template #icon>
                    <NIcon><FolderOpenOutline /></NIcon>
                  </template>
                </NButton>
                <DirectoryPopover @select="onDirectorySelect" />
              </NInputGroup>
              <Transition name="category-hint" mode="out-in">
                <div v-if="categoryEnabled" :key="categoryHintKey" class="category-hint-text">
                  ⓘ {{ t(categoryHintKey) }}
                </div>
              </Transition>
            </div>
          </NFormItem>
          <AdvancedOptions
            v-model:show="showAdvanced"
            v-model:user-agent="form.userAgent"
            v-model:authorization="form.authorization"
            v-model:referer="form.referer"
            v-model:cookie="form.cookie"
            v-model:proxy-mode="form.proxyMode"
            v-model:custom-proxy="form.customProxy"
            :global-proxy-available="globalProxyAvailable"
            :global-proxy-server="globalProxyServer"
          />
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton data-testid="submit-button" type="primary" :loading="submitting" @click="handleSubmit">
            {{ submitLabel }}
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.torrent-file-list {
  margin-top: 8px;
}

/* Fixed-height tab panes prevent jitter when switching tabs.
 * URI textarea rows=5 ≈ 138px — keep both panes at same min-height. */
.tab-pane-content {
  min-height: 150px;
}

/* ── Torrent panel ────────────────────────────────────────────────── */
.torrent-panel {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  background: var(--n-color, var(--m3-surface-container-low));
}

/* ── Batch list ───────────────────────────────────────────────────── */
.batch-list {
  border-radius: 6px;
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  overflow: hidden;
}

/* ── Upload zone (when no torrents) ───────────────────────────────── */
.torrent-upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 138px;
  border: 1px dashed var(--m3-drop-zone-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.torrent-upload-zone:hover {
  border-color: var(--color-primary);
}
.torrent-upload-text {
  font-size: 13px;
  opacity: 0.6;
}

/* ── Download settings ────────────────────────────────────────────── */
.download-settings {
  margin-top: 4px;
}

/* ── Split limit hint — CSS Grid 0fr→1fr slide-in (mirrors ua-warn) ─── */
.split-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.split-limit-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.split-limit-collapse--open {
  grid-template-rows: 1fr;
}
.split-limit-collapse__inner {
  overflow: hidden;
}
.split-limit-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container-bg);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.split-limit-collapse--open .split-limit-bar {
  opacity: 1;
}
.split-limit-text {
  font-size: var(--font-size-sm);
  color: var(--m3-error);
  flex: 1;
}
</style>

<!-- Non-scoped: Vue Transition classes must NOT be scoped -->
<style>
/* ── Batch item base styles ───────────────────────────────────────── */
.batch-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.batch-item:hover {
  background: var(--n-color-hover, var(--m3-surface-container-high));
}
.batch-item-selected {
  background: var(--n-color-hover, var(--m3-surface-container-highest));
}
.batch-item + .batch-item {
  border-top: 1px solid var(--n-border-color, var(--m3-outline-variant));
}
.batch-item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* ── Content crossfade (file detail switching) ────────────────────── */
.content-fade-enter-active {
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.content-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.content-fade-enter-from,
.content-fade-leave-to {
  opacity: 0;
}

/* ── Category hint below dir field ────────────────────────────────── */
.category-hint-text {
  font-size: var(--font-size-sm, 12px);
  color: var(--n-text-color-3, #999);
  margin-top: 4px;
  padding-left: 2px;
}
.category-hint-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.category-hint-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.category-hint-enter-from,
.category-hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
