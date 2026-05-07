import { describe, it, expect } from 'vitest'
import { countryCodeToFlag, lookupPeerIps } from '../geoip'

describe('countryCodeToFlag', () => {
  it('converts US to 🇺🇸', () => {
    expect(countryCodeToFlag('US')).toBe('🇺🇸')
  })

  it('converts JP to 🇯🇵', () => {
    expect(countryCodeToFlag('JP')).toBe('🇯🇵')
  })

  it('converts DE to 🇩🇪', () => {
    expect(countryCodeToFlag('DE')).toBe('🇩🇪')
  })

  it('converts CN to 🇨🇳', () => {
    expect(countryCodeToFlag('CN')).toBe('🇨🇳')
  })

  it('is case-insensitive', () => {
    expect(countryCodeToFlag('us')).toBe('🇺🇸')
    expect(countryCodeToFlag('Jp')).toBe('🇯🇵')
  })

  it('returns empty string for empty input', () => {
    expect(countryCodeToFlag('')).toBe('')
  })

  it('returns empty string for single character', () => {
    expect(countryCodeToFlag('U')).toBe('')
  })

  it('returns empty string for three characters', () => {
    expect(countryCodeToFlag('USA')).toBe('')
  })
})

describe('lookupPeerIps', () => {
  it('returns empty object for empty input without invoking IPC', async () => {
    // Empty array short-circuits before invoke() is called
    const result = await lookupPeerIps([], 'en-US')
    expect(result).toEqual({})
  })
})
