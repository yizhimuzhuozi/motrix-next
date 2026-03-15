<script setup lang="ts">
/** @fileoverview Modal dialog for selecting files from a magnet link's metadata.
 *
 * Displayed after aria2 downloads the metadata (info dict) for a magnet URI.
 * Uses NDataTable file selection pattern consistent with torrent upload in AddTask.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NCard, NDataTable, NButton, NSpace, NEllipsis } from 'naive-ui'
import { bytesToSize } from '@shared/utils'
import type { DataTableColumns, DataTableRowKey } from 'naive-ui'
import type { MagnetFileItem } from '@/composables/useMagnetFlow'

const props = defineProps<{
  show: boolean
  files: MagnetFileItem[]
  taskName: string
}>()

const emit = defineEmits<{
  confirm: [selectedIndices: number[]]
  cancel: []
}>()

const { t } = useI18n()

const checkedKeys = ref<DataTableRowKey[]>([])

watch(
  () => props.files,
  (files) => {
    checkedKeys.value = files.map((f) => f.index)
  },
  { immediate: true },
)

const columns = computed<DataTableColumns>(() => [
  { type: 'selection' },
  {
    title: '#',
    key: 'index',
    width: 50,
  },
  {
    title: t('task.file-name') || 'File Name',
    key: 'name',
    ellipsis: { tooltip: true },
  },
  {
    title: t('task.file-size') || 'Size',
    key: 'length',
    width: 110,
    render(row: Record<string, unknown>) {
      return bytesToSize(row.length as number)
    },
  },
])

const totalSize = computed(() => {
  const selected = new Set(checkedKeys.value)
  return props.files.filter((f) => selected.has(f.index)).reduce((sum, f) => sum + f.length, 0)
})

const hasSelection = computed(() => checkedKeys.value.length > 0)

function handleConfirm() {
  emit('confirm', checkedKeys.value as number[])
}

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <NModal :show="show" :mask-closable="false" @update:show="(v) => !v && handleCancel()">
    <NCard
      :title="t('task.select-files') || 'Select Files'"
      :bordered="false"
      closable
      role="dialog"
      class="magnet-file-select-card"
      @close="handleCancel"
    >
      <!-- Task name subtitle -->
      <div class="task-name-subtitle">
        <NEllipsis :line-clamp="1">{{ taskName }}</NEllipsis>
      </div>

      <NDataTable
        :columns="columns"
        :data="files"
        :row-key="(row: MagnetFileItem) => row.index"
        :checked-row-keys="checkedKeys"
        :max-height="360"
        size="small"
        @update:checked-row-keys="(keys: DataTableRowKey[]) => (checkedKeys = keys)"
      />

      <template #footer>
        <NSpace justify="space-between" align="center">
          <span class="file-summary">
            <Transition name="val" mode="out-in">
              <span :key="checkedKeys.length" class="file-summary-count"
                >{{ checkedKeys.length }}/{{ files.length }}</span
              >
            </Transition>
            <span class="file-summary-sep">—</span>
            <Transition name="val" mode="out-in">
              <span :key="bytesToSize(totalSize)" class="file-summary-size">{{ bytesToSize(totalSize) }}</span>
            </Transition>
          </span>
          <NSpace>
            <NButton @click="handleCancel">
              {{ t('task.magnet-cancel-download') || 'Cancel Download' }}
            </NButton>
            <NButton type="primary" :disabled="!hasSelection" @click="handleConfirm">
              {{ t('task.magnet-start-download') || 'Start Download' }}
            </NButton>
          </NSpace>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.magnet-file-select-card {
  width: 640px;
  max-width: 90vw;
}

.task-name-subtitle {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--n-text-color-3, rgba(255, 255, 255, 0.38));
  line-height: 1.4;
}

.file-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--n-text-color-2, rgba(255, 255, 255, 0.82));
}

.file-summary-count,
.file-summary-size {
  display: inline-block;
}

.file-summary-sep {
  opacity: 0.5;
}

/* Value change transition — fade + slight vertical slide */
.val-enter-active,
.val-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.val-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.val-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
