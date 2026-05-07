/** @fileoverview Composable providing application-level message notifications. */
import type { VNodeChild } from 'vue'
import { useMessage, type MessageOptions } from 'naive-ui'
import { MESSAGE_DURATION } from '@shared/timing'
import { ellipsis } from '@shared/utils/format'

/** Maximum display length for toast notification content. */
const TOAST_MAX_LENGTH = 128

/** Content accepted by message methods — plain text or VNode render function. */
export type MessageContent = string | (() => VNodeChild)

const DEFAULTS: MessageOptions = {
  closable: true,
  duration: MESSAGE_DURATION,
  keepAliveOnHover: true,
}

const activeMessages = new Map<
  string,
  { el: ReturnType<ReturnType<typeof useMessage>['error']>; timer: ReturnType<typeof setTimeout> }
>()

/**
 * Dedup-aware message dispatcher.
 *
 * For plain string content: applies ellipsis truncation and deduplication.
 * For render functions: passes through directly to Naive UI (no dedup —
 * render functions are unique closures that cannot be compared by value).
 */
function dedupShow(
  fn: (content: MessageContent, options?: MessageOptions) => ReturnType<ReturnType<typeof useMessage>['error']>,
  content: MessageContent,
  options?: MessageOptions,
) {
  // VNode render functions: pass through directly to Naive UI.
  // No dedup — each render closure is unique and cannot be compared.
  if (typeof content === 'function') {
    return fn(content, { ...DEFAULTS, ...options })
  }

  const key = content
  const display = ellipsis(content, TOAST_MAX_LENGTH)
  const existing = activeMessages.get(key)
  const duration = options?.duration ?? DEFAULTS.duration ?? MESSAGE_DURATION

  if (existing) {
    existing.el.destroy()
    clearTimeout(existing.timer)
    activeMessages.delete(key)
    setTimeout(() => {
      const el = fn(display, { ...DEFAULTS, ...options })
      const timer = setTimeout(() => activeMessages.delete(key), duration)
      activeMessages.set(key, { el, timer })
    }, 80)
    return existing.el
  }

  const el = fn(display, { ...DEFAULTS, ...options })
  const timer = setTimeout(() => activeMessages.delete(key), duration)
  activeMessages.set(key, { el, timer })
  return el
}

export function useAppMessage() {
  const message = useMessage()
  return {
    success: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.success.bind(message), content, options),
    error: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.error.bind(message), content, options),
    warning: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.warning.bind(message), content, options),
    info: (content: MessageContent, options?: MessageOptions) =>
      dedupShow(message.info.bind(message), content, options),
  }
}
