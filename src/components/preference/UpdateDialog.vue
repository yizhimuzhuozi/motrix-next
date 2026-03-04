<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NButton, NSpace, NProgress, NIcon, NText, NSpin } from 'naive-ui'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import { CheckmarkCircleOutline, CloseCircleOutline, ArrowUpCircleOutline } from '@vicons/ionicons5'

const { t } = useI18n()

const show = ref(false)
const phase = ref<'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'>('checking')
const version = ref('')
const currentVersion = ref('')
const errorMsg = ref('')
const downloadTotal = ref(0)
const downloadReceived = ref(0)
const downloadCancelled = ref(false)

let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null

const progressPercent = computed(() => {
  if (downloadTotal.value <= 0) return 0
  return Math.round((downloadReceived.value / downloadTotal.value) * 100)
})

const downloadedMB = computed(() => (downloadReceived.value / 1048576).toFixed(1))
const totalMB = computed(() => (downloadTotal.value / 1048576).toFixed(1))

async function open() {
  show.value = true
  phase.value = 'checking'
  version.value = ''
  errorMsg.value = ''
  downloadTotal.value = 0
  downloadReceived.value = 0
  downloadCancelled.value = false
  pendingUpdate = null
  currentVersion.value = await getVersion()

  try {
    const update = await check()
    if (update?.available) {
      version.value = update.version || ''
      pendingUpdate = update
      phase.value = 'available'
    } else {
      phase.value = 'up-to-date'
    }
  } catch (e) {
    errorMsg.value = String(e)
    phase.value = 'error'
  }
}

async function startDownload() {
  if (!pendingUpdate) return
  phase.value = 'downloading'
  downloadReceived.value = 0
  downloadTotal.value = 0
  downloadCancelled.value = false

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (downloadCancelled.value) return
      if (event.event === 'Started') {
        downloadTotal.value = (event.data as { contentLength?: number }).contentLength || 0
      } else if (event.event === 'Progress') {
        downloadReceived.value += (event.data as { chunkLength: number }).chunkLength
      } else if (event.event === 'Finished') {
        downloadReceived.value = downloadTotal.value
      }
    })
    if (!downloadCancelled.value) {
      phase.value = 'ready'
    }
  } catch (e) {
    if (!downloadCancelled.value) {
      errorMsg.value = String(e)
      phase.value = 'error'
    }
  }
}

function cancelDownload() {
  downloadCancelled.value = true
  phase.value = 'available'
}

function handleRelaunch() {
  relaunch()
}

function close() {
  if (phase.value === 'downloading') {
    cancelDownload()
  }
  show.value = false
}

defineExpose({ open })
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="phase !== 'downloading'"
    :close-on-esc="phase !== 'downloading'"
    transform-origin="center"
    :closable="phase !== 'downloading'"
    @update:show="(v: boolean) => { if (!v) close() }"
  >
    <div class="update-dialog">
      <div class="update-dialog-header">
        <span class="update-dialog-title">{{ t('preferences.auto-update') }}</span>
        <button class="update-dialog-close" @click="close">×</button>
      </div>
      <div class="update-dialog-body">
        <Transition name="phase-switch" mode="out-in">
          <div v-if="phase === 'checking'" key="checking" class="update-phase">
            <NSpin size="medium" />
            <NText depth="2" class="update-hint">{{ t('app.checking-for-updates') }}</NText>
          </div>

          <div v-else-if="phase === 'up-to-date'" key="up-to-date" class="update-phase">
            <div class="update-icon-wrap update-icon-success">
              <NIcon :size="40"><CheckmarkCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.is-latest-version') }}</NText>
            <NText depth="3" class="update-hint">v{{ currentVersion }}</NText>
          </div>

          <div v-else-if="phase === 'available'" key="available" class="update-phase">
            <div class="update-icon-wrap update-icon-new">
              <NIcon :size="40"><ArrowUpCircleOutline /></NIcon>
            </div>
            <div class="update-version-info">
              <NText class="update-main-text">{{ t('app.new-version-available') }}</NText>
              <div class="update-version-tags">
                <span class="version-tag version-old">v{{ currentVersion }}</span>
                <span class="version-arrow">→</span>
                <span class="version-tag version-new">v{{ version }}</span>
              </div>
            </div>
            <NButton type="primary" @click="startDownload" style="min-width: 160px;">
              {{ t('preferences.update-and-install') }}
            </NButton>
          </div>

          <div v-else-if="phase === 'downloading'" key="downloading" class="update-phase">
            <div class="update-icon-wrap update-icon-new">
              <NIcon :size="40"><ArrowUpCircleOutline /></NIcon>
            </div>
            <div class="update-progress-wrap">
              <NProgress
                type="line"
                :percentage="progressPercent"
                :show-indicator="true"
                indicator-placement="inside"
                processing
              />
              <NText depth="3" class="update-hint" style="margin-top: 6px;">
                {{ downloadedMB }} / {{ totalMB }} MB · {{ progressPercent }}%
              </NText>
            </div>
            <NButton size="small" quaternary @click="cancelDownload" style="opacity: 0.6;">
              {{ t('app.cancel') || 'Cancel' }}
            </NButton>
          </div>

          <div v-else-if="phase === 'ready'" key="ready" class="update-phase">
            <div class="update-icon-wrap update-icon-success">
              <NIcon :size="40"><CheckmarkCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.update-download-complete') }}</NText>
            <NButton type="primary" @click="handleRelaunch" style="min-width: 160px;">
              {{ t('preferences.restart-now') }}
            </NButton>
          </div>

          <div v-else-if="phase === 'error'" key="error" class="update-phase">
            <div class="update-icon-wrap update-icon-error">
              <NIcon :size="40"><CloseCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.check-update-failed') }}</NText>
            <div class="update-error-detail">
              <NText depth="3" class="update-error-msg">{{ errorMsg }}</NText>
            </div>
            <NSpace justify="center" :size="8">
              <NButton size="small" @click="open">{{ t('app.retry') }}</NButton>
              <NButton size="small" quaternary @click="close">{{ t('app.close') }}</NButton>
            </NSpace>
          </div>
        </Transition>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.update-dialog {
  width: 400px;
  background: var(--n-color, #1e1e2e);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.update-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 0;
}
.update-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color, #fff);
}
.update-dialog-close {
  background: none;
  border: none;
  color: var(--n-text-color, #aaa);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.update-dialog-close:hover {
  opacity: 1;
}
.update-dialog-body {
  padding: 20px 28px 28px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.update-phase {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  width: 100%;
}

.update-icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}
.update-icon-success {
  background: rgba(99, 226, 183, 0.12);
  color: #63e2b7;
}
.update-icon-new {
  background: rgba(224, 164, 34, 0.12);
  color: #E0A422;
}
.update-icon-error {
  background: rgba(232, 128, 128, 0.12);
  color: #e88080;
}

.update-main-text {
  font-size: 15px;
  font-weight: 600;
}
.update-hint {
  font-size: 12px;
}

.update-version-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.update-version-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-tag {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.version-old {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.4);
}
.version-new {
  background: rgba(224, 164, 34, 0.15);
  color: #E0A422;
}
.version-arrow {
  font-size: 12px;
  opacity: 0.3;
}

.update-progress-wrap {
  width: 100%;
  padding: 0 8px;
}

.update-error-detail {
  width: 100%;
  background: rgba(232, 128, 128, 0.06);
  border-radius: 8px;
  padding: 8px 12px;
  max-height: 52px;
  overflow-y: auto;
}
.update-error-msg {
  font-size: 12.5px;
  word-break: break-all;
  opacity: 0.55;
  line-height: 1.5;
}

.phase-switch-enter-active {
  transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.phase-switch-leave-active {
  transition: opacity 0.25s cubic-bezier(0.4, 0, 1, 1),
              transform 0.25s cubic-bezier(0.4, 0, 1, 1);
}
.phase-switch-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(8px);
}
.phase-switch-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}
</style>
