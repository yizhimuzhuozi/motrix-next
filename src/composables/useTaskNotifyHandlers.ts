/**
 * @fileoverview Extracted notification handlers for task lifecycle events.
 *
 * These handlers are registered by MainLayout as callbacks on the lifecycle
 * service. Extracted here as pure functions for independent unit testing —
 * following the same pattern as useTaskLifecycle.ts.
 *
 * Each handler sends both an in-app toast (via Naive UI message) and
 * an OS-level notification (via tauri-plugin-notification), gated
 * by the user's taskNotification preference.
 *
 * When `onOpenFile` / `onShowInFolder` callbacks are provided in deps,
 * the in-app toast renders inline action buttons so the user can open
 * the downloaded file or reveal it in the system file manager directly
 * from the notification — without navigating through the task list.
 */
import type { VNodeChild } from 'vue'
import type { Aria2Task } from '@shared/types'
import { getTaskDisplayName } from '@shared/utils'
import { isMetadataTask } from '@/composables/useTaskLifecycle'
import { notifyOs } from '@/composables/useOsNotification'
import { renderCompletionToast } from '@/composables/useNotificationToast'

/** Dependency interface for testability. */
export interface NotifyDeps {
  messageSuccess: (content: string | (() => VNodeChild)) => void
  messageError: (content: string, options?: Record<string, unknown>) => void
  t: (key: string, params?: Record<string, unknown>) => string
  taskNotification: boolean
  /** Optional: open the downloaded file with the default application. */
  onOpenFile?: (task: Aria2Task) => void
  /** Optional: reveal the downloaded file in the system file manager. */
  onShowInFolder?: (task: Aria2Task) => void
}

/**
 * Handle a completed HTTP/FTP download.
 * Sends in-app toast + OS notification unless gated or metadata task.
 *
 * When action callbacks are provided, the toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleTaskComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (isMetadataTask(task)) return
  if (!deps.taskNotification) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.download-complete-message', { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: deps.onOpenFile ? () => deps.onOpenFile!(task) : undefined,
    onShowInFolder: deps.onShowInFolder ? () => deps.onShowInFolder!(task) : undefined,
  })
  deps.messageSuccess(toastContent)
  notifyOs('MotrixNext', body)
}

/**
 * Handle a BT download entering seeding state (download phase complete).
 * Sends in-app toast + OS notification unless gated.
 *
 * When action callbacks are provided, the toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleBtComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (!deps.taskNotification) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.bt-download-complete-message', { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: deps.onOpenFile ? () => deps.onOpenFile!(task) : undefined,
    onShowInFolder: deps.onShowInFolder ? () => deps.onShowInFolder!(task) : undefined,
  })
  deps.messageSuccess(toastContent)
  notifyOs('MotrixNext', body)
}

/**
 * Handle a download error — send OS notification for the error text.
 * The in-app error toast is already handled by the caller in TaskView.
 */
export function handleTaskError(_task: Aria2Task, errorText: string, deps: NotifyDeps): void {
  if (!deps.taskNotification) return
  notifyOs('MotrixNext', errorText)
}
