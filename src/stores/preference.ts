/** @fileoverview Pinia store for user preferences with persistence and directory history. */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isEmpty } from 'lodash-es'
import { load } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { getLangDirection, pushItemToFixedLengthArray, removeArrayItem } from '@shared/utils'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { DEFAULT_APP_CONFIG, MAX_NUM_OF_DIRECTORIES } from '@shared/constants'
import { logger } from '@shared/logger'
import { runMigrations, type MigrationResult } from '@shared/utils/configMigration'
import type { AppConfig, ProxyConfig } from '@shared/types'

const STORE_KEY = 'preferences'

/**
 * Lazily reads the active vue-i18n locale without importing useLocale at
 * module scope (which would create a circular dependency in tests).
 */
function readI18nLocale(): string {
  try {
    const { i18n } = require('@/composables/useLocale') as {
      i18n: { global: { locale: { value: string } | string } }
    }
    const loc = i18n.global.locale
    return typeof loc === 'string' ? loc : loc.value
  } catch {
    return 'en-US'
  }
}

export const usePreferenceStore = defineStore('preference', () => {
  const engineMode = ref('MAX')
  const pendingChanges = ref(false)
  /** Callback registered by the active preference page to save before navigation. */
  const saveBeforeLeave = ref<(() => Promise<void>) | null>(null)
  const config = ref<AppConfig>({ ...DEFAULT_APP_CONFIG } as AppConfig)
  /** Result from the last migration run (null = no migration attempted yet). */
  const migrationResult = ref<MigrationResult | null>(null)
  /** Set when DB schema upgrade is detected during loadPreference.
   *  MainLayout watches this to show an info toast. Null = no upgrade detected. */
  const dbUpgradeVersion = ref<number | null>(null)

  // ── Deferred migration signals ──────────────────────────────────────
  // loadPreference() runs before setI18nLocale(), so setting these refs
  // immediately would trigger MainLayout watchers while the locale is
  // still 'en-US' — causing migration toasts to always display in English.
  // Solution: buffer the values and flush them after locale is ready.
  let pendingMigrationResult: MigrationResult | null = null
  let pendingDbUpgradeVersion: number | null = null

  const theme = computed(() => config.value.theme)
  const locale = computed(() => config.value.locale)

  /** The actual locale code in use — resolves 'auto' to the live vue-i18n locale. */
  const resolvedLocale = computed(() => {
    const l = config.value.locale
    if (!l || l === 'auto') {
      return readI18nLocale()
    }
    return l
  })

  const direction = computed(() => getLangDirection(resolvedLocale.value))

  async function getStore() {
    return await load('config.json')
  }

  async function loadPreference() {
    try {
      const store = await getStore()
      const saved = await store.get<Partial<AppConfig>>(STORE_KEY)
      if (saved && !isEmpty(saved)) {
        // Backfill dbSchemaVersion for existing users upgrading to a version
        // that includes this field. saved being non-empty proves this is NOT
        // a fresh install — fresh installs have empty config.json and take
        // the DEFAULT_APP_CONFIG path (which already has dbSchemaVersion = 2).
        if (saved.dbSchemaVersion === undefined) {
          saved.dbSchemaVersion = 1
        }
        // Always signal the saved version so the MainLayout watch can
        // compare it against the live DB version. Fresh installs never
        // reach here (saved is null), so no false toast.
        pendingDbUpgradeVersion = saved.dbSchemaVersion

        const result = runMigrations(saved)
        config.value = { ...config.value, ...saved }
        if (result.migrated) {
          pendingMigrationResult = result
          await store.set(STORE_KEY, config.value)
          await store.save()
          logger.info('PreferenceStore', 'config migrated and persisted')
        }
        invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      }
    } catch (e) {
      logger.error('PreferenceStore.loadPreference', e)
    }
  }

  async function savePreference(): Promise<boolean> {
    try {
      const store = await getStore()
      await store.set(STORE_KEY, config.value)
      await store.save()
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.savePreference', e)
      return false
    }
  }

  async function updateAndSave(cfg: Partial<AppConfig>): Promise<boolean> {
    const merged = { ...config.value, ...cfg }
    try {
      const store = await getStore()
      await store.set(STORE_KEY, merged)
      await store.save()
      config.value = merged
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.updateAndSave', e)
      return false
    }
  }

  function updatePreference(cfg: Partial<AppConfig>) {
    config.value = { ...config.value, ...cfg }
  }

  function recordHistoryDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    const all = new Set([...historyDirectories, ...favoriteDirectories])
    if (all.has(directory)) return
    addHistoryDirectory(directory)
  }

  function addHistoryDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    config.value = { ...config.value, historyDirectories: history }
    void savePreference()
  }

  function favoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (favoriteDirectories.includes(directory) || favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES) return
    const favorite = pushItemToFixedLengthArray(favoriteDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function cancelFavoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (historyDirectories.includes(directory)) return
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function removeDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function updateAppTheme(t: AppConfig['theme']) {
    updatePreference({ theme: t })
  }

  function updateAppLocale(l: string) {
    updatePreference({ locale: l })
  }

  /**
   * Resets all preferences to factory defaults and persists.
   * Preserves the current locale to avoid unexpected language switches.
   */
  async function resetToDefaults(): Promise<boolean> {
    const currentLocale = config.value.locale
    try {
      const { generateSecret } = await import('@/composables/useAdvancedPreference')
      const store = await getStore()
      const defaults = {
        ...DEFAULT_APP_CONFIG,
        locale: currentLocale,
        rpcSecret: generateSecret(),
        extensionApiSecret: generateSecret(),
      } as AppConfig
      await store.set(STORE_KEY, defaults)
      await store.save()
      config.value = defaults
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.resetToDefaults', e)
      return false
    }
  }

  async function fetchBtTracker(trackerSource: string[] = []) {
    const proxy = config.value.proxy || ({ enable: false } as ProxyConfig)
    return fetchBtTrackerFromSource(trackerSource, proxy)
  }

  /**
   * Emit deferred migration signals so MainLayout watchers fire
   * AFTER i18n locale is set. Call from main.ts after setI18nLocale().
   */
  function flushMigrationSignals() {
    if (pendingMigrationResult) {
      migrationResult.value = pendingMigrationResult
      pendingMigrationResult = null
    }
    if (pendingDbUpgradeVersion !== null) {
      dbUpgradeVersion.value = pendingDbUpgradeVersion
      pendingDbUpgradeVersion = null
    }
  }

  return {
    engineMode,
    pendingChanges,
    saveBeforeLeave,
    config,
    migrationResult,
    dbUpgradeVersion,
    theme,
    locale,
    resolvedLocale,
    direction,
    updatePreference,
    updateAndSave,
    loadPreference,
    savePreference,
    recordHistoryDirectory,
    addHistoryDirectory,
    favoriteDirectory,
    cancelFavoriteDirectory,
    removeDirectory,
    updateAppTheme,
    updateAppLocale,
    fetchBtTracker,
    resetToDefaults,
    flushMigrationSignals,
  }
})
