<script setup lang="ts">
/** @fileoverview Downloads preference tab: paths, concurrency, speed limits, notifications, cleanup. */
import { ref, computed, h, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { extractSpeedUnit } from '@shared/utils'
import { logger } from '@shared/logger'
import { toggleSpeedLimit } from '@/composables/useSpeedLimiter'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import {
  ENGINE_RPC_PORT,
  ENGINE_MAX_CONNECTION_PER_SERVER,
  SAFE_LIMIT_SPLIT,
  SAFE_LIMIT_CONNECTION_PER_SERVER,
  SCHEDULE_DAY,
  buildDefaultCategories,
  MAX_FILE_CATEGORIES,
} from '@shared/constants'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  buildDownloadsForm,
  buildDownloadsSystemConfig,
  recordDownloadsDirectory,
  transformDownloadsForStore,
} from '@/composables/useDownloadsPreference'
import type { FileCategory } from '@shared/types'
import { vAutoAnimate } from '@formkit/auto-animate'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NButton,
  NDivider,
  NInputGroup,
  NText,
  NCollapseTransition,
  NDynamicTags,
  NIcon,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import DirectoryPopover from '@/components/common/DirectoryPopover.vue'
import { FolderOpenOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const defaultDownloadDir = ref('')

// ── File timestamp strategy ─────────────────────────────────────────
const FILE_TS_DOWNLOAD = 'download'
const FILE_TS_SERVER = 'server'
const fileTimestampOptions = computed(() => [
  { label: t('preferences.file-timestamp-download'), value: FILE_TS_DOWNLOAD },
  { label: t('preferences.file-timestamp-server'), value: FILE_TS_SERVER },
])
const fileTimestampValue = computed(() => (form.value.remoteTime ? FILE_TS_SERVER : FILE_TS_DOWNLOAD))
function handleFileTimestampChange(val: string) {
  form.value.remoteTime = val === FILE_TS_SERVER
}

// ── Safe-limit warning ──────────────────────────────────────────────
const safeLimits = [
  {
    field: 'split' as const,
    safe: SAFE_LIMIT_SPLIT,
    labelKey: 'preferences.split-count',
    reasonKey: 'preferences.high-split-reason',
  },
  {
    field: 'maxConnectionPerServer' as const,
    safe: SAFE_LIMIT_CONNECTION_PER_SERVER,
    labelKey: 'preferences.max-connection-per-server',
    reasonKey: 'preferences.high-connection-reason',
  },
]

function buildSafeLimitContent(f: Record<string, unknown>, exceeded: typeof safeLimits) {
  return h(
    'div',
    { style: 'display: flex; flex-direction: column; gap: 12px' },
    exceeded.map((e) => {
      const current = f[e.field] as number
      return h('div', [
        h(
          'div',
          { style: 'font-weight: 500' },
          `• ${t(e.labelKey)}: ${current} (${t('preferences.recommended-limit', { value: e.safe })})`,
        ),
        h('div', { style: 'padding-left: 14px; opacity: 0.75' }, t(e.reasonKey)),
      ])
    }),
  )
}

function confirmSafeLimits(f: Record<string, unknown>, exceeded: typeof safeLimits): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const revert = () => {
      for (const e of exceeded) f[e.field] = e.safe
      resolve(false)
    }
    dialog.warning({
      title: t('preferences.safe-limit-warning-title'),
      content: () => buildSafeLimitContent(f, exceeded),
      positiveText: t('preferences.high-connection-continue'),
      negativeText: t('app.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: revert,
      onClose: revert,
    })
  })
}

function buildForm() {
  return buildDownloadsForm(preferenceStore.config, defaultDownloadDir.value)
}

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildDownloadsSystemConfig,
  transformForStore: transformDownloadsForStore,
  beforeSave: async (f) => {
    const exceeded = safeLimits.filter((e) => {
      const v = f[e.field as string]
      return typeof v === 'number' && v > e.safe
    })
    if (exceeded.length > 0) {
      const ok = await confirmSafeLimits(f, exceeded)
      if (!ok) return false
    }
    return true
  },
  afterSave: (f) => {
    recordDownloadsDirectory(f, preferenceStore.recordHistoryDirectory)
  },
})

// ── Speed limit ─────────────────────────────────────────────────────
const uploadSpeedValue = ref(0)
const uploadUnit = ref('K')
const downloadSpeedValue = ref(0)
const downloadUnit = ref('K')
const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

const timeOptions = (() => {
  const opts: Array<{ label: string; value: string }> = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0')
      const mm = String(m).padStart(2, '0')
      opts.push({ label: `${hh}:${mm}`, value: `${hh}:${mm}` })
    }
  }
  return opts
})()

const scheduleDayOptions = computed(() => [
  { label: t('preferences.schedule-days-everyday'), value: SCHEDULE_DAY.EVERY_DAY },
  { label: t('preferences.schedule-days-weekdays'), value: SCHEDULE_DAY.WEEKDAYS },
  { label: t('preferences.schedule-days-weekends'), value: SCHEDULE_DAY.WEEKENDS },
])

function parseSpeedLimit(value: unknown) {
  const str = String(value || '0')
  const num = parseInt(str, 10) || 0
  const unit = extractSpeedUnit(str) || 'K'
  return { num, unit }
}

function buildSpeedLimit(value: number, unit: string): string {
  return value > 0 ? `${value}${unit}` : '0'
}

function handleUploadUnitChange(val: string) {
  uploadUnit.value = val
  form.value.maxOverallUploadLimit = buildSpeedLimit(uploadSpeedValue.value, val)
}
function handleDownloadUnitChange(val: string) {
  downloadUnit.value = val
  form.value.maxOverallDownloadLimit = buildSpeedLimit(downloadSpeedValue.value, val)
}
function handleUploadValueChange(val: number | null) {
  const v = val || 0
  uploadSpeedValue.value = v
  form.value.maxOverallUploadLimit = buildSpeedLimit(v, uploadUnit.value)
}
function handleDownloadValueChange(val: number | null) {
  const v = val || 0
  downloadSpeedValue.value = v
  form.value.maxOverallDownloadLimit = buildSpeedLimit(v, downloadUnit.value)
}

// ── File categories ─────────────────────────────────────────────────
let categoryUid = 0
function ensureCategoryUid(cat: FileCategory): string {
  const record = cat as unknown as Record<string, unknown>
  if (!record._uid) {
    Object.defineProperty(cat, '_uid', { value: `cat-${++categoryUid}`, enumerable: false })
  }
  return record._uid as string
}
function handleCategoryLabelChange(index: number, label: string) {
  form.value.fileCategories[index].label = label
}
function handleCategoryDirInput(index: number, value: string) {
  form.value.fileCategories[index].directory = value
}
function handleCategoryExtChange(index: number, extensions: string[]) {
  form.value.fileCategories[index].extensions = extensions.map((e) => e.toLowerCase().replace(/^\./, ''))
}
function handleDeleteCategory(index: number) {
  form.value.fileCategories.splice(index, 1)
}
function handleAddCategory() {
  if (form.value.fileCategories.length >= MAX_FILE_CATEGORIES) return
  const baseDir = form.value.dir || defaultDownloadDir.value
  form.value.fileCategories.push({ label: '', extensions: [], directory: baseDir, builtIn: false })
}
function handleResetCategories() {
  const baseDir = form.value.dir || defaultDownloadDir.value
  form.value.fileCategories = buildDefaultCategories(baseDir)
}
async function handleSelectDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.dir = selected
}
function handleRecentDirSelect(dir: string) {
  form.value.dir = dir
}
async function handleSelectCategoryDir(index: number) {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.fileCategories[index].directory = selected
}

// ── Speed limit toggle ──────────────────────────────────────────────
async function handleSpeedLimitToggle() {
  if (!isEngineReady()) return
  try {
    const result = await toggleSpeedLimit(preferenceStore.config, {
      changeGlobalOption,
      updateAndSave: (partial) => preferenceStore.updateAndSave(partial),
    })
    if (result === 'enabled') message.success(t('app.speedometer-limit-applied'))
    else if (result === 'disabled') message.success(t('app.speedometer-limit-removed'))
    else message.info(t('app.speedometer-needs-config-settings'))
  } catch (e) {
    logger.error('Downloads.speedLimitToggle', e)
  }
}

async function handleScheduleToggle(enabled: boolean) {
  try {
    await preferenceStore.updateAndSave({ speedScheduleEnabled: enabled })
    message.success(t(enabled ? 'app.schedule-enabled' : 'app.schedule-disabled'))
  } catch (e) {
    logger.error('Downloads.scheduleToggle', e)
  }
}

function loadForm() {
  Object.assign(form.value, buildForm())
  const ul = parseSpeedLimit(form.value.maxOverallUploadLimit)
  uploadSpeedValue.value = ul.num
  uploadUnit.value = ul.unit
  const dl = parseSpeedLimit(form.value.maxOverallDownloadLimit)
  downloadSpeedValue.value = dl.num
  downloadUnit.value = dl.unit
}

const { restartEngine } = useEngineRestart()
function handleManualRestart() {
  const port = (preferenceStore.config.rpcListenPort as number) || ENGINE_RPC_PORT
  const secret = (preferenceStore.config.rpcSecret as string) || ''
  const d = dialog.warning({
    title: t('preferences.engine-restart-title'),
    content: t('preferences.engine-restart-manual-confirm'),
    positiveText: t('preferences.engine-restart-now'),
    negativeText: t('preferences.engine-restart-later'),
    maskClosable: false,
    onPositiveClick: async () => {
      d.loading = true
      d.negativeText = ''
      d.closable = false
      message.info(t('preferences.engine-restarting'))
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    },
  })
}

onMounted(async () => {
  try {
    defaultDownloadDir.value = await downloadDir()
  } catch (e) {
    logger.debug('Downloads.downloadDir', e)
  }
  loadForm()
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <!-- Concurrency & Segments -->
      <NDivider title-placement="left">{{ t('preferences.concurrency-and-segments') }}</NDivider>
      <NFormItem :label="t('preferences.max-concurrent-downloads')">
        <NInputNumber v-model:value="form.maxConcurrentDownloads" :min="1" :max="10" style="width: 120px" />
      </NFormItem>
      <NFormItem :label="t('preferences.split-count')">
        <NInputNumber
          v-model:value="form.split"
          :min="1"
          :max="ENGINE_MAX_CONNECTION_PER_SERVER"
          style="width: 120px"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.max-connection-per-server')">
        <NInputNumber
          v-model:value="form.maxConnectionPerServer"
          :min="1"
          :max="ENGINE_MAX_CONNECTION_PER_SERVER"
          style="width: 120px"
        />
      </NFormItem>
      <!-- Retry & File Options -->
      <NDivider title-placement="left">{{ t('preferences.retry-and-file-behavior') }}</NDivider>
      <NFormItem :label="t('preferences.max-tries')">
        <NInputNumber v-model:value="form.maxTries" :min="0" :max="60" style="width: 120px" />
        <NText depth="3" style="font-size: 12px; margin-left: 8px">
          {{ t('preferences.max-tries-hint') }}
        </NText>
      </NFormItem>
      <NFormItem :label="t('preferences.retry-wait')">
        <NInputNumber v-model:value="form.retryWait" :min="0" :max="600" style="width: 120px" />
        <NText depth="3" style="font-size: 12px; margin-left: 8px">{{ t('preferences.unit-seconds') }}</NText>
      </NFormItem>
      <NFormItem :label="t('preferences.continue')">
        <NSwitch v-model:value="form.continue" />
      </NFormItem>

      <!-- Download Path -->
      <NDivider title-placement="left">{{ t('preferences.download-path') }}</NDivider>
      <NFormItem :label="t('preferences.default-path')">
        <NInputGroup>
          <NInput v-model:value="form.dir" style="flex: 1" />
          <NButton style="padding: 0 12px" @click="handleSelectDir">
            <template #icon>
              <NIcon :size="16"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
          <DirectoryPopover @select="handleRecentDirSelect" />
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.file-timestamp')">
        <NSelect
          :value="fileTimestampValue"
          :options="fileTimestampOptions"
          style="width: 260px"
          @update:value="handleFileTimestampChange"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.file-category-save')">
        <NSwitch v-model:value="form.fileCategoryEnabled" />
      </NFormItem>
      <NCollapseTransition :show="form.fileCategoryEnabled">
        <NFormItem :show-label="false">
          <div class="file-category-list">
            <div v-auto-animate="{ duration: 250, easing: 'ease-out' }" class="file-category-cards">
              <div v-for="(cat, idx) in form.fileCategories" :key="ensureCategoryUid(cat)" class="file-category-card">
                <div class="file-category-header">
                  <span v-if="cat.builtIn" class="file-category-label">{{ t(`preferences.${cat.label}`) }}</span>
                  <NInput
                    v-else
                    :value="cat.label"
                    size="small"
                    :placeholder="t('preferences.file-category-custom-label')"
                    style="width: 120px"
                    @update:value="(v: string) => handleCategoryLabelChange(idx, v)"
                  />
                  <NButton
                    class="ghost-btn--danger"
                    size="tiny"
                    ghost
                    style="margin-left: auto"
                    @click="handleDeleteCategory(idx)"
                  >
                    {{ t('edit.delete') }}
                  </NButton>
                </div>
                <NDynamicTags
                  :value="cat.extensions.map((e: string) => `.${e}`)"
                  size="small"
                  @update:value="(tags: string[]) => handleCategoryExtChange(idx, tags)"
                />
                <NInputGroup>
                  <NInput
                    :value="cat.directory"
                    size="small"
                    style="flex: 1"
                    @update:value="(v: string) => handleCategoryDirInput(idx, v)"
                  />
                  <NButton size="small" style="padding: 0 8px" @click="handleSelectCategoryDir(idx)">
                    <template #icon>
                      <NIcon :size="14"><FolderOpenOutline /></NIcon>
                    </template>
                  </NButton>
                </NInputGroup>
              </div>
            </div>
            <div class="file-category-actions">
              <NButton size="small" dashed @click="handleAddCategory">
                {{ t('preferences.file-category-add') }}
              </NButton>
              <NButton size="small" quaternary @click="handleResetCategories">
                ↺ {{ t('preferences.file-category-reset') }}
              </NButton>
            </div>
            <NText depth="3" style="font-size: 12px; display: block; margin-top: 4px">
              ⓘ {{ t('preferences.file-category-auto-archive-hint') }}
            </NText>
          </div>
        </NFormItem>
      </NCollapseTransition>

      <!-- Speed Limit -->
      <NDivider title-placement="left">{{ t('preferences.speed-limit') }}</NDivider>
      <NFormItem :label="t('app.speedometer-enable-limit')">
        <NSwitch :value="preferenceStore.config.speedLimitEnabled" @update:value="handleSpeedLimitToggle" />
      </NFormItem>
      <NFormItem :label="t('preferences.speed-schedule-enabled')">
        <NSwitch :value="preferenceStore.config.speedScheduleEnabled" @update:value="handleScheduleToggle" />
      </NFormItem>
      <NCollapseTransition :show="preferenceStore.config.speedScheduleEnabled" class="collapse-indent">
        <Transition name="schedule-warn">
          <NFormItem v-if="!preferenceStore.config.speedLimitEnabled" :show-label="false">
            <NText depth="3" type="warning" style="font-size: 12px">
              {{ t('preferences.schedule-needs-limit') }}
            </NText>
          </NFormItem>
        </Transition>
        <NFormItem :label="t('preferences.schedule-from')">
          <NSelect v-model:value="form.speedScheduleFrom" :options="timeOptions" style="width: 120px" />
        </NFormItem>
        <NFormItem :label="t('preferences.schedule-to')">
          <NSelect v-model:value="form.speedScheduleTo" :options="timeOptions" style="width: 120px" />
        </NFormItem>
        <NFormItem :label="t('preferences.schedule-days')">
          <NSelect v-model:value="form.speedScheduleDays" :options="scheduleDayOptions" style="width: 160px" />
        </NFormItem>
        <NText depth="3" style="font-size: 12px; display: block; margin-top: -8px; margin-bottom: 8px">
          {{ t('preferences.schedule-hint') }}
        </NText>
      </NCollapseTransition>
      <div>
        <NFormItem :label="t('preferences.transfer-speed-upload')">
          <NInputGroup>
            <NInputNumber
              :value="uploadSpeedValue"
              :min="0"
              :max="65535"
              :step="1"
              style="width: 140px"
              @update:value="handleUploadValueChange"
            />
            <NSelect
              :value="uploadUnit"
              :options="speedUnitOptions"
              style="width: 100px"
              @update:value="handleUploadUnitChange"
            />
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.transfer-speed-download')">
          <NInputGroup>
            <NInputNumber
              :value="downloadSpeedValue"
              :min="0"
              :max="65535"
              :step="1"
              style="width: 140px"
              @update:value="handleDownloadValueChange"
            />
            <NSelect
              :value="downloadUnit"
              :options="speedUnitOptions"
              style="width: 100px"
              @update:value="handleDownloadUnitChange"
            />
          </NInputGroup>
        </NFormItem>
      </div>

      <!-- Notification & Confirm -->
      <NDivider title-placement="left">{{ t('preferences.notification-and-confirm') }}</NDivider>
      <NFormItem :label="t('preferences.new-task-show-downloading')">
        <NSwitch v-model:value="form.newTaskShowDownloading" />
      </NFormItem>
      <NFormItem :label="t('preferences.no-confirm-before-delete-task')">
        <NSwitch v-model:value="form.noConfirmBeforeDeleteTask" />
      </NFormItem>
      <NCollapseTransition :show="form.noConfirmBeforeDeleteTask" class="collapse-indent">
        <NFormItem :label="t('preferences.delete-files-when-skip-confirm')">
          <NSwitch v-model:value="form.deleteFilesWhenSkipConfirm" />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.task-completed-notify')">
        <NSwitch v-model:value="form.taskNotification" />
      </NFormItem>
      <NCollapseTransition :show="form.taskNotification" class="collapse-indent">
        <NFormItem :label="t('preferences.notify-on-start')">
          <NSwitch v-model:value="form.notifyOnStart" />
        </NFormItem>
        <NFormItem :label="t('preferences.notify-on-complete')">
          <NSwitch v-model:value="form.notifyOnComplete" />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.shutdown-when-complete')">
        <NSwitch v-model:value="form.shutdownWhenComplete" />
      </NFormItem>
      <NFormItem :label="t('preferences.keep-awake')">
        <NSwitch v-model:value="form.keepAwake" />
      </NFormItem>

      <!-- Auto Cleanup -->
      <NDivider title-placement="left">{{ t('preferences.auto-cleanup') }}</NDivider>
      <NFormItem :label="t('preferences.delete-torrent-after-complete')">
        <NSwitch v-model:value="form.deleteTorrentAfterComplete" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-delete-stale-records')">
        <NSwitch v-model:value="form.autoDeleteStaleRecords" />
      </NFormItem>
      <NFormItem :label="t('preferences.clear-completed-on-exit')">
        <NSwitch v-model:value="form.clearCompletedOnExit" />
      </NFormItem>
    </NForm>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.preference-form-wrapper {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.form-preference {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.form-preference :deep(.collapse-indent) {
  position: relative;
  margin-left: 16px;
}
.schedule-warn-enter-active,
.schedule-warn-leave-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1),
    max-height 0.25s cubic-bezier(0.2, 0, 0, 1);
  overflow: hidden;
}
.schedule-warn-enter-from,
.schedule-warn-leave-to {
  opacity: 0;
  transform: translateY(-8px);
  max-height: 0;
}
.schedule-warn-enter-to,
.schedule-warn-leave-from {
  max-height: 60px;
}

/* ── File Category List ──────────────────────────────────────────── */
.file-category-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
  width: 100%;
}
.file-category-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.file-category-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--n-color, var(--m3-surface-container-low));
  border: 1px solid var(--n-border-color, var(--m3-outline-variant));
  transition: border-color 0.2s ease;
}
.file-category-card:hover {
  border-color: var(--color-primary);
}
.file-category-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-category-label {
  font-size: 13px;
  font-weight: 500;
}
.file-category-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 4px;
}
.ghost-btn--danger {
  --btn-tint: var(--m3-error, #c97070);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--danger:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--danger :deep(.n-button__border),
.ghost-btn--danger :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
</style>
