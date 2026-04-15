/**
 * @fileoverview Tests for the useEngineRestart composable.
 *
 * Verifies the concurrency guard that prevents multiple simultaneous engine
 * restarts — the root cause of orphaned aria2c processes.
 *
 * Now tests the invoke()-only flow: restart_engine_command (which runs
 * on_engine_ready internally) + wait_for_engine (Rust-side health check).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

// Mock Tauri invoke — returns a controllable promise
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))

// Mock aria2 API — only setEngineReady is used now
vi.mock('@/api/aria2', () => ({
  setEngineReady: vi.fn(),
}))

// Mock app store
const mockAppStore = {
  engineReady: true,
  engineRestarting: false,
  setEngineRestarting(val: boolean) {
    mockAppStore.engineRestarting = val
  },
}
vi.mock('@/stores/app', () => ({
  useAppStore: () => mockAppStore,
}))

import { useEngineRestart } from '@/composables/useEngineRestart'

describe('useEngineRestart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAppStore.engineReady = true
    mockAppStore.engineRestarting = false
    // By default: restart_engine_command succeeds, wait_for_engine returns true
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'wait_for_engine') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })
  })

  it('exposes isRestarting ref that starts as false', () => {
    const { isRestarting } = useEngineRestart()
    expect(isRestarting.value).toBe(false)
  })

  it('sets isRestarting to true during restart', async () => {
    // Make invoke hang so we can observe the in-progress state
    let resolveInvoke!: () => void
    mockInvoke.mockReturnValue(
      new Promise<void>((r) => {
        resolveInvoke = r
      }),
    )

    const { restartEngine, isRestarting } = useEngineRestart()
    const promise = restartEngine({ port: 16800, secret: 'test' })

    await nextTick()
    expect(isRestarting.value).toBe(true)

    resolveInvoke()
    await promise
    expect(isRestarting.value).toBe(false)
  })

  it('prevents concurrent restarts — second call returns false', async () => {
    let resolveInvoke!: () => void
    mockInvoke.mockReturnValue(
      new Promise<void>((r) => {
        resolveInvoke = r
      }),
    )

    const { restartEngine } = useEngineRestart()

    // First call starts restart
    const first = restartEngine({ port: 16800, secret: 'test' })

    await nextTick()

    // Second call while first is in-flight should be rejected
    const secondResult = await restartEngine({ port: 16800, secret: 'test' })
    expect(secondResult).toBe(false)

    // Only ONE invoke call should have been made
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    resolveInvoke()
    await first
  })

  it('resets isRestarting after error (no permanent lock)', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('engine crash'))

    const { restartEngine, isRestarting } = useEngineRestart()
    const result = await restartEngine({ port: 16800, secret: 'test' })

    // Guard must be released even after failure
    expect(result).toBe(false)
    expect(isRestarting.value).toBe(false)
  })

  it('returns false when wait_for_engine returns false', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'wait_for_engine') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })

    const { restartEngine } = useEngineRestart()
    const result = await restartEngine({ port: 16800, secret: 'test' })
    expect(result).toBe(false)
  })

  it('allows restart after a previous one completes', async () => {
    const { restartEngine, isRestarting } = useEngineRestart()

    // First restart succeeds
    await restartEngine({ port: 16800, secret: 'test' })
    expect(isRestarting.value).toBe(false)

    // Second restart should also be allowed
    const result = await restartEngine({ port: 16800, secret: 'test' })
    expect(result).toBe(true)
  })

  it('calls restart_engine_command then wait_for_engine via invoke', async () => {
    const { restartEngine } = useEngineRestart()
    await restartEngine({ port: 16800, secret: 'abc' })
    expect(mockInvoke).toHaveBeenCalledWith('restart_engine_command')
    expect(mockInvoke).toHaveBeenCalledWith('wait_for_engine')
  })

  it('sets engineReady=true on success', async () => {
    mockAppStore.engineReady = false
    const { restartEngine } = useEngineRestart()
    await restartEngine({ port: 16800, secret: 'abc' })
    expect(mockAppStore.engineReady).toBe(true)
  })
})
