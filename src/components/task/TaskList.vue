<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useTaskStore } from '@/stores/task'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import TaskItem from './TaskItem.vue'
import watermarkDark from '@/assets/brand-watermark-dark.png'
import watermarkLight from '@/assets/brand-watermark-light.png'

const emit = defineEmits<{
  pause: [task: Record<string, unknown>]
  resume: [task: Record<string, unknown>]
  delete: [task: Record<string, unknown>]
  'delete-record': [task: Record<string, unknown>]
  'copy-link': [task: Record<string, unknown>]
  'show-info': [task: Record<string, unknown>]
  folder: [task: Record<string, unknown>]
  'stop-seeding': [task: Record<string, unknown>]
}>()

const { t } = useI18n()
const taskStore = useTaskStore()
const { isDark } = useTheme()
const watermarkSrc = computed(() => isDark.value ? watermarkLight : watermarkDark)

const mounted = ref(false)
const taskList = ref<Record<string, unknown>[]>([])
const selectedGidList = computed(() => taskStore.selectedGidList)

onMounted(() => {
  nextTick(() => {
    mounted.value = true
    taskList.value = taskStore.taskList as Record<string, unknown>[]
  })
})

watch(() => taskStore.taskList, (v) => {
  if (mounted.value) taskList.value = v as Record<string, unknown>[]
})

function isSelected(gid: string) {
  return selectedGidList.value.includes(gid)
}

function handleItemClick(task: Record<string, unknown>, event: MouseEvent) {
  const gid = task.gid as string
  const list = [...selectedGidList.value]
  if (event.metaKey || event.ctrlKey) {
    const idx = list.indexOf(gid)
    if (idx === -1) list.push(gid)
    else list.splice(idx, 1)
  } else {
    list.length = 0
    list.push(gid)
  }
  taskStore.selectTasks(list)
}
</script>

<template>
  <div class="task-list" :class="{ 'is-empty': taskList.length === 0 }">
    <TransitionGroup name="task-list" tag="div" class="task-list-inner">
      <div
        v-for="item in taskList"
        :key="(item as Record<string, unknown>).gid as string"
        :class="{ selected: isSelected((item as Record<string, unknown>).gid as string) }"
        class="task-list-item"
        @click="handleItemClick(item as Record<string, unknown>, $event)"
      >
        <TaskItem
          :task="item as Record<string, unknown>"
          @pause="emit('pause', item as Record<string, unknown>)"
          @resume="emit('resume', item as Record<string, unknown>)"
          @delete="emit('delete', item as Record<string, unknown>)"
          @delete-record="emit('delete-record', item as Record<string, unknown>)"
          @copy-link="emit('copy-link', item as Record<string, unknown>)"
          @show-info="emit('show-info', item as Record<string, unknown>)"
          @folder="emit('folder', item as Record<string, unknown>)"
          @stop-seeding="emit('stop-seeding', item as Record<string, unknown>)"
        />
      </div>
    </TransitionGroup>
    <Transition name="fade">
      <div v-if="mounted && taskList.length === 0" class="no-task">
        <div class="no-task-inner">
          <img :src="watermarkSrc" alt="Motrix Next" class="no-task-brand" />
          <div class="no-task-text">{{ t('task.no-task') || 'No Task' }}</div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.task-list {
  padding: 16px 36px 64px;
  min-height: 100%;
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
}
.task-list-inner {
  position: relative;
}
.selected :deep(.task-item) {
  border-color: var(--task-item-hover-border);
}
.task-list-item {
  margin-bottom: 16px;
}
.task-list-enter-active {
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
}
.task-list-leave-active {
  transition: all 0.2s cubic-bezier(0.3, 0, 0.8, 0.15);
  position: absolute;
  width: calc(100% - 72px);
}
.task-list-enter-from {
  opacity: 0;
  transform: translateY(24px) scale(0.97);
}
.task-list-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.97);
}
.task-list-move {
  transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1);
}
.no-task {
  display: flex;
  flex: 1;
  text-align: center;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.no-task-inner {
  width: 100%;
}
.no-task-brand {
  max-width: 320px;
  width: 60%;
  opacity: 0.35;
  pointer-events: none;
  margin-bottom: 16px;
}
.no-task-text {
  font-size: 14px;
  color: #555;
}
.fade-enter-active { transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1); }
.fade-leave-active { transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15); }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
