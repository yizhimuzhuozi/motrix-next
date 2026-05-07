/**
 * @fileoverview Tests for the OS-level notification helper.
 *
 * Key behaviors under test:
 * 1. Sends OS notification when permission is already granted.
 * 2. Requests permission when not granted; sends if approved.
 * 3. Does NOT send when permission is denied.
 * 4. Silently catches errors without throwing (non-critical path).
 * 5. Passes title and body verbatim to sendNotification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @tauri-apps/plugin-notification ─────────────────────────────
const mockIsPermissionGranted = vi.fn((): Promise<boolean> => Promise.resolve(false))
const mockRequestPermission = vi.fn((): Promise<string> => Promise.resolve('denied'))
const mockSendNotification = vi.fn()

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: (...args: unknown[]) => mockIsPermissionGranted(...(args as [])),
  requestPermission: (...args: unknown[]) => mockRequestPermission(...(args as [])),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

// ── Mock @shared/logger ─────────────────────────────────────────────
vi.mock('@shared/logger', () => ({
  formatLogFields: (fields: Record<string, unknown>) =>
    Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' '),
  logger: { debug: vi.fn(), info: vi.fn() },
}))

import { notifyOs } from '../useOsNotification'
import { logger } from '@shared/logger'

describe('notifyOs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends notification when permission is already granted', async () => {
    mockIsPermissionGranted.mockResolvedValue(true)

    await notifyOs('MotrixNext', 'Download complete')

    expect(mockSendNotification).toHaveBeenCalledOnce()
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'MotrixNext',
      body: 'Download complete',
    })
    // Should not request permission — already granted
    expect(mockRequestPermission).not.toHaveBeenCalled()
  })

  it('requests permission when not granted and sends if approved', async () => {
    mockIsPermissionGranted.mockResolvedValue(false)
    mockRequestPermission.mockResolvedValue('granted')

    await notifyOs('MotrixNext', 'Task finished')

    expect(mockRequestPermission).toHaveBeenCalledOnce()
    expect(mockSendNotification).toHaveBeenCalledOnce()
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'MotrixNext',
      body: 'Task finished',
    })
  })

  it('does NOT send notification when permission is denied', async () => {
    mockIsPermissionGranted.mockResolvedValue(false)
    mockRequestPermission.mockResolvedValue('denied')

    await notifyOs('MotrixNext', 'Should not appear')

    expect(mockRequestPermission).toHaveBeenCalledOnce()
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('notifyOs', expect.stringContaining('result=permission-denied'))
  })

  it('silently catches errors without throwing', async () => {
    mockIsPermissionGranted.mockRejectedValue(new Error('D-Bus unavailable'))

    // Must not throw — OS notifications are non-critical
    await expect(notifyOs('MotrixNext', 'body')).resolves.toBeUndefined()

    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('notifyOs', expect.stringContaining('stage=permission-check'))
    expect(logger.debug).toHaveBeenCalledWith('notifyOs', expect.stringContaining('result=failed'))
  })

  it('catches sendNotification errors without throwing', async () => {
    mockIsPermissionGranted.mockResolvedValue(true)
    mockSendNotification.mockImplementation(() => {
      throw new Error('notification daemon crashed')
    })

    await expect(notifyOs('MotrixNext', 'body')).resolves.toBeUndefined()
    expect(logger.debug).toHaveBeenCalledWith('notifyOs', expect.stringContaining('stage=send'))
    expect(logger.debug).toHaveBeenCalledWith('notifyOs', expect.stringContaining('notification daemon crashed'))
  })

  it('passes title and body verbatim without truncation', async () => {
    mockIsPermissionGranted.mockResolvedValue(true)
    const longBody = 'A'.repeat(200)

    await notifyOs('Title', longBody)

    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Title',
      body: longBody,
    })
  })
})
