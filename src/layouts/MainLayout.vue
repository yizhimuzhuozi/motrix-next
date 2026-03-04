<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { ADD_TASK_TYPE } from '@shared/constants'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'
import { useTaskStore } from '@/stores/task'
import { openUrl } from '@tauri-apps/plugin-opener'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useDialog } from 'naive-ui'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const dialog = useDialog()

const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)
const appReady = ref(false)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null

onMounted(async () => {
  nextTick(() => { appReady.value = true })

  const webview = getCurrentWebview()
  unlistenDragDrop = await webview.onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      const paths = event.payload.paths
      const torrentPaths = paths?.filter((p: string) => p.endsWith('.torrent')) || []
      if (torrentPaths.length > 0) {
        appStore.showAddTaskDialog(ADD_TASK_TYPE.TORRENT, torrentPaths)
      }
    }
  })
  unlistenMenuEvent = await listen<string>('menu-event', async (event) => {
    const action = event.payload
    switch (action) {
      case 'new-task':
        appStore.showAddTaskDialog(ADD_TASK_TYPE.URI)
        break
      case 'open-torrent': {
        const selected = await openDialog({
          multiple: false,
          filters: [{ name: 'Torrent', extensions: ['torrent'] }],
        })
        if (selected) appStore.showAddTaskDialog(ADD_TASK_TYPE.TORRENT, [selected as string])
        break
      }
      case 'preferences':
        router.push('/preference').catch(() => {})
        break
      case 'resume-all':
        taskStore.resumeAllTask().catch(console.error)
        break
      case 'pause-all':
        taskStore.pauseAllTask().catch(console.error)
        break
      case 'release-notes':
        openUrl('https://github.com/AnInsomniacy/motrix-next/releases').catch(console.error)
        break
      case 'report-issue':
        openUrl('https://github.com/AnInsomniacy/motrix-next/issues').catch(console.error)
        break
    }
  })

  const appWindow = getCurrentWindow()
  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    dialog.warning({
      title: t('app.confirm-exit-title'),
      content: t('app.confirm-exit-message'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        // Simultaneously: dialog close animation (Naive UI built-in) + window body fade
        appReady.value = false
        await new Promise((r) => setTimeout(r, 400))
        await appWindow.destroy()
      },
    })
  })
})

onUnmounted(() => {
  if (unlistenDragDrop) unlistenDragDrop()
  if (unlistenMenuEvent) unlistenMenuEvent()
  if (unlistenCloseRequested) unlistenCloseRequested()
})
</script>

<template>
  <div id="container" :class="{ 'app-ready': appReady }">
    <AsideBar @show-about="showAbout = true" />
    <div class="subnav-slot">
      <Transition name="fade" mode="out-in">
        <TaskSubnav v-if="isTaskPage" key="task-subnav" />
        <PreferenceSubnav v-else-if="isPreferencePage" key="pref-subnav" />
      </Transition>
    </div>
    <main class="content">
      <router-view v-slot="{ Component, route: viewRoute }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls class="window-controls" />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask
      :show="appStore.addTaskVisible"
      :type="appStore.addTaskType"
      @close="appStore.hideAddTaskDialog()"
    />
  </div>
</template>

<style scoped>
#container {
  display: flex;
  height: 100vh;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.35s ease;
}
#container.app-ready {
  opacity: 1;
}
.subnav-slot {
  width: var(--subnav-width);
  flex-shrink: 0;
  background-color: var(--subnav-bg);
}
.content {
  flex: 1;
  overflow-y: auto;
  background-color: var(--main-bg);
}
.window-controls {
  position: fixed;
  top: 6px;
  right: 12px;
  z-index: 100;
}
</style>
