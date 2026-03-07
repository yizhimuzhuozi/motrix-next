<script setup lang="ts">
import { ref, computed, h, onMounted, watchSyncEffect, onUnmounted } from 'vue'
import { isEqual } from 'lodash-es'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import { relaunch } from '@tauri-apps/plugin-process'
import { appDataDir, resolveResource } from '@tauri-apps/api/path'
import {
  NGOSANG_TRACKERS_BEST_URL_CDN,
  NGOSANG_TRACKERS_BEST_IP_URL_CDN,
  ENGINE_RPC_PORT,
  LOG_LEVELS,
  PROXY_SCOPE_OPTIONS,
} from '@shared/constants'
import {
  convertCommaToLine,
  convertLineToComma,
  generateRandomInt,
} from '@shared/utils'
import { fetchBtTrackerFromSource, convertTrackerDataToLine } from '@shared/utils/tracker'
import userAgentMap from '@shared/ua'
import {
  NForm, NFormItem, NInput, NInputNumber, NInputGroup, NSwitch, NSelect, NTag,
  NButton, NButtonGroup, NSpace, NDivider, NIcon, NCheckbox,
  useDialog,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  SyncOutline, DiceOutline, FolderOpenOutline, LinkOutline,
} from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const message = useAppMessage()
const dialog = useDialog()

const DEFAULT_TRACKER_SOURCE = [
  NGOSANG_TRACKERS_BEST_URL_CDN,
  NGOSANG_TRACKERS_BEST_IP_URL_CDN,
]

const trackerSourceOptions = [
  {
    type: 'group' as const,
    label: 'ngosang/trackerslist',
    key: 'ngosang',
    children: [
      { label: 'trackers_best.txt', value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt' },
      { label: 'trackers_best_ip.txt', value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt' },
      { label: 'trackers_all.txt', value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt' },
      { label: 'trackers_all_ip.txt', value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt' },
      { label: () => h('span', {}, [h('span', {}, 'trackers_best.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt' },
      { label: () => h('span', {}, [h('span', {}, 'trackers_best_ip.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best_ip.txt' },
      { label: () => h('span', {}, [h('span', {}, 'trackers_all.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all.txt' },
      { label: () => h('span', {}, [h('span', {}, 'trackers_all_ip.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all_ip.txt' },
    ],
  },
  {
    type: 'group' as const,
    label: 'XIU2/TrackersListCollection',
    key: 'xiu2',
    children: [
      { label: 'best.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt' },
      { label: 'all.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt' },
      { label: 'http.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/http.txt' },
      { label: () => h('span', {}, [h('span', {}, 'best.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/best.txt' },
      { label: () => h('span', {}, [h('span', {}, 'all.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/all.txt' },
      { label: () => h('span', {}, [h('span', {}, 'http.txt '), h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' })]), value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/http.txt' },
    ],
  },
]

const proxyScopeOptions = PROXY_SCOPE_OPTIONS.map((s: string) => ({
  label: t(`preferences.proxy-scope-${s}`),
  value: s,
}))

const logLevelOptions = LOG_LEVELS.map((l: string) => ({ label: l, value: l }))

const syncingTracker = ref(false)

const aria2ConfPath = ref('')
const sessionPath = ref('')
const logPath = ref('')

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

const form = ref(buildForm())
const savedSnapshot = ref(JSON.parse(JSON.stringify(buildForm())))

const isDirty = computed(() => !isEqual(
  JSON.parse(JSON.stringify(form.value)),
  savedSnapshot.value
))

watchSyncEffect(() => { preferenceStore.pendingChanges = isDirty.value })
onUnmounted(() => { preferenceStore.pendingChanges = false })

function buildForm() {
  const c = (preferenceStore.config || {}) as Record<string, unknown>
  const proxy = (c.proxy as Record<string, unknown>) || {}
  const protocols = (c.protocols as Record<string, boolean>) || {}
  const savedSecret = (c.rpcSecret as string) || ''
  const rpcSecret = savedSecret || generateSecret()
  if (!savedSecret) {
    preferenceStore.updateAndSave({ rpcSecret })
  }
  return {
    proxy: {
      enable: !!proxy.enable,
      server: (proxy.server as string) || '',
      bypass: (proxy.bypass as string) || '',
      scope: (proxy.scope as string[]) || [...PROXY_SCOPE_OPTIONS],
    },
    trackerSource: (c.trackerSource as string[]) || [...DEFAULT_TRACKER_SOURCE],
    btTracker: convertCommaToLine((c.btTracker as string) || ''),
    autoSyncTracker: !!c.autoSyncTracker,
    lastSyncTrackerTime: (c.lastSyncTrackerTime as number) || 0,
    rpcListenPort: (c.rpcListenPort as number) || ENGINE_RPC_PORT,
    rpcSecret,
    enableUpnp: c.enableUpnp !== false,
    listenPort: (c.listenPort as number) || 21301,
    dhtListenPort: (c.dhtListenPort as number) || 26701,
    protocols: {
      magnet: protocols.magnet !== false,
      thunder: !!protocols.thunder,
    },
    userAgent: (c.userAgent as string) || '',
    logLevel: (c.logLevel as string) || 'warn',
  }
}

function loadForm() {
  form.value = buildForm()
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))
}

async function loadPaths() {
  try {
    aria2ConfPath.value = await resolveResource('engine/aria2.conf')
  } catch { aria2ConfPath.value = '' }
  try {
    const dataDir = await appDataDir()
    sessionPath.value = `${dataDir}download.session`
    logPath.value = `${dataDir}motrix-next.log`
  } catch {}
}

async function handleSyncTracker() {
  if (form.value.trackerSource.length === 0) {
    message.warning(t('preferences.bt-tracker-select-source'))
    return
  }
  syncingTracker.value = true
  try {
    const results = await fetchBtTrackerFromSource(form.value.trackerSource)
    const text = convertTrackerDataToLine(results)
    if (text) {
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      message.success(t('preferences.bt-tracker-sync-succeed'))
    } else {
      message.error(t('preferences.bt-tracker-sync-failed'))
    }
  } catch {
    message.error(t('preferences.bt-tracker-sync-failed'))
  } finally {
    syncingTracker.value = false
  }
}

function onRpcPortDice() {
  form.value.rpcListenPort = generateRandomInt(ENGINE_RPC_PORT, 20000)
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

function onBtPortDice() {
  form.value.listenPort = generateRandomInt(20000, 24999)
}

function onDhtPortDice() {
  form.value.dhtListenPort = generateRandomInt(25000, 29999)
}

function changeUA(type: string) {
  const ua = userAgentMap[type]
  if (ua) form.value.userAgent = ua
}

function handleSessionReset() {
  dialog.warning({
    title: t('preferences.session-reset'),
    content: t('preferences.session-reset-confirm'),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      try {
        await taskStore.purgeTaskRecord()
        await taskStore.pauseAllTask()
        message.success(t('preferences.session-reset'))
      } catch {}
    },
  })
}

function handleFactoryReset() {
  dialog.error({
    title: t('preferences.factory-reset'),
    content: t('preferences.factory-reset-confirm'),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      try {
        await invoke('factory_reset')
        relaunch()
      } catch {}
    },
  })
}

function handleSave() {
  if (!form.value.rpcSecret) {
    message.error(t('preferences.rpc-secret-empty-warning'))
    return
  }
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))
  const data: Record<string, unknown> = {
    ...form.value,
    btTracker: convertLineToComma(form.value.btTracker),
  }
  preferenceStore.updateAndSave(data)
  invoke('save_system_config', {
    config: {
      'rpc-listen-port': String(form.value.rpcListenPort),
      'rpc-secret': form.value.rpcSecret,
      'enable-dht': 'true',
      'enable-peer-exchange': 'true',
      'enable-upnp': String(form.value.enableUpnp),
      'listen-port': String(form.value.listenPort),
      'dht-listen-port': String(form.value.dhtListenPort),
      'user-agent': form.value.userAgent || '',
      'log-level': form.value.logLevel || 'warn',
      'bt-tracker': convertLineToComma(form.value.btTracker),
    },
  }).catch(console.error)
  message.success(t('preferences.save-success-message'))
}

function handleReset() {
  loadForm()
  savedSnapshot.value = JSON.parse(JSON.stringify(form.value))
}

onMounted(() => {
  loadForm()
  loadPaths()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="240px" size="small" class="form-preference">

      <NDivider title-placement="left">{{ t('preferences.proxy') }}</NDivider>
      <NFormItem :label="t('preferences.enable-proxy')">
        <NSwitch v-model:value="form.proxy.enable" />
      </NFormItem>
      <template v-if="form.proxy.enable">
        <NFormItem :label="t('preferences.proxy-server')">
          <NInput placeholder="[http://][USER:PASSWORD@]HOST[:PORT]" v-model:value="form.proxy.server" />
        </NFormItem>
        <NFormItem label="Bypass">
          <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 3 }" :placeholder="t('preferences.proxy-bypass-input-tips')" v-model:value="form.proxy.bypass" />
        </NFormItem>
        <NFormItem label="Scope">
          <NSelect v-model:value="form.proxy.scope" :options="proxyScopeOptions" multiple style="width: 100%;" />
        </NFormItem>
        <NFormItem :show-label="false">
          <a target="_blank" href="https://github.com/AnInsomniacy/motrix-next/wiki/Proxy" rel="noopener noreferrer" class="info-link">
            {{ t('preferences.proxy-tips') }} ↗
          </a>
        </NFormItem>
      </template>

      <NDivider title-placement="left">{{ t('preferences.bt-tracker') }}</NDivider>
      <NFormItem :label="t('preferences.bt-tracker-source')">
        <NInputGroup>
          <NSelect
            v-model:value="form.trackerSource"
            :options="trackerSourceOptions"
            multiple
            :placeholder="t('preferences.bt-tracker-tips')"
            style="flex: 1;"
            clearable
            max-tag-count="responsive"
          />
          <NButton :loading="syncingTracker" @click="handleSyncTracker" size="small" style="flex-shrink: 0;">
            <template #icon><NIcon><SyncOutline /></NIcon></template>
            {{ t('preferences.bt-tracker-sync') }}
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-content')">
        <NInput type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :placeholder="t('preferences.bt-tracker-input-tips')" v-model:value="form.btTracker" />
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="info-text">
          {{ t('preferences.bt-tracker-tips') }}
          <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer" class="info-link">ngosang/trackerslist ↗</a>
          <a target="_blank" href="https://github.com/XIU2/TrackersListCollection" rel="noopener noreferrer" class="info-link" style="margin-left: 8px;">XIU2/TrackersListCollection ↗</a>
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.auto-sync-tracker')">
        <NSwitch v-model:value="form.autoSyncTracker" />
      </NFormItem>
      <NFormItem v-if="form.lastSyncTrackerTime" :show-label="false">
        <div class="info-text">{{ new Date(form.lastSyncTrackerTime).toLocaleString() }}</div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.rpc') }}</NDivider>
      <NFormItem :label="t('preferences.rpc-listen-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.rpcListenPort" :min="1024" :max="65535" style="width: 160px;" />
          <NButton @click="onRpcPortDice" style="padding: 0 10px;">
            <template #icon><NIcon :size="14"><DiceOutline /></NIcon></template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.rpc-secret')" :validation-status="form.rpcSecret ? undefined : 'error'">
        <NInputGroup>
          <NInput type="password" show-password-on="click" v-model:value="form.rpcSecret" placeholder="RPC Secret" style="flex: 1;" :status="form.rpcSecret ? undefined : 'error'" />
          <NButton @click="onRpcSecretDice" style="padding: 0 10px;">
            <template #icon><NIcon :size="14"><DiceOutline /></NIcon></template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.port') }}</NDivider>
      <NFormItem label="UPnP/NAT-PMP">
        <NSwitch v-model:value="form.enableUpnp" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.listenPort" :min="1024" :max="65535" style="width: 160px;" />
          <NButton @click="onBtPortDice" style="padding: 0 10px;">
            <template #icon><NIcon :size="14"><DiceOutline /></NIcon></template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.dht-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.dhtListenPort" :min="1024" :max="65535" style="width: 160px;" />
          <NButton @click="onDhtPortDice" style="padding: 0 10px;">
            <template #icon><NIcon :size="14"><DiceOutline /></NIcon></template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.download-protocol') }}</NDivider>
      <NFormItem :show-label="false">
        <div class="info-text">{{ t('preferences.protocols-default-client') }}</div>
      </NFormItem>
      <NFormItem :label="t('preferences.protocols-magnet')">
        <NSwitch v-model:value="form.protocols.magnet" />
      </NFormItem>
      <NFormItem :label="t('preferences.protocols-thunder')">
        <NSwitch v-model:value="form.protocols.thunder" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.user-agent') }}</NDivider>
      <NFormItem :label="t('preferences.mock-user-agent')">
        <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="User-Agent" v-model:value="form.userAgent" />
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace align="center" :size="8">
          <NButtonGroup size="small">
            <NButton @click="changeUA('aria2')">Aria2</NButton>
            <NButton @click="changeUA('transmission')">Transmission</NButton>
            <NButton @click="changeUA('chrome')">Chrome</NButton>
            <NButton @click="changeUA('du')">du</NButton>
          </NButtonGroup>
          <NButton size="small" quaternary type="warning" @click="form.userAgent = ''">Reset</NButton>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.developer') }}</NDivider>
      <NFormItem :label="t('preferences.aria2-conf-path')">
        <NInput :value="aria2ConfPath" readonly />
      </NFormItem>
      <NFormItem :label="t('preferences.download-session-path')">
        <NInput :value="sessionPath" readonly />
      </NFormItem>
      <NFormItem :label="t('preferences.app-log-path')">
        <NInputGroup>
          <NInput :value="logPath" readonly style="flex: 1;" />
          <NSelect v-model:value="form.logLevel" :options="logLevelOptions" style="width: 110px;" />
        </NInputGroup>
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton type="warning" ghost @click="handleSessionReset">{{ t('preferences.session-reset') }}</NButton>
          <NButton type="error" ghost @click="handleFactoryReset">{{ t('preferences.factory-reset') }}</NButton>
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
.info-text {
  color: #999;
  font-size: 12px;
}
.info-link {
  color: #e8a838;
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: #e8a838;
  cursor: pointer;
  margin-left: 8px;
  font-size: 12px;
}
.action-link:hover {
  text-decoration: underline;
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
