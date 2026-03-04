<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE } from '@shared/constants'
import { isEngineReady } from '@/api/aria2'
import { remove } from '@tauri-apps/plugin-fs'
import { getTaskName } from '@shared/utils'
import { NButton, NIcon, NTooltip, NCheckbox, useDialog } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  AddOutline, PlayOutline, PauseOutline, TrashOutline,
  RefreshOutline, CloseOutline
} from '@vicons/ionicons5'

const { t } = useI18n()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
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
  refreshTimer = setTimeout(() => { refreshing.value = false }, 500)
  taskStore.fetchList().catch(console.error)
}

function onDeleteAll() {
  if (allGids.value.length === 0) return
  const gids = [...allGids.value]
  const deleteFiles = ref(false)
  dialog.warning({
    title: t('task.delete-task'),
    content: () => h('div', {}, [
      h('p', { style: 'margin: 0 0 12px;' }, `${t('task.batch-delete-task-confirm').replace('{{count}}', String(gids.length))}`),
      h(NCheckbox, {
        checked: deleteFiles.value,
        'onUpdate:checked': (v: boolean) => { deleteFiles.value = v },
      }, { default: () => t('task.delete-task-label') }),
    ]),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      if (deleteFiles.value) {
        const tasks = taskStore.taskList.filter(t => gids.includes(t.gid))
        for (const task of tasks) {
          const dir = (task as Record<string, unknown>).dir as string
          const files = ((task as Record<string, unknown>).files || []) as { path: string }[]
          const parentDirs = new Set<string>()
          for (const f of files) {
            if (!f.path) continue
            try { await remove(f.path) } catch {}
            try { await remove(f.path + '.aria2') } catch {}
            const lastSep = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\'))
            if (lastSep > 0) {
              const parent = f.path.substring(0, lastSep)
              if (parent !== dir) parentDirs.add(parent)
            }
          }
          for (const pd of parentDirs) {
            try { await remove(pd, { recursive: true }) } catch {}
          }
          if (dir) {
            const name = getTaskName(task as never, { defaultName: '', maxLen: -1 })
            if (name) {
              const { join } = await import('@tauri-apps/api/path')
              const taskDir = await join(dir, name)
              try { await remove(taskDir, { recursive: true }) } catch {}
            }
            try {
              const { readDir } = await import('@tauri-apps/plugin-fs')
              const entries = await readDir(dir)
              for (const entry of entries) {
                if (entry.name.endsWith('.aria2')) {
                  const { join } = await import('@tauri-apps/api/path')
                  const fullPath = await join(dir, entry.name)
                  try { await remove(fullPath) } catch {}
                }
              }
            } catch {}
          }
        }
      }
      await taskStore.batchRemoveTask(gids)
    },
  })
}

function resumeAll() {
  if (!isEngineReady()) { message.warning(t('app.engine-not-ready')); return }
  taskStore.resumeAllTask()
    .then(() => message.success(t('task.resume-all-task-success')))
    .catch(() => message.error(t('task.resume-all-task-fail')))
}

function pauseAll() {
  if (!isEngineReady()) { message.warning(t('app.engine-not-ready')); return }
  taskStore.pauseAllTask()
    .then(() => message.success(t('task.pause-all-task-success')))
    .catch(() => message.error(t('task.pause-all-task-fail')))
}

function purgeRecord() {
  if (!isEngineReady()) { message.warning(t('app.engine-not-ready')); return }
  taskStore.purgeTaskRecord()
    .then(() => message.success(t('task.purge-record-success')))
    .catch(() => message.error(t('task.purge-record-fail')))
}
</script>

<template>
  <div class="task-actions">
    <NTooltip>
      <template #trigger>
        <NButton type="primary" circle size="small" @click="showAddTask">
          <template #icon><NIcon><AddOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.new-task') || 'New Task' }}
    </NTooltip>
    <NTooltip v-if="currentList !== 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" :disabled="allGids.length === 0" @click="onDeleteAll">
          <template #icon><NIcon><CloseOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.delete-all-task') }}
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
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="resumeAll">
          <template #icon><NIcon><PlayOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.resume-all-task') || 'Resume All' }}
    </NTooltip>
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="pauseAll">
          <template #icon><NIcon><PauseOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.pause-all-task') || 'Pause All' }}
    </NTooltip>
    <NTooltip v-if="currentList === 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" @click="purgeRecord">
          <template #icon><NIcon><TrashOutline /></NIcon></template>
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
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spinning {
  animation: spin 0.5s linear;
}
</style>
