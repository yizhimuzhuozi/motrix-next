<script setup lang="ts">
/** @fileoverview Batch task action buttons: resume all, pause all, delete all, purge. */
import { ref, computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { ADD_TASK_TYPE } from '@shared/constants'
import { isEngineReady } from '@/api/aria2'
import { deleteTaskFiles } from '@/composables/useFileDelete'
import { logger } from '@shared/logger'
import { NButton, NIcon, NTooltip, NCheckbox, useDialog } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import { AddOutline, PlayOutline, PauseOutline, TrashOutline, RefreshOutline, CloseOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const appStore = useAppStore()
const taskStore = useTaskStore()
const message = useAppMessage()
const dialog = useDialog()

const refreshing = ref(false)
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const currentList = computed(() => taskStore.currentList)
const allGids = computed(() => taskStore.taskList.map((t: { gid: string }) => t.gid))

function showAddTask() {
  appStore.showAddTaskDialog(ADD_TASK_TYPE.URI)
}

function onRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshing.value = true
  refreshTimer = setTimeout(() => {
    refreshing.value = false
  }, 500)
  taskStore
    .fetchList()
    .then(() => message.success(t('task.refresh-list-success') || 'List refreshed'))
    .catch((e: unknown) => logger.warn('TaskActions.onRefresh', (e as Error).message))
}

function onDeleteAll() {
  if (allGids.value.length === 0) return
  const gids = [...allGids.value]
  const deleteFiles = ref(false)
  const d = dialog.warning({
    title: t('task.delete-task'),
    content: () =>
      h('div', {}, [
        h('p', { style: 'margin: 0 0 12px;' }, t('task.batch-delete-task-confirm', { count: gids.length })),
        h(
          NCheckbox,
          {
            checked: deleteFiles.value,
            'onUpdate:checked': (v: boolean) => {
              deleteFiles.value = v
            },
          },
          { default: () => t('task.delete-task-label') },
        ),
      ]),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      d.loading = true
      d.negativeButtonProps = { disabled: true }
      d.closable = false
      d.maskClosable = false
      // Yield to browser so the loading spinner renders before heavy IPC work
      await new Promise((r) => setTimeout(r, 50))
      if (deleteFiles.value) {
        const tasks = taskStore.taskList.filter((t) => gids.includes(t.gid))
        for (const task of tasks) {
          await deleteTaskFiles(task)
        }
      }
      await taskStore.batchRemoveTask(gids)
      message.success(t('task.batch-delete-task-success'))
    },
  })
}

function resumeAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  dialog.warning({
    title: t('task.resume-all-task'),
    content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      await taskStore
        .resumeAllTask()
        .then(() => message.success(t('task.resume-all-task-success')))
        .catch(() => message.error(t('task.resume-all-task-fail')))
    },
  })
}

function pauseAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  dialog.warning({
    title: t('task.pause-all-task'),
    content: t('task.pause-all-task-confirm') || 'Pause all tasks?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      await taskStore
        .pauseAllTask()
        .then(() => message.success(t('task.pause-all-task-success')))
        .catch(() => message.error(t('task.pause-all-task-fail')))
    },
  })
}

function purgeRecord() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  dialog.warning({
    title: t('task.purge-record'),
    content: t('task.purge-record-confirm') || 'Clear all finished records?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      await taskStore
        .purgeTaskRecord()
        .then(() => message.success(t('task.purge-record-success')))
        .catch(() => message.error(t('task.purge-record-fail')))
    },
  })
}
</script>

<template>
  <div class="task-actions">
    <NTooltip>
      <template #trigger>
        <NButton type="primary" circle size="small" @click="showAddTask">
          <template #icon
            ><NIcon><AddOutline /></NIcon
          ></template>
        </NButton>
      </template>
      {{ t('task.new-task') || 'New Task' }}
    </NTooltip>
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="onRefresh">
          <template #icon>
            <NIcon :class="{ spinning: refreshing }"><RefreshOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.refresh-list') || 'Refresh' }}
    </NTooltip>
    <NTooltip v-if="currentList !== 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" @click="resumeAll">
          <template #icon
            ><NIcon><PlayOutline /></NIcon
          ></template>
        </NButton>
      </template>
      {{ t('task.resume-all-task') || 'Resume All' }}
    </NTooltip>
    <NTooltip v-if="currentList !== 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" @click="pauseAll">
          <template #icon
            ><NIcon><PauseOutline /></NIcon
          ></template>
        </NButton>
      </template>
      {{ t('task.pause-all-task') || 'Pause All' }}
    </NTooltip>
    <NTooltip v-if="currentList !== 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" :disabled="allGids.length === 0" @click="onDeleteAll">
          <template #icon
            ><NIcon><CloseOutline /></NIcon
          ></template>
        </NButton>
      </template>
      {{ t('task.delete-all-task') }}
    </NTooltip>
    <NTooltip v-if="currentList === 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" @click="purgeRecord">
          <template #icon
            ><NIcon><TrashOutline /></NIcon
          ></template>
        </NButton>
      </template>
      {{ t('task.purge-record') || 'Purge Records' }}
    </NTooltip>
  </div>
</template>

<style scoped>
.task-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.spinning {
  animation: spin 0.5s linear;
  display: inline-block;
  transform-origin: center;
}
</style>
