/**
 * @fileoverview Tests for macOS native traffic lights migration.
 *
 * Verifies that:
 * 1. macStyleControls is removed from all shared types and config structures
 * 2. BasicForm no longer includes macStyleControls
 * 3. configKeys no longer contains 'mac-style-controls'
 * 4. DEFAULT_APP_CONFIG no longer contains macStyleControls
 *
 * These tests are written RED-first (TDD) — they must FAIL before implementation.
 */
import { describe, it, expect } from 'vitest'
import { buildGeneralForm } from '../useGeneralPreference'
import type { AppConfig } from '@shared/types'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import { userKeys } from '@shared/configKeys'

// ── macStyleControls removal from DEFAULT_APP_CONFIG ────────────────

describe('DEFAULT_APP_CONFIG: macStyleControls removal', () => {
  it('does not contain macStyleControls property', () => {
    expect(DEFAULT_APP_CONFIG).not.toHaveProperty('macStyleControls')
  })
})

// ── macStyleControls removal from configKeys ────────────────────────

describe('configKeys: mac-style-controls removal', () => {
  it('userKeys does not contain mac-style-controls', () => {
    expect(userKeys).not.toContain('mac-style-controls')
  })
})

// ── macStyleControls removal from BasicForm ─────────────────────────

describe('BasicForm: macStyleControls removal', () => {
  it('buildGeneralForm output does not include macStyleControls', () => {
    const form = buildGeneralForm({} as AppConfig)
    expect(form).not.toHaveProperty('macStyleControls')
  })

  it('buildGeneralForm ignores macStyleControls in input config', () => {
    const form = buildGeneralForm({ macStyleControls: true } as unknown as AppConfig)
    expect(form).not.toHaveProperty('macStyleControls')
  })
})

// ── AppConfig type: macStyleControls removal ────────────────────────
// This is a compile-time check — if macStyleControls still exists on
// AppConfig, TypeScript will allow the assignment.  When removed,
// accessing config.macStyleControls in strongly-typed code will error.
//
// We test the runtime manifestation: DEFAULT_APP_CONFIG (which is typed
// as AppConfig) should not have the key.

describe('AppConfig: macStyleControls not in default shape', () => {
  it('DEFAULT_APP_CONFIG keys do not include macStyleControls', () => {
    const keys = Object.keys(DEFAULT_APP_CONFIG)
    expect(keys).not.toContain('macStyleControls')
  })
})
