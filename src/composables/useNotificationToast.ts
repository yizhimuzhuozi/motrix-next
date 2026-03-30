/**
 * @fileoverview Toast VNode rendering for download-completion notifications.
 *
 * Produces a Naive UI `message.success` render function with inline action
 * buttons that let the user open the downloaded file or reveal it in the
 * system file manager — directly from the toast notification.
 *
 * Extracted as a pure function so that `useTaskNotifyHandlers.ts` stays
 * independently testable (no VNode imports required in tests).
 *
 * Visual layout:
 *   [✓ body text                      Open File · Show in Folder]
 */
import { h, type VNodeChild } from 'vue'
import { NButton } from 'naive-ui'

/** Options accepted by {@link renderCompletionToast}. */
export interface CompletionToastOptions {
  /** Localised notification body text (e.g. "movie.mp4 completed"). */
  body: string
  /** i18n translation function. */
  t: (key: string) => string
  /** Callback fired when the user clicks "Open File". */
  onOpenFile?: () => void
  /** Callback fired when the user clicks "Show in Folder". */
  onShowInFolder?: () => void
}

/**
 * Build a VNode render function for a download-complete toast.
 *
 * Returns a `() => VNodeChild` suitable for `message.success(renderFn)`.
 * If no action callbacks are provided, returns the plain body string
 * instead — callers can pass the result directly to `messageSuccess`.
 */
export function renderCompletionToast(options: CompletionToastOptions): string | (() => VNodeChild) {
  const { body, t, onOpenFile, onShowInFolder } = options

  // Degrade gracefully when no action callbacks are provided.
  // This keeps backward-compatibility with unit tests and callers that
  // do not need actionable toasts.
  if (!onOpenFile && !onShowInFolder) return body

  return () =>
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          width: '100%',
        },
      },
      [
        h(
          'span',
          {
            style: {
              flex: '1',
              minWidth: '0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          body,
        ),
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              gap: '8px',
              flexShrink: '0',
            },
          },
          [
            onOpenFile &&
              h(
                NButton,
                {
                  tertiary: true,
                  type: 'primary',
                  size: 'small',
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation()
                    onOpenFile()
                  },
                },
                { default: () => t('task.open-file') },
              ),
            onShowInFolder &&
              h(
                NButton,
                {
                  tertiary: true,
                  type: 'primary',
                  size: 'small',
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation()
                    onShowInFolder()
                  },
                },
                { default: () => t('task.show-in-folder') },
              ),
          ],
        ),
      ],
    )
}
