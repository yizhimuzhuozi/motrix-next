<script setup lang="ts">
/** @fileoverview BitTorrent preference tab: BT settings + tracker management. */
import { ref, computed, onMounted, h } from 'vue'
import type { VNodeChild } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { convertTrackerDataToLine } from '@shared/utils/tracker'
import { SYNC_MIN_DURATION } from '@shared/timing'
import { DEFAULT_TRACKER_SOURCE, ENGINE_RPC_PORT } from '@shared/constants'
import { logger } from '@shared/logger'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  buildBtForm,
  buildBtSystemConfig,
  transformBtForStore,
  isValidTrackerSourceUrl,
} from '@/composables/useBtPreference'
import { trackerSourceOptions } from '@shared/constants/trackerSources'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NDivider,
  NIcon,
  NCollapseTransition,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import { SyncOutline, AddCircleOutline, CloseCircleOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()

const syncingTracker = ref(false)
const customTrackerInput = ref('')

// ── Tracker source management ───────────────────────────────────────
const presetTrackerValues = new Set(
  trackerSourceOptions.flatMap((group) => ('children' in group ? group.children.map((c) => c.value) : [])),
)

const presetSources = computed({
  get: () => form.value.trackerSource.filter((v: string) => presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const custom = form.value.trackerSource.filter((v: string) => !presetTrackerValues.has(v))
    form.value.trackerSource = [...vals, ...custom]
  },
})

const customSelectOptions = computed(() =>
  form.value.customTrackerUrls.map((url: string) => ({ label: url, value: url })),
)

const customSources = computed({
  get: () => form.value.trackerSource.filter((v: string) => !presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const preset = form.value.trackerSource.filter((v: string) => presetTrackerValues.has(v))
    form.value.trackerSource = [...preset, ...vals]
  },
})

function onDeleteCustomTracker(url: string, e: Event) {
  e.stopPropagation()
  form.value.customTrackerUrls = form.value.customTrackerUrls.filter((v: string) => v !== url)
  customSources.value = customSources.value.filter((v: string) => v !== url)
}

function renderCustomOption(info: {
  node: VNodeChild
  option: { value?: string | number }
  selected: boolean
}): VNodeChild {
  const url = String(info.option.value ?? '')
  return h('div', { style: 'display:flex;align-items:center;position:relative;padding-right:32px' }, [
    h('div', { style: 'flex:1;min-width:0' }, [info.node]),
    h(
      'span',
      {
        style:
          'position:absolute;right:8px;display:flex;align-items:center;cursor:pointer;color:var(--error-color, #e88080)',
        onClick: (e: Event) => onDeleteCustomTracker(url, e),
      },
      [h(NIcon, { size: 18 }, { default: () => h(CloseCircleOutline) })],
    ),
  ])
}

const customPlaceholder = computed(() =>
  form.value.customTrackerUrls.length
    ? t('preferences.bt-tracker-source-custom-select')
    : t('preferences.bt-tracker-source-custom-empty'),
)

function buildForm() {
  const c = preferenceStore.config
  const formData = buildBtForm(c)
  if (!c.trackerSource) {
    formData.trackerSource = [...DEFAULT_TRACKER_SOURCE]
  }
  return formData
}

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildBtSystemConfig,
  transformForStore: transformBtForStore,
})

// ── Tracker sync ────────────────────────────────────────────────────
async function handleSyncTracker() {
  if (form.value.trackerSource.length === 0) {
    message.warning(t('preferences.bt-tracker-select-source'))
    return
  }
  syncingTracker.value = true
  try {
    const [result] = await Promise.all([
      preferenceStore.fetchBtTracker(form.value.trackerSource),
      new Promise((r) => setTimeout(r, SYNC_MIN_DURATION)),
    ])
    const text = convertTrackerDataToLine(result.data)
    if (result.failures.length === 0 && text) {
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      message.success(t('preferences.bt-tracker-sync-succeed'))
    } else if (result.data.length > 0 && text) {
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      showSyncFailureDialog(result.failures, result.data.length, form.value.trackerSource.length)
    } else {
      showSyncFailureDialog(result.failures, 0, form.value.trackerSource.length)
    }
  } catch (e) {
    logger.debug('BT.syncTracker', e)
    message.error(t('preferences.bt-tracker-sync-failed'))
  } finally {
    syncingTracker.value = false
  }
}

function showSyncFailureDialog(
  failures: Array<{ url: string; reason: string }>,
  successCount: number,
  totalCount: number,
) {
  const isPartial = successCount > 0
  const dialogType = isPartial ? 'warning' : 'error'
  const title = isPartial ? t('preferences.bt-tracker-sync-partial-title') : t('preferences.bt-tracker-sync-failed')
  dialog[dialogType]({
    title,
    content: () =>
      h('div', { style: 'max-height:300px;overflow-y:auto' }, [
        isPartial
          ? h(
              'p',
              { style: 'margin:0 0 8px;color:var(--text-color-secondary, #999)' },
              `${successCount}/${totalCount} ${t('preferences.bt-tracker-sync-sources-ok')}`,
            )
          : null,
        h('p', { style: 'margin:0 0 8px;font-weight:500' }, t('preferences.bt-tracker-sync-failed-sources')),
        ...failures.map((f) =>
          h(
            'div',
            {
              style:
                'margin:6px 0;padding:6px 8px;border-radius:4px;background:var(--error-color-hover, rgba(232,128,128,0.08))',
            },
            [
              h('div', { style: 'font-size:12px;word-break:break-all;font-weight:500' }, f.url),
              h('div', { style: 'font-size:11px;color:var(--error-color, #e88080);margin-top:2px' }, f.reason),
            ],
          ),
        ),
      ]),
    positiveText: 'OK',
  })
}

function onAddCustomTracker() {
  const url = customTrackerInput.value.trim()
  if (!url) return
  if (!isValidTrackerSourceUrl(url)) {
    message.warning(t('preferences.bt-tracker-source-invalid-url'))
    return
  }
  if (!form.value.customTrackerUrls.includes(url)) {
    form.value.customTrackerUrls = [...form.value.customTrackerUrls, url]
  }
  if (!form.value.trackerSource.includes(url)) {
    form.value.trackerSource = [...form.value.trackerSource, url]
  }
  customTrackerInput.value = ''
}

function onKeepSeedingChange(val: boolean) {
  if (val) {
    form.value.seedRatio = 0
    form.value.seedTime = 0
  } else {
    form.value.seedRatio = 1
    form.value.seedTime = 60
  }
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

onMounted(() => {
  Object.assign(form.value, buildForm())
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <!-- BT Settings -->
      <NDivider title-placement="left">{{ t('preferences.bt-settings') }}</NDivider>
      <NFormItem :label="t('preferences.bt-auto-download-content')">
        <NSwitch v-model:value="form.btAutoDownloadContent" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-force-encryption')">
        <NSwitch v-model:value="form.btForceEncryption" />
      </NFormItem>
      <NFormItem :label="t('preferences.keep-seeding')">
        <NSwitch v-model:value="form.keepSeeding" @update:value="onKeepSeedingChange" />
      </NFormItem>
      <NCollapseTransition :show="!form.keepSeeding" class="collapse-indent">
        <NFormItem :label="t('preferences.seed-ratio')">
          <NInputNumber v-model:value="form.seedRatio" :min="1" :max="100" :step="0.1" style="width: 120px" />
        </NFormItem>
        <NFormItem :label="t('preferences.seed-time') + ' (' + t('preferences.seed-time-unit') + ')'">
          <NInputNumber v-model:value="form.seedTime" :min="60" :max="525600" style="width: 120px" />
        </NFormItem>
      </NCollapseTransition>

      <!-- Tracker Management -->
      <NDivider title-placement="left">{{ t('preferences.bt-tracker') }}</NDivider>
      <NFormItem :label="t('preferences.bt-tracker-source-preset')">
        <NSelect
          v-model:value="presetSources"
          :options="trackerSourceOptions"
          multiple
          :placeholder="t('preferences.bt-tracker-source-placeholder')"
          clearable
          max-tag-count="responsive"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-source-custom')">
        <NInputGroup>
          <NInput
            v-model:value="customTrackerInput"
            :placeholder="t('preferences.bt-tracker-source-custom-placeholder')"
            clearable
            @keydown.enter="onAddCustomTracker"
          />
          <NButton size="small" style="flex-shrink: 0" @click="onAddCustomTracker">
            <template #icon>
              <NIcon><AddCircleOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem label=" ">
        <NSelect
          v-model:value="customSources"
          :options="customSelectOptions"
          :render-option="renderCustomOption"
          multiple
          clearable
          :placeholder="customPlaceholder"
          max-tag-count="responsive"
        />
      </NFormItem>
      <NFormItem label=" ">
        <NButton :loading="syncingTracker" type="primary" secondary style="min-width: 140px" @click="handleSyncTracker">
          <template #icon>
            <NIcon><SyncOutline /></NIcon>
          </template>
          {{ t('preferences.bt-tracker-sync') }}
        </NButton>
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-content')">
        <NInput
          v-model:value="form.btTracker"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('preferences.bt-tracker-input-tips')"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="info-text">
          {{ t('preferences.bt-tracker-tips') }}
          <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer" class="info-link"
            >ngosang/trackerslist ↗</a
          >
          <a
            target="_blank"
            href="https://github.com/XIU2/TrackersListCollection"
            rel="noopener noreferrer"
            class="info-link"
            style="margin-left: 8px"
            >XIU2/TrackersListCollection ↗</a
          >
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.auto-sync-tracker')">
        <NSwitch v-model:value="form.autoSyncTracker" />
      </NFormItem>
      <NFormItem v-if="form.lastSyncTrackerTime" :show-label="false">
        <div class="info-text">{{ new Date(form.lastSyncTrackerTime as number).toLocaleString() }}</div>
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
.info-text {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  max-width: 520px;
  word-wrap: break-word;
}
.info-link {
  color: var(--color-primary);
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
</style>
