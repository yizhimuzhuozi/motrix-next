<script setup lang="ts">
/** @fileoverview Individual task row in the task list with progress and controls. */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import {
  checkTaskIsSeeder,
  getTaskDisplayName,
  calcProgress,
  bytesToSize,
  timeRemaining,
  timeFormat,
  checkTaskIsBT,
} from '@shared/utils'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
import { resolveTaskFilePath, recheckTrigger } from '@/composables/useArchivedPaths'
import { NProgress, NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import {
  ArrowUpOutline,
  ArrowDownOutline,
  GitNetworkOutline,
  MagnetOutline,
  AlertCircleOutline,
  CloudUploadOutline,
  CheckmarkCircleOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import TaskItemActions from './TaskItemActions.vue'
import type { Aria2Task } from '@shared/types'

const props = defineProps<{ task: Aria2Task }>()
const emit = defineEmits<{
  pause: [task: Aria2Task]
  resume: [task: Aria2Task]
  delete: [task: Aria2Task]
  'delete-record': [task: Aria2Task]
  'copy-link': [task: Aria2Task]
  'show-info': [task: Aria2Task]
  folder: [task: Aria2Task]
  'open-file': [task: Aria2Task]
  'stop-seeding': [task: Aria2Task]
}>()

const { t } = useI18n()

const taskFullName = computed(() =>
  getTaskDisplayName(props.task, { defaultName: t('task.get-task-name') || 'Unknown' }),
)

const isSeeder = computed(() => checkTaskIsSeeder(props.task))
const isBT = computed(() => checkTaskIsBT(props.task))
const taskStatus = computed(() => (isSeeder.value ? TASK_STATUS.SEEDING : props.task.status))
const isActive = computed(() => props.task.status === TASK_STATUS.ACTIVE)

const percent = computed(() => calcProgress(props.task.totalLength, props.task.completedLength))
const completedSize = computed(() => bytesToSize(props.task.completedLength, 2))
const totalSize = computed(() => bytesToSize(props.task.totalLength, 2))
const hasSizeInfo = computed(() => Number(props.task.completedLength) > 0 || Number(props.task.totalLength) > 0)
const downloadSpeed = computed(() => bytesToSize(props.task.downloadSpeed))
const uploadSpeed = computed(() => bytesToSize(props.task.uploadSpeed))

const remaining = computed(() => {
  if (!isActive.value) return 0
  return timeRemaining(
    Number(props.task.totalLength),
    Number(props.task.completedLength),
    Number(props.task.downloadSpeed),
  )
})

const remainingText = computed(() => {
  if (remaining.value <= 0) return ''
  return timeFormat(remaining.value, {
    prefix: t('task.remaining-prefix') || '',
    i18n: {
      gt1d: t('app.gt1d') || '>1d',
      hour: t('app.hour') || 'h',
      minute: t('app.minute') || 'm',
      second: t('app.second') || 's',
    },
  })
})

/** Reads a CSS variable from :root, returning the fallback if unavailable. */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

const statusColorMap = computed<Record<string, string>>(() => ({
  active: cssVar('--m3-status-active', ''),
  waiting: cssVar('--m3-status-waiting', ''),
  paused: cssVar('--m3-status-paused', '#909399'),
  error: cssVar('--m3-status-error', '#F56C6C'),
  complete: cssVar('--m3-status-success', '#67C23A'),
  removed: cssVar('--m3-status-paused', '#909399'),
  seeding: cssVar('--m3-status-success', '#67C23A'),
}))

const progressColor = computed(() => statusColorMap.value[taskStatus.value] || cssVar('--m3-status-active', ''))

const finishedTag = computed(() => {
  const s = props.task.status
  if (s === TASK_STATUS.COMPLETE)
    return {
      label: t('task.task-complete') || 'Completed',
      color: cssVar('--m3-status-success', '#67C23A'),
      icon: CheckmarkCircleOutline,
    }
  if (s === TASK_STATUS.ERROR)
    return {
      label: t('task.task-error') || 'Error',
      color: cssVar('--m3-status-error', '#F56C6C'),
      icon: AlertCircleOutline,
    }
  if (s === TASK_STATUS.REMOVED)
    return {
      label: t('task.task-removed') || 'Removed',
      color: cssVar('--m3-status-paused', '#909399'),
      icon: TrashOutline,
    }
  return null
})

function onDblClick() {
  if (isSeeder.value) return
  const s = props.task.status
  if (s === TASK_STATUS.COMPLETE) {
    emit('open-file', props.task)
    return
  }
  if (s === TASK_STATUS.ACTIVE) emit('pause', props.task)
  else if (s === TASK_STATUS.WAITING || s === TASK_STATUS.PAUSED) emit('resume', props.task)
}

// File missing detection for completed/stopped tasks
const fileMissing = ref(false)
const FILE_CHECK_THROTTLE_MS = 120
let fileCheckTimer: ReturnType<typeof setTimeout> | null = null

const fileCheckTargetPath = computed(() => {
  const status = props.task.status
  if (status === TASK_STATUS.ACTIVE || status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) {
    return null
  }
  return resolveTaskFilePath(props.task)
})

async function checkFileExists(targetPath: string | null) {
  if (!targetPath) {
    fileMissing.value = false
    return
  }

  try {
    fileMissing.value = !(await invoke<boolean>('check_path_exists', { path: targetPath }))
  } catch (e) {
    logger.debug('TaskItem.fileCheck', e)
    fileMissing.value = false
  }
}

function scheduleFileExistsCheck(targetPath: string | null) {
  if (fileCheckTimer) {
    clearTimeout(fileCheckTimer)
    fileCheckTimer = null
  }

  if (!targetPath) {
    fileMissing.value = false
    return
  }

  fileCheckTimer = setTimeout(() => {
    fileCheckTimer = null
    void checkFileExists(targetPath)
  }, FILE_CHECK_THROTTLE_MS)
}

// Dual-source trigger: re-check when path changes (archive) OR on explicit
// recheck request (action handler file-not-found, periodic background timer).
watch([fileCheckTargetPath, recheckTrigger], ([path]) => scheduleFileExistsCheck(path), { immediate: true })
onBeforeUnmount(() => {
  if (fileCheckTimer) {
    clearTimeout(fileCheckTimer)
    fileCheckTimer = null
  }
})

// ── M3 seeding state entrance animation ───────────────────────────
// CSS transitions fail here because the store's polling cycle replaces
// task objects entirely — even though Vue reuses the DOM element (same
// gid key), NProgress internally rebuilds its fill node, losing the
// transition starting point. @keyframes animations do not depend on
// property value continuity — they always play from→to.
const seedingEnter = ref(false)

watch(isSeeder, (now, was) => {
  if (now && !was) {
    seedingEnter.value = true
  }
})

// ── Card press-hold interaction ─────────────────────────────────────
// Mirrors the pointerdown/pointerup pattern from TaskItemActions.
// Card stays pressed (scale down) while pointer is held, then springs
// back on release with a minimum visual duration for quick clicks.
const CARD_PRESS_MS = 180
let cardPressStart = 0
let cardPressTimer: ReturnType<typeof setTimeout> | null = null
const cardRef = ref<HTMLElement | null>(null)

function onCardPress() {
  if (cardPressTimer) clearTimeout(cardPressTimer)
  cardPressStart = Date.now()
  cardRef.value?.classList.add('pressed')
}

function onCardRelease() {
  const elapsed = Date.now() - cardPressStart
  const remaining = Math.max(0, CARD_PRESS_MS - elapsed)
  cardPressTimer = setTimeout(() => {
    cardRef.value?.classList.remove('pressed')
    cardPressTimer = null
  }, remaining)
}

onBeforeUnmount(() => {
  if (cardPressTimer) {
    clearTimeout(cardPressTimer)
    cardPressTimer = null
  }
})
</script>

<template>
  <div
    ref="cardRef"
    class="task-item"
    :class="{
      'file-missing': fileMissing,
      'is-seeding': isSeeder,
      'seeding-enter': seedingEnter,
    }"
    @dblclick="onDblClick"
    @pointerdown="onCardPress"
    @pointerup="onCardRelease"
    @pointerleave="onCardRelease"
    @animationend="seedingEnter = false"
  >
    <MTooltip placement="bottom-start">
      <template #trigger>
        <div class="task-name">
          <!-- Crossfade: old name fades out, then new name fades in.
               :key ensures transition only fires when the text actually changes.
               Polling-safe: computed returns the same string each cycle → no key change. -->
          <Transition name="name-crossfade" mode="out-in">
            <span :key="taskFullName">{{ taskFullName }}</span>
          </Transition>
          <div class="tags-wrapper" :class="{ 'has-tags': isSeeder || finishedTag || fileMissing }">
            <div class="tags-inner">
              <div v-if="isSeeder || finishedTag || fileMissing" class="task-tags">
                <span v-if="isSeeder" class="seeding-tag">
                  <NIcon :size="13"><CloudUploadOutline /></NIcon>
                  {{ t('task.seeding') || 'Seeding' }}
                </span>
                <span v-else-if="finishedTag" class="status-tag" :style="{ color: finishedTag.color }">
                  <NIcon :size="13"><component :is="finishedTag.icon" /></NIcon>
                  {{ finishedTag.label }}
                </span>
                <span v-if="fileMissing" class="file-missing-tag">
                  <NIcon :size="13"><AlertCircleOutline /></NIcon>
                  {{ t('task.file-missing') || 'File missing' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>
      {{ taskFullName }}
    </MTooltip>
    <TaskItemActions
      :task="task"
      :status="taskStatus"
      :file-missing="fileMissing"
      @pause="emit('pause', task)"
      @resume="emit('resume', task)"
      @delete="emit('delete', task)"
      @delete-record="emit('delete-record', task)"
      @copy-link="emit('copy-link', task)"
      @show-info="emit('show-info', task)"
      @folder="emit('folder', task)"
      @open-file="emit('open-file', task)"
      @stop-seeding="emit('stop-seeding', task)"
    />
    <div class="task-progress">
      <NProgress
        type="line"
        :percentage="percent"
        :color="progressColor"
        :rail-color="undefined"
        :height="6"
        :border-radius="3"
        :show-indicator="false"
        :processing="isActive"
      />
      <div class="task-progress-info">
        <div class="progress-left" :class="{ 'info-hidden': !hasSizeInfo }">
          <span>
            {{ completedSize }}
            <span v-if="Number(task.totalLength) > 0"> / {{ totalSize }}</span>
          </span>
        </div>
        <div class="progress-right" :class="{ 'info-hidden': !isActive }">
          <span class="speed-text" :class="{ 'info-hidden': remaining <= 0 }">
            <span>{{ remainingText }}</span>
          </span>
          <span v-if="isBT" class="speed-text">
            <NIcon :size="10"><ArrowUpOutline /></NIcon>
            <span>{{ uploadSpeed }}/s</span>
          </span>
          <span class="speed-text">
            <NIcon :size="10"><ArrowDownOutline /></NIcon>
            <span>{{ downloadSpeed }}/s</span>
          </span>
          <span v-if="isBT" class="speed-text">
            <NIcon :size="10"><MagnetOutline /></NIcon>
            <span>{{ task.numSeeders }}</span>
          </span>
          <span class="speed-text">
            <NIcon :size="10"><GitNetworkOutline /></NIcon>
            <span>{{ task.connections }}</span>
          </span>
        </div>
        <div class="error-message" :class="{ 'info-hidden': !task.errorMessage }">{{ task.errorMessage }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-item {
  position: relative;
  min-height: 78px;
  padding: 16px 12px;
  background-color: var(--task-item-bg);
  border: 1px solid var(--m3-outline-variant);
  /* Reserve 3px left border at base color so seeding only animates color */
  border-left: 3px solid var(--m3-outline-variant);
  border-radius: 6px;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
/* Gradient overlay — always present, hidden by default */
.task-item::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--m3-success) 6%, transparent) 0%, transparent 40%);
  opacity: 0;
  pointer-events: none;
}
/* ── Seeding state (static) ────────────────────────────────────────── */
.task-item.is-seeding {
  border-left-color: var(--m3-success);
}
.task-item.is-seeding::before {
  opacity: 1;
}
/* ── Seeding entrance animation (triggered by Vue watch) ───────────── */
/* @keyframes always plays from→to regardless of prior DOM state,       */
/* unlike CSS transitions which break when the element is re-rendered.  */
@keyframes seeding-border-enter {
  from {
    border-left-color: var(--m3-outline-variant);
  }
  to {
    border-left-color: var(--m3-success);
  }
}
@keyframes seeding-overlay-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.task-item.seeding-enter {
  animation: seeding-border-enter 1s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item.seeding-enter::before {
  animation: seeding-overlay-enter 1.2s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item:hover {
  border-color: var(--task-item-hover-border);
}
/* ── Card press-hold state ──────────────────────────────────────────── */
/* Asymmetric timing: fast press-in (0.15s), springy release (0.35s).   */
/* The release uses M3 emphasized-decelerate for organic overshoot.     */
.task-item.pressed {
  transform: scale(0.98);
  border-color: var(--color-primary);
  transition:
    transform 0.15s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.15s;
}
/* Spring-back on release — overshoots slightly via emphasized easing */
.task-item:not(.pressed) {
  transition:
    transform 0.35s cubic-bezier(0.05, 0.7, 0.1, 1),
    border-color 0.3s;
}
.task-name {
  color: var(--m3-on-surface-variant);
  margin-bottom: 1.5rem;
  margin-right: 250px;
  overflow: hidden;
  min-height: 26px;
}
.task-name > span {
  font-size: 14px;
  line-height: 26px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
}
/* ── Filename resolution crossfade (Vue <Transition mode="out-in">) ── */
/* Old text fades out → new text fades in. No flash because Vue applies  */
/* enter-from (opacity:0) BEFORE inserting the new element.              */
/* Polling-safe: :key is the string value — same string = no transition. */
.name-crossfade-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.05, 0.7, 0.1, 1),
    transform 0.25s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.name-crossfade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.2, 0, 0, 1);
}
.name-crossfade-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
.name-crossfade-leave-to {
  opacity: 0;
}
.file-missing-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  color: var(--m3-error);
  opacity: 0.85;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
/* M3 emphasized-decelerate tag entrance — shared by all status tags */
@keyframes m3-tag-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 0.9;
    transform: translateY(0);
  }
}
.task-item.file-missing {
  border-color: var(--m3-error-container-bg);
}
/* M3 progress-bar color transition (amber → green on status change) */
.task-progress :deep(.n-progress-graph-line-fill) {
  transition: background-color 0.5s cubic-bezier(0.2, 0, 0, 1);
}
.task-progress-info {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  font-size: 12px;
  line-height: 14px;
  min-height: 14px;
  color: var(--m3-on-surface-variant);
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
}
.progress-left {
  white-space: nowrap;
  transition: opacity 0.4s cubic-bezier(0.2, 0, 0, 1);
}
.progress-right {
  display: flex;
  gap: 8px;
  text-align: right;
  align-items: center;
  transition: opacity 0.4s cubic-bezier(0.2, 0, 0, 1);
}
.speed-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  line-height: 14px;
  white-space: nowrap;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Pure CSS show/hide (polling-safe) ────────────────────────────── */
/* Bypasses Vue <Transition> to avoid leave-animation loss when       */
/* reactive polling updates child content in the same render tick.    */
.info-hidden {
  opacity: 0;
  pointer-events: none;
}
.task-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* ── Tag height transition (CSS Grid 0fr→1fr) ────────────────────── */
/* Wrapper is always in the DOM. grid-template-rows transitions from    */
/* 0fr (collapsed, zero height) to 1fr (natural height). The inner      */
/* element uses overflow:hidden + min-height:0 to clip during collapse.  */
/* Works for all tags: seeding, completed, removed, file-missing.       */
.tags-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.4s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.tags-wrapper.has-tags {
  grid-template-rows: 1fr;
}
.tags-inner {
  overflow: hidden;
  min-height: 0;
}
.seeding-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  color: var(--m3-success);
  opacity: 0.9;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  opacity: 0.9;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.error-message {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--m3-error);
  margin-top: 4px;
  opacity: 0.85;
  word-break: break-all;
  line-height: 1.4;
}
</style>
