<script setup lang="ts">
/** @fileoverview Scrollable task list container with AutoAnimate transitions. */
import { ref, computed, watch } from 'vue'
import { vAutoAnimate } from '@formkit/auto-animate'
import { useTaskStore } from '@/stores/task'
import TaskItem from './TaskItem.vue'
import type { Aria2Task } from '@shared/types'

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

const taskStore = useTaskStore()

const taskList = ref<Aria2Task[]>(taskStore.taskList)
const selectedGidList = computed(() => taskStore.selectedGidList)

watch(
  () => taskStore.taskList,
  (v) => {
    taskList.value = v
  },
)

function isSelected(gid: string) {
  return selectedGidList.value.includes(gid)
}

function handleItemClick(task: Aria2Task, event: MouseEvent) {
  const gid = task.gid
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
  <div class="task-list">
    <div v-auto-animate="{ duration: 300, easing: 'ease-out' }" class="task-list-inner">
      <div
        v-for="item in taskList"
        :key="item.gid"
        :class="{ selected: isSelected(item.gid) }"
        class="task-list-item"
        @click="handleItemClick(item, $event)"
      >
        <TaskItem
          :task="item"
          @pause="emit('pause', item)"
          @resume="emit('resume', item)"
          @delete="emit('delete', item)"
          @delete-record="emit('delete-record', item)"
          @copy-link="emit('copy-link', item)"
          @show-info="emit('show-info', item)"
          @folder="emit('folder', item)"
          @open-file="emit('open-file', item)"
          @stop-seeding="emit('stop-seeding', item)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-list {
  padding: 16px 36px 16px;
  min-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
/*
 * Speedometer clearance spacer — only when cards are present.
 * A ::after pseudo-element participates in flex layout, reliably
 * reserving space above the fixed Speedometer widget.
 */
.task-list-inner:not(:empty)::after {
  content: '';
  display: block;
  flex: 0 0 48px;
}

/* ── Task card layer ─────────────────────────────────────────────────── */
.task-list-inner {
  position: relative;
  z-index: 1;
}
.selected :deep(.task-item) {
  border-color: var(--task-item-hover-border);
}
.task-list-item {
  margin-bottom: 16px;
}
</style>
