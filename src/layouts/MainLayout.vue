<script setup lang="ts">
/** @fileoverview Main application layout with sidebar, subnav, and IPC event handling. */
import { computed, h, ref, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'
import { createTaskLifecycleService } from '@/composables/useTaskLifecycleService'
import {
  buildHistoryRecord,
  buildBtCompletionRecord,
  isMetadataTask,
  updateHistoryFilePath,
} from '@/composables/useTaskLifecycle'
import { setArchivedPath, resolveTaskFilePath, requestFileRecheck } from '@/composables/useArchivedPaths'
import { handleTaskComplete, handleBtComplete, handleTaskError } from '@/composables/useTaskNotifyHandlers'
import { shouldDeleteTorrent, trashTorrentFile, cleanupTorrentMetadataFiles } from '@/composables/useDownloadCleanup'
import { cleanupAria2ControlFile } from '@/composables/useFileDelete'
import { getTaskDisplayName, resolveOpenTarget, checkTaskIsSeeder } from '@shared/utils'
import type { Aria2Task } from '@shared/types'
import { ARIA2_ERROR_CODES } from '@shared/aria2ErrorCodes'
import { TASK_STATUS } from '@shared/constants'
import { useHistoryStore } from '@/stores/history'
import {
  parseFilesForSelection,
  buildSelectFileOption,
  buildStatusAwareConfirmAction,
} from '@/composables/useMagnetFlow'
import type { MagnetFileItem } from '@/composables/useMagnetFlow'
import aria2Api from '@/api/aria2'
import { usePlatform } from '@/composables/usePlatform'
import { throttledResizeHandler, cancelPendingResize } from '@/layouts/resizeThrottle'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import EngineOverlay from '@/components/layout/EngineOverlay.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import MagnetFileSelect from '@/components/task/MagnetFileSelect.vue'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { NModal, NButton, NCheckbox, NProgress, useDialog } from 'naive-ui'

import { useAppEvents } from '@/composables/useAppEvents'
import { loadAddedAtFromRecords } from '@/composables/useTaskOrder'
import { resolveArchiveAction } from '@shared/utils/autoArchive'

interface MagnetSelectionSession {
  metadataGid: string
  downloadGid: string
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const navDialog = useDialog()
const message = useAppMessage()

const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)
const showExitDialog = ref(false)
const isExiting = ref(false)
const rememberChoice = ref(false)
const pendingTrayHide = ref(false)
const isMaximized = ref(false)
const { platform: currentPlatform, isMac } = usePlatform()
const showEngineOverlay = ref(false)

// ── Auto-shutdown countdown state ──────────────────────────────────
const showShutdownCountdown = ref(false)
const shutdownCountdown = ref(60)
let shutdownTimer: ReturnType<typeof setInterval> | null = null
let unlistenPowerCountdown: (() => void) | null = null

const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null
let unlistenDeepLink: (() => void) | null = null
let unlistenSingleInstance: (() => void) | null = null
let unlistenTrayMenu: (() => void) | null = null
let unlistenResize: (() => void) | null = null
let unlistenExitDialog: (() => void) | null = null
let unlistenStat: (() => void) | null = null
let lifecycleService: ReturnType<typeof createTaskLifecycleService> | null = null
let magnetPollTimer: ReturnType<typeof setTimeout> | null = null
let unlistenFocusRecheck: (() => void) | null = null

// ── Notification action helpers (reuse existing IPC commands) ────────

/**
 * Open the downloaded file with the system's default application.
 *
 * Reuses the same IPC commands as TaskItem's "Open File" context menu:
 *   - `resolveOpenTarget()` for smart path resolution (BT multi-file → subdir)
 *   - `check_path_exists` to guard against deleted files
 *   - `open_path_normalized` to invoke the system opener
 */
async function openFileFromNotification(task: Aria2Task) {
  const { invoke } = await import('@tauri-apps/api/core')
  const target = await resolveOpenTarget(task)
  if (!target) return
  try {
    const fileExists = await invoke<boolean>('check_path_exists', { path: target })
    if (!fileExists) {
      message.warning(t('task.file-not-exist'))
      requestFileRecheck()
      return
    }
    const isDir = await invoke<boolean>('check_path_is_dir', { path: target })
    await invoke('open_path_normalized', { path: target })
    message.success(t(isDir ? 'task.open-file-is-folder' : 'task.open-file-success'))
  } catch (e) {
    logger.warn('Notification.openFile', e instanceof Error ? e.message : String(e))
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  }
}

/**
 * Reveal the downloaded file in the system file manager.
 *
 * Reuses the same IPC commands as TaskItem's "Show in Folder" context menu:
 *   - `check_path_exists` to guard against deleted files
 *   - `show_item_in_dir` to invoke the platform-native file reveal
 */
async function showInFolderFromNotification(task: Aria2Task) {
  const { invoke } = await import('@tauri-apps/api/core')

  // Resolve correct path — archived location takes priority over aria2 original
  const filePath = resolveTaskFilePath(task)

  if (!filePath) return
  try {
    const fileExists = await invoke<boolean>('check_path_exists', { path: filePath })
    if (fileExists) {
      await invoke('show_item_in_dir', { path: filePath })
      message.success(t('task.open-folder-success'))
      return
    }
    // Fallback: file missing but BT folder or download dir may still exist
    const fallback = await resolveOpenTarget(task)
    if (fallback) {
      const fallbackExists = await invoke<boolean>('check_path_exists', { path: fallback })
      if (fallbackExists) {
        await invoke('show_item_in_dir', { path: fallback })
        message.success(t('task.open-folder-success'))
        return
      }
    }
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  } catch (e) {
    logger.warn('Notification.showInFolder', e instanceof Error ? e.message : String(e))
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  }
}

// ── Magnet file selection state (app-level) ─────────────────────────
const magnetSelectVisible = ref(false)
const magnetSelectFiles = ref<MagnetFileItem[]>([])
const magnetSelectionSession = ref<MagnetSelectionSession | null>(null)
const magnetSelectName = ref('')

const { setupListeners } = useAppEvents({
  t,
  appStore,
  taskStore,
  preferenceStore,
  message,
  navDialog,
  showEngineOverlay,
  isExiting,
  handleExitConfirm,
  onAbout: () => {
    showAbout.value = true
  },
})

// ── Config migration toast ──────────────────────────────────────────
watch(
  () => preferenceStore.migrationResult,
  (result) => {
    if (!result?.migrated) return
    const v = `v${result.targetVersion}`
    if (result.errors.length === 0) {
      message.success(t('app.migration-success', { version: v }))
    } else {
      message.warning(t('app.migration-incomplete', { version: v }))
    }
    preferenceStore.migrationResult = null
  },
  { immediate: true },
)

// ── DB schema migration toast ───────────────────────────────────────
// Uses the same reactive pattern as config migration toast above.
// loadPreference() sets dbUpgradeVersion when it detects an existing user
// whose config.json has no dbSchemaVersion field (backfilled to 1).
// Fresh installs: DEFAULT_APP_CONFIG.dbSchemaVersion = 2 → no signal fired.
watch(
  () => preferenceStore.dbUpgradeVersion,
  async (savedDbVersion) => {
    if (savedDbVersion === null) return
    try {
      const historyStore = useHistoryStore()
      const currentDbVersion = await historyStore.getSchemaVersion()
      if (savedDbVersion < currentDbVersion) {
        message.info(t('app.db-upgraded', { version: `v${currentDbVersion}` }))
        await preferenceStore.updateAndSave({ dbSchemaVersion: currentDbVersion })
      }
    } catch (e) {
      logger.debug('DbMigration.toast', e)
    }
    preferenceStore.dbUpgradeVersion = null
  },
  { immediate: true },
)

// ── Protocol association confirmation dialog ────────────────────────
// syncProtocolHandlers() in main.ts detects unregistered protocols at
// startup and posts them to appStore.pendingProtocolHijack.  This watcher
// picks them up once the Naive UI dialog provider is active.
watch(
  () => appStore.pendingProtocolHijack,
  (hijacked) => {
    if (!hijacked || hijacked.length === 0) return
    const protocolList = hijacked.join(', ')
    const rawContent = t('app.protocol-hijacked-dialog-content', { protocols: protocolList })
    navDialog.warning({
      title: t('app.protocol-hijacked-title'),
      content: () =>
        rawContent.split('\n').reduce<(string | ReturnType<typeof h>)[]>((acc, line, i) => {
          if (i > 0) acc.push(h('br'))
          if (line) acc.push(line)
          return acc
        }, []),
      positiveText: t('preferences.open-settings'),
      negativeText: t('app.dismiss'),
      onPositiveClick: () => {
        if (!route.path.startsWith('/preference')) {
          router.push('/preference/general')
        }
      },
    })
    appStore.pendingProtocolHijack = []
  },
  { deep: true, immediate: true },
)

// ── Stat listener — passive subscription to Rust stat_service events ──
// Replaces the old frontend polling loop. Rust is the sole poller of aria2;
// the frontend simply listens for `stat:update` and updates reactive state.

async function startStatListener() {
  stopStatListener()
  unlistenStat = await appStore.setupStatListener()
}

function stopStatListener() {
  unlistenStat?.()
  unlistenStat = null
}

// ── Magnet metadata monitoring (app-level) ──────────────────────────

/**
 * Poll pending magnet tasks for metadata completion.
 *
 * aria2 creates a NEW GID (via followedBy) for the actual download after
 * magnet metadata resolves. With pause-metadata=true, this follow-up task
 * starts paused. We poll the metadata GID for followedBy, then call getFiles
 * on the follow-up GID to show the file selection dialog.
 *
 * When multiple magnets are added concurrently, only one dialog is shown at
 * a time. The poll pauses while a dialog is open and resumes after the user
 * confirms or cancels — preventing dialog state from being overwritten.
 */
function startMagnetPoll() {
  if (magnetPollTimer) clearTimeout(magnetPollTimer)

  async function tick() {
    const gids = appStore.pendingMagnetGids

    // Don't overwrite an open dialog — pause polling and let
    // confirm/cancel handler restart it for remaining GIDs.
    if (magnetSelectVisible.value) {
      magnetPollTimer = null
      return
    }

    if (gids.length === 0) {
      magnetPollTimer = null
      return
    }

    for (const gid of [...gids]) {
      try {
        const task = await taskStore.fetchTaskStatus(gid)

        // Use followedBy GID if available (magnet follow-up), else same GID
        const targetGid = task.followedBy?.[0] ?? gid

        const files = await taskStore.getFiles(targetGid)
        // Filter real content files (length > 0) and skip [METADATA] entries
        const realFiles = files.filter((f) => Number(f.length) > 0 && !f.path.startsWith('[METADATA]'))
        if (realFiles.length === 0) continue

        // Metadata resolved — show file selection dialog
        appStore.pendingMagnetGids = appStore.pendingMagnetGids.filter((g) => g !== gid)
        const parsed = parseFilesForSelection(realFiles)
        magnetSelectFiles.value = parsed
        magnetSelectionSession.value = { metadataGid: gid, downloadGid: targetGid }
        magnetSelectName.value = task.bittorrent?.info?.name || parsed[0]?.name || t('task.magnet-task')
        magnetSelectVisible.value = true
        return // Process one magnet at a time
      } catch (e) {
        logger.debug('MainLayout.magnetPoll', `gid=${gid} metadata query skipped: ${e}`)
      }
    }

    magnetPollTimer = setTimeout(tick, 2000)
  }

  void tick()
}

async function handleMagnetConfirm(selectedIndices: number[]) {
  magnetSelectVisible.value = false
  const gid = magnetSelectionSession.value?.downloadGid
  if (!gid) return

  try {
    const selectFile = buildSelectFileOption(selectedIndices)
    const task = await taskStore.fetchTaskStatus(gid)
    const action = buildStatusAwareConfirmAction(task.status)

    // aria2 requires task to be paused before changing select-file on active tasks
    if (action.needsPause) {
      await taskStore.pauseTask(task)
    }

    await taskStore.changeTaskOption({ gid, options: { 'select-file': selectFile } })

    if (action.needsResume) {
      await taskStore.resumeTask(task)
    }
    message.success(t('task.magnet-files-selected') || 'Files selected, download starting')
  } catch (e) {
    logger.error('MainLayout.magnetConfirm', e)
    message.error(t('task.magnet-select-fail') || 'Failed to configure download')
  } finally {
    magnetSelectionSession.value = null
    magnetSelectFiles.value = []
    magnetSelectName.value = ''
  }

  // Resume polling for any remaining pending magnet GIDs.
  // Delay to let the modal close animation finish before showing the next dialog.
  if (appStore.pendingMagnetGids.length > 0) {
    setTimeout(startMagnetPoll, 350)
  }
}

async function handleMagnetCancel() {
  magnetSelectVisible.value = false
  const session = magnetSelectionSession.value
  magnetSelectionSession.value = null
  magnetSelectFiles.value = []
  magnetSelectName.value = ''
  if (!session) return

  try {
    await taskStore.cancelMagnetSelectionDownload(session)
  } catch (e) {
    // Task may already be removed — log at debug level for diagnostics
    logger.debug('MainLayout.magnetCancel', e)
  }
  message.info(t('task.magnet-download-cancelled') || 'Download cancelled')

  // Resume polling for any remaining pending magnet GIDs.
  // Delay to let the modal close animation finish before showing the next dialog.
  if (appStore.pendingMagnetGids.length > 0) {
    setTimeout(startMagnetPoll, 350)
  }
}

/**
 * Handle the maximize-toggled event from WindowControls.
 * Query isMaximized() after a delay to let the native animation settle.
 * This is safe on all platforms — the bug only triggers inside onResized.
 */
async function onMaximizeToggled() {
  setTimeout(async () => {
    const appWindow = getCurrentWindow()
    isMaximized.value = await appWindow.isMaximized()
  }, 300)
}

watch(
  () => appStore.pendingUpdate,
  (update) => {
    if (update) {
      nextTick(() => updateDialogRef.value?.open())
      appStore.pendingUpdate = null
    }
  },
)

async function handleExitConfirm() {
  // Checkbox means "always minimize to tray from now on" —
  // save the setting even when quitting this time.
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  isExiting.value = true
  showExitDialog.value = false
  rememberChoice.value = false

  // ── Clear completed download records on exit (#134) ──────────
  // Runs while the webview JS context is still fully functional.
  // Only removes 'complete' status tasks; error and removed records
  // are preserved for diagnostics.
  if (preferenceStore.config.clearCompletedOnExit) {
    try {
      const completedTasks = taskStore.taskList.filter((t) => t.status === TASK_STATUS.COMPLETE)
      for (const task of completedTasks) {
        await taskStore.removeTaskRecord(task)
      }
    } catch (e: unknown) {
      logger.warn('MainLayout.exitCleanup', e instanceof Error ? e.message : String(e))
    }
  }

  // Hide the window and let the OS play its native close animation
  // (DWM fade on Windows, AppKit transition on macOS, compositor
  // effect on Linux).  No custom CSS or alpha animation needed.
  const appWindow = getCurrentWindow()
  await appWindow.hide()

  // exit(0) sends an IPC call to Rust — if we destroy() first,
  // the webview is gone and the IPC silently fails.
  // Session cleanup (purge completed tasks + save) is handled by the
  // Rust RunEvent::Exit handler — single entry point for all exit paths.
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

async function handleMinimizeToTray() {
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  // Defer window hide until NModal exit animation completes.
  // If we hide immediately, the GPU compositor caches the frame with
  // the dialog still visible, causing a flash when the window re-shows.
  pendingTrayHide.value = true
  showExitDialog.value = false
  rememberChoice.value = false
}

async function onExitDialogAfterLeave() {
  if (pendingTrayHide.value) {
    pendingTrayHide.value = false
    const appWindow = getCurrentWindow()

    // Signal Rust to hide the Dock icon if the user opted in.
    // The Rust command reads the preference from the persistent store.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_dock_visible', { visible: false })

    await appWindow.hide()
  }
}

function handleExitCancel() {
  showExitDialog.value = false
  rememberChoice.value = false
}

// ── Auto-shutdown countdown ─────────────────────────────────────────

function startShutdownCountdown() {
  if (showShutdownCountdown.value) return
  shutdownCountdown.value = 60
  showShutdownCountdown.value = true

  // Bring window to front so the user sees the countdown
  const countdownWindow = getCurrentWindow()
  countdownWindow.unminimize().catch(() => {})
  countdownWindow.show().catch(() => {})
  countdownWindow.setFocus().catch(() => {})

  shutdownTimer = setInterval(async () => {
    shutdownCountdown.value--
    if (shutdownCountdown.value <= 0) {
      dismissCountdown()
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('system_shutdown')
      } catch (e) {
        logger.error('Power.shutdown', e instanceof Error ? e.message : String(e))
        message.error(t('app.shutdown-failed'))
      }
    }
  }, 1000)
}

/** Shared countdown teardown — stops timer and hides dialog. */
function dismissCountdown() {
  showShutdownCountdown.value = false
  if (shutdownTimer) {
    clearInterval(shutdownTimer)
    shutdownTimer = null
  }
  // Signal Rust safety-net to skip this shutdown cycle.
  import('@tauri-apps/api/core').then(({ invoke }) =>
    invoke('cancel_shutdown').catch((e: unknown) => logger.debug('Power.cancel', String(e))),
  )
}

/** "Disable Auto-Shutdown" button — turns off the preference permanently. */
function disableShutdownAndCancel() {
  dismissCountdown()
  preferenceStore.updateAndSave({ shutdownWhenComplete: false })
}

/** "Skip This Time" button — cancels only the current countdown. */
function skipShutdownOnce() {
  dismissCountdown()
}

/**
 * Event-driven shutdown condition check.
 *
 * Called from lifecycle callbacks (onTaskComplete / onBtComplete) instead
 * of a stat watcher. Queries aria2 directly for real-time task state,
 * bypassing the stale taskStore.taskList and the unreliable
 * appStore.stat.numActive (which counts seeders as active).
 */
async function checkShutdownCondition() {
  if (!preferenceStore.config.shutdownWhenComplete) return
  if (showShutdownCountdown.value) return

  try {
    const activeTasks = await aria2Api.fetchTaskList({ type: 'active' })
    const activeNonSeeders = activeTasks.filter((t) => !checkTaskIsSeeder(t))
    if (activeNonSeeders.length > 0) return

    const waitingTasks = await aria2Api.fetchTaskList({ type: 'waiting' })
    if (waitingTasks.length > 0) return

    startShutdownCountdown()
  } catch (e) {
    logger.debug('Power.checkCondition', e instanceof Error ? e.message : String(e))
  }
}

onMounted(async () => {
  // Platform is initialised by usePlatform() singleton — no per-component call needed.

  // Show the main window now that the frontend has mounted and the
  // webview has renderable content.  This prevents the transparent-frame
  // flash on Windows where DWM renders a native shadow before WebView2
  // finishes initializing.  Follows Tauri official recommendation:
  // visible:false in config → show() from frontend when content is ready.
  //
  // Skip show when the app was launched by OS autostart AND the user has
  // opted into "minimize to tray on autostart" — the window stays hidden.
  //
  // Architecture (two-layer defense-in-depth):
  //   1. PRIMARY: Rust setup_app() force-hides the window synchronously
  //      before the frontend mounts (see lib.rs autostart silent-mode guard).
  //   2. SECONDARY: This frontend check acts as a safety net.  If the
  //      --autostart flag was lost (auto-launch crate #771) or if a
  //      window-state plugin update re-introduces VISIBLE restoration,
  //      this code detects and corrects the state.
  //
  // NOTE: The Rust backend logs the same detection at INFO level in
  // setup_app().  Both logs together provide a full diagnostic trace for
  // autostart bugs (e.g. --autostart flag missing on Windows cold boot).

  {
    const { invoke } = await import('@tauri-apps/api/core')
    const isAutostart: boolean = await invoke('is_autostart_launch')
    // Read autoHideWindow directly from the Tauri persistent store
    // instead of the Pinia reactive state.  The Pinia store initialises
    // with DEFAULT_APP_CONFIG (autoHideWindow: false) and is hydrated
    // asynchronously by loadPreference() in main.ts.  Because
    // loadPreference() uses a non-blocking .then(), Vue components can
    // mount before hydration completes, causing this code to read the
    // stale default value and incorrectly call show() — undoing the
    // Rust-layer force-hide.  Reading via Tauri Store IPC matches
    // exactly what the Rust setup() guard does, guaranteeing both
    // layers see the same persisted value.
    const { load } = await import('@tauri-apps/plugin-store')
    const tauriStore = await load('config.json')
    const prefs = await tauriStore.get<Record<string, unknown>>('preferences')
    const autoHide = !!(prefs?.autoHideWindow ?? false)
    const shouldHide = isAutostart && autoHide
    logger.info(
      'MainLayout.windowVisibility',
      `autostart=${isAutostart} autoHide=${autoHide} → shouldHide=${shouldHide}`,
    )
    if (!shouldHide) {
      const appWindow = getCurrentWindow()
      await appWindow.show()
      await appWindow.setFocus()
    } else {
      // Defense-in-depth: if the window is somehow visible despite the
      // Rust-layer guard (e.g. --autostart flag lost, window-state race),
      // force-hide it now.  Log a warning so the root cause can be
      // investigated from user-submitted logs.
      const appWindow = getCurrentWindow()
      const visible = await appWindow.isVisible()
      if (visible) {
        logger.warn(
          'MainLayout.windowVisibility',
          'window unexpectedly visible during autostart silent mode — forcing hide',
        )
        await appWindow.hide()
      }
    }
  }

  startStatListener()

  // ── Auto-shutdown event from Rust monitor (lightweight mode fallback) ──
  unlistenPowerCountdown = await listen('power:countdown', () => {
    startShutdownCountdown()
  })

  // ── App-level task lifecycle service ─────────────────────────────
  // Polls aria2 for active + stopped tasks independently of route/tab
  // state, ensuring completion/error/BT-seeding detection works even
  // when the user is on Settings or About pages.
  const historyStore = useHistoryStore()

  // ── Pre-populate task birth timestamps from DB ──────────────────
  // Ensures position-stable ordering survives app restarts.
  try {
    const birthRecords = await historyStore.loadBirthRecords()
    loadAddedAtFromRecords(birthRecords)
    // Also load from download_history.added_at for completed tasks
    // whose task_birth entry may have been cleaned up.
    const historyRecords = await historyStore.getRecords()
    loadAddedAtFromRecords(historyRecords)
  } catch (e) {
    logger.debug('TaskOrder.loadBirthRecords', e)
  }

  lifecycleService = createTaskLifecycleService(aria2Api, {
    onTaskError: (task) => {
      if (isMetadataTask(task)) return
      const record = buildHistoryRecord(task)
      historyStore.addRecord(record).catch((e) => logger.debug('Lifecycle.historyRecord.error', e))
      const i18nKey = task.errorCode ? ARIA2_ERROR_CODES[task.errorCode] : undefined
      const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
      const errorText = i18nKey ? t(i18nKey) : task.errorMessage || t('task.error-unknown')
      message.error(`${taskName}: ${errorText}`)
      handleTaskError(task, `${taskName}: ${errorText}`)
    },
    onTaskComplete: async (task) => {
      if (isMetadataTask(task)) return
      const record = buildHistoryRecord(task)
      // BT tasks: clean up stale DB records from previous sessions where
      // aria2 assigned a different GID to the same torrent (infoHash is stable).
      if (task.infoHash) {
        historyStore.removeByInfoHash(task.infoHash, task.gid).catch((e) => logger.debug('Lifecycle.cleanStale', e))
      }
      historyStore.addRecord(record).catch((e) => logger.debug('Lifecycle.historyRecord', e))
      handleTaskComplete(task, {
        messageSuccess: message.success,
        t,
        onOpenFile: openFileFromNotification,
        onShowInFolder: showInFolderFromNotification,
      })

      // ── Auto-archive: move file to category directory if applicable ──
      logger.debug(
        'AutoArchive.input',
        `gid=${task.gid} enabled=${preferenceStore.config.fileCategoryEnabled} ` +
          `categories=${preferenceStore.config.fileCategories?.length ?? 0} ` +
          `baseDir=${preferenceStore.config.dir}`,
      )
      const archiveAction = resolveArchiveAction(
        task,
        preferenceStore.config.fileCategoryEnabled,
        preferenceStore.config.fileCategories,
        preferenceStore.config.dir,
      )
      if (archiveAction) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const newPath = await invoke<string>('move_file', {
            source: archiveAction.source,
            targetDir: archiveAction.targetDir,
          })
          logger.info('AutoArchive.moved', `${archiveAction.source} → ${newPath}`)

          // Persist the new path so all consumers resolve to the archived location.
          // Runtime Map — effective immediately for this session.
          setArchivedPath(task.gid, newPath)
          // History DB — effective after app restart (meta.files path update).
          updateHistoryFilePath(historyStore, task.gid, archiveAction.source, newPath).catch((e) =>
            logger.debug('AutoArchive.historyUpdate', e),
          )
        } catch (e) {
          // Archive failure is non-critical — file remains at download location
          logger.warn('AutoArchive.failed', e instanceof Error ? e.message : String(e))
        }
      } else {
        logger.debug('AutoArchive.result', `gid=${task.gid} action=none`)
      }

      // Clean up .aria2 control file for BT tasks that auto-completed seeding
      // (seed-ratio or seed-time threshold reached). Best-effort, never throws.
      if (task.bittorrent) {
        cleanupAria2ControlFile(task).catch((e) => logger.debug('Lifecycle.aria2ControlCleanup', e))
        // Also clean hex40 .torrent/.meta4 metadata. Covers session-restore case
        // where onBtComplete was suppressed by initialScanDone — the metadata
        // wasn't deleted at download-complete time, so we catch it here.
        if (task.dir && task.infoHash) {
          cleanupTorrentMetadataFiles(task.dir, task.infoHash).catch((e) =>
            logger.debug('Lifecycle.metadataCleanup.complete', e),
          )
        }
      }

      // ── Auto-shutdown: check after task completion ──
      checkShutdownCondition()
    },
    onBtComplete: async (task) => {
      // Persist immediately — download is complete, seeding is just uploading.
      // INSERT OR REPLACE: safe if onTaskComplete later writes the same GID.
      if (!isMetadataTask(task)) {
        // Clean up stale DB records from previous sessions (different GID, same infoHash)
        if (task.infoHash) {
          historyStore
            .removeByInfoHash(task.infoHash, task.gid)
            .catch((e) => logger.debug('Lifecycle.btComplete.cleanStale', e))
        }
        const record = buildBtCompletionRecord(task)
        historyStore.addRecord(record).catch((e) => logger.debug('Lifecycle.btComplete.history', e))
      }
      handleBtComplete(task, {
        messageSuccess: message.success,
        t,
        onOpenFile: openFileFromNotification,
        onShowInFolder: showInFolderFromNotification,
      })

      // ── Auto-shutdown: check after BT download completion ──
      // Must be BEFORE shouldDeleteTorrent early return to avoid being skipped.
      checkShutdownCondition()

      if (!shouldDeleteTorrent(preferenceStore.config)) return
      const sourcePath = task.infoHash ? taskStore.consumeTorrentSource(task.infoHash) : undefined
      if (sourcePath) {
        const ok = await trashTorrentFile(sourcePath)
        if (ok) {
          const taskName = getTaskDisplayName(task)
          message.success(t('task.torrent-trashed', { taskName }))
        }
      }
      if (task.dir && task.infoHash) {
        cleanupTorrentMetadataFiles(task.dir, task.infoHash).catch((e) => logger.debug('Lifecycle.metadataCleanup', e))
      }
    },
  })
  lifecycleService.start(() => appStore.interval)

  // ── Window-focus file-existence recheck ─────────────────────────────
  // When the user switches back from Finder / Explorer after deleting a
  // file, the focus event bumps recheckTrigger so visible TaskItems
  // re-run check_path_exists.  Zero polling overhead.
  unlistenFocusRecheck = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) requestFileRecheck()
  })

  // ── Magnet metadata monitoring (app-level) ────────────────────────
  // Watches pendingMagnetGids in app store and starts polling when
  // magnet tasks are added. Runs at MainLayout level so it works
  // even when the user navigates away from the task page.
  watch(
    () => appStore.pendingMagnetGids,
    (gids) => {
      if (gids.length > 0) startMagnetPoll()
    },
    { immediate: true },
  )

  // Track maximize state for WindowControls icon toggle (maximize ↔ restore).
  // macOS: skipped — native traffic lights handle this; isMaximized() inside
  // onResized triggers an infinite loop (tauri-apps/tauri#5812).
  if (!isMac.value) {
    const appWindow = getCurrentWindow()
    isMaximized.value = await appWindow.isMaximized()
    unlistenResize = await appWindow.onResized(() => {
      throttledResizeHandler(async () => {
        isMaximized.value = await appWindow.isMaximized()
      })
    })
  }

  // Engine-init feedback, navigation guards, IPC listeners, and crash recovery
  // are encapsulated in the useAppEvents composable.
  const listeners = await setupListeners()
  unlistenDragDrop = listeners.unlistenDragDrop
  unlistenMenuEvent = listeners.unlistenMenuEvent
  unlistenTrayMenu = listeners.unlistenTrayMenu
  unlistenDeepLink = listeners.unlistenDeepLink
  unlistenSingleInstance = listeners.unlistenSingleInstance

  const appWindow = getCurrentWindow()
  // Close prevention: both JS event.preventDefault() and Rust
  // api.prevent_close() are needed for reliable interception across
  // all close paths (native traffic light, Cmd+W, taskbar close).
  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    // With native decorations (macOS overlay), the JS handler MUST call
    // preventDefault() to prevent the native close.  The Rust on_window_event
    // handler calls api.prevent_close() as a parallel safeguard.
    event.preventDefault()
    // Rust on_window_event handles the full close flow:
    // - minimizeToTrayOnClose=true → handle_minimize_to_tray (hide or destroy)
    // - minimizeToTrayOnClose=false → emit("show-exit-dialog")
    // This JS path is a fallback for platforms where the Rust event may
    // not reliably fire (e.g. macOS traffic-light with overlay titlebar).
    if (preferenceStore.config.minimizeToTrayOnClose) return
    if (!isExiting.value) {
      rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose
      showExitDialog.value = true
    }
  })

  // Rust emits "show-exit-dialog" when the native close is intercepted
  // and minimize-to-tray is NOT enabled. This is more reliable than the
  // JS onCloseRequested listener on Linux/Wayland with decorations:false,
  // where certain close paths (taskbar close, GNOME overview ×) do not
  // trigger the webview callback.
  unlistenExitDialog = await listen('show-exit-dialog', () => {
    if (!isExiting.value) {
      showExitDialog.value = true
    }
  })

  // Sync native menu labels with current locale
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('update_tray_menu_labels', {
      labels: {
        show: t('app.show'),
        'tray-new-task': t('app.tray-new-task'),
        'tray-resume-all': t('app.tray-resume-all'),
        'tray-pause-all': t('app.tray-pause-all'),
        'tray-quit': t('app.quit'),
      },
    })
    await invoke('update_menu_labels', {
      labels: {
        // Custom menu items (matched by ID)
        about: t('app.menu-about'),
        'new-task': t('app.menu-new-task'),
        'open-torrent': t('app.menu-open-torrent'),
        preferences: t('app.menu-preferences'),
        'release-notes': t('app.menu-release-notes'),
        'report-issue': t('app.menu-report-issue'),
        'minimize-window': t('app.menu-minimize'),
        'zoom-window': t('app.menu-zoom'),
        'close-window': t('app.menu-close-window'),
        // Submenu titles (matched by ID)
        'file-menu': t('app.menu-file'),
        'edit-menu': t('app.menu-edit'),
        'window-menu': t('app.menu-window'),
        'help-menu': t('app.menu-help'),
        // PredefinedMenuItems — keyed by English default text because
        // their IDs are auto-generated UUIDs that cannot be predicted.
        Undo: t('app.menu-undo'),
        Redo: t('app.menu-redo'),
        Cut: t('app.menu-cut'),
        Copy: t('app.menu-copy'),
        Paste: t('app.menu-paste'),
        'Select All': t('app.menu-select-all'),
        'Hide MotrixNext': t('app.hide'),
        'Hide Others': t('app.hide-others'),
        'Show All': t('app.unhide'),
        'Quit MotrixNext': t('app.quit'),
      },
    })
  } catch (e) {
    logger.debug('MainLayout.trayMenu', e)
  }
})

onUnmounted(() => {
  stopStatListener()
  lifecycleService?.stop()
  if (unlistenFocusRecheck) unlistenFocusRecheck()
  if (magnetPollTimer) {
    clearTimeout(magnetPollTimer)
    magnetPollTimer = null
  }
  if (unlistenDragDrop) unlistenDragDrop()
  if (unlistenMenuEvent) unlistenMenuEvent()
  if (unlistenCloseRequested) unlistenCloseRequested()
  if (unlistenDeepLink) unlistenDeepLink()
  if (unlistenSingleInstance) unlistenSingleInstance()
  if (unlistenTrayMenu) unlistenTrayMenu()
  if (unlistenResize) unlistenResize()
  if (unlistenExitDialog) unlistenExitDialog()
  if (unlistenPowerCountdown) unlistenPowerCountdown()
  dismissCountdown()
  cancelPendingResize()
})
</script>

<template>
  <div id="container" :class="{ 'native-frame': isMac }">
    <!-- Minimal progress bar during engine initialization / restart -->
    <Transition name="engine-slide">
      <div v-if="appStore.engineRestarting" class="engine-banner">
        <div class="engine-progress" />
      </div>
    </Transition>
    <AsideBar @show-about="showAbout = true" />
    <div class="subnav-slot">
      <Transition name="fade" mode="out-in">
        <TaskSubnav v-if="isTaskPage" key="task-subnav" />
        <PreferenceSubnav v-else-if="isPreferencePage" key="pref-subnav" />
      </Transition>
    </div>
    <main class="content">
      <router-view v-slot="{ Component, route: viewRoute }">
        <Transition name="fade" mode="out-in" appear>
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls
      class="window-controls"
      :is-maximized="isMaximized"
      :platform="currentPlatform"
      @close="showExitDialog = true"
      @maximize-toggled="onMaximizeToggled"
    />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask :show="appStore.addTaskVisible" @close="appStore.hideAddTaskDialog()" />
    <UpdateDialog ref="updateDialogRef" />
    <EngineOverlay
      :show="showEngineOverlay"
      @recovered="showEngineOverlay = false"
      @close="showEngineOverlay = false"
    />
    <MagnetFileSelect
      :show="magnetSelectVisible"
      :files="magnetSelectFiles"
      :task-name="magnetSelectName"
      @confirm="handleMagnetConfirm"
      @cancel="handleMagnetCancel"
    />

    <!-- Close action dialog: minimize-to-tray / quit / cancel -->
    <NModal
      :show="showExitDialog"
      preset="dialog"
      type="warning"
      :title="t('app.close-action-title')"
      :closable="true"
      :mask-closable="true"
      style="width: 480px"
      transform-origin="center"
      @after-leave="onExitDialogAfterLeave"
      @update:show="
        (v: boolean) => {
          if (!v) handleExitCancel()
        }
      "
    >
      <span>{{ t('app.close-action-message') }}</span>
      <div class="remember-choice">
        <NCheckbox v-model:checked="rememberChoice">
          {{ t('app.remember-close-choice') }}
        </NCheckbox>
      </div>
      <template #action>
        <NButton class="exit-btn" @click="handleExitCancel">
          {{ t('app.cancel') }}
        </NButton>
        <NButton class="exit-btn" @click="handleMinimizeToTray">
          {{ t('app.minimize-to-tray') }}
        </NButton>
        <NButton class="exit-btn" type="primary" @click="handleExitConfirm">
          {{ t('app.quit-app') }}
        </NButton>
      </template>
    </NModal>

    <NModal
      :show="showShutdownCountdown"
      preset="dialog"
      type="warning"
      :title="t('app.shutdown-countdown-title')"
      :closable="false"
      :mask-closable="false"
      style="width: 480px"
      transform-origin="center"
      :positive-text="t('app.shutdown-skip-once')"
      :negative-text="t('app.shutdown-disable')"
      @positive-click="skipShutdownOnce"
      @negative-click="disableShutdownAndCancel"
    >
      <span>{{ t('app.shutdown-countdown-message', { seconds: shutdownCountdown }) }}</span>
      <NProgress
        type="line"
        :percentage="(shutdownCountdown / 60) * 100"
        :show-indicator="false"
        style="margin-top: 12px"
      />
    </NModal>
  </div>
</template>

<style scoped>
#container {
  display: flex;
  height: 100vh;
  position: relative;
  overflow: hidden;
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
  z-index: 100;
}

.exit-btn {
  min-width: 88px;
  padding: 0 20px;
}
.remember-choice {
  margin-top: 16px;
  margin-bottom: 8px;
  display: flex;
  justify-content: flex-start;
  font-size: 13px;
  opacity: 0.85;
}

/* Minimal progress bar during engine initialization / restart */
.engine-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 200;
  overflow: hidden;
  pointer-events: none;
}
.engine-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 30%;
  background: linear-gradient(90deg, transparent, var(--color-primary), transparent);
  animation: engine-indeterminate 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  will-change: transform;
  contain: layout style paint;
}
@keyframes engine-indeterminate {
  0% {
    left: -30%;
  }
  100% {
    left: 100%;
  }
}
.engine-slide-enter-active {
  transition:
    transform 0.25s cubic-bezier(0, 0, 0, 1),
    opacity 0.2s linear;
}
.engine-slide-leave-active {
  transition:
    transform 0.2s cubic-bezier(0.3, 0, 1, 1),
    opacity 0.15s linear;
}
.engine-slide-enter-from,
.engine-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
