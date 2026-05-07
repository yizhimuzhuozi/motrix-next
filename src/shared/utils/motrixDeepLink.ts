/** @fileoverview Parser for Motrix internal deep-link inputs. */

export type MotrixDeepLinkAction = 'new' | 'none' | 'unknown'
export type MotrixDeepLinkFailureReason = 'unsupported-scheme' | 'malformed'

export interface ParsedMotrixDeepLink {
  valid: boolean
  action: MotrixDeepLinkAction
  isNewTask: boolean
  downloadUrl: string
  referer: string
  cookie: string
  filename: string
  reason?: MotrixDeepLinkFailureReason
}

const EMPTY_RESULT: ParsedMotrixDeepLink = {
  valid: false,
  action: 'none',
  isNewTask: false,
  downloadUrl: '',
  referer: '',
  cookie: '',
  filename: '',
}

function hasMotrixScheme(value: string): boolean {
  return value.trim().toLowerCase().startsWith('motrixnext:')
}

function normalizeAction(value: string): MotrixDeepLinkAction {
  if (!value) return 'none'
  return value.toLowerCase() === 'new' ? 'new' : 'unknown'
}

function getFirstPathSegment(pathname: string): string {
  return pathname.replace(/^\/+/, '').split(/[/?#]/, 1)[0] || ''
}

function getRawAction(value: string): MotrixDeepLinkAction {
  const trimmed = value.trim()
  const payload = trimmed.slice('motrixnext:'.length).replace(/^\/+/, '')
  return normalizeAction(payload.split(/[/?#]/, 1)[0] || '')
}

function getSearchParams(value: string, parsed: URL | null): URLSearchParams {
  if (parsed) return parsed.searchParams

  const queryStart = value.indexOf('?')
  if (queryStart < 0) return new URLSearchParams()

  const fragmentStart = value.indexOf('#', queryStart)
  const query = fragmentStart >= 0 ? value.slice(queryStart + 1, fragmentStart) : value.slice(queryStart + 1)
  return new URLSearchParams(query)
}

/** Parses Motrix internal deep links without depending on one runtime-specific URL action shape. */
export function parseMotrixDeepLink(value: string): ParsedMotrixDeepLink {
  if (!hasMotrixScheme(value)) {
    return { ...EMPTY_RESULT, reason: 'unsupported-scheme' }
  }

  let parsed: URL | null = null
  try {
    parsed = new URL(value)
  } catch {
    return { ...EMPTY_RESULT, valid: false, reason: 'malformed' }
  }

  if (parsed.protocol.toLowerCase() !== 'motrixnext:') {
    return { ...EMPTY_RESULT, reason: 'unsupported-scheme' }
  }

  const actionFromUrl = normalizeAction(parsed.hostname || getFirstPathSegment(parsed.pathname))
  const rawAction = getRawAction(value)
  const action = actionFromUrl === 'none' ? rawAction : actionFromUrl
  const params = getSearchParams(value, parsed)
  const downloadUrl = params.get('url') || ''

  return {
    valid: true,
    action,
    isNewTask: action === 'new' && downloadUrl.length > 0,
    downloadUrl,
    referer: params.get('referer') || '',
    cookie: params.get('cookie') || '',
    filename: params.get('filename') || '',
  }
}

export function isMotrixNewTaskLink(value: string): boolean {
  return parseMotrixDeepLink(value).isNewTask
}
