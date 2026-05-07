/**
 * @fileoverview OS-level desktop notification helper.
 *
 * Sends native notifications via @tauri-apps/plugin-notification which supports:
 *   - macOS: NSUserNotificationCenter
 *   - Windows: WinRT Toast Notifications
 *   - Linux: D-Bus org.freedesktop.Notifications (via notify-rust)
 *
 * Permission is requested lazily on first use rather than at app startup
 * to avoid interrupting the user before any download has finished.
 *
 * This is a non-critical path — all errors are silently caught and logged
 * to prevent notification failures from disrupting core download functionality.
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { formatLogFields, logger } from '@shared/logger'

/**
 * Send an OS-level notification if permission is granted.
 *
 * Silently skips if permission is denied or the call fails (e.g. Linux without
 * a notification daemon, or dev-mode webview context issues).
 */
export async function notifyOs(title: string, body: string): Promise<void> {
  let stage: 'permission-check' | 'permission-request' | 'send' = 'permission-check'
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      stage = 'permission-request'
      const permission = await requestPermission()
      granted = permission === 'granted'
    }
    if (granted) {
      stage = 'send'
      sendNotification({ title, body })
      logger.info('notifyOs', formatLogFields({ stage, title }))
    } else {
      logger.debug('notifyOs', formatLogFields({ stage, result: 'permission-denied', title }))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.debug('notifyOs', formatLogFields({ stage, result: 'failed', title, error: message }))
  }
}
