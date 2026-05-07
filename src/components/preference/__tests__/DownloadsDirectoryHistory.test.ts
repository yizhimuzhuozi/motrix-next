/** @fileoverview Structure tests for the shared directory history picker in Downloads preferences. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = resolve(__dirname, '../../../..')
const downloadsSource = readFileSync(resolve(PROJECT_ROOT, 'src/components/preference/Downloads.vue'), 'utf-8')
const addTaskSource = readFileSync(resolve(PROJECT_ROOT, 'src/components/task/AddTask.vue'), 'utf-8')

describe('Downloads directory history integration', () => {
  it('uses the shared DirectoryPopover component in Downloads preferences', () => {
    expect(downloadsSource).toContain("import DirectoryPopover from '@/components/common/DirectoryPopover.vue'")
  })

  it('keeps AddTask on the same shared DirectoryPopover component', () => {
    expect(addTaskSource).toContain("import DirectoryPopover from '@/components/common/DirectoryPopover.vue'")
  })

  it('adds exactly one directory history popover to the Downloads preference page', () => {
    const matches = downloadsSource.match(/<DirectoryPopover\b/g) ?? []

    expect(matches).toHaveLength(1)
  })
})
