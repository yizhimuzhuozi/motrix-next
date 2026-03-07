/** @fileoverview Unit tests for the centralized logger utility covering all four log levels. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '@shared/logger'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── error ───────────────────────────────────────────────

  describe('error', () => {
    it('outputs formatted message with [ERROR] tag and context', () => {
      logger.error('TaskStore', 'connection lost')
      expect(console.error).toHaveBeenCalled()
      const msg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('[ERROR]')
      expect(msg).toContain('TaskStore')
      expect(msg).toContain('connection lost')
    })

    it('logs error stack as second console.error call when Error instance provided', () => {
      const err = new Error('test error')
      logger.error('Engine', err)
      // First call: formatted message, second call: stack trace
      expect(console.error).toHaveBeenCalledTimes(2)
      const firstMsg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(firstMsg).toContain('test error')
    })

    it('includes ISO 8601 timestamp', () => {
      logger.error('Ctx', 'msg')
      const msg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    })

    it('converts non-Error objects to string via String()', () => {
      logger.error('Ctx', 42)
      const msg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('42')
      // Non-Error: no stack trace, so only 1 call
      expect(console.error).toHaveBeenCalledTimes(1)
    })
  })

  // ─── warn ────────────────────────────────────────────────

  describe('warn', () => {
    it('outputs formatted message with [WARN] tag and context', () => {
      logger.warn('Polling', 'degraded to fallback')
      expect(console.warn).toHaveBeenCalled()
      const msg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('[WARN]')
      expect(msg).toContain('Polling')
      expect(msg).toContain('degraded to fallback')
    })

    it('includes ISO 8601 timestamp', () => {
      logger.warn('Ctx', 'msg')
      const msg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T/)
    })
  })

  // ─── info ────────────────────────────────────────────────

  describe('info', () => {
    it('outputs formatted message with [INFO] tag and context', () => {
      logger.info('AppInit', 'engine started successfully')
      expect(console.info).toHaveBeenCalled()
      const msg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('[INFO]')
      expect(msg).toContain('AppInit')
      expect(msg).toContain('engine started successfully')
    })

    it('includes ISO 8601 timestamp', () => {
      logger.info('Ctx', 'msg')
      const msg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T/)
    })
  })

  // ─── debug ───────────────────────────────────────────────

  describe('debug', () => {
    it('serializes data object via JSON.stringify', () => {
      logger.debug('Parser', { key: 'value', count: 42 })
      expect(console.debug).toHaveBeenCalled()
      const msg = (console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('[DEBUG]')
      expect(msg).toContain('Parser')
      expect(msg).toContain('"key":"value"')
      expect(msg).toContain('"count":42')
    })

    it('outputs empty message body when data is undefined', () => {
      logger.debug('EmptyCtx')
      expect(console.debug).toHaveBeenCalled()
      const msg = (console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('[DEBUG]')
      expect(msg).toContain('EmptyCtx')
    })

    it('includes ISO 8601 timestamp', () => {
      logger.debug('Ctx', 'test')
      const msg = (console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T/)
    })

    it('handles string data directly', () => {
      logger.debug('Ctx', 'raw string data')
      const msg = (console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(msg).toContain('raw string data')
    })
  })
})
