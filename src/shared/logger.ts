/** @fileoverview Centralized logging utility bridging to tauri-plugin-log for persistent file output. */
import { error as tauriError, warn as tauriWarn, info as tauriInfo, debug as tauriDebug } from '@tauri-apps/plugin-log'

export type LogFieldValue = string | number | boolean | null | undefined
export type LogFields = Record<string, LogFieldValue>

/** Formats a context-prefixed log message suitable for both console and file output. */
function formatMessage(context: string, message: string): string {
  return `[${context}] ${message}`
}

function formatLogFieldValue(value: LogFieldValue): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const raw = String(value)
  return /[\s="]/.test(raw) ? JSON.stringify(raw) : raw
}

/** Formats structured diagnostics as compact key-value fields. */
export function formatLogFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatLogFieldValue(value)}`)
    .join(' ')
}

function serializeDebugValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value.toString()}n`
    case 'undefined':
      return '"[undefined]"'
    case 'symbol':
      return JSON.stringify(value.toString())
    case 'function':
      return JSON.stringify(`[Function ${value.name || 'anonymous'}]`)
    case 'object':
      break
    default:
      return JSON.stringify(String(value))
  }

  if (value instanceof Error) {
    return JSON.stringify(value.stack ?? value.message)
  }

  if (seen.has(value)) {
    return JSON.stringify('[Circular]')
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeDebugValue(item, seen)).join(',')}]`
    }

    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
      try {
        return `${JSON.stringify(key)}:${serializeDebugValue(entryValue, seen)}`
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return `${JSON.stringify(key)}:${JSON.stringify(`[Unserializable: ${reason}]`)}`
      }
    })

    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function formatDebugMessage(data: unknown): string {
  if (data instanceof Error) {
    return data.stack ?? data.message
  }

  if (typeof data === 'string') {
    return data
  }

  if (data === undefined) {
    return ''
  }

  try {
    return serializeDebugValue(data)
  } catch (error) {
    return error instanceof Error ? `[Unserializable: ${error.message}]` : '[Unserializable payload]'
  }
}

/**
 * Centralized logger providing structured, level-gated output.
 *
 * Each log level bridges to the Rust-side `tauri-plugin-log` for persistent file storage
 * with automatic rotation. Console output policy:
 * - **error / warn**: mirror to `console.error` / `console.warn` for DevTools visibility
 * - **info / debug**: silent in console — only written to the Rust log file
 *
 * The `.catch(() => {})` on every tauri call prevents IPC failures from propagating
 * into business logic (e.g., during app teardown or before plugin initialisation).
 */
export const logger = {
  /** Logs an error with full Error object serialization to both console and log file. */
  error(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const formatted = formatMessage(context, message)
    console.error(formatted)
    tauriError(formatted).catch(() => {})
    if (error instanceof Error && error.stack) {
      const stackFormatted = formatMessage(context, error.stack)
      tauriError(stackFormatted).catch(() => {})
    }
  },

  /** Logs a warning for degradable failures to both console and log file. */
  warn(context: string, message: string): void {
    const formatted = formatMessage(context, message)
    console.warn(formatted)
    tauriWarn(formatted).catch(() => {})
  },

  /** Logs informational messages for significant operations (log file only, no console). */
  info(context: string, message: string): void {
    const formatted = formatMessage(context, message)
    tauriInfo(formatted).catch(() => {})
  },

  /** Logs debug data (log file only, no console). Suppressed in production by Rust-side level filter. */
  debug(context: string, data?: unknown): void {
    const message = formatDebugMessage(data)
    const formatted = formatMessage(context, message)
    tauriDebug(formatted).catch(() => {})
  },
}
