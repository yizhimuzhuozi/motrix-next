<script setup lang="ts">
/** @fileoverview Detailed task view with file list, peers, and BT info. */
import { ref, computed, watch, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { logger } from '@shared/logger'
import {
  checkTaskIsBT,
  checkTaskIsSeeder,
  getTaskDisplayName,
  bytesToSize,
  calcProgress,
  calcRatio,
  getFileName,
  getFileExtension,
  localeDateTimeFormat,
  bitfieldToPercent,
  peerIdParser,
  timeRemaining,
  timeFormat,
} from '@shared/utils'
import { decodePathSegment } from '@shared/utils/batchHelpers'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { countryCodeToFlag, lookupPeerIps, type GeoInfo } from '@shared/utils/geoip'
import {
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NDataTable,
  NIcon,
  NProgress,
  NTag,
  NButton,
  NRadioGroup,
  NRadio,
  NInput,
  NFormItem,
  NCollapseTransition,
  NEllipsis,
  NTooltip,
} from 'naive-ui'
import {
  InformationCircleOutline,
  PulseOutline,
  DocumentOutline,
  PeopleOutline,
  ServerOutline,
  SettingsOutline,
  SearchOutline,
} from '@vicons/ionicons5'
import TaskGraphic from './TaskGraphic.vue'
import { useTrackerProbe, buildTrackerRows, type TrackerRow } from '@/composables/useTrackerProbe'
import { useTaskDetailOptions } from '@/composables/useTaskDetailOptions'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import { useHistoryStore } from '@/stores/history'
import { useAppMessage } from '@/composables/useAppMessage'
import { useSystemProxyDetect } from '@/composables/useSystemProxyDetect'
import { getAddedAt } from '@/composables/useTaskOrder'
import type { Aria2Task, Aria2File, Aria2Peer } from '@shared/types'

const props = defineProps<{
  show: boolean
  task: Aria2Task | null
  files: Aria2File[]
}>()
const emit = defineEmits<{ close: [] }>()

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const historyStore = useHistoryStore()
const message = useAppMessage()
const taskRef = computed(() => props.task)

const {
  form: optForm,
  canModify: optCanModify,
  globalProxyAvailable: optGlobalProxyAvailable,
  proxyAddress: optProxyAddress,
  dirty: optDirty,
  applying: optApplying,
  applyOptions: optApplyFn,
} = useTaskDetailOptions({
  task: taskRef,
  getTaskOption: (gid) => taskStore.getTaskOption(gid),
  changeTaskOption: (payload) => taskStore.changeTaskOption(payload),
  proxyConfig: () => preferenceStore.config.proxy,
  message,
  t,
})

const { detecting: detectingProxy, detect: detectProxy } = useSystemProxyDetect({
  onSuccess(info) {
    optForm.customProxy = info.server
    message.success(t('preferences.proxy-detected-success'))
  },
  onSocks() {
    message.warning(t('preferences.proxy-system-socks-rejected'))
  },
  onNotFound() {
    message.info(t('preferences.proxy-system-not-detected'))
  },
  onError() {
    message.error(t('preferences.proxy-system-detect-failed'))
  },
})

const activeTab = ref('general')
const slideDirection = ref<'left' | 'right'>('left')
const prevTabIndex = ref(0)

interface TabDef {
  key: string
  labelKey: string
  icon: typeof InformationCircleOutline
  btOnly?: boolean
}
const allTabs: TabDef[] = [
  { key: 'general', labelKey: 'task.task-tab-general', icon: InformationCircleOutline },
  { key: 'activity', labelKey: 'task.task-tab-activity', icon: PulseOutline },
  { key: 'files', labelKey: 'task.task-tab-files', icon: DocumentOutline },
  { key: 'options', labelKey: 'task.task-tab-options', icon: SettingsOutline },
  { key: 'peers', labelKey: 'task.task-tab-peers', icon: PeopleOutline, btOnly: true },
  { key: 'trackers', labelKey: 'task.task-tab-trackers', icon: ServerOutline, btOnly: true },
]

const visibleTabs = computed(() => allTabs.filter((tab) => !tab.btOnly || isBT.value))

function switchTab(key: string) {
  const oldIdx = visibleTabs.value.findIndex((t) => t.key === activeTab.value)
  const newIdx = visibleTabs.value.findIndex((t) => t.key === key)
  slideDirection.value = newIdx > oldIdx ? 'left' : 'right'
  prevTabIndex.value = newIdx
  activeTab.value = key
}

const isBT = computed(() => (props.task ? checkTaskIsBT(props.task) : false))

const prevTaskGid = ref('')
watch(
  () => props.task?.gid,
  (gid) => {
    if (gid && gid !== prevTaskGid.value) {
      activeTab.value = 'general'
      prevTaskGid.value = gid
    }
  },
)
const isSeeder = computed(() => (props.task ? checkTaskIsSeeder(props.task) : false))
const taskStatusKey = computed(() => (isSeeder.value ? TASK_STATUS.SEEDING : props.task?.status))
const taskStatus = computed(() => {
  const key = taskStatusKey.value
  const translated = t(`task.status-${key}`)
  return translated !== `task.status-${key}` ? translated : key
})
const isActive = computed(() => props.task?.status === TASK_STATUS.ACTIVE)
const taskFullName = computed(() => (props.task ? getTaskDisplayName(props.task, { defaultName: 'Unknown' }) : ''))

// ── Task date display ────────────────────────────────────────────────
const taskAddedAt = computed(() => {
  if (!props.task) return ''
  const iso = getAddedAt(props.task.gid)
  if (!iso) return ''
  return localeDateTimeFormat(new Date(iso).getTime(), locale.value)
})

const taskCompletedAt = ref('')
watch(
  () => props.task?.gid,
  async (gid) => {
    if (!gid) {
      taskCompletedAt.value = ''
      return
    }
    try {
      const record = await historyStore.getRecordByGid(gid)
      if (record?.completed_at) {
        taskCompletedAt.value = localeDateTimeFormat(new Date(record.completed_at).getTime(), locale.value)
      } else {
        taskCompletedAt.value = ''
      }
    } catch (e) {
      logger.debug('TaskDetail.completedAt', `gid=${gid} query failed: ${e}`)
      taskCompletedAt.value = ''
    }
  },
  { immediate: true },
)
const percent = computed(() => (props.task ? calcProgress(props.task.totalLength, props.task.completedLength) : 0))

const remaining = computed(() => {
  if (!isActive.value || !props.task) return 0
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

const ratio = computed(() => {
  if (!isBT.value || !props.task) return 0
  return calcRatio(Number(props.task.totalLength), Number(props.task.uploadLength))
})

const btInfo = computed(() => {
  if (!isBT.value || !props.task) return null
  return props.task.bittorrent
})

const statusTagType = computed(() => {
  switch (taskStatusKey.value) {
    case 'active':
      return 'warning'
    case 'complete':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'default'
  }
})

const fileList = computed(() =>
  (props.files || []).map((item: Aria2File) => {
    const name = decodePathSegment(getFileName(item.path))
    return {
      idx: Number(item.index),
      name,
      extension: '.' + getFileExtension(name),
      length: Number(item.length),
      completedLength: Number(item.completedLength),
      percent: calcProgress(item.length, item.completedLength, 1),
      selected: item.selected === 'true',
    }
  }),
)

const fileColumns = computed(() => {
  const data = fileList.value
  return [
    {
      title: t('task.file-index') || '#',
      key: 'idx',
      width: calcColumnWidth({
        title: t('task.file-index') || '#',
        values: data.map((r) => String(r.idx)),
        sortable: true,
      }),
      sorter: (a: { idx: number }, b: { idx: number }) => a.idx - b.idx,
    },
    { title: t('task.file-name') || 'Name', key: 'name', ellipsis: { tooltip: true } },
    {
      title: t('task.file-extension') || 'Ext',
      key: 'extension',
      width: calcColumnWidth({
        title: t('task.file-extension') || 'Ext',
        values: data.map((r) => r.extension),
      }),
    },
    {
      title: t('task.task-peer-percent'),
      key: 'percent',
      width: calcColumnWidth({
        title: t('task.task-peer-percent'),
        values: data.map((r) => String(r.percent)),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: { percent: string }, b: { percent: string }) => parseFloat(a.percent) - parseFloat(b.percent),
    },
    {
      title: t('task.file-completed'),
      key: 'completedLength',
      width: calcColumnWidth({
        title: t('task.file-completed'),
        values: data.map((r) => bytesToSize(String(r.completedLength))),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: { completedLength: number }, b: { completedLength: number }) => a.completedLength - b.completedLength,
      render: (row: { completedLength: number }) => bytesToSize(String(row.completedLength)),
    },
    {
      title: t('task.file-size') || 'Size',
      key: 'length',
      width: calcColumnWidth({
        title: t('task.file-size') || 'Size',
        values: data.map((r) => bytesToSize(String(r.length))),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: { length: number }, b: { length: number }) => a.length - b.length,
      render: (row: { length: number }) => bytesToSize(String(row.length)),
    },
  ]
})

const peers = computed(() => {
  if (!props.task || !isBT.value) return []
  const p = props.task.peers
  return (p || [])
    .map((peer: Aria2Peer) => ({
      host: `${peer.ip}:${peer.port}`,
      client: peerIdParser(peer.peerId),
      percent: peer.bitfield ? bitfieldToPercent(peer.bitfield) + '%' : '-',
      uploadSpeed: bytesToSize(peer.uploadSpeed) + '/s',
      downloadSpeed: bytesToSize(peer.downloadSpeed) + '/s',
      amChoking: peer.amChoking === 'true',
      peerChoking: peer.peerChoking === 'true',
      seeder: peer.seeder === 'true',
    }))
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((row, i) => ({ ...row, index: i + 1 }))
})

interface PeerRow {
  index: number
  host: string
  client: string
  percent: string
  uploadSpeed: string
  downloadSpeed: string
  amChoking: boolean
  peerChoking: boolean
  seeder: boolean
}

// ── GeoIP: peer country flag resolution ──────────────────────────────
const geoCache = ref<Record<string, GeoInfo>>({})

watch(
  peers,
  async (list) => {
    const uniqueIps = [...new Set(list.map((p) => p.host.split(':')[0]))]
    if (uniqueIps.length === 0) {
      geoCache.value = {}
      return
    }
    try {
      geoCache.value = await lookupPeerIps(uniqueIps, locale.value)
    } catch (e) {
      logger.debug('TaskDetail.geoip', `lookupPeerIps failed: ${e}`)
    }
  },
  { immediate: true },
)

const peerColumns = computed(() => {
  const data = peers.value
  return [
    {
      title: t('task.task-tracker-tier'),
      key: 'index',
      width: 64,
      align: 'center' as const,
      sorter: (a: PeerRow, b: PeerRow) => a.index - b.index,
      defaultSortOrder: 'ascend' as const,
      render: (row: PeerRow) => {
        const ip = row.host.split(':')[0]
        const geo = geoCache.value[ip]
        if (!geo) return String(row.index)
        const flag = countryCodeToFlag(geo.country_code)
        const label = `${geo.country_name} · ${geo.continent}`
        return h(
          NTooltip,
          { delay: 500, placement: 'right' },
          {
            trigger: () => h('span', { style: 'cursor: default' }, [String(row.index), ' ', flag]),
            default: () => label,
          },
        )
      },
    },
    { title: t('task.task-peer-host'), key: 'host', minWidth: 140 },
    {
      title: t('task.task-peer-client'),
      key: 'client',
      minWidth: 100,
      render: (row: PeerRow) => h(NEllipsis, null, { default: () => row.client }),
    },
    {
      title: t('task.task-peer-percent'),
      key: 'percent',
      width: calcColumnWidth({
        title: t('task.task-peer-percent'),
        values: data.map((r) => r.percent),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: PeerRow, b: PeerRow) => parseFloat(a.percent) - parseFloat(b.percent),
    },
    {
      title: t('task.task-peer-download-speed'),
      key: 'downloadSpeed',
      width: calcColumnWidth({
        title: t('task.task-peer-download-speed'),
        values: data.map((r) => r.downloadSpeed),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: PeerRow, b: PeerRow) => parseFloat(a.downloadSpeed) - parseFloat(b.downloadSpeed),
    },
    {
      title: t('task.task-peer-upload-speed'),
      key: 'uploadSpeed',
      width: calcColumnWidth({
        title: t('task.task-peer-upload-speed'),
        values: data.map((r) => r.uploadSpeed),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: PeerRow, b: PeerRow) => parseFloat(a.uploadSpeed) - parseFloat(b.uploadSpeed),
    },
    {
      title: t('task.task-peer-flags'),
      key: 'flags',
      width: calcColumnWidth({
        title: t('task.task-peer-flags'),
        values: ['DU', 'D', 'U', '—'],
      }),
      align: 'center' as const,
      render: (row: PeerRow) => {
        const flags: string[] = []
        if (!row.amChoking) flags.push('D')
        if (!row.peerChoking) flags.push('U')
        return flags.join('') || '—'
      },
    },
    {
      title: t('task.task-peer-seeder'),
      key: 'seeder',
      width: calcColumnWidth({
        title: t('task.task-peer-seeder'),
        values: ['✓'],
        sortable: true,
      }),
      align: 'center' as const,
      sorter: (a: PeerRow, b: PeerRow) => Number(b.seeder) - Number(a.seeder),
      render: (row: PeerRow) => (row.seeder ? '✓' : ''),
    },
  ]
})

const {
  statuses: trackerStatuses,
  probing: trackerProbing,
  probeAll: probeTrackers,
  cancelProbe: cancelTrackerProbe,
} = useTrackerProbe()

const trackerRows = computed((): TrackerRow[] => {
  if (!isBT.value || !btInfo.value) return []
  const rows = buildTrackerRows(btInfo.value.announceList)
  return rows.map((row) => ({
    ...row,
    status: trackerStatuses.value[row.url] ?? row.status,
  }))
})

/** Sort-order mapping for tracker status: lower = higher priority. */
const TRACKER_STATUS_ORDER: Record<string, number> = { online: 0, checking: 1, unknown: 2, offline: 3 }

const trackerColumns = computed(() => {
  const data = trackerRows.value
  return [
    {
      title: t('task.task-tracker-tier'),
      key: 'tier',
      width: calcColumnWidth({
        title: t('task.task-tracker-tier'),
        values: data.map((r) => String(r.tier)),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: (a: TrackerRow, b: TrackerRow) => a.tier - b.tier,
    },
    { title: 'URL', key: 'url', ellipsis: { tooltip: true } },
    {
      title: t('task.task-tracker-protocol'),
      key: 'protocol',
      width: calcColumnWidth({
        title: t('task.task-tracker-protocol'),
        values: data.map((r) => r.protocol),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: 'default' as const,
    },
    {
      title: t('task.task-tracker-status'),
      key: 'status',
      width: calcColumnWidth({
        title: t('task.task-tracker-status'),
        values: ['online', 'offline', 'checking', 'unknown'].map((s) => t(`task.task-tracker-${s}`)),
        sortable: true,
        extraWidth: 20,
      }),
      align: 'center' as const,
      sorter: (a: TrackerRow, b: TrackerRow) =>
        (TRACKER_STATUS_ORDER[a.status] ?? 2) - (TRACKER_STATUS_ORDER[b.status] ?? 2),
      render: (row: TrackerRow) =>
        h(
          NTag,
          {
            type: row.status === 'online' ? 'success' : row.status === 'offline' ? 'error' : 'default',
            size: 'small',
            round: true,
            style: 'transition: all 0.3s cubic-bezier(0.05, 0.7, 0.1, 1)',
          },
          () => t(`task.task-tracker-${row.status}`),
        ),
    },
  ]
})

function handleProbeTrackers() {
  if (trackerProbing.value) {
    cancelTrackerProbe()
    return
  }
  const urls = trackerRows.value.map((r) => r.url)
  probeTrackers(urls)
}

function handleClose() {
  emit('close')
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="'61.8%'"
    placement="right"
    :trap-focus="false"
    :block-scroll="false"
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NDrawerContent :title="t('task.task-detail-title') || 'Task Details'" closable @close="handleClose">
      <div class="detail-tabs">
        <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          :class="['detail-tab', { active: activeTab === tab.key }]"
          @click="switchTab(tab.key)"
        >
          <NIcon :size="16"><component :is="tab.icon" /></NIcon>
          <span class="detail-tab-label">{{ t(tab.labelKey) }}</span>
        </button>
      </div>

      <div class="tab-content-wrapper">
        <Transition :name="`tab-slide-${slideDirection}`" mode="out-in">
          <div v-if="activeTab === 'general'" key="general" class="tab-content">
            <template v-if="task">
              <NDescriptions
                :column="1"
                label-placement="left"
                bordered
                size="small"
                :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
              >
                <NDescriptionsItem :label="t('task.task-gid') || 'GID'">{{ task.gid }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-name') || 'Name'">{{ taskFullName }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-dir') || 'Directory'">{{ task.dir }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-status') || 'Status'">
                  <NTag :type="statusTagType" size="small">{{ taskStatus }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem
                  v-if="task.errorCode && task.errorCode !== '0'"
                  :label="t('task.task-error-info') || 'Error'"
                >
                  {{ task.errorCode }} {{ task.errorMessage }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="taskAddedAt" :label="t('task.task-added-at') || 'Added At'">
                  {{ taskAddedAt }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="taskCompletedAt" :label="t('task.task-completed-at') || 'Completed At'">
                  {{ taskCompletedAt }}
                </NDescriptionsItem>
              </NDescriptions>
              <template v-if="isBT && btInfo">
                <div class="section-divider">BitTorrent</div>
                <NDescriptions
                  :column="1"
                  label-placement="left"
                  bordered
                  size="small"
                  :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
                >
                  <NDescriptionsItem :label="t('task.task-info-hash') || 'Hash'">{{ task.infoHash }}</NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-piece-length') || 'Piece Size'">
                    {{ bytesToSize(String(task.pieceLength)) }}
                  </NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-num-pieces') || 'Pieces'">
                    {{ task.numPieces }}
                  </NDescriptionsItem>
                  <NDescriptionsItem
                    v-if="btInfo?.creationDate"
                    :label="t('task.task-bittorrent-creation-date') || 'Created'"
                  >
                    {{ localeDateTimeFormat(Number(btInfo.creationDate), locale) }}
                  </NDescriptionsItem>
                  <NDescriptionsItem v-if="btInfo?.comment" :label="t('task.task-bittorrent-comment') || 'Comment'">
                    {{ btInfo.comment }}
                  </NDescriptionsItem>
                </NDescriptions>
              </template>
            </template>
          </div>

          <div v-else-if="activeTab === 'activity'" key="activity" class="tab-content">
            <template v-if="task">
              <TaskGraphic v-if="task.bitfield" :bitfield="task.bitfield" />
              <NDescriptions :column="1" label-placement="left" bordered size="small">
                <NDescriptionsItem :label="t('task.task-progress-info') || 'Progress'">
                  <div class="progress-row">
                    <NProgress type="line" :percentage="percent" :height="10" :show-indicator="false" processing />
                    <span class="progress-pct">{{ percent }}%</span>
                  </div>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-file-size') || 'Size'">
                  {{ bytesToSize(task.completedLength, 2) }}
                  <span v-if="Number(task.totalLength) > 0"> / {{ bytesToSize(task.totalLength, 2) }}</span>
                  <span v-if="remainingText" class="remaining-text">{{ remainingText }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-download-speed') || 'DL Speed'">
                  {{ bytesToSize(task.downloadSpeed) }}/s
                </NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-upload-speed') || 'UL Speed'">
                  {{ bytesToSize(task.uploadSpeed) }}/s
                </NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-upload-length') || 'Uploaded'">
                  {{ bytesToSize(task.uploadLength) }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-ratio') || 'Ratio'">{{ ratio }}</NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-num-seeders') || 'Seeders'">
                  {{ task.numSeeders }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-connections') || 'Connections'">
                  {{ task.connections }}
                </NDescriptionsItem>
              </NDescriptions>
            </template>
          </div>

          <div v-else-if="activeTab === 'files'" key="files" class="tab-content">
            <NDataTable
              :columns="fileColumns"
              :data="fileList"
              :row-key="(row) => row.idx"
              size="small"
              :bordered="true"
              :max-height="400"
              virtual-scroll
              striped
            />
          </div>

          <div v-else-if="activeTab === 'options'" key="options" class="tab-content">
            <div class="options-form">
              <NFormItem :label="t('task.task-user-agent') + ':'">
                <NInput
                  v-model:value="optForm.userAgent"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-user-agent-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-authorization') + ':'">
                <NInput
                  v-model:value="optForm.authorization"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-authorization-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-referer') + ':'">
                <NInput
                  v-model:value="optForm.referer"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-referer-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-cookie') + ':'">
                <NInput
                  v-model:value="optForm.cookie"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-cookie-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-proxy-label') + ':'">
                <div class="proxy-radio-group">
                  <NRadioGroup v-model:value="optForm.proxyMode" :disabled="!optCanModify" name="task-proxy-mode">
                    <NRadio value="none">{{ t('task.proxy-mode-none') }}</NRadio>
                    <NRadio v-if="optGlobalProxyAvailable" value="global">
                      {{ t('task.proxy-mode-global') }}
                    </NRadio>
                    <NRadio value="custom">{{ t('task.proxy-mode-custom') }}</NRadio>
                  </NRadioGroup>
                  <div
                    class="proxy-hint-collapse"
                    :class="{ 'proxy-hint-collapse--open': optForm.proxyMode === 'global' }"
                  >
                    <div class="proxy-hint-collapse__inner">
                      <div class="proxy-server-hint">{{ t('task.proxy-global-server') }} {{ optProxyAddress }}</div>
                    </div>
                  </div>
                  <NCollapseTransition :show="optForm.proxyMode === 'custom'">
                    <div class="custom-proxy-input">
                      <NInput
                        v-model:value="optForm.customProxy"
                        :readonly="!optCanModify"
                        :placeholder="'http://host:port'"
                      />
                      <NButton :loading="detectingProxy" :disabled="!optCanModify" size="small" @click="detectProxy">
                        <template #icon>
                          <NIcon><SearchOutline /></NIcon>
                        </template>
                        {{ t('preferences.detect-system-proxy') }}
                      </NButton>
                    </div>
                  </NCollapseTransition>
                </div>
              </NFormItem>
              <div v-if="optCanModify" class="options-apply-bar">
                <NButton
                  :type="optDirty ? 'primary' : 'default'"
                  :disabled="!optDirty"
                  :loading="optApplying"
                  class="apply-btn"
                  @click="optApplyFn"
                >
                  {{ optDirty ? t('task.apply-changes') : t('task.no-changes') }}
                </NButton>
              </div>
            </div>
          </div>

          <div v-else-if="activeTab === 'peers'" key="peers" class="tab-content">
            <NDataTable
              :columns="peerColumns"
              :data="peers"
              :row-key="(row) => row.host"
              size="small"
              :bordered="true"
              :max-height="400"
              striped
            />
          </div>

          <div v-else-if="activeTab === 'trackers'" key="trackers" class="tab-content">
            <div style="margin-bottom: 12px; height: 34px">
              <NButton
                size="medium"
                :type="trackerProbing ? 'default' : 'primary'"
                class="probe-btn"
                @click="handleProbeTrackers"
              >
                <template v-if="trackerProbing" #icon>
                  <div class="probe-spinner" />
                </template>
                {{ trackerProbing ? t('task.task-tracker-cancel-probe') : t('task.task-tracker-probe') }}
              </NButton>
            </div>
            <NDataTable
              :columns="trackerColumns"
              :data="trackerRows"
              :row-key="(row: TrackerRow) => row.url"
              size="small"
              :bordered="true"
              :max-height="400"
              striped
            />
          </div>
        </Transition>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.detail-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--panel-border, #3a3a3a);
  padding-bottom: 0;
  margin-bottom: 0;
}

.detail-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 12px;
  height: 36px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--task-action-color, #999);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.detail-tab:hover {
  color: var(--color-primary);
}

.detail-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.tab-content-wrapper {
  overflow: hidden;
  position: relative;
}

.tab-content {
  padding: 16px 0;
}

.section-divider {
  margin: 20px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary);
  letter-spacing: 0.5px;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-pct {
  white-space: nowrap;
  font-size: 12px;
  color: var(--m3-on-surface-variant);
  min-width: 45px;
  text-align: right;
}

.remaining-text {
  margin-left: 12px;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}

.detail-footer {
  display: flex;
  justify-content: center;
}

.detail-footer :deep(.task-item-actions) {
  position: static;
  width: auto;
  height: auto;
  overflow: visible;
  direction: ltr;
  text-align: center;
}

.tab-slide-left-enter-active,
.tab-slide-left-leave-active,
.tab-slide-right-enter-active,
.tab-slide-right-leave-active {
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.tab-slide-left-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.tab-slide-left-leave-to {
  opacity: 0;
  transform: translateX(-40px);
}

.tab-slide-right-enter-from {
  opacity: 0;
  transform: translateX(-40px);
}
.tab-slide-right-leave-to {
  opacity: 0;
  transform: translateX(40px);
}

/* Probe button M3 transition */
.probe-btn {
  transition:
    background-color 0.3s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.3s cubic-bezier(0.2, 0, 0, 1),
    color 0.3s cubic-bezier(0.2, 0, 0, 1);
}

/* Spinning indicator matching Naive UI's loading style */
.probe-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: m3-spin 0.8s linear infinite;
  will-change: transform;
  contain: layout style paint;
}

@keyframes m3-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Options tab ─────────────────────────────────────────────────── */
.options-form {
  padding: 4px 0;
}
.options-apply-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
}
.apply-btn {
  transition:
    background-color 0.25s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.25s cubic-bezier(0.2, 0, 0, 1),
    color 0.25s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.proxy-radio-group {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.custom-proxy-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  margin-left: 24px;
}
.custom-proxy-input .n-button {
  align-self: flex-start;
}
.proxy-hint-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.proxy-hint-collapse--open {
  grid-template-rows: 1fr;
}
.proxy-hint-collapse__inner {
  overflow: hidden;
}
.proxy-server-hint {
  font-size: var(--font-size-sm);
  color: var(--n-text-color-3, #999);
  opacity: 0.8;
  user-select: all;
  padding: 4px 0 2px;
}

/* Allow table header text to wrap instead of truncating with "…"
   when the column is too narrow for the translated label. */
:deep(.n-data-table-th__title) {
  white-space: normal;
  word-break: break-word;
}
</style>
