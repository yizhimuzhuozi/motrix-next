<script setup lang="ts">
import { ref, computed, onMounted, watchSyncEffect, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { isEqual } from 'lodash-es'
import { usePreferenceStore } from '@/stores/preference'
import { relaunch } from '@tauri-apps/plugin-process'
import { platform } from '@tauri-apps/plugin-os'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir } from '@tauri-apps/api/path'
import { extractSpeedUnit } from '@shared/utils'
import {
  NForm, NFormItem, NInput, NInputNumber, NSelect, NCheckbox, NSwitch,
  NButton, NSpace, NDivider, NInputGroup, NText, NCollapseTransition, NTag, useDialog
} from 'naive-ui'
import { FolderOpenOutline, CloudDownloadOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()

const message = useAppMessage()
const dialog = useDialog()
const defaultDownloadDir = ref('')
const currentPlatform = ref('')
const isMac = computed(() => currentPlatform.value === 'macos')
const isMacOrWin = computed(() => currentPlatform.value === 'macos' || currentPlatform.value === 'windows')
const platformLabel = computed(() => {
  const map: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }
  return map[currentPlatform.value] || currentPlatform.value
})
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

const checkIntervalOptions = [
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
  { label: t('preferences.interval-monthly'), value: 720 },
  { label: t('preferences.interval-semi-annual'), value: 4320 },
  { label: t('preferences.interval-yearly'), value: 8760 },
]

function buildForm() {
  const config = (preferenceStore.config || {}) as Record<string, unknown>
  const followTorrent = config.followTorrent !== false
  const followMetalink = config.followMetalink !== false
  const pauseMetadata = !!config.pauseMetadata
  const btAutoDownloadContent = followTorrent && followMetalink && !pauseMetadata
  return {
    autoCheckUpdate: config.autoCheckUpdate !== false,
    autoCheckUpdateInterval: (config.autoCheckUpdateInterval as number) || 24,
    lastCheckUpdateTime: (config.lastCheckUpdateTime as number) || 0,
    dir: (config.dir as string) || defaultDownloadDir.value,
    locale: (config.locale as string) || 'en-US',
    theme: (config.theme as string) || 'dark',
    openAtLogin: !!config.openAtLogin,
    keepWindowState: !!config.keepWindowState,
    resumeAllWhenAppLaunched: !!config.resumeAllWhenAppLaunched,
    autoHideWindow: !!config.autoHideWindow,
    showProgressBar: !!config.showProgressBar,
    traySpeedometer: !!config.traySpeedometer,
    dockBadgeSpeed: config.dockBadgeSpeed !== false,
    taskNotification: config.taskNotification !== false,
    newTaskShowDownloading: config.newTaskShowDownloading !== false,
    noConfirmBeforeDeleteTask: !!config.noConfirmBeforeDeleteTask,
    maxConcurrentDownloads: (config.maxConcurrentDownloads as number) || 5,
    maxConnectionPerServer: (config.maxConnectionPerServer as number) || 16,
    maxOverallDownloadLimit: String(config.maxOverallDownloadLimit || '0'),
    maxOverallUploadLimit: String(config.maxOverallUploadLimit || '0'),
    btSaveMetadata: !!config.btSaveMetadata,
    btAutoDownloadContent,
    btForceEncryption: !!config.btForceEncryption,
    keepSeeding: config.keepSeeding !== false,
    seedRatio: (config.seedRatio as number) || 1,
    seedTime: (config.seedTime as number) || 60,
    continue: config.continue !== false,
  }
}

const form = ref(buildForm())
const savedSnapshot = ref(JSON.parse(JSON.stringify(buildForm())))

const isDirty = computed(() => !isEqual(
  JSON.parse(JSON.stringify(form.value)),
  savedSnapshot.value
))

watchSyncEffect(() => { preferenceStore.pendingChanges = isDirty.value })
onUnmounted(() => { preferenceStore.pendingChanges = false })

const uploadSpeedValue = ref(0)
const uploadUnit = ref('K')
const downloadSpeedValue = ref(0)
const downloadUnit = ref('K')

const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

const localeOptions = [
  { label: 'English', value: 'en-US' },
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
  { label: 'Français', value: 'fr' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Español', value: 'es' },
  { label: 'Português (Brasil)', value: 'pt-BR' },
  { label: 'Русский', value: 'ru' },
  { label: 'Türkçe', value: 'tr' },
  { label: 'العربية', value: 'ar' },
  { label: 'Български', value: 'bg' },
  { label: 'Català', value: 'ca' },
  { label: 'Ελληνικά', value: 'el' },
  { label: 'فارسی', value: 'fa' },
  { label: 'Magyar', value: 'hu' },
  { label: 'Bahasa Indonesia', value: 'id' },
  { label: 'Italiano', value: 'it' },
  { label: 'Norsk Bokmål', value: 'nb' },
  { label: 'Nederlands', value: 'nl' },
  { label: 'Polski', value: 'pl' },
  { label: 'Română', value: 'ro' },
  { label: 'ไทย', value: 'th' },
  { label: 'Українська', value: 'uk' },
  { label: 'Tiếng Việt', value: 'vi' },
]

const themeOptions = computed(() => [
  { label: t('preferences.theme-auto'), value: 'auto' },
  { label: t('preferences.theme-light'), value: 'light' },
  { label: t('preferences.theme-dark'), value: 'dark' },
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

function onKeepSeedingChange(enable: boolean) {
  if (enable) {
    form.value.seedRatio = 0
    form.value.seedTime = 525600
  } else {
    form.value.seedRatio = 1
    form.value.seedTime = 60
  }
}

async function handleSelectDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (selected) form.value.dir = selected as string
}

function loadForm() {
  form.value = buildForm()
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))

  const ul = parseSpeedLimit(form.value.maxOverallUploadLimit)
  uploadSpeedValue.value = ul.num
  uploadUnit.value = ul.unit

  const dl = parseSpeedLimit(form.value.maxOverallDownloadLimit)
  downloadSpeedValue.value = dl.num
  downloadUnit.value = dl.unit
}

function handleSave() {
  const prevLocale = preferenceStore.locale || 'en-US'
  const newLocale = form.value.locale
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))

  const data: Record<string, unknown> = { ...form.value }

  if (form.value.btAutoDownloadContent) {
    data.followTorrent = true
    data.followMetalink = true
    data.pauseMetadata = false
  } else {
    data.followTorrent = false
    data.followMetalink = false
    data.pauseMetadata = true
  }
  delete data.btAutoDownloadContent

  preferenceStore.updateAndSave(data)
  invoke('save_system_config', {
    config: {
      dir: form.value.dir,
      'max-concurrent-downloads': String(form.value.maxConcurrentDownloads),
      'max-connection-per-server': String(form.value.maxConnectionPerServer),
      'max-overall-download-limit': form.value.maxOverallDownloadLimit,
      'max-overall-upload-limit': form.value.maxOverallUploadLimit,
      'bt-save-metadata': String(!!form.value.btSaveMetadata),
      'bt-force-encryption': String(!!form.value.btForceEncryption),
      'seed-ratio': String(form.value.seedRatio),
      'seed-time': String(form.value.seedTime),
    },
  }).catch(console.error)
  message.success(t('preferences.save-success-message'))

  if (newLocale !== prevLocale) {
    dialog.info({
      title: 'Language Changed',
      content: 'Restart the application to apply the new language.',
      positiveText: 'Restart Now',
      negativeText: 'Later',
      onPositiveClick: () => { relaunch() },
    })
  }
}

function handleReset() {
  loadForm()
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))
}

function handleCheckUpdate() {
  updateDialogRef.value?.open()
}

onMounted(async () => {
  try { defaultDownloadDir.value = await downloadDir() } catch {}
  try { currentPlatform.value = platform() } catch {}
  loadForm()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="240px" size="small" class="form-preference">
      <NDivider title-placement="left">{{ t('preferences.auto-update') }}</NDivider>
      <NFormItem :label="t('preferences.auto-check-update')">
        <NSwitch v-model:value="form.autoCheckUpdate" />
      </NFormItem>
      <NCollapseTransition :show="form.autoCheckUpdate">
        <NFormItem :label="t('preferences.check-frequency')">
          <NSelect
            v-model:value="form.autoCheckUpdateInterval"
            :options="checkIntervalOptions"
            style="width: 180px;"
          />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.last-check-update-time')">
        <div style="display: flex; align-items: center; gap: 16px;">
          <NButton size="small" @click="handleCheckUpdate">
            <template #icon><NIcon :size="14"><CloudDownloadOutline /></NIcon></template>
            {{ t('app.check-updates-now') }}
          </NButton>
          <NText v-if="form.lastCheckUpdateTime" depth="3" style="font-size: 13px;">
            {{ new Date(form.lastCheckUpdateTime).toLocaleString() }}
          </NText>
          <NText v-else depth="3" style="font-size: 13px;">—</NText>
        </div>
      </NFormItem>
      <UpdateDialog ref="updateDialogRef" />

      <NDivider title-placement="left">{{ t('preferences.ui') }}</NDivider>
      <NFormItem :label="t('preferences.detected-platform')">
        <NTag type="info" round>{{ platformLabel }}</NTag>
      </NFormItem>
      <NFormItem :label="t('preferences.appearance')">
        <NSelect v-model:value="form.theme" :options="themeOptions" style="width: 200px;" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-hide-window')">
        <NSwitch v-model:value="form.autoHideWindow" />
      </NFormItem>
      <NFormItem v-if="isMacOrWin" :label="t('preferences.show-progress-bar')">
        <NSwitch v-model:value="form.showProgressBar" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.tray-speedometer')">
        <NSwitch v-model:value="form.traySpeedometer" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.dock-badge-speed')">
        <NSwitch v-model:value="form.dockBadgeSpeed" />
      </NFormItem>

      <NDivider title-placement="left">Language</NDivider>
      <NFormItem label="Select Language">
        <NSelect v-model:value="form.locale" :options="localeOptions" style="width: 200px;" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.startup') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.openAtLogin">{{ t('preferences.open-at-login') }}</NCheckbox>
          <NCheckbox v-model:checked="form.keepWindowState">{{ t('preferences.keep-window-state') }}</NCheckbox>
          <NCheckbox v-model:checked="form.resumeAllWhenAppLaunched">{{ t('preferences.auto-resume-all') }}</NCheckbox>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.default-dir') }}</NDivider>
      <NFormItem :label="t('preferences.default-dir')">
        <NInputGroup>
          <NInput v-model:value="form.dir" style="flex: 1;" />
          <NButton @click="handleSelectDir" style="padding: 0 12px;">
            <template #icon>
              <NIcon :size="16"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.transfer-settings') }}</NDivider>
      <NFormItem :label="t('preferences.transfer-speed-upload')">
        <NInputGroup>
          <NInputNumber
            :value="uploadSpeedValue"
            @update:value="handleUploadValueChange"
            :min="0" :max="65535" :step="1"
            style="width: 140px;"
          />
          <NSelect
            :value="uploadUnit"
            @update:value="handleUploadUnitChange"
            :options="speedUnitOptions"
            style="width: 100px;"
          />
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.transfer-speed-download')">
        <NInputGroup>
          <NInputNumber
            :value="downloadSpeedValue"
            @update:value="handleDownloadValueChange"
            :min="0" :max="65535" :step="1"
            style="width: 140px;"
          />
          <NSelect
            :value="downloadUnit"
            @update:value="handleDownloadUnitChange"
            :options="speedUnitOptions"
            style="width: 100px;"
          />
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.bt-settings') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.btSaveMetadata">{{ t('preferences.bt-save-metadata') }}</NCheckbox>
          <NCheckbox v-model:checked="form.btAutoDownloadContent">{{ t('preferences.bt-auto-download-content') }}</NCheckbox>
          <NCheckbox v-model:checked="form.btForceEncryption">{{ t('preferences.bt-force-encryption') }}</NCheckbox>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('preferences.keep-seeding')">
        <NSwitch v-model:value="form.keepSeeding" @update:value="onKeepSeedingChange" />
      </NFormItem>
      <template v-if="!form.keepSeeding">
        <NFormItem :label="t('preferences.seed-ratio')">
          <NInputNumber v-model:value="form.seedRatio" :min="1" :max="100" :step="0.1" style="width: 120px;" />
        </NFormItem>
        <NFormItem :label="t('preferences.seed-time') + ' (' + t('preferences.seed-time-unit') + ')'">
          <NInputNumber v-model:value="form.seedTime" :min="60" :max="525600" style="width: 120px;" />
        </NFormItem>
      </template>

      <NDivider title-placement="left">{{ t('preferences.task-manage') }}</NDivider>
      <NFormItem :label="t('preferences.max-concurrent-downloads')">
        <NInputNumber v-model:value="form.maxConcurrentDownloads" :min="1" :max="10" style="width: 120px;" />
      </NFormItem>
      <NFormItem :label="t('preferences.max-connection-per-server')">
        <NInputNumber v-model:value="form.maxConnectionPerServer" :min="1" :max="64" style="width: 120px;" />
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.continue">{{ t('preferences.continue') }}</NCheckbox>
          <NCheckbox v-model:checked="form.newTaskShowDownloading">{{ t('preferences.new-task-show-downloading') }}</NCheckbox>
          <NCheckbox v-model:checked="form.taskNotification">{{ t('preferences.task-completed-notify') }}</NCheckbox>
          <NCheckbox v-model:checked="form.noConfirmBeforeDeleteTask">{{ t('preferences.no-confirm-before-delete-task') }}</NCheckbox>
        </NSpace>
      </NFormItem>
    </NForm>
    <div class="form-actions">
      <NSpace>
        <NButton :class="{ 'save-btn-dirty': isDirty }" type="primary" @click="handleSave">{{ t('preferences.save') }}</NButton>
        <NButton :class="{ 'discard-btn-dirty': isDirty }" @click="handleReset">{{ t('preferences.discard') }}</NButton>
      </NSpace>
    </div>
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
  padding: 16px 24px 64px 24px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.form-preference :deep(.n-form-item .n-form-item-blank > .n-space) {
  padding-left: 50px;
}
.form-actions {
  position: sticky;
  bottom: 0;
  z-index: 10;
  padding: 16px 24px 16px 40px;
}
.save-btn-dirty {
  background-color: #18a058 !important;
  transition: background-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.save-btn-dirty :deep(.n-button__border) {
  border-color: rgba(255, 255, 255, 0.15) !important;
}
.save-btn-dirty :deep(.n-button__state-border) {
  border-color: rgba(255, 255, 255, 0.15) !important;
}
.discard-btn-dirty {
  background-color: rgba(208, 48, 80, 0.85) !important;
  color: #fff !important;
  transition: background-color 0.35s cubic-bezier(0.2, 0, 0, 1), color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.discard-btn-dirty :deep(.n-button__border) {
  border-color: rgba(255, 255, 255, 0.15) !important;
}
.discard-btn-dirty :deep(.n-button__state-border) {
  border-color: rgba(255, 255, 255, 0.15) !important;
}
</style>
