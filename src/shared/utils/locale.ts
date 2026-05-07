/** @fileoverview Locale utilities: direction detection, system locale resolution, form label width. */
import { SUPPORT_RTL_LOCALES } from '@shared/constants'

/**
 * Resolves a raw OS locale string (e.g. `'zh-Hans-CN'`) to the best
 * matching locale code from the available set (e.g. `'zh-CN'`).
 *
 * Resolution strategy:
 *  1. Normalize Apple-style subtags (`-Hans`, `-Hant`) that don't match BCP 47.
 *  2. Exact match against available locales.
 *  3. Prefix match (e.g. `'pt'` → `'pt-BR'`).
 *  4. Fallback to `'en-US'`.
 */
export function resolveSystemLocale(rawLocale: string, availableLocales: string[]): string {
  const normalized = rawLocale.replace('-Hans', '').replace('-Hant', '')
  if (availableLocales.includes(normalized)) return normalized
  const prefix = normalized.split('-')[0]
  return availableLocales.find((l) => l === prefix || l.startsWith(prefix + '-')) || 'en-US'
}

export const isRTL = (locale = 'en-US'): boolean => {
  return SUPPORT_RTL_LOCALES.includes(locale)
}

export const getLangDirection = (locale = 'en-US'): string => {
  return isRTL(locale) ? 'rtl' : 'ltr'
}

export const calcFormLabelWidth = (locale: string): string => {
  return locale.startsWith('de') ? '28%' : '25%'
}
