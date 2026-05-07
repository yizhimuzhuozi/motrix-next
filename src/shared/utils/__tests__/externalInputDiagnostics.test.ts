/** @fileoverview Tests for privacy-preserving external input diagnostics. */
import { describe, expect, it } from 'vitest'
import { summarizeExternalInput, summarizeExternalInputBatch } from '../externalInputDiagnostics'

describe('externalInputDiagnostics', () => {
  it('summarizes motrixnext deep-links without leaking cookie or query values', () => {
    const summary = summarizeExternalInput(
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Fdownload%2Ffile.zip%3Ftoken%3Dsecret-token&cookie=session%3Dsecret-cookie&filename=file.zip',
    )

    expect(summary).toContain('scheme=motrixnext')
    expect(summary).toContain('target=scheme=https host=example.com ext=zip hasQuery=true')
    expect(summary).toContain('hasCookie=true')
    expect(summary).not.toContain('secret-token')
    expect(summary).not.toContain('secret-cookie')
  })

  it('summarizes batches with counts and first-input metadata only', () => {
    const fields = summarizeExternalInputBatch([
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip&cookie=session%3Dsecret-cookie',
    ])

    expect(fields.count).toBe(1)
    expect(fields.hasNewTask).toBe(true)
    expect(fields.hasCookie).toBe(true)
    expect(String(fields.first)).not.toContain('secret-cookie')
  })

  it('uses the same new-task detection for single-slash Motrix deep links', () => {
    const fields = summarizeExternalInputBatch(['motrixnext:/new?url=https%3A%2F%2Fexample.com%2Ffile.zip'])

    expect(fields.hasNewTask).toBe(true)
    expect(String(fields.first)).toContain('action=new')
  })
})
