/**
 * @fileoverview App-level task lifecycle service.
 *
 * Runs independently of TaskView and currentList. Polls aria2 for
 * active + stopped tasks and feeds them to an internal notifier for
 * completion / error / BT-seeding detection.
 *
 * Architecture decision: this service does NOT use taskStore.fetchList()
 * because fetchList() is coupled to UI state (currentList, taskList ref,
 * detail panel, etc.). Instead it makes its own targeted RPC calls
 * specifically for lifecycle event detection.
 *
 * The stopped slice is limited to the 50 most recent entries to avoid
 * scanning the entire download history on every tick.
 */
import { createTaskNotifier } from '@/stores/task/notifications'
import { isEngineReady } from '@/api/aria2'
import { logger } from '@shared/logger'
import type { Aria2Task } from '@shared/types'

/** Maximum number of stopped tasks to scan per tick. */
const STOPPED_SLICE_LIMIT = 50

interface LifecycleCallbacks {
  onTaskError: (task: Aria2Task) => void
  onTaskComplete: (task: Aria2Task) => void
  onBtComplete: (task: Aria2Task) => void
}

interface LifecycleApi {
  fetchTaskList: (params: { type: string }) => Promise<Aria2Task[]>
}

interface LifecycleService {
  start: (getInterval: () => number) => void
  stop: () => void
  reset: () => void
}

/**
 * Creates an app-level lifecycle service that polls independently of
 * route/tab state.
 *
 * The service owns its own {@link createTaskNotifier} instance so that
 * deduplication state is independent of any UI-level notifier.
 */
export function createTaskLifecycleService(api: LifecycleApi, callbacks: LifecycleCallbacks): LifecycleService {
  const notifier = createTaskNotifier()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true

  async function scan(): Promise<void> {
    if (!isEngineReady()) return
    try {
      const activeTasks = await api.fetchTaskList({ type: 'active' })
      const stoppedSlice = (await api.fetchTaskList({ type: 'stopped' })).slice(0, STOPPED_SLICE_LIMIT)
      notifier.scanTasks([...activeTasks, ...stoppedSlice], callbacks)
    } catch (e) {
      logger.debug('LifecycleService.scan', (e as Error).message)
    }
  }

  function start(getInterval: () => number): void {
    stop()
    stopped = false

    async function tick(): Promise<void> {
      if (stopped) return
      await scan()
      if (stopped) return
      timer = setTimeout(tick, getInterval())
    }

    timer = setTimeout(tick, getInterval())
  }

  function stop(): void {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function reset(): void {
    notifier.reset()
  }

  return { start, stop, reset }
}
