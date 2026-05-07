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
import { formatLogFields, logger } from '@shared/logger'
import { setEngineReady, isEngineReady } from '@/api/aria2'
import { detectKind, createBatchItem } from '@shared/utils/batchHelpers'
import { createExternalInputTraceId, summarizeExternalInputBatch } from '@shared/utils/externalInputDiagnostics'
import { isMotrixNewTaskLink } from '@shared/utils/motrixDeepLink'
import { onUnmounted, watch, type Ref, type WatchStopHandle } from 'vue'

interface DeepLinkHandlingResult {
  received: number
  queued: number
  autoSubmitted: number
  ignored: number
}

type PendingFrontendActionChannel = 'menu-event' | 'tray-menu-action'

interface PendingFrontendAction {
  channel: PendingFrontendActionChannel
  action: string
}

interface AppEventsDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  appStore: {
    showAddTaskDialog: () => void
    enqueueBatch: (items: ReturnType<typeof createBatchItem>[]) => number
    handleDeepLinkUrls: (urls: string[]) => DeepLinkHandlingResult | void
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

  async function runExternalInputWindowStage(
    traceId: string,
    stage: 'unminimize' | 'show' | 'setFocus',
    operation: () => Promise<void>,
  ) {
    try {
      await operation()
      logger.debug('ExternalInput', formatLogFields({ traceId, stage, result: 'ok' }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn('ExternalInput', formatLogFields({ traceId, stage, result: 'failed', reason }))
    }
  }

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
        await handleMenuAction(event.payload)
      }),
    )
  }

  // ─── Tray menu actions (system-tray right-click menu) ──────────────
  async function setupTrayListener() {
    return registerCleanup(
      await listen<string>('tray-menu-action', async (event) => {
        await handleTrayAction(event.payload)
      }),
    )
  }

  async function surfaceMainWindow() {
    const mainWindow = getCurrentWindow()
    await mainWindow.unminimize()
    await mainWindow.show()
    await mainWindow.setFocus()
  }

  async function handleMenuAction(action: string) {
    switch (action) {
      case 'about':
        deps.onAbout()
        break
      case 'new-task':
        await surfaceMainWindow()
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
  }

  async function handleTrayAction(action: string) {
    switch (action) {
      case 'show':
        await surfaceMainWindow()
        break
      case 'new-task':
        await surfaceMainWindow()
        appStore.showAddTaskDialog()
        break
      case 'resume-all':
        await surfaceMainWindow()
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
      case 'pause-all': {
        await surfaceMainWindow()
        if (!(await taskStore.hasActiveTasks())) {
          message.info(t('task.no-active-tasks'))
          break
        }
        if (!isEngineReady()) {
          message.warning(t('app.engine-not-ready'))
          break
        }
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
        break
      }
      case 'quit':
        await handleExitConfirm()
        break
    }
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
    const traceId = createExternalInputTraceId()
    logger.info(
      'ExternalInput',
      formatLogFields({
        traceId,
        stage: 'received',
        route: route.path,
        ...summarizeExternalInputBatch(urls),
      }),
    )
    const mainWindow = getCurrentWindow()
    await runExternalInputWindowStage(traceId, 'unminimize', () => mainWindow.unminimize())
    await runExternalInputWindowStage(traceId, 'show', () => mainWindow.show())
    await runExternalInputWindowStage(traceId, 'setFocus', () => mainWindow.setFocus())

    // Navigate to the "All" downloads tab when receiving new tasks from
    // extension.  Always land on /task/all regardless of current sub-tab
    // (active, stopped, etc.) so the user sees the full task list.
    const hasNewTask = urls.some(isMotrixNewTaskLink)
    if (hasNewTask && route.path !== '/task/all') {
      try {
        await router.push('/task/all')
        logger.debug('ExternalInput', formatLogFields({ traceId, stage: 'navigate', result: 'ok', route: '/task/all' }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn(
          'ExternalInput',
          formatLogFields({ traceId, stage: 'navigate', result: 'failed', route: '/task/all', reason }),
        )
      }
    }

    logger.info('ExternalInput', formatLogFields({ traceId, stage: 'route-download', result: 'start' }))
    try {
      const handlingResult = appStore.handleDeepLinkUrls(urls)
      logger.info(
        'ExternalInput',
        formatLogFields({
          traceId,
          stage: 'route-download',
          result: 'ok',
          received: handlingResult?.received ?? 'unknown',
          queued: handlingResult?.queued ?? 'unknown',
          autoSubmitted: handlingResult?.autoSubmitted ?? 'unknown',
          ignored: handlingResult?.ignored ?? 'unknown',
        }),
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.error('ExternalInput', formatLogFields({ traceId, stage: 'route-download', result: 'failed', reason }))
      throw error
    }
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
      const pendingActions = await invoke<PendingFrontendAction[]>('take_pending_frontend_actions')
      if (pendingActions.length > 0) {
        logger.info('AppEvents', `consuming ${pendingActions.length} pending frontend action(s) from window recreation`)
        for (const pendingAction of pendingActions) {
          if (pendingAction.channel === 'menu-event') {
            await handleMenuAction(pendingAction.action)
          } else if (pendingAction.channel === 'tray-menu-action') {
            await handleTrayAction(pendingAction.action)
          }
        }
      }
    } catch (e) {
      logger.debug('AppEvents.pendingNativeEvents', e)
    }

    return { unlistenDragDrop, unlistenMenuEvent, unlistenTrayMenu, unlistenDeepLink, unlistenSingleInstance, teardown }
  }

  return { setupListeners }
}
