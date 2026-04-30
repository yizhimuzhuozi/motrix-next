import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'

const listenMock = vi.fn()
const invokeMock = vi.fn()
const routerBeforeEachMock = vi.fn()
const dragDropListenerMock = vi.fn()
const openDialogMock = vi.fn()
const openUrlMock = vi.fn()

const setEngineReadyMock = vi.fn()
let eventUnlisteners: Array<ReturnType<typeof vi.fn>> = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (...args: unknown[]) => dragDropListenerMock(...args),
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    unminimize: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    beforeEach: (...args: unknown[]) => routerBeforeEachMock(...args),
    push: vi.fn().mockResolvedValue(undefined),
  }),
  useRoute: () => ({
    path: '/task/all',
  }),
}))

vi.mock('@/api/aria2', () => ({
  isEngineReady: vi.fn(() => true),
  setEngineReady: (...args: unknown[]) => setEngineReadyMock(...args),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { useAppEvents } from '../useAppEvents'

type UseAppEventsDeps = Parameters<typeof useAppEvents>[0]

function createDeps() {
  const showEngineOverlay = ref(false)
  const isExiting = ref(false)
  const appStore = reactive({
    showAddTaskDialog: vi.fn(),
    enqueueBatch: vi.fn(() => 0),
    handleDeepLinkUrls: vi.fn(),
    engineReady: false,
    engineRestarting: true,
  })
  const taskStore = reactive({
    taskList: [] as unknown[],
    selectedGidList: [] as string[],
    hasPausedTasks: vi.fn().mockResolvedValue(false),
    hasActiveTasks: vi.fn().mockResolvedValue(false),
    resumeAllTask: vi.fn().mockResolvedValue(undefined),
    pauseAllTask: vi.fn().mockResolvedValue(undefined),
    fetchList: vi.fn().mockResolvedValue(undefined),
  })
  const preferenceStore = reactive({
    pendingChanges: false,
    saveBeforeLeave: null as (() => Promise<void>) | null,
    config: {
      rpcListenPort: 16800,
      rpcSecret: '',
    },
  })
  const message = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }
  const navDialog = {
    warning: vi.fn(),
  }

  const deps: UseAppEventsDeps = {
    t: (key) => key,
    appStore,
    taskStore,
    preferenceStore,
    message,
    navDialog: navDialog as never,
    showEngineOverlay,
    isExiting,
    handleExitConfirm: vi.fn().mockResolvedValue(undefined),
    onAbout: vi.fn(),
  }

  return { deps, appStore, message }
}

function mountComposable(deps: UseAppEventsDeps) {
  let setupListeners!: ReturnType<typeof useAppEvents>['setupListeners']
  const wrapper = mount(
    defineComponent({
      setup() {
        setupListeners = useAppEvents(deps).setupListeners
        return {}
      },
      template: '<div />',
    }),
  )

  return {
    wrapper,
    setupListeners,
    unmount: () => wrapper.unmount(),
  }
}

describe('useAppEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventUnlisteners = []

    listenMock.mockImplementation(async (eventName: string) => {
      const unlisten = vi.fn().mockName(`unlisten:${eventName}`)
      eventUnlisteners.push(unlisten)
      return unlisten
    })
    routerBeforeEachMock.mockImplementation(() => vi.fn().mockName('remove-nav-guard'))
    dragDropListenerMock.mockImplementation(async () => vi.fn().mockName('unlisten:drag-drop'))
    openDialogMock.mockResolvedValue(null)
    openUrlMock.mockResolvedValue(undefined)
    invokeMock.mockResolvedValue([])
  })

  it('returns a teardown that unregisters engine listeners, the watcher, and the router guard', async () => {
    const { deps, appStore, message } = createDeps()
    const { setupListeners } = mountComposable(deps)

    const listeners = await setupListeners()
    expect(typeof (listeners as { teardown?: unknown }).teardown).toBe('function')

    appStore.engineRestarting = false
    await nextTick()
    expect(message.error).toHaveBeenCalledTimes(1)

    appStore.engineRestarting = true
    await nextTick()
    message.success.mockClear()
    message.error.mockClear()
    message.warning.mockClear()
    message.info.mockClear()
    ;(listeners as { teardown: () => void }).teardown()

    appStore.engineRestarting = false
    await nextTick()

    expect(message.error).not.toHaveBeenCalled()
    expect(routerBeforeEachMock).toHaveBeenCalledTimes(1)

    const engineUnlisteners = eventUnlisteners.slice(0, 3)
    for (const unlisten of engineUnlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1)
    }

    const removeGuard = routerBeforeEachMock.mock.results[0]?.value as (() => void) | undefined
    expect(removeGuard).toBeDefined()
    expect(removeGuard).toHaveBeenCalledTimes(1)
  })

  it('cleans up the watcher and listeners automatically on component unmount', async () => {
    const { deps, appStore, message } = createDeps()
    const { setupListeners, unmount } = mountComposable(deps)

    await setupListeners()
    unmount()

    appStore.engineRestarting = false
    await nextTick()

    expect(message.error).not.toHaveBeenCalled()

    const engineUnlisteners = eventUnlisteners.slice(0, 3)
    for (const unlisten of engineUnlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1)
    }

    const removeGuard = routerBeforeEachMock.mock.results[0]?.value as (() => void) | undefined
    expect(removeGuard).toBeDefined()
    expect(removeGuard).toHaveBeenCalledTimes(1)
  })

  it('does not process external input when the Rust pending queue is empty', async () => {
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(invokeMock).toHaveBeenCalledWith('take_pending_deep_links')
    expect(appStore.handleDeepLinkUrls).not.toHaveBeenCalled()
  })

  it('processes external input drained from the Rust pending queue once listeners are ready', async () => {
    invokeMock.mockResolvedValueOnce(['file:///Users/example/ubuntu.torrent'])
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledTimes(1)
    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith(['file:///Users/example/ubuntu.torrent'])
  })
})
