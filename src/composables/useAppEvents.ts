/**
 * @fileoverview Composable encapsulating IPC event listeners for MainLayout.
 *
 * Extracted from MainLayout.vue to reduce component script size.
 * Contains handlers for: menu-event, tray-menu-action, deep-link-open,
 * single-instance-triggered, engine-crashed, engine-stopped, and drag-drop.
 */
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useRouter, useRoute } from 'vue-router'
import { logger } from '@shared/logger'
import { setEngineReady, isEngineReady } from '@/api/aria2'
import { detectKind, createBatchItem } from '@shared/utils/batchHelpers'
import { onUnmounted, watch, type Ref, type WatchStopHandle } from 'vue'

interface AppEventsDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  appStore: {
    showAddTaskDialog: () => void
    enqueueBatch: (items: ReturnType<typeof createBatchItem>[]) => number
    handleDeepLinkUrls: (urls: string[]) => void
    engineReady: boolean
    engineRestarting: boolean
  }
  taskStore: {
    taskList: unknown[]
    selectedGidList: string[]
    hasPausedTasks: () => Promise<boolean>
    hasActiveTasks: () => Promise<boolean>
    resumeAllTask: () => Promise<unknown>
    pauseAllTask: () => Promise<unknown>
    fetchList: () => Promise<unknown>
  }
  preferenceStore: {
    pendingChanges: boolean
    saveBeforeLeave: (() => Promise<void>) | null
    config: {
      rpcListenPort?: string | number
      rpcSecret?: string
    }
  }
  message: {
    success: (msg: string) => void
    error: (msg: string, opts?: Record<string, unknown>) => void
    warning: (msg: string) => void
    info: (msg: string, opts?: Record<string, unknown>) => void
  }
  navDialog: ReturnType<typeof import('naive-ui').useDialog>
  showEngineOverlay: Ref<boolean>
  isExiting: Ref<boolean>
  handleExitConfirm: () => Promise<void>
  onAbout: () => void
}

interface AppEventsReturn {
  setupListeners: () => Promise<{
    unlistenDragDrop: (() => void) | null
    unlistenMenuEvent: (() => void) | null
    unlistenTrayMenu: (() => void) | null
    unlistenDeepLink: (() => void) | null
    unlistenSingleInstance: (() => void) | null
    teardown: () => void
  }>
}

export function useAppEvents(deps: AppEventsDeps): AppEventsReturn {
  const {
    t,
    appStore,
    taskStore,
    preferenceStore,
    message,
    navDialog,
    showEngineOverlay,
    isExiting,
    handleExitConfirm,
  } = deps

  const router = useRouter()
  const route = useRoute()
  const cleanupFns: Array<() => void> = []

  function registerCleanup(cleanup: (() => void) | null | undefined): () => void {
    let active = true
    const once = () => {
      if (!active || !cleanup) return
      active = false
      cleanup()
    }
    cleanupFns.push(once)
    return once
  }

  function teardown() {
    const pending = cleanupFns.splice(0)
    for (const cleanup of pending.reverse()) {
      cleanup()
    }
  }

  onUnmounted(teardown)

  // ─── Engine lifecycle watchers ────────────────────────────────────
  async function setupEngineWatchers() {
    const unlistenEngineCrashed = registerCleanup(
      await listen<{ code: number; signal?: number }>('engine-crashed', (event) => {
        if (isExiting.value) return
        const { code } = event.payload
        logger.error('MainLayout', `engine crashed with code ${code}`)
        appStore.engineReady = false
        setEngineReady(false)
        showEngineOverlay.value = true
      }),
    )

    const stopEngineWatch: WatchStopHandle = watch(
      () => appStore.engineRestarting,
      (initializing) => {
        if (!initializing) {
          if (appStore.engineReady) {
            message.success(t('app.engine-ready'))
          } else {
            message.error(t('app.engine-failed'), { closable: true })
            showEngineOverlay.value = true
          }
        }
      },
    )
    const unwatchEngineState = registerCleanup(stopEngineWatch)

    const unlistenEngineRecovered = registerCleanup(
      await listen<{ source: string }>('engine-recovered', async (event) => {
        logger.info('MainLayout', `engine recovered (source: ${event.payload.source})`)

        // Rust-side health check with retries — also updates Aria2Client credentials.
        // on_engine_ready() was already called by restart_engine_command before
        // this event is emitted, so credentials and options are synced.
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const ready = await invoke<boolean>('wait_for_engine')
          if (ready) {
            setEngineReady(true)
            appStore.engineReady = true
            message.success(t('app.engine-recovered'))
          } else {
            logger.error('MainLayout', 'engine-recovered: wait_for_engine returned false')
            setEngineReady(false)
            appStore.engineReady = false
          }
        } catch (e) {
          logger.error('MainLayout', `engine-recovered: wait_for_engine failed: ${e}`)
          setEngineReady(false)
          appStore.engineReady = false
        }
      }),
    )

    const unlistenEngineStopped = registerCleanup(
      await listen('engine-stopped', () => {
        message.warning(t('app.engine-stopped'))
      }),
    )

    const unlistenHttpApiFailed = registerCleanup(
      await listen<number>('http-api-bind-failed', (event) => {
        message.error(t('preferences.extension-api-port-failed', { port: event.payload }))
      }),
    )

    return {
      unlistenEngineCrashed,
      unwatchEngineState,
      unlistenEngineRecovered,
      unlistenEngineStopped,
      unlistenHttpApiFailed,
    }
  }

  // ─── Navigation guard ─────────────────────────────────────────────
  function setupNavGuard() {
    return registerCleanup(
      router.beforeEach((to, from) => {
        if (from.name === 'task' && to.name === 'task' && from.params.status !== to.params.status) {
          taskStore.taskList = []
          taskStore.selectedGidList = []
        }

        const leavingPrefs = from.path.startsWith('/preference') && !to.path.startsWith('/preference')
        const switchingPrefsTab =
          from.path.startsWith('/preference') && to.path.startsWith('/preference') && from.path !== to.path
        if ((leavingPrefs || switchingPrefsTab) && preferenceStore.pendingChanges) {
          return new Promise<boolean>((resolve) => {
            navDialog.warning({
              title: t('preferences.not-saved'),
              content: t('preferences.not-saved-confirm'),
              positiveText: t('preferences.save-and-leave'),
              negativeText: t('preferences.leave-without-saving'),
              onPositiveClick: async () => {
                try {
                  if (preferenceStore.saveBeforeLeave) {
                    await preferenceStore.saveBeforeLeave()
                  }
                  preferenceStore.pendingChanges = false
                  resolve(true)
                } catch (e) {
                  logger.error('NavGuard', e)
                  resolve(false)
                }
              },
              onNegativeClick: () => {
                preferenceStore.pendingChanges = false
                resolve(true)
              },
              onClose: () => {
                resolve(false)
              },
              onMaskClick: () => {
                resolve(false)
              },
            })
          })
        }
        return true
      }),
    )
  }

  // ─── Native menu events (macOS menu bar) ──────────────────────────
  async function setupMenuListener() {
    return registerCleanup(
      await listen<string>('menu-event', async (event) => {
        const action = event.payload
        switch (action) {
          case 'about':
            deps.onAbout()
            break
          case 'new-task':
            await getCurrentWindow().unminimize()
            await getCurrentWindow().show()
            await getCurrentWindow().setFocus()
            appStore.showAddTaskDialog()
            break
          case 'open-torrent': {
            const selected = await openDialog({
              multiple: true,
              filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }],
            })
            if (typeof selected === 'string') {
              const skipped = appStore.enqueueBatch([createBatchItem(detectKind(selected), selected)])
              if (skipped > 0) message.warning(t('task.duplicate-task'))
            } else if (Array.isArray(selected) && selected.length > 0) {
              const skipped = appStore.enqueueBatch(selected.map((p) => createBatchItem(detectKind(p), p)))
              if (skipped > 0) message.warning(t('task.duplicate-task'))
            }
            break
          }
          case 'preferences':
            router.push('/preference').catch(() => {
              /* duplicate navigation */
            })
            break
          case 'resume-all':
            if (!(await taskStore.hasPausedTasks())) break
            taskStore.resumeAllTask().catch((e) => logger.error('TrayMenu', e))
            break
          case 'pause-all':
            if (!(await taskStore.hasActiveTasks())) break
            taskStore.pauseAllTask().catch((e) => logger.error('TrayMenu', e))
            break
          case 'release-notes':
            openUrl('https://github.com/AnInsomniacy/motrix-next/releases').catch((e) => logger.error('TrayMenu', e))
            break
          case 'report-issue':
            openUrl('https://github.com/AnInsomniacy/motrix-next/issues').catch((e) => logger.error('TrayMenu', e))
            break
        }
      }),
    )
  }

  // ─── Tray menu actions (system-tray right-click menu) ──────────────
  async function setupTrayListener() {
    return registerCleanup(
      await listen<string>('tray-menu-action', async (event) => {
        const action = event.payload
        const mainWindow = getCurrentWindow()
        switch (action) {
          case 'show':
            await mainWindow.unminimize()
            await mainWindow.show()
            await mainWindow.setFocus()
            break
          case 'new-task':
            await mainWindow.unminimize()
            await mainWindow.show()
            await mainWindow.setFocus()
            appStore.showAddTaskDialog()
            break
          case 'resume-all':
            await mainWindow.unminimize()
            await mainWindow.show()
            await mainWindow.setFocus()
            if (!(await taskStore.hasPausedTasks())) {
              message.info(t('task.no-paused-tasks'))
              break
            }
            if (!isEngineReady()) {
              message.warning(t('app.engine-not-ready'))
            } else {
              navDialog.warning({
                title: t('task.resume-all-task'),
                content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
                positiveText: t('app.yes'),
                negativeText: t('app.no'),
                onPositiveClick: () => {
                  taskStore
                    .resumeAllTask()
                    .then(() => message.success(t('task.resume-all-task-success')))
                    .catch(() => message.error(t('task.resume-all-task-fail')))
                },
              })
            }
            break
          case 'pause-all':
            await mainWindow.unminimize()
            await mainWindow.show()
            await mainWindow.setFocus()
            if (!(await taskStore.hasActiveTasks())) {
              message.info(t('task.no-active-tasks'))
              break
            }
            if (!isEngineReady()) {
              message.warning(t('app.engine-not-ready'))
            } else {
              const d = navDialog.warning({
                title: t('task.pause-all-task'),
                content: t('task.pause-all-task-confirm') || 'Pause all tasks?',
                positiveText: t('app.yes'),
                negativeText: t('app.no'),
                onPositiveClick: () => {
                  d.loading = true
                  d.negativeButtonProps = { disabled: true }
                  d.closable = false
                  d.maskClosable = false
                  taskStore
                    .pauseAllTask()
                    .then(async () => {
                      await new Promise((r) => setTimeout(r, 500))
                      await taskStore.fetchList()
                      message.success(t('task.pause-all-task-success'))
                      d.destroy()
                    })
                    .catch(() => {
                      message.error(t('task.pause-all-task-fail'))
                      d.destroy()
                    })
                  return false
                },
              })
            }
            break
          case 'quit':
            await handleExitConfirm()
            break
        }
      }),
    )
  }

  // ─── Drag & drop .torrent / .metalink files ──────────────────────
  async function setupDragDropListener() {
    const webview = getCurrentWebview()
    return registerCleanup(
      await webview.onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          const paths = event.payload.paths
          const validPaths =
            paths?.filter((p: string) => p.endsWith('.torrent') || p.endsWith('.metalink') || p.endsWith('.meta4')) ||
            []
          if (validPaths.length > 0) {
            logger.info('DragDrop', `dropped ${validPaths.length} file(s): [${validPaths.join(', ')}]`)
            const items = validPaths.map((p: string) => createBatchItem(detectKind(p), p))
            const skipped = appStore.enqueueBatch(items)
            if (skipped > 0) message.warning(t('task.duplicate-task'))
          }
        }
      }),
    )
  }

  // ─── Deep-link and single-instance listeners ─────────────────────

  /**
   * Process incoming deep-link URLs: surface window, navigate to downloads
   * page if the payload contains a new-task URL, then delegate to the app
   * store's handleDeepLinkUrls for actual download routing.
   *
   * Shared by the live `deep-link-open` listener and the pending-URL
   * consumption path (lightweight mode window recreation).
   */
  async function processIncomingDeepLinks(urls: string[]) {
    logger.info('DeepLink.process', `count=${urls.length} urls=[${urls.join(', ')}]`)
    const mainWindow = getCurrentWindow()
    await mainWindow.unminimize()
    await mainWindow.show()
    await mainWindow.setFocus()

    // Navigate to the "All" downloads tab when receiving new tasks from
    // extension.  Always land on /task/all regardless of current sub-tab
    // (active, stopped, etc.) so the user sees the full task list.
    const hasNewTask = urls.some((url) => url.toLowerCase().startsWith('motrixnext://new'))
    if (hasNewTask && route.path !== '/task/all') {
      router.push('/task/all').catch(() => {})
    }

    appStore.handleDeepLinkUrls(urls)
  }

  async function setupExternalInputListeners() {
    const unlistenDeepLink = registerCleanup(
      await listen<string[]>('deep-link-open', async (event) => {
        await processIncomingDeepLinks(event.payload)
      }),
    )

    const unlistenSingleInstance = registerCleanup(
      await listen<string[]>('single-instance-triggered', async (event) => {
        const argv = event.payload
        const urls = argv.filter((a) => {
          const lower = a.toLowerCase()
          return (
            !a.startsWith('-') &&
            (lower.includes('://') ||
              lower.startsWith('magnet:') ||
              lower.endsWith('.torrent') ||
              lower.endsWith('.metalink') ||
              lower.endsWith('.meta4'))
          )
        })
        if (urls.length > 0) {
          logger.info('SingleInstance', `forwarding ${urls.length} URL(s) from second instance`)
          await processIncomingDeepLinks(urls)
        }
      }),
    )

    return { unlistenDeepLink, unlistenSingleInstance }
  }

  // ─── Orchestrator ─────────────────────────────────────────────────
  async function setupListeners() {
    teardown()

    await setupEngineWatchers()
    setupNavGuard()

    const { unlistenDeepLink, unlistenSingleInstance } = await setupExternalInputListeners()
    const unlistenDragDrop = await setupDragDropListener()
    const unlistenMenuEvent = await setupMenuListener()
    const unlistenTrayMenu = await setupTrayListener()

    // After all listeners are registered, consume any deep-link URLs
    // queued by Rust during window recreation (lightweight mode timing gap).
    // Normal startups return an empty array — this is a no-op.
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const pendingUrls = await invoke<string[]>('take_pending_deep_links')
      if (pendingUrls.length > 0) {
        logger.info('AppEvents', `consuming ${pendingUrls.length} pending deep-link(s) from window recreation`)
        await processIncomingDeepLinks(pendingUrls)
      }
    } catch (e) {
      logger.debug('AppEvents.pendingDeepLinks', e)
    }

    return { unlistenDragDrop, unlistenMenuEvent, unlistenTrayMenu, unlistenDeepLink, unlistenSingleInstance, teardown }
  }

  return { setupListeners }
}
