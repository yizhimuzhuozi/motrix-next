import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ADD_TASK_TYPE } from '@shared/constants'
import { invoke } from '@tauri-apps/api/core'
import { bytesToSize, decodeThunderLink } from '@shared/utils'

const BASE_INTERVAL = 1000
const PER_INTERVAL = 100
const MIN_INTERVAL = 500
const MAX_INTERVAL = 6000

export const useAppStore = defineStore('app', () => {
    const systemTheme = ref('light')
    const trayFocused = ref(false)
    const aboutPanelVisible = ref(false)
    const engineInfo = ref<{ version: string; enabledFeatures: string[] }>({
        version: '',
        enabledFeatures: [],
    })
    const engineOptions = ref<Record<string, unknown>>({})
    const interval = ref(BASE_INTERVAL)
    const stat = ref({
        downloadSpeed: 0,
        uploadSpeed: 0,
        numActive: 0,
        numWaiting: 0,
        numStopped: 0,
    })
    const addTaskVisible = ref(false)
    const addTaskType = ref(ADD_TASK_TYPE.URI)
    const addTaskUrl = ref('')
    const addTaskTorrents = ref<File[]>([])
    const addTaskOptions = ref<Record<string, unknown>>({})
    const droppedTorrentPaths = ref<string[]>([])
    const progress = ref(0)
    const pendingUpdate = ref<any>(null)

    function updateInterval(millisecond: number) {
        let val = millisecond
        if (val > MAX_INTERVAL) val = MAX_INTERVAL
        if (val < MIN_INTERVAL) val = MIN_INTERVAL
        if (interval.value === val) return
        interval.value = val
    }

    function increaseInterval(millisecond = 100) {
        if (interval.value < MAX_INTERVAL) interval.value += millisecond
    }

    function decreaseInterval(millisecond = 100) {
        if (interval.value > MIN_INTERVAL) interval.value -= millisecond
    }

    function resetInterval() {
        interval.value = BASE_INTERVAL
    }

    function showAddTaskDialog(taskType: string, torrentPaths?: string[]) {
        addTaskType.value = taskType
        droppedTorrentPaths.value = torrentPaths || []
        addTaskVisible.value = true
    }

    function hideAddTaskDialog() {
        addTaskVisible.value = false
        addTaskUrl.value = ''
        addTaskTorrents.value = []
        droppedTorrentPaths.value = []
    }

    function updateAddTaskOptions(options: Record<string, unknown> = {}) {
        addTaskOptions.value = { ...options }
    }

    async function fetchGlobalStat(api: { getGlobalStat: () => Promise<Record<string, string>> }) {
        try {
            const data = await api.getGlobalStat()
            const parsed: Record<string, number> = {}
            Object.keys(data).forEach((key) => {
                parsed[key] = Number(data[key])
            })

            const { numActive } = parsed
            if (numActive > 0) {
                updateInterval(BASE_INTERVAL - PER_INTERVAL * numActive)
            } else {
                parsed.downloadSpeed = 0
                increaseInterval()
            }
            stat.value = parsed as typeof stat.value

            // Update tray speed display (macOS only, Linux partial)
            try {
                const prefStore = (await import('@/stores/preference')).usePreferenceStore()
                if (prefStore.config?.traySpeedometer && (parsed.downloadSpeed > 0 || parsed.uploadSpeed > 0)) {
                    const parts: string[] = []
                    if (parsed.downloadSpeed > 0) parts.push(`↓ ${bytesToSize(parsed.downloadSpeed)}/s`)
                    if (parsed.uploadSpeed > 0) parts.push(`↑ ${bytesToSize(parsed.uploadSpeed)}/s`)
                    await invoke('update_tray_title', { title: parts.join(' ') })
                } else {
                    await invoke('update_tray_title', { title: '' })
                }
            } catch { /* tray not available */ }
        } catch (e) {
            console.warn((e as Error).message)
        }
    }

    async function fetchEngineInfo(api: { getVersion: () => Promise<{ version: string; enabledFeatures: string[] }> }) {
        const data = await api.getVersion()
        engineInfo.value = { ...engineInfo.value, ...data }
    }

    async function fetchEngineOptions(api: { getGlobalOption: () => Promise<Record<string, unknown>> }) {
        const data = await api.getGlobalOption()
        engineOptions.value = { ...engineOptions.value, ...data }
        return data
    }

    async function fetchProgress(api: { fetchActiveTaskList: () => Promise<{ totalLength: string; completedLength: string }[]> }) {
        try {
            const data = await api.fetchActiveTaskList()
            let prog = -1
            if (data.length !== 0) {
                const tasks = data.map((t) => ({
                    totalLength: Number(t.totalLength),
                    completedLength: Number(t.completedLength),
                }))
                const realTotal = tasks.reduce((total, task) => total + task.totalLength, 0)
                if (realTotal === 0) {
                    prog = 2
                } else {
                    const filtered = tasks.filter((task) => task.totalLength !== 0)
                    const completed = filtered.reduce((total, task) => total + task.completedLength, 0)
                    const total = filtered.reduce((total, task) => total + task.totalLength, 0)
                    prog = completed / total
                }
            }
            progress.value = prog
        } catch (e) {
            console.warn((e as Error).message)
        }
    }

    function handleDeepLinkUrls(urls: string[]) {
        if (!urls || urls.length === 0) return
        const url = urls[0]
        const lower = url.toLowerCase()
        if (lower.endsWith('.torrent') || lower.startsWith('file://') && lower.includes('.torrent')) {
            const filePath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
            showAddTaskDialog(ADD_TASK_TYPE.TORRENT, [filePath])
        } else if (lower.endsWith('.metalink') || lower.endsWith('.meta4') || (lower.startsWith('file://') && (lower.includes('.metalink') || lower.includes('.meta4')))) {
            const filePath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
            droppedTorrentPaths.value = [filePath]
            addTaskType.value = ADD_TASK_TYPE.URI
            addTaskUrl.value = filePath
            addTaskVisible.value = true
        } else if (lower.startsWith('magnet:')) {
            addTaskUrl.value = url
            showAddTaskDialog(ADD_TASK_TYPE.URI)
        } else if (lower.startsWith('thunder://')) {
            addTaskUrl.value = decodeThunderLink(url)
            showAddTaskDialog(ADD_TASK_TYPE.URI)
        } else if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('ftp://')) {
            addTaskUrl.value = url
            showAddTaskDialog(ADD_TASK_TYPE.URI)
        }
    }

    return {
        systemTheme,
        trayFocused,
        aboutPanelVisible,
        engineInfo,
        engineOptions,
        interval,
        stat,
        addTaskVisible,
        addTaskType,
        addTaskUrl,
        addTaskTorrents,
        addTaskOptions,
        droppedTorrentPaths,
        progress,
        pendingUpdate,
        updateInterval,
        increaseInterval,
        decreaseInterval,
        resetInterval,
        showAddTaskDialog,
        hideAddTaskDialog,
        updateAddTaskOptions,
        fetchGlobalStat,
        fetchEngineInfo,
        fetchEngineOptions,
        fetchProgress,
        handleDeepLinkUrls,
    }
})
