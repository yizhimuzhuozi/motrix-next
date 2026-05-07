import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Aria2Task } from '@shared/types'

const invokeMock = vi.fn()

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('naive-ui', () => ({
  NProgress: { template: '<div class="progress-stub" />' },
  NIcon: { template: '<span><slot /></span>' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' },
}))

vi.mock('@vicons/ionicons5', () => ({
  ArrowUpOutline: { template: '<i />' },
  ArrowDownOutline: { template: '<i />' },
  GitNetworkOutline: { template: '<i />' },
  MagnetOutline: { template: '<i />' },
  AlertCircleOutline: { template: '<i />' },
  CloudUploadOutline: { template: '<i />' },
  CheckmarkCircleOutline: { template: '<i />' },
  TrashOutline: { template: '<i />' },
}))

vi.mock('../TaskItemActions.vue', () => ({
  default: { template: '<div class="task-item-actions-stub" />' },
}))

import TaskItem from '../TaskItem.vue'

function createTask(path: string): Aria2Task {
  return {
    gid: 'gid-1',
    status: 'complete',
    totalLength: '100',
    completedLength: '100',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/ignored.bin',
        length: '10',
        completedLength: '0',
        selected: 'false',
        uris: [],
      },
      {
        index: '2',
        path,
        length: '90',
        completedLength: '90',
        selected: 'true',
        uris: [],
      },
    ],
    bittorrent: { info: { name: 'archive.zip' } },
    numSeeders: '0',
    errorMessage: '',
  }
}

describe('TaskItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes file existence when the selected target path changes', async () => {
    const wrapper = mount(TaskItem, {
      props: {
        task: createTask('/downloads/first.bin'),
      },
    })

    await vi.advanceTimersByTimeAsync(200)
    expect(invokeMock).toHaveBeenLastCalledWith('check_path_exists', {
      path: '/downloads/first.bin',
    })

    invokeMock.mockClear()

    await wrapper.setProps({
      task: createTask('/downloads/second.bin'),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('check_path_exists', {
      path: '/downloads/second.bin',
    })
  })

  it('coalesces rapid target path changes into a single file check for the latest path', async () => {
    const wrapper = mount(TaskItem, {
      props: {
        task: createTask('/downloads/first.bin'),
      },
    })

    await vi.advanceTimersByTimeAsync(200)
    invokeMock.mockClear()

    await wrapper.setProps({
      task: createTask('/downloads/second.bin'),
    })
    await vi.advanceTimersByTimeAsync(50)
    await wrapper.setProps({
      task: createTask('/downloads/third.bin'),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('check_path_exists', {
      path: '/downloads/third.bin',
    })
  })
})
